/**
 * Coleta o árbitro (nome + país) de cada jogo da tabela `jogos`
 * abrindo o link_estatisticas no Flashscore.
 *
 * Controle de fila: coluna jogos.juiz_coletado
 *   0 = pendente (ainda não tentado)
 *   1 = árbitro coletado
 *   2 = bloco de detalhes não encontrado OU jogo sem árbitro
 * Erros de rede/HTTP NÃO marcam o jogo: ele volta pra fila na próxima execução.
 *
 * Uso:   node coletar-arbitros.js [limite]      (padrão: 200 jogos por execução)
 * Deps:  npm i pg playwright cheerio && npx playwright install chromium
 */
const fs = require('fs');
const { criarClient } = require('../../db');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

// ---------------------------------------------------------------- conexão
const client = criarClient('modelo');
client.on('error', (err) => console.error('[pg] conexão caiu:', err.message));

// ---------------------------------------------------------------- config
const SELETOR = '[data-testid="wcl-summaryMatchInformation"]';
const PAUSA_MS = 1500;
const TIMEOUT_BLOCO_MS = 10000;   // espera pelo bloco de detalhes (só pesa em jogo sem bloco)
const MAX_DEBUG = 5;              // máx. de páginas salvas em debug/ por execução
const CONCURRENCIA = parseInt(process.argv[3], 10) || 2;   // abas em paralelo

const PENDENTE = 0;
const COLETADO = 1;
const SEM_DADO = 2;

// Confira com: SELECT DISTINCT pais_liga FROM jogos ORDER BY 1;
const REGIOES_INTERNACIONAIS = new Set([
  'Europa', 'Ásia', 'África', 'América do Sul',
  'América do Norte', 'América Central', 'Oceania', 'Mundo',
]);

// ---------------------------------------------------------------- extração
const CAMPOS = {
  'wcl-icon-incidents-whistle': 'arbitro',
  'wcl-icon-other-venue': 'estadio',
  'wcl-icon-other-people': 'capacidade',
  'wcl-icon-settings-tickets': 'publico',
};

// "Szabolcs K. (Rou)" -> { texto: "Szabolcs K.", extra: "Rou" }
function separarParenteses(str) {
  const limpo = str.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const m = limpo.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m ? { texto: m[1].trim(), extra: m[2].trim() } : { texto: limpo, extra: null };
}

function extrairDetalhesJogo(html) {
  const $ = cheerio.load(html);
  const resultado = {
    arbitro_nome: null, arbitro_pais: null,
    estadio_nome: null, estadio_cidade: null,
    capacidade: null, publico: null,
  };

  $(`${SELETOR} svg[data-testid^="wcl-icon-"]`).each((_, svg) => {
    const campo = CAMPOS[$(svg).attr('data-testid')];
    if (!campo) return;

    // estrutura: [wrapper com svg + label] seguido de [div com o valor]
    const valor = $(svg).parent().next();
    const { texto, extra } = separarParenteses(valor.text());

    if (campo === 'arbitro') {
      resultado.arbitro_nome = texto || null;
      resultado.arbitro_pais = extra;
    } else if (campo === 'estadio') {
      resultado.estadio_nome = texto || null;
      resultado.estadio_cidade = extra;
    } else {
      const n = parseInt(texto.replace(/\D/g, ''), 10);
      resultado[campo] = Number.isNaN(n) ? null : n;
    }
  });

  return resultado;
}

