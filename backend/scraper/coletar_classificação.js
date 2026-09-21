// require('dotenv').config();
const { criarPool } = require('../../db');
const puppeteer = require('puppeteer');

// =========================================================
// CONFIG
// =========================================================

const TABELA_CLASSIFICACAO = 'classificacao_geral_2026';

// Se rodar com --all, atualiza todas as ligas de classificação.
// Sem --all, pega só temporadas_coletados = 0.
const ATUALIZAR_TODAS = process.argv.includes('--all');

// Para rodar headless: HEADLESS=true node script.js
const HEADLESS = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';

// =========================================================
// CONEXÃO POSTGRES
// =========================================================

const pool = criarPool('modelo', { 
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// =========================================================
// UTIL
// =========================================================

function sleep(min, max) {
  const ms = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function marcarComoColetado(client, idLinhaTemporaria, status = 10) {
  await client.query(
    `UPDATE competicoes_temporaria
     SET coletado = $2
     WHERE id = $1`,
    [idLinhaTemporaria, status]
  );
}
function toInt(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const ABAS_ALVO = [
  'CLASSIFICAÇÃO',
  'ACIMA/ABAIXO',
  'HT/FT',
  'ARTILHEIROS',
];

async function getCompeticoesParaClassificacao(client) {
  const filtroColetada = ATUALIZAR_TODAS ? '' : 'AND coletado = 1';
  const res = await client.query(`
    SELECT id, competicao_id, nome, pais, url, aba_url, aba_nome
    FROM competicoes_temporaria 
    WHERE aba_url IS NOT NULL AND UPPER(TRIM(aba_nome)) IN ('CLASSIFICAÇÃO', 'PRINCIPAL') ${filtroColetada} 
    ORDER BY competicao_id, CASE WHEN UPPER(TRIM(aba_nome)) = 'CLASSIFICAÇÃO' THEN 1 WHEN UPPER(TRIM(aba_nome)) = 'PRINCIPAL' THEN 2 ELSE 3 END, id
  `);

  const selecionadas = new Map();
  for (const row of res.rows) {
    const chave = String(row.competicao_id);
    if (!selecionadas.has(chave)) {
      selecionadas.set(chave, row);
      continue;
    }

    const atual = selecionadas.get(chave);
    const abaAtual = String(atual.aba_nome || '').trim().toUpperCase();
    const abaNova = String(row.aba_nome || '').trim().toUpperCase();

    // CLASSIFICAÇÃO sempre tem prioridade sobre PRINCIPAL
    if (abaAtual === 'PRINCIPAL' && abaNova === 'CLASSIFICAÇÃO') selecionadas.set(chave, row);
  }

  return Array.from(selecionadas.values());
}

async function getTimesByFlashscoreIds(client, flashscoreIds) {
  if (!flashscoreIds || flashscoreIds.length === 0) return {};

  // Remove nulos e duplicados
  const idsUnicos = [...new Set(flashscoreIds.filter(Boolean))];
  if (idsUnicos.length === 0) return {};

  // Monta a string de parâmetros ($1, $2, $3...)
  const placeholders = idsUnicos.map((_, i) => `$${i + 1}`).join(',');

  const res = await client.query(
    `
      SELECT id, nome, flashscore_id 
      FROM times 
      WHERE flashscore_id IN (${placeholders})
    `,
    idsUnicos
  );

  // Cria um mapa/dicionário para acesso instantâneo na memória
  const mapaTimes = {};
  for (const row of res.rows) {
    mapaTimes[row.flashscore_id] = row;
  }

  return mapaTimes;
}

async function upsertClassificacao(client, data) {
  const jogos = toInt(data.jogos, 0);
  const pontos = toInt(data.pontos, 0);
  const saldo = toInt(data.saldo_gols, 0);
  const golsPro = toInt(data.gols_pro, 0);
  const golsContra = toInt(data.gols_contra, 0);

  const pontosPorJogo = jogos > 0 ? +(pontos / jogos).toFixed(3) : 0;
  const saldoPorJogo = jogos > 0 ? +(saldo / jogos).toFixed(3) : 0;
  const golsProPorJogo = jogos > 0 ? +(golsPro / jogos).toFixed(3) : 0;
  const golsContraPorJogo = jogos > 0 ? +(golsContra / jogos).toFixed(3) : 0;

  const query = `
    INSERT INTO ${TABELA_CLASSIFICACAO} (
      id_competicao,
      id_time,

      flashscore_id_time,
      flashscore_slug_times,

      nome_time,
      classificacao_tipo,

      posicao_final,

      jogos,
      vitorias,
      empates,
      derrotas,

      gols_pro,
      gols_contra,
      saldo_gols,

      pontos,

      pontos_por_jogo,
      saldo_por_jogo,
      gols_pro_por_jogo,
      gols_contra_por_jogo,

      pais,
      nome_competicao,
      url_temporada,

      flashscore_id_temporada,
      temporada
    )
    VALUES (
      $1,$2,
      $3,$4,
      $5,$6,
      $7,
      $8,$9,$10,$11,
      $12,$13,$14,
      $15,
      $16,$17,$18,$19,
      $20,$21,$22,
      $23,$24
    )
     ON CONFLICT (id_time, id_competicao, classificacao_tipo)
     DO UPDATE SET
      flashscore_id_temporada = EXCLUDED.flashscore_id_temporada,

      posicao_final = EXCLUDED.posicao_final,
      jogos = EXCLUDED.jogos,
      pontos = EXCLUDED.pontos,
      vitorias = EXCLUDED.vitorias,
      empates = EXCLUDED.empates,
      derrotas = EXCLUDED.derrotas,

      gols_pro = EXCLUDED.gols_pro,
      gols_contra = EXCLUDED.gols_contra,
      saldo_gols = EXCLUDED.saldo_gols,

      pontos_por_jogo = EXCLUDED.pontos_por_jogo,
      saldo_por_jogo = EXCLUDED.saldo_por_jogo,
      gols_pro_por_jogo = EXCLUDED.gols_pro_por_jogo,
      gols_contra_por_jogo = EXCLUDED.gols_contra_por_jogo,

      classificacao_tipo = EXCLUDED.classificacao_tipo,
      pais = EXCLUDED.pais,
      nome_competicao = EXCLUDED.nome_competicao,
      nome_time = EXCLUDED.nome_time,

      url_temporada = EXCLUDED.url_temporada,
      flashscore_slug_times = EXCLUDED.flashscore_slug_times,
      flashscore_id_time = EXCLUDED.flashscore_id_time;
  `;

  const params = [
    data.id_competicao,
    data.id_time,

    data.flashscore_id_time,
    data.flashscore_slug_times,

    data.nome_time,
    data.classificacao_tipo,

    data.posicao_final,

    jogos,
    data.vitorias,
    data.empates,
    data.derrotas,

    golsPro,
    golsContra,
    saldo,

    pontos,

    pontosPorJogo,
    saldoPorJogo,
    golsProPorJogo,
    golsContraPorJogo,

    data.pais,
    data.nome_competicao,
    data.url_temporada,

    data.flashscore_id_temporada,
    data.temporada
  ];

  await client.query(query, params);
}
async function upsertHtFt(client, data) {

  const query = `
    INSERT INTO classificacao_ht_ft_2026 (

      id_competicao,
      id_time,

      flashscore_id_time,
      flashscore_slug_times,
      flashscore_id_temporada,

      nome_time,
      nome_competicao,
      pais,
      temporada,
      url_temporada,

      classificacao_tipo,

      posicao_final,
      jogos,

      v_v,
      v_e,
      v_d,

      e_v,
      e_e,
      e_d,

      d_v,
      d_e,
      d_d,

      pontos

    )
    VALUES (

      $1,$2,

      $3,$4,$5,

      $6,$7,$8,$9,$10,

      $11,

      $12,$13,

      $14,$15,$16,

      $17,$18,$19,

      $20,$21,$22,

      $23

    )

    ON CONFLICT (id_time, id_competicao, classificacao_tipo)

    DO UPDATE SET

      flashscore_id_time = EXCLUDED.flashscore_id_time,
      flashscore_slug_times = EXCLUDED.flashscore_slug_times,
      flashscore_id_temporada = EXCLUDED.flashscore_id_temporada,

      nome_time = EXCLUDED.nome_time,
      nome_competicao = EXCLUDED.nome_competicao,
      pais = EXCLUDED.pais,
      temporada = EXCLUDED.temporada,
      url_temporada = EXCLUDED.url_temporada,

      posicao_final = EXCLUDED.posicao_final,
      jogos = EXCLUDED.jogos,

      v_v = EXCLUDED.v_v,
      v_e = EXCLUDED.v_e,
      v_d = EXCLUDED.v_d,

      e_v = EXCLUDED.e_v,
      e_e = EXCLUDED.e_e,
      e_d = EXCLUDED.e_d,

      d_v = EXCLUDED.d_v,
      d_e = EXCLUDED.d_e,
      d_d = EXCLUDED.d_d,

      pontos = EXCLUDED.pontos,

      atualizado_em = CURRENT_TIMESTAMP;
  `;

  const params = [

    data.id_competicao,
    data.id_time,

    data.flashscore_id_time,
    data.flashscore_slug_times,
    data.flashscore_id_temporada,

    data.nome_time,
    data.nome_competicao,
    data.pais,
    data.temporada,
    data.url_temporada,

    data.classificacao_tipo,

    toInt(data.posicao_final),
    toInt(data.jogos),

    toInt(data.v_v),
    toInt(data.v_e),
    toInt(data.v_d),

    toInt(data.e_v),
    toInt(data.e_e),
    toInt(data.e_d),

    toInt(data.d_v),
    toInt(data.d_e),
    toInt(data.d_d),

    toInt(data.pontos)

  ];

  await client.query(query, params);

}
async function upsertArtilheiros(client, data) {
  const query = `
    INSERT INTO classificacao_artilheiros_2026 (
      id_competicao,
      id_time,

      flashscore_id_jogador,
      flashscore_id_time,
      flashscore_id_temporada,

      nome_jogador,
      nome_time,
      nome_competicao,
      pais,
      temporada,
      url_temporada,

      posicao,
      gols,
      assistencias
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
    )
    ON CONFLICT (nome_jogador, id_time, id_competicao)
    DO UPDATE SET
      flashscore_id_jogador = EXCLUDED.flashscore_id_jogador,
      flashscore_id_time = EXCLUDED.flashscore_id_time,
      flashscore_id_temporada = EXCLUDED.flashscore_id_temporada,
      
      nome_time = EXCLUDED.nome_time,
      nome_competicao = EXCLUDED.nome_competicao,
      pais = EXCLUDED.pais,
      temporada = EXCLUDED.temporada,
      url_temporada = EXCLUDED.url_temporada,
      
      posicao = EXCLUDED.posicao,
      gols = EXCLUDED.gols,
      assistencias = EXCLUDED.assistencias,
      
      atualizado_em = CURRENT_TIMESTAMP;
  `;

  const params = [
    data.id_competicao,
    data.id_time,

    data.flashscore_id_jogador,
    data.flashscore_id_time,
    data.flashscore_id_temporada,

    data.nome_jogador,
    data.nome_time,
    data.nome_competicao,
    data.pais,
    data.temporada,
    data.url_temporada,

    toInt(data.posicao),
    toInt(data.gols),
    toInt(data.assistencias)
  ];

  await client.query(query, params);
}

// =========================================================
// SCRAPER
// =========================================================

async function rasparClassificacao(page, baseUrl) {

  async function rasparTabela(urlParaAbrir, tipoClassificacao) {

    await page.goto(urlParaAbrir, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForSelector('.ui-table__row', { timeout: 15000 });

    const flashscoreIdTemporada = await page.evaluate(() => {
      return window.leaguePageHeaderData?.tournamentId || null;
    });

    const timesData = await page.evaluate(() => {

      const rows = Array.from(document.querySelectorAll('.ui-table__row'));
      const data = [];

      function parseIntSafeInner(v, fallback = 0) {
        const n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10);
        return Number.isFinite(n) ? n : fallback;
      }

      rows.forEach((row) => {

        const posEl = row.querySelector('.tableCellRank');

        const nameEl =
          row.querySelector('.tableCellParticipant__name') ||
          row.querySelector('[class*="Participant"]');

        const linkEl =
          row.querySelector('a[href*="/time/"]') ||
          row.querySelector('a.tableCellParticipant__name') ||
          nameEl;

        const statsEls = Array.from(row.querySelectorAll('.table__cell--value'));

        if (!posEl || !nameEl || statsEls.length < 7) return;

        const stats = statsEls.map(el => (el.textContent || '').trim());

        const jogos = parseIntSafeInner(stats[0]);
        const vitorias = parseIntSafeInner(stats[1]);
        const empates = parseIntSafeInner(stats[2]);
        const derrotas = parseIntSafeInner(stats[3]);

        const golsScore = stats[4] || '';

        let golsPro = 0;
        let golsContra = 0;

        if (golsScore.includes(':')) {
          const [pro, contra] = golsScore.split(':');
          golsPro = parseIntSafeInner(pro);
          golsContra = parseIntSafeInner(contra);
        }

        const saldoGols = parseIntSafeInner(stats[5]);
        const pontos = parseIntSafeInner(stats[6]);

        const href = linkEl?.getAttribute?.('href') || '';
        const hrefParts = href.split('/').filter(Boolean);

        const flashscoreIdTime = hrefParts.pop() || null;
        const flashscoreSlug = hrefParts.pop() || null;

        data.push({
          flashscore_id_time: flashscoreIdTime,
          flashscore_slug: flashscoreSlug,
          nome: (nameEl.textContent || '').trim(),
          posicao_final: parseIntSafeInner((posEl.textContent || '').replace('.', '')),
          jogos,
          vitorias,
          empates,
          derrotas,
          gols_pro: golsPro,
          gols_contra: golsContra,
          saldo_gols: saldoGols,
          pontos,
        });

      });

      return data;

    });

    return {
      flashscoreIdTemporada,
      tipoClassificacao,
      timesData,
      urlLida: page.url(),
    };

  }

  const urlGeral = `${baseUrl}/classificacoes/geral/`;
  const urlCasa = `${baseUrl}/classificacoes/casa/`;
  const urlFora = `${baseUrl}/classificacoes/fora/`;

  const geral = await rasparTabela(urlGeral, 'GERAL');
  const casa = await rasparTabela(urlCasa, 'CASA');
  const fora = await rasparTabela(urlFora, 'FORA');

  return {
    flashscoreIdTemporada:
      geral.flashscoreIdTemporada ||
      casa.flashscoreIdTemporada ||
      fora.flashscoreIdTemporada,

    tabelas: [
      geral,
      casa,
      fora
    ]
  };

}
async function rasparHtFt(page, baseUrl) {

  async function rasparTabela(urlParaAbrir, tipoClassificacao) {

    await page.goto(urlParaAbrir, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    await page.waitForSelector('.ui-table__row', { timeout: 15000 });

    const flashscoreIdTemporada = await page.evaluate(() => {
      return window.leaguePageHeaderData?.tournamentId || null;
    });

    const timesData = await page.evaluate(() => {

      const rows = Array.from(document.querySelectorAll('.ui-table__row'));
      const data = [];

      function parseIntSafe(v, fallback = 0) {
        const n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10);
        return Number.isFinite(n) ? n : fallback;
      }

      rows.forEach(row => {

        const posEl = row.querySelector('.tableCellRank');

        const nameEl =
          row.querySelector('.tableCellParticipant__name') ||
          row.querySelector('[class*="Participant"]');

        const linkEl =
          row.querySelector('a[href*="/equipe/"]') ||
          row.querySelector('a[href*="/time/"]') ||
          row.querySelector('a.tableCellParticipant__name');

        const statsEls = Array.from(
          row.querySelectorAll('.table__cell--value')
        );

        if (!posEl || !nameEl || statsEls.length < 11) return;

        const stats = statsEls.map(el => (el.textContent || '').trim());

        const href = linkEl?.getAttribute('href') || '';
        const hrefParts = href.split('/').filter(Boolean);

        const flashscoreIdTime = hrefParts.pop() || null;
        const flashscoreSlug = hrefParts.pop() || null;

        data.push({
          flashscore_id_time: flashscoreIdTime,
          flashscore_slug: flashscoreSlug,

          nome: (nameEl.textContent || '').trim(),

          posicao_final: parseIntSafe(
            (posEl.textContent || '').replace('.', '')
          ),

          jogos: parseIntSafe(stats[0]),

          v_v: parseIntSafe(stats[1]),
          v_e: parseIntSafe(stats[2]),
          v_d: parseIntSafe(stats[3]),

          e_v: parseIntSafe(stats[4]),
          e_e: parseIntSafe(stats[5]),
          e_d: parseIntSafe(stats[6]),

          d_v: parseIntSafe(stats[7]),
          d_e: parseIntSafe(stats[8]),
          d_d: parseIntSafe(stats[9]),

          pontos: parseIntSafe(stats[10]),
        });
      });

      return data;
    });

    return {
      flashscoreIdTemporada,
      tipoClassificacao,
      timesData,
      urlLida: page.url(),
    };
  }

  // Define as 3 URLs alvo
  const urlGeral = `${baseUrl}/ht_ft/geral/`;
  const urlCasa = `${baseUrl}/ht_ft/casa/`;
  const urlFora = `${baseUrl}/ht_ft/fora/`;

  // Faz a raspagem das 3 tabelas
  const geral = await rasparTabela(urlGeral, 'GERAL');
  const casa = await rasparTabela(urlCasa, 'CASA');
  const fora = await rasparTabela(urlFora, 'FORA');

  // Retorna todas no mesmo formato que a classificação padrão
  return {
    flashscoreIdTemporada:
      geral.flashscoreIdTemporada ||
      casa.flashscoreIdTemporada ||
      fora.flashscoreIdTemporada,

    tabelas: [
      geral,
      casa,
      fora
    ]
  };
}
async function coletarClassificacao(browser, urlFinal) {
  const page = await browser.newPage();

  // Otimização: bloqueia imagens, CSS e fontes para carregar mais rápido
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      request.abort();
    } else {
      request.continue();
    }
  });

  // Disfarce básico do Puppeteer
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  await page.setViewport({ width: 1366, height: 768 });

  try {
    const baseUrl = urlFinal.replace(
      /\/classificacoes\/(geral|casa|fora)\/?$/i,
      ''
    );

    // 1. CLASSIFICAÇÃO (Geral / Casa / Fora)
    const classificacao = await rasparClassificacao(page, baseUrl);

    // 2. HT / FT
    const htft = await rasparHtFt(page, baseUrl);

    // 3. ARTILHEIROS
    const artilheiros = await rasparArtilheiros(page, baseUrl);

    return {
      classificacao,
      htft,
      artilheiros
    };

  } finally {
    // Garante que a aba será fechada mesmo se der erro
    await page.close();
  }
}
async function rasparArtilheiros(page, baseUrl) {
  const urlParaAbrir = `${baseUrl}/artilheiros/`;

  await page.goto(urlParaAbrir, {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });

  // Tenta aguardar a tabela de artilheiros carregar.
  // Colocamos num try/catch porque nem toda competição tem artilheiros.
  try {
    await page.waitForSelector('.ui-table__row', { timeout: 10000 });
  } catch (error) {
    console.log(`ℹ️ Nenhuma tabela de artilheiros encontrada em: ${urlParaAbrir}`);
    return { timesData: [] };
  }

  const flashscoreIdTemporada = await page.evaluate(() => {
    return window.leaguePageHeaderData?.tournamentId || null;
  });

  const timesData = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.ui-table__row.topScorers__row'));
    const data = [];

    function parseIntSafe(v, fallback = 0) {
      const n = parseInt(String(v || '').replace(/[^\d-]/g, ''), 10);
      return Number.isFinite(n) ? n : fallback;
    }

    rows.forEach(row => {
      const posEl = row.querySelector('.topScorers__cell--rank');
      const playerLink = row.querySelector('a[href*="/jogador/"]');
      const teamLink = row.querySelector('a[href*="/equipe/"]');
      const goalsEl = row.querySelector('.topScorers__cell--goals');
      // A classe grey costuma guardar a assistência
      const assistEl = row.querySelector('.topScorers__cell--gray');

      if (!playerLink) return;

      // Tratamento ID Jogador
      const playerHref = playerLink.getAttribute('href') || '';
      const playerHrefParts = playerHref.split('/').filter(Boolean);
      const flashscoreIdJogador = playerHrefParts.pop() || null;

      // Tratamento Nome Jogador (O textContent já ignora tags filhas vazias como a bandeira)
      const nomeJogador = (playerLink.textContent || '').trim();

      // Tratamento ID Time
      let flashscoreIdTime = null;
      if (teamLink) {
        const teamHref = teamLink.getAttribute('href') || '';
        const teamHrefParts = teamHref.split('/').filter(Boolean);
        flashscoreIdTime = teamHrefParts.pop() || null;
      }

      data.push({
        posicao: posEl ? parseIntSafe(posEl.textContent) : 0,
        flashscore_id_jogador: flashscoreIdJogador,
        nome_jogador: nomeJogador,
        flashscore_id_time: flashscoreIdTime,
        gols: goalsEl ? parseIntSafe(goalsEl.textContent) : 0,
        assistencias: assistEl ? parseIntSafe(assistEl.textContent) : 0
      });
    });

    return data;
  });

  return {
    flashscoreIdTemporada,
    timesData,
    urlLida: page.url(),
  };
}


