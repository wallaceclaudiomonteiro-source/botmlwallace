/**
 * Coleta o árbitro (nome + país) de cada jogo da tabela `jogos`
 * abrindo o link_estatisticas no Flashscore.
 *
 * Uso:   node coletar-arbitros.js [limite]      (padrão: 200 jogos por execução)
 * Deps:  npm i pg playwright cheerio && npx playwright install chromium
 */
const { Client } = require('pg');
const { chromium } = require('playwright');
const cheerio = require('cheerio');

// ---------------------------------------------------------------- conexão
const client = new Client({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol',
});
client.on('error', (err) => console.error('[pg] conexão caiu:', err.message));

// ---------------------------------------------------------------- config
const SELETOR = '[data-testid="wcl-summaryMatchInformation"]';
const MAX_TENTATIVAS = 3;
const PAUSA_MS = 1500;

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
}

async function jogosPendentes(limite) {
  const { rows } = await client.query(
    `SELECT j.id, j.flashscore_id, j.link_estatisticas, j.data_jogo::text AS data_jogo,
            j.id_competicao, j.flashscore_id_competicao, j.flashscore_slug_liga,
            j.pais_liga, j.flashscore_slug_pais_liga, j.temporada::text AS temporada,
            j.rodada, j.id_time_casa, j.id_time_fora,
            j.flashscore_id_time_casa, j.flashscore_id_time_fora
       FROM jogos j
       LEFT JOIN arbitros_jogo aj ON aj.flashscore_id_jogo = j.flashscore_id
      WHERE j.link_estatisticas IS NOT NULL
        AND j.placar_casa IS NOT NULL
        AND (aj.flashscore_id_jogo IS NULL
             OR (aj.status = 'erro' AND aj.tentativas < $2))
      ORDER BY j.data_jogo DESC
      LIMIT $1`,
    [limite, MAX_TENTATIVAS]);
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

async function salvar(jogo, det, status) {
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
}

// ---------------------------------------------------------------- coleta
async function coletarArbitros(page, limite) {
  const jogos = await jogosPendentes(limite);
  console.log(`[arbitro] ${jogos.length} jogo(s) pendente(s)`);

  let ok = 0, semArbitro = 0, erros = 0;

  for (const [i, jogo] of jogos.entries()) {
    try {
      await page.goto(jogo.link_estatisticas, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(SELETOR, { timeout: 15000 });

      const det = extrairDetalhesJogo(await page.content());
      const status = det.arbitro_nome ? 'ok' : 'sem_arbitro';
      await salvar(jogo, det, status);

      if (status === 'ok') ok++; else semArbitro++;
      console.log(
        `[${i + 1}/${jogos.length}] ${jogo.flashscore_id} -> ` +
        (det.arbitro_nome ? `${det.arbitro_nome} (${det.arbitro_pais ?? '?'})` : 'sem árbitro'));
    } catch (err) {
      erros++;
      console.error(`[${i + 1}/${jogos.length}] ${jogo.flashscore_id} ERRO: ${err.message}`);
      await salvar(jogo, null, 'erro').catch((e) =>
        console.error(`  falha ao registrar erro: ${e.message}`));
    }
    await new Promise((r) => setTimeout(r, PAUSA_MS));
  }

  console.log(`[arbitro] fim: ${ok} ok, ${semArbitro} sem árbitro, ${erros} erro(s)`);
}

// ---------------------------------------------------------------- main
async function main() {
  const limite = parseInt(process.argv[2], 10) || 200;

  await client.connect();
  await garantirTabelas();

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    // não precisa de imagem/fonte/mídia: acelera bastante
    await page.route('**/*', (route) => {
      const tipo = route.request().resourceType();
      return ['image', 'font', 'media'].includes(tipo) ? route.abort() : route.continue();
    });

    await coletarArbitros(page, limite);
  } finally {
    await browser.close();
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { extrairDetalhesJogo, coletarArbitros };