// ---------------------------------------------------------------- banco
async function garantirTabelas() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS arbitros (
      id         SERIAL PRIMARY KEY,
      nome       TEXT NOT NULL,
      pais       TEXT NOT NULL DEFAULT '',
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (nome, pais)
    )`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS arbitros_jogo (
      flashscore_id_jogo        TEXT PRIMARY KEY,
      id_jogo                   INT  NOT NULL,
      id_arbitro                INT  REFERENCES arbitros(id),
      status                    TEXT NOT NULL,
      tentativas                INT  NOT NULL DEFAULT 1,
      coletado_em               TIMESTAMPTZ NOT NULL DEFAULT now(),
      tipo_competicao           TEXT,
      data_jogo                 DATE,
      id_competicao             INT,
      flashscore_id_competicao  TEXT,
      flashscore_slug_liga      TEXT,
      pais_liga                 TEXT,
      flashscore_slug_pais_liga TEXT,
      temporada                 TEXT,
      rodada                    TEXT,
      id_time_casa              INT,
      id_time_fora              INT,
      flashscore_id_time_casa   TEXT,
      flashscore_id_time_fora   TEXT,
      estadio_nome              TEXT,
      estadio_cidade            TEXT,
      capacidade                INT,
      publico                   INT
    )`);

  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_arbitros_jogo_arbitro ON arbitros_jogo (id_arbitro)`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_arbitros_jogo_liga ON arbitros_jogo (id_competicao, pais_liga)`);

  // coluna de controle na tabela jogos
  await client.query(
    `ALTER TABLE jogos ADD COLUMN IF NOT EXISTS juiz_coletado SMALLINT NOT NULL DEFAULT 0`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_jogos_juiz_pendente
       ON jogos (data_jogo DESC) WHERE juiz_coletado = 0`);

  // aproveita o que já foi raspado antes da coluna existir
  const { rowCount } = await client.query(
    `UPDATE jogos j
        SET juiz_coletado = CASE WHEN aj.status = 'ok' THEN ${COLETADO} ELSE ${SEM_DADO} END
       FROM arbitros_jogo aj
      WHERE aj.flashscore_id_jogo = j.flashscore_id
        AND j.juiz_coletado = ${PENDENTE}
        AND aj.status IN ('ok', 'sem_arbitro', 'sem_bloco')`);
  if (rowCount) console.log(`[arbitro] ${rowCount} jogo(s) já raspados marcados na jogos`);
}

async function jogosPendentes(limite, excluir = []) {
  const { rows } = await client.query(
    `SELECT j.id, j.flashscore_id, j.link_estatisticas, j.data_jogo::text AS data_jogo,
            j.id_competicao, j.flashscore_id_competicao, j.flashscore_slug_liga,
            j.pais_liga, j.flashscore_slug_pais_liga, j.temporada::text AS temporada,
            j.rodada, j.id_time_casa, j.id_time_fora,
            j.flashscore_id_time_casa, j.flashscore_id_time_fora
       FROM jogos j
      WHERE j.juiz_coletado = ${PENDENTE}
        AND j.link_estatisticas IS NOT NULL
        AND j.placar_casa IS NOT NULL
        AND j.id <> ALL($2::bigint[])
      ORDER BY j.data_jogo DESC
      LIMIT $1`,
    [limite, excluir]);
  return rows;
}

async function obterOuCriarArbitro(nome, pais) {
  const { rows } = await client.query(
    `INSERT INTO arbitros (nome, pais) VALUES ($1, $2)
     ON CONFLICT (nome, pais) DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [nome, pais ?? '']);
  return rows[0].id;
}

// grava o resultado em arbitros_jogo e marca jogos.juiz_coletado
async function salvar(jogo, det, status, marca) {
  const idArbitro = det?.arbitro_nome
    ? await obterOuCriarArbitro(det.arbitro_nome, det.arbitro_pais)
    : null;

  const dados = {
    flashscore_id_jogo: jogo.flashscore_id,
    id_jogo: jogo.id,
    id_arbitro: idArbitro,
    status,
    tipo_competicao: REGIOES_INTERNACIONAIS.has(jogo.pais_liga) ? 'internacional' : 'nacional',
    data_jogo: jogo.data_jogo,
    id_competicao: jogo.id_competicao,
    flashscore_id_competicao: jogo.flashscore_id_competicao || null,
    flashscore_slug_liga: jogo.flashscore_slug_liga,
    pais_liga: jogo.pais_liga,
    flashscore_slug_pais_liga: jogo.flashscore_slug_pais_liga,
    temporada: jogo.temporada || null,
    rodada: jogo.rodada,
    id_time_casa: jogo.id_time_casa,
    id_time_fora: jogo.id_time_fora,
    flashscore_id_time_casa: jogo.flashscore_id_time_casa,
    flashscore_id_time_fora: jogo.flashscore_id_time_fora,
    estadio_nome: det?.estadio_nome ?? null,
    estadio_cidade: det?.estadio_cidade ?? null,
    capacidade: det?.capacidade ?? null,
    publico: det?.publico ?? null,
  };

  const cols = Object.keys(dados);
  const params = cols.map((_, i) => `$${i + 1}`);
  const updates = cols
    .filter((c) => c !== 'flashscore_id_jogo')
    .map((c) => `${c} = EXCLUDED.${c}`);

  await client.query(
    `INSERT INTO arbitros_jogo (${cols.join(', ')}) VALUES (${params.join(', ')})
     ON CONFLICT (flashscore_id_jogo) DO UPDATE SET
       ${updates.join(', ')},
       tentativas = arbitros_jogo.tentativas + 1,
       coletado_em = now()`,
    Object.values(dados));

  await client.query(`UPDATE jogos SET juiz_coletado = $1 WHERE id = $2`, [marca, jogo.id]);
}

// ---------------------------------------------------------------- coleta
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

let debugsSalvos = 0;
async function salvarDebug(page, id) {
  if (debugsSalvos >= MAX_DEBUG) return;
  debugsSalvos++;
  fs.mkdirSync('debug', { recursive: true });
  fs.writeFileSync(`debug/${id}.html`, await page.content());
}