async function main() {
  console.log(`🚀 Iniciando Scraper de Classificação em PostgreSQL...`);
  console.log(`📦 Tabela alvo: ${TABELA_CLASSIFICACAO}`);
  console.log(`🔁 Modo: ${ATUALIZAR_TODAS ? 'atualizar todas (--all)' : 'somente pendentes (coletado = 1)'}`);

  const client = await pool.connect();
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const competicoes = await getCompeticoesParaClassificacao(client);
    console.log(`📋 Registros pendentes encontrados no banco: ${competicoes.length}`);

    const urlsProcessadas = new Set();

    for (const competicao of competicoes) {
      // Este scraper aqui só processa a aba CLASSIFICAÇÃO
      const abaNome = String(competicao.aba_nome || '').trim().toUpperCase();

      if (abaNome !== 'CLASSIFICAÇÃO' && abaNome !== 'PRINCIPAL') {
        continue;
      }

      const urlFinal = competicao.aba_url;

      if (!urlFinal) {
        console.warn(`⚠️ Aba sem URL.`);
        await marcarComoColetado(client, competicao.id, 2);
        continue;
      }

      if (urlsProcessadas.has(urlFinal)) {
        console.log(`⏭️ Ignorando URL duplicada nesta sessão: ${competicao.nome} | ${competicao.aba_nome}`);
        continue;
      }

      console.log(`\n📡 ${competicao.nome} | ${competicao.aba_nome}`);
      console.log(`🔗 URL base: ${urlFinal}`);

      let sucesso = false;
      let tentativa = 1;

      while (tentativa <= 3 && !sucesso) {
        try {
          const resultado = await coletarClassificacao(browser, urlFinal);

          const { classificacao, htft, artilheiros } = resultado;

          // Verifica se pelo menos UMA das tabelas retornou dados para prosseguir
          if (
            (!classificacao || !classificacao.tabelas?.length) &&
            (!htft || !htft.tabelas?.length) &&
            (!artilheiros || !artilheiros.timesData?.length)
          ) {
            throw new Error('Nenhuma tabela retornada pelo scraper.');
          }

          let salvos = 0;
          let semVinculo = 0;

          await client.query('BEGIN');

          try {
            // =========================================================
            // 1. SALVAR CLASSIFICAÇÃO (Geral, Casa, Fora)
            // =========================================================
            for (const tabela of classificacao?.tabelas || []) {
              if (!tabela || !tabela.timesData || tabela.timesData.length === 0) {
                continue;
              }

              const idsDaTabela = [...new Set(
                tabela.timesData
                  .map(t => t.flashscore_id_time)
                  .filter(Boolean)
              )];

              const mapaTimesDb = await getTimesByFlashscoreIds(client, idsDaTabela);

              for (const time of tabela.timesData) {
                const dbTime = mapaTimesDb[time.flashscore_id_time];

                if (!dbTime) {
                  semVinculo++;
                  continue;
                }

                await upsertClassificacao(client, {
                  ...time,
                  id_time: dbTime.id,
                  id_competicao: competicao.competicao_id,
                  flashscore_id_temporada: classificacao.flashscoreIdTemporada,
                  temporada: competicao.temporada,
                  pais: competicao.pais,
                  nome_competicao: competicao.nome,
                  classificacao_tipo: tabela.tipoClassificacao,
                  url_temporada: urlFinal,
                  nome_time: dbTime.nome,
                  flashscore_slug_times: time.flashscore_slug,
                  flashscore_id_time: time.flashscore_id_time,
                });

                salvos++;
              }
            }

            // =========================================================
            // 2. SALVAR HT/FT (Geral, Casa, Fora)
            // =========================================================
            for (const tabela of htft?.tabelas || []) {
              if (!tabela || !tabela.timesData || !tabela.timesData.length) continue;

              const idsDaTabela = [...new Set(
                tabela.timesData
                  .map(t => t.flashscore_id_time)
                  .filter(Boolean)
              )];

              const mapaTimesDb = await getTimesByFlashscoreIds(client, idsDaTabela);

              for (const time of tabela.timesData) {
                const dbTime = mapaTimesDb[time.flashscore_id_time];

                if (!dbTime) {
                  semVinculo++;
                  continue;
                }

                await upsertHtFt(client, {
                  ...time,
                  id_time: dbTime.id,
                  id_competicao: competicao.competicao_id,
                  flashscore_id_temporada: htft.flashscoreIdTemporada,
                  temporada: competicao.temporada,
                  pais: competicao.pais,
                  nome_competicao: competicao.nome,
                  classificacao_tipo: tabela.tipoClassificacao,
                  url_temporada: tabela.urlLida,
                  nome_time: dbTime.nome,
                  flashscore_slug_times: time.flashscore_slug,
                  flashscore_id_time: time.flashscore_id_time
                });

                salvos++;
              }
            }

            // =========================================================
            // 3. SALVAR ARTILHEIROS
            // =========================================================
            if (artilheiros?.timesData && artilheiros.timesData.length > 0) {
              const idsDaTabela = [...new Set(
                artilheiros.timesData
                  .map(t => t.flashscore_id_time)
                  .filter(Boolean)
              )];

              const mapaTimesDb = await getTimesByFlashscoreIds(client, idsDaTabela);

              for (const jogador of artilheiros.timesData) {
                const dbTime = mapaTimesDb[jogador.flashscore_id_time];

                if (!dbTime) {
                  semVinculo++;
                  continue;
                }

                await upsertArtilheiros(client, {
                  ...jogador,
                  id_time: dbTime.id,
                  id_competicao: competicao.competicao_id,
                  flashscore_id_temporada: artilheiros.flashscoreIdTemporada,
                  temporada: competicao.temporada,
                  pais: competicao.pais,
                  nome_competicao: competicao.nome,
                  url_temporada: artilheiros.urlLida,
                  nome_time: dbTime.nome
                });

                salvos++;
              }
            }

            await client.query('COMMIT');

            // Marca somente após salvar tudo
            await marcarComoColetado(client, competicao.id, 10);

          } catch (e) {
            await client.query('ROLLBACK');
            throw e;
          }

          console.log(
            `✅ ${competicao.nome}: ${salvos} registros salvos${semVinculo > 0 ? ` (${semVinculo} sem vínculo)` : ''}`
          );

          sucesso = true;
          urlsProcessadas.add(urlFinal);

        } catch (err) {
          console.warn(`⚠️ Erro tentativa ${tentativa}: ${err.message}`);

          tentativa++;

          if (tentativa <= 3) {
            await sleep(2, 4);
          }
        }
      }

      if (!sucesso) {
        console.log(`❌ Marcando como erro: ${competicao.nome}`);
        await marcarComoColetado(client, competicao.id, 2);
      }

      await sleep(1, 2);
    }

  } finally {
    if (browser) {
      await browser.close();
    }

    client.release();
    await pool.end();

    console.log('\n🏁 Processo Finalizado.');
  }
}

main().catch((err) => {
  console.error('❌ ERRO FATAL:', err);
  process.exit(1);
});