// devolve { tipo: 'ok' | 'semDado', msg }; lança erro em falha de rede/HTTP (não marca o jogo)
async function processarJogo(page, jogo) {
  const resp = await page.goto(jogo.link_estatisticas, { waitUntil: 'domcontentloaded' });
  if (!resp || resp.status() >= 400) {
    throw new Error(`HTTP ${resp ? resp.status() : 'sem resposta'}`);
  }

  const temBloco = await page
    .waitForSelector(SELETOR, { state: 'attached', timeout: TIMEOUT_BLOCO_MS })
    .then(() => true, () => false);

  if (!temBloco) {
    await salvarDebug(page, jogo.flashscore_id);
    await salvar(jogo, null, 'sem_bloco', SEM_DADO);
    return { tipo: 'semDado', msg: 'sem bloco de detalhes -> marcado 2' };
  }

  const det = extrairDetalhesJogo(await page.content());
  if (det.arbitro_nome) {
    await salvar(jogo, det, 'ok', COLETADO);
    return { tipo: 'ok', msg: `${det.arbitro_nome} (${det.arbitro_pais ?? '?'}) -> marcado 1` };
  }
  await salvar(jogo, det, 'sem_arbitro', SEM_DADO);
  return { tipo: 'semDado', msg: 'sem árbitro -> marcado 2' };
}

async function coletarArbitros(pages, limite, excluir = []) {
  const jogos = await jogosPendentes(limite, excluir);
  const total = jogos.length;
  if (total === 0) return { total: 0, ok: 0, semDado: 0, erro: 0, idsComErro: [] };
  console.log(`[arbitro] lote de ${total} jogo(s), ${pages.length} aba(s) em paralelo`);
  const idsComErro = [];

  const cont = { ok: 0, semDado: 0, erro: 0 };
  const inicio = Date.now();
  let proximo = 0;

  async function worker(page) {
    for (;;) {
      const i = proximo++;
      if (i >= total) return;
      const jogo = jogos[i];
      const prefixo = `[${i + 1}/${total}] ${jogo.flashscore_id}`;
      const t0 = Date.now();
      try {
        const { tipo, msg } = await processarJogo(page, jogo);
        cont[tipo]++;
        console.log(`${prefixo} ${msg} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (err) {
        cont.erro++;
        idsComErro.push(jogo.id);
        console.error(`${prefixo} ERRO (não marcado, volta na próxima execução): ${err.message}`);
      }
      await dormir(PAUSA_MS);
    }
  }

  await Promise.all(pages.map(worker));

  const min = (Date.now() - inicio) / 60000;
  console.log(
    `[arbitro] fim: ${cont.ok} coletado(s), ${cont.semDado} sem dado, ${cont.erro} erro(s) ` +
    `em ${min.toFixed(1)} min (${(total / Math.max(min, 0.01)).toFixed(0)} jogos/min)`);
  return { total, ...cont, idsComErro };
}

// ---------------------------------------------------------------- main
async function main() {
  const limite = parseInt(process.argv[2], 10) || 200;

  await client.connect();
  await garantirTabelas();

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();

    // o bloco vem no DOM via JS; imagem, fonte, mídia e CSS não são necessários
    await context.route('**/*', (route) => {
      const tipo = route.request().resourceType();
      return ['image', 'font', 'media', 'stylesheet'].includes(tipo)
        ? route.abort()
        : route.continue();
    });

    const pages = await Promise.all(
      Array.from({ length: CONCURRENCIA }, () => context.newPage()));

    // repete em lotes até não sobrar jogo com juiz_coletado = 0.
    // Jogos que deram erro (não marcados) ficam de fora do resto desta execução
    // pra não entrar em loop infinito; voltam na próxima.
    const excluir = new Set();
    const totais = { ok: 0, semDado: 0, erro: 0 };
    const inicio = Date.now();

    for (let lote = 1; ; lote++) {
      const r = await coletarArbitros(pages, limite, [...excluir]);
      if (r.total === 0) break;

      totais.ok += r.ok;
      totais.semDado += r.semDado;
      totais.erro += r.erro;
      r.idsComErro.forEach((id) => excluir.add(id));

      // lote inteiro falhou: provável bloqueio ou queda de rede; para em vez de insistir
      if (r.erro === r.total) {
        console.error('[arbitro] todos os jogos do lote falharam; parando (bloqueio ou rede?)');
        break;
      }
    }

    const min = (Date.now() - inicio) / 60000;
    console.log(
      `[arbitro] FILA ENCERRADA: ${totais.ok} coletado(s), ${totais.semDado} sem dado, ` +
      `${totais.erro} erro(s) em ${min.toFixed(1)} min`);
  } finally {
    await browser.close();
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { extrairDetalhesJogo, coletarArbitros };