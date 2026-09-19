import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';
import { chromium } from 'playwright';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ======================================================
// ENV
// ======================================================
const envCandidates = [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../.env'),
  path.resolve(process.cwd(), '.env'),
];

let envLoadedFrom = null;

for (const candidate of envCandidates) {
  const result = dotenv.config({ path: candidate });
  if (!result.error) {
    envLoadedFrom = candidate;
    break;
  }
}

if (envLoadedFrom) {
  console.log(`✅ .env carregado de: ${envLoadedFrom}`);
} else {
  console.warn('⚠️ .env não encontrado nos caminhos esperados.');
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Variável de ambiente ausente: ${name}`);
  }
  return value.trim();
}

// ======================================================
// CONFIG BANCO
// ======================================================
const pool = new Pool({
  host: requireEnv('PGHOST'),
  port: Number(process.env.PGPORT || 5432),
  user: requireEnv('PGUSER'),
  password: requireEnv('PGPASSWORD'),
  database: requireEnv('PGDATABASE'),
});

console.log('✅ Configuração PG carregada');
console.log({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  database: process.env.PGDATABASE,
  hasPassword:
    typeof process.env.PGPASSWORD === 'string' &&
    process.env.PGPASSWORD.length > 0,
});

// ======================================================
// PARAMETROS
// ======================================================
const HEADLESS = String(process.env.ODD_HEADLESS || 'false').toLowerCase() === 'true';
const PAGE_TIMEOUT_MS = Number(process.env.ODD_PAGE_TIMEOUT_MS || 45000);
const WAIT_AFTER_GOTO_MS = Number(process.env.ODD_WAIT_AFTER_GOTO_MS || 2500);

const MARKET_BATCH_SIZE = Number(process.env.ODD_MARKET_BATCH_SIZE || 3);
const WAIT_BETWEEN_BATCHES_MS = Number(process.env.ODD_WAIT_BETWEEN_BATCHES_MS || 1200);

const USE_SYSTEM_CHROME = String(process.env.ODD_USE_SYSTEM_CHROME || 'true').toLowerCase() === 'true';
const GUEST_MODE = String(process.env.ODD_GUEST_MODE || 'true').toLowerCase() === 'true';
const CHROME_EXECUTABLE_PATH = (process.env.ODD_CHROME_EXECUTABLE_PATH || '').trim();

const EXECUCAO_ID =
  process.env.ODD_EXECUCAO_ID ||
  `odd_exec_${new Date().toISOString().replace(/[:.]/g, '-')}`;

// ======================================================
// MERCADOS
// ======================================================
const MERCADOS = [
  { mercado_codigo: '1x2', mercado_nome: '1X2', slug_flashscore: '1x2-odds' },
  { mercado_codigo: 'over_under', mercado_nome: 'Acima/Abaixo', slug_flashscore: 'acima-abaixo' },
  { mercado_codigo: 'asian_handicap', mercado_nome: 'Handicap Asiático', slug_flashscore: 'handicap-asiatico' },
  { mercado_codigo: 'btts', mercado_nome: 'Ambos Marcam', slug_flashscore: 'ambos-marcam' },
  { mercado_codigo: 'double_chance', mercado_nome: 'Double Chance', slug_flashscore: 'double-chance' },
  { mercado_codigo: 'european_handicap', mercado_nome: 'European Handicap', slug_flashscore: 'european-handicap' },
  { mercado_codigo: 'draw_no_bet', mercado_nome: 'Draw No Bet', slug_flashscore: 'draw-no-bet' },
  { mercado_codigo: 'correct_score', mercado_nome: 'Correct Score', slug_flashscore: 'correct-score' },
  { mercado_codigo: 'ht_ft', mercado_nome: 'HT/FT', slug_flashscore: 'ht-ft' },
];

// ======================================================
// SQL
// ======================================================
const SQL_LOCK_PROXIMO_JOGO = `
  UPDATE analises_jogos
  SET odd_coletada = 4
  WHERE id = (
    SELECT a.id
    FROM analises_jogos a
    WHERE COALESCE(a.odd_coletada, 0) = 0
      AND a.url IS NOT NULL
      AND TRIM(a.url) <> ''
    ORDER BY a.data_jogo ASC, a.hora_jogo NULLS LAST, a.id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING
    id,
    flashscore_id_jogo AS flashscore_id,
    data_jogo::date AS data_jogo,
    hora_jogo,
    flashscore_slug_liga,
    url AS url_base_flashscore,
    time_casa AS mandante_nome,
    time_fora AS visitante_nome,
    id_time_casa,
    id_time_fora,
    flashscore_id_casa,
    flashscore_id_fora
`;

const SQL_MARCAR_SUCESSO = `
  UPDATE analises_jogos
  SET odd_coletada = 1
  WHERE id = $1
`;

const SQL_MARCAR_FALHA = `
  UPDATE analises_jogos
  SET odd_coletada = 2
  WHERE id = $1
`;

const SQL_BUSCAR_ODD_ATIVA_IGUAL = `
  SELECT id
  FROM odds_linha_tempo
  WHERE id_bookmaker = $1
    AND bookmaker_match_id = $2
    AND contexto_coleta = 'pre_live'
    AND mercado_codigo = $3
    AND periodo_codigo = 'tempo_regular'
    AND COALESCE(linha_principal, -99999.99) = COALESCE($4, -99999.99)
    AND selecao_codigo = $5
    AND odd = $6
    AND ativo = TRUE
  LIMIT 1
`;

const SQL_CONFIRMAR_ODD_ATIVA_IGUAL = `
  UPDATE odds_linha_tempo
  SET ultima_captura_em = NOW(),
      n_confirmacoes = n_confirmacoes + 1,
      atualizado_em = NOW()
  WHERE id = $1
`;

const SQL_FECHAR_ODD_ATIVA_DIFERENTE = `
  UPDATE odds_linha_tempo
  SET fim_em = NOW(),
      ativo = FALSE,
      status_saida = 'alterada',
      atualizado_em = NOW()
  WHERE id_bookmaker = $1
    AND bookmaker_match_id = $2
    AND contexto_coleta = 'pre_live'
    AND mercado_codigo = $3
    AND periodo_codigo = 'tempo_regular'
    AND COALESCE(linha_principal, -99999.99) = COALESCE($4, -99999.99)
    AND selecao_codigo = $5
    AND ativo = TRUE
`;

const SQL_INSERIR_ODD = `
  INSERT INTO odds_linha_tempo (
    id_bookmaker,
    bookmaker_nome,
    bookmaker_match_id,
    flashscore_id_jogo,
    esporte,
    contexto_coleta,
    competicao_slug_snapshot,
    mandante_nome_snapshot,
    visitante_nome_snapshot,
    id_time_casa,
    id_time_fora,
    flashscore_id_casa,
    flashscore_id_fora,
    data_jogo,
    hora_jogo,
    mercado_codigo,
    mercado_nome,
    periodo_codigo,
    periodo_nome,
    linha_principal,
    selecao_codigo,
    selecao_nome,
    selecao_ordem,
    odd,
    origem_coleta,
    origem_detalhe,
    source_url,
    execucao_id,
    extra_json
  )
  VALUES (
    $1,
    $2,
    $3,
    $4,
    'futebol',
    'pre_live',
    $5,
    $6,
    $7,
    $8,
    $9,
    $10,
    $11,
    $12,
    $13,
    $14,
    $15,
    'tempo_regular',
    'Tempo Regulamentar',
    $16,
    $17,
    $18,
    $19,
    $20,
    'scraper',
    'flashscore_playwright',
    $21,
    $22,
    $23
  )
  RETURNING id
`;

const SQL_ATUALIZAR_MELHORES_ODDS_ANALISES_JOGOS = `
  WITH melhores AS (
    SELECT
      o.flashscore_id_jogo,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = '1x2'
          AND o.selecao_codigo = 'home'
      ) AS odd_mercado_casa,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = '1x2'
          AND o.selecao_codigo = 'draw'
      ) AS odd_mercado_empate,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = '1x2'
          AND o.selecao_codigo = 'away'
      ) AS odd_mercado_fora,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'over_under'
          AND o.selecao_codigo = 'over'
          AND o.linha_principal = 1.5
      ) AS odd_mercado_over15,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'over_under'
          AND o.selecao_codigo = 'under'
          AND o.linha_principal = 1.5
      ) AS odd_mercado_under15,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'over_under'
          AND o.selecao_codigo = 'over'
          AND o.linha_principal = 2.5
      ) AS odd_mercado_over25,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'over_under'
          AND o.selecao_codigo = 'under'
          AND o.linha_principal = 2.5
      ) AS odd_mercado_under25,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'over_under'
          AND o.selecao_codigo = 'over'
          AND o.linha_principal = 3.5
      ) AS odd_mercado_over35,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'over_under'
          AND o.selecao_codigo = 'under'
          AND o.linha_principal = 3.5
      ) AS odd_mercado_under35,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'btts'
          AND o.selecao_codigo = 'yes'
      ) AS odd_mercado_btts_sim,

      MAX(o.odd) FILTER (
        WHERE o.ativo = TRUE
          AND o.contexto_coleta = 'pre_live'
          AND o.mercado_codigo = 'btts'
          AND o.selecao_codigo = 'no'
      ) AS odd_mercado_btts_nao

    FROM odds_linha_tempo o
    WHERE o.flashscore_id_jogo = $1
    GROUP BY o.flashscore_id_jogo
  )
  UPDATE analises_jogos a
  SET
    odd_mercado_casa = m.odd_mercado_casa,
    p_mercado_casa = CASE WHEN m.odd_mercado_casa > 0 THEN ROUND((100.0 / m.odd_mercado_casa)::numeric, 2) END,

    odd_mercado_empate = m.odd_mercado_empate,
    p_mercado_empate = CASE WHEN m.odd_mercado_empate > 0 THEN ROUND((100.0 / m.odd_mercado_empate)::numeric, 2) END,

    odd_mercado_fora = m.odd_mercado_fora,
    p_mercado_fora = CASE WHEN m.odd_mercado_fora > 0 THEN ROUND((100.0 / m.odd_mercado_fora)::numeric, 2) END,

    odd_mercado_over15 = m.odd_mercado_over15,
    p_mercado_over15 = CASE WHEN m.odd_mercado_over15 > 0 THEN ROUND((100.0 / m.odd_mercado_over15)::numeric, 2) END,

    odd_mercado_under15 = m.odd_mercado_under15,
    p_mercado_under15 = CASE WHEN m.odd_mercado_under15 > 0 THEN ROUND((100.0 / m.odd_mercado_under15)::numeric, 2) END,

    odd_mercado_over25 = m.odd_mercado_over25,
    p_mercado_over25 = CASE WHEN m.odd_mercado_over25 > 0 THEN ROUND((100.0 / m.odd_mercado_over25)::numeric, 2) END,

    odd_mercado_under25 = m.odd_mercado_under25,
    p_mercado_under25 = CASE WHEN m.odd_mercado_under25 > 0 THEN ROUND((100.0 / m.odd_mercado_under25)::numeric, 2) END,

    odd_mercado_over35 = m.odd_mercado_over35,
    p_mercado_over35 = CASE WHEN m.odd_mercado_over35 > 0 THEN ROUND((100.0 / m.odd_mercado_over35)::numeric, 2) END,

    odd_mercado_under35 = m.odd_mercado_under35,
    p_mercado_under35 = CASE WHEN m.odd_mercado_under35 > 0 THEN ROUND((100.0 / m.odd_mercado_under35)::numeric, 2) END,

    odd_mercado_btts_sim = m.odd_mercado_btts_sim,
    p_mercado_btts_sim = CASE WHEN m.odd_mercado_btts_sim > 0 THEN ROUND((100.0 / m.odd_mercado_btts_sim)::numeric, 2) END,

    odd_mercado_btts_nao = m.odd_mercado_btts_nao,
    p_mercado_btts_nao = CASE WHEN m.odd_mercado_btts_nao > 0 THEN ROUND((100.0 / m.odd_mercado_btts_nao)::numeric, 2) END

  FROM melhores m
  WHERE a.flashscore_id_jogo = m.flashscore_id_jogo
  RETURNING
    a.flashscore_id_jogo,
    a.odd_mercado_casa,
    a.odd_mercado_empate,
    a.odd_mercado_fora,
    a.odd_mercado_over15,
    a.odd_mercado_under15,
    a.odd_mercado_over25,
    a.odd_mercado_under25,
    a.odd_mercado_over35,
    a.odd_mercado_under35,
    a.odd_mercado_btts_sim,
    a.odd_mercado_btts_nao,
    a.p_mercado_casa,
    a.p_mercado_empate,
    a.p_mercado_fora,
    a.p_mercado_over15,
    a.p_mercado_under15,
    a.p_mercado_over25,
    a.p_mercado_under25,
    a.p_mercado_over35,
    a.p_mercado_under35,
    a.p_mercado_btts_sim,
    a.p_mercado_btts_nao
`;

// ======================================================
// HELPERS URL
// ======================================================
function normalizarUrlBaseJogo(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  try {
    const url = new URL(rawUrl.trim());
    let pathname = url.pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/odds\/.*$/i, '');
    url.pathname = `${pathname}/`;
    return url;
  } catch {
    console.warn(`⚠️ URL inválida ignorada: ${rawUrl}`);
    return null;
  }
}

function montarUrlMercado(rawUrlBase, slugMercado) {
  const url = normalizarUrlBaseJogo(rawUrlBase);
  if (!url) return null;

  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/odds/${slugMercado}/tempo-regulamentar/`;

  return url.toString();
}

// ======================================================
// HELPERS GERAIS
// ======================================================
function parseNumero(raw) {
  if (raw == null) return null;
  const texto = String(raw).trim().replace(',', '.');
  const num = Number(texto);
  return Number.isFinite(num) ? num : null;
}

function slugifyTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'sem_rotulo';
}

function inferirSelecao(mercadoCodigo, oddIndex, totalOdds, lineRaw) {
  const idx = Number(oddIndex);

  switch (mercadoCodigo) {
    case 'over_under':
      if (idx === 0) return { selecao_codigo: 'over', selecao_nome: 'Over', selecao_ordem: 1 };
      if (idx === 1) return { selecao_codigo: 'under', selecao_nome: 'Under', selecao_ordem: 2 };
      break;

    case 'btts':
      if (idx === 0) return { selecao_codigo: 'yes', selecao_nome: 'Sim', selecao_ordem: 1 };
      if (idx === 1) return { selecao_codigo: 'no', selecao_nome: 'Não', selecao_ordem: 2 };
      break;

    case '1x2':
      if (idx === 0) return { selecao_codigo: 'home', selecao_nome: 'Casa', selecao_ordem: 1 };
      if (idx === 1) return { selecao_codigo: 'draw', selecao_nome: 'Empate', selecao_ordem: 2 };
      if (idx === 2) return { selecao_codigo: 'away', selecao_nome: 'Fora', selecao_ordem: 3 };
      break;

    case 'double_chance':
      if (idx === 0) return { selecao_codigo: '1x', selecao_nome: '1X', selecao_ordem: 1 };
      if (idx === 1) return { selecao_codigo: '12', selecao_nome: '12', selecao_ordem: 2 };
      if (idx === 2) return { selecao_codigo: 'x2', selecao_nome: 'X2', selecao_ordem: 3 };
      break;

    case 'draw_no_bet':
    case 'asian_handicap':
      if (idx === 0) return { selecao_codigo: 'home', selecao_nome: 'Casa', selecao_ordem: 1 };
      if (idx === 1) return { selecao_codigo: 'away', selecao_nome: 'Fora', selecao_ordem: 2 };
      break;

    case 'european_handicap':
      if (totalOdds === 3) {
        if (idx === 0) return { selecao_codigo: 'home', selecao_nome: 'Casa', selecao_ordem: 1 };
        if (idx === 1) return { selecao_codigo: 'draw', selecao_nome: 'Empate', selecao_ordem: 2 };
        if (idx === 2) return { selecao_codigo: 'away', selecao_nome: 'Fora', selecao_ordem: 3 };
      } else {
        if (idx === 0) return { selecao_codigo: 'home', selecao_nome: 'Casa', selecao_ordem: 1 };
        if (idx === 1) return { selecao_codigo: 'away', selecao_nome: 'Fora', selecao_ordem: 2 };
      }
      break;
  }

  if (lineRaw && totalOdds === 1) {
    return {
      selecao_codigo: slugifyTexto(lineRaw),
      selecao_nome: String(lineRaw),
      selecao_ordem: 1,
    };
  }

  return {
    selecao_codigo: `opt${idx + 1}`,
    selecao_nome: `Opção ${idx + 1}`,
    selecao_ordem: idx + 1,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkArray(items, size) {
  const safeSize = Math.max(1, Number(size || 1));
  const chunks = [];

  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }

  return chunks;
}

async function dismissCookies(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button:has-text("Aceitar")',
    'button:has-text("I Accept")',
    '[id*="onetrust-accept"]',
  ];

  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout: 1500 });
        await page.waitForTimeout(500);
        return true;
      }
    } catch {}
  }

  return false;
}

// ======================================================
// SCRAPER
// ======================================================
async function extrairTodasOddsDaPagina(page, mercado) {
  await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
  await dismissCookies(page);
  await page.waitForTimeout(WAIT_AFTER_GOTO_MS);

  const rowLocator = page.locator('.ui-table__body .ui-table__row');

  if ((await rowLocator.count()) === 0) {
    return [];
  }

  const rows = await rowLocator.evaluateAll((elements) => {
    return elements.map((row) => {
      const bookmakerPart = row.querySelector('.oddsCell__bookmakerPart');
      const logoImg = row.querySelector('.wcl-bookmakerLogo_4IUU0 img[alt]');

      const lineEl = Array.from(
        row.querySelectorAll('[data-testid="wcl-oddsValue"]')
      ).find((el) => !el.closest('a.oddsCell__odd'));

      const oddLinks = Array.from(row.querySelectorAll('a.oddsCell__odd'))
        .map((a, index) => {
          const span = a.querySelector('span');
          const value = span?.textContent?.trim() || null;
          const href = a.getAttribute('href');
          const title = a.getAttribute('title') || '';
          const className = a.getAttribute('class') || '';
          const hasLineThrough = !!a.querySelector('span.oddsCell__lineThrough');

          return {
            odd_index: index,
            odd_valor: value,
            href,
            title,
            class_name: className,
            has_line_through: hasLineThrough,
            removida:
              hasLineThrough ||
              /odds removidas pela casa de apostas/i.test(title),
          };
        })
        .filter((x) => x.odd_valor && !x.removida);

      return {
        bookmaker_id:
          bookmakerPart?.getAttribute('data-analytics-bookmaker-id') ||
          row.getAttribute('data-analytics-bookmaker-id') ||
          null,
        bookmaker_nome: logoImg?.getAttribute('alt') || null,
        linha_raw: lineEl?.textContent?.trim() || null,
        odds: oddLinks,
        row_html: row.outerHTML,
      };
    });
  });

  const coletadas = [];

  for (const row of rows) {
    const linhaNum = parseNumero(row.linha_raw);
    const totalOdds = Array.isArray(row.odds) ? row.odds.length : 0;

    for (const oddItem of row.odds || []) {
      const oddNum = parseNumero(oddItem.odd_valor);
      if (!oddNum || oddNum <= 1) continue;

      const selecao = inferirSelecao(
        mercado.mercado_codigo,
        oddItem.odd_index,
        totalOdds,
        row.linha_raw
      );

      coletadas.push({
        mercado_codigo: mercado.mercado_codigo,
        mercado_nome: mercado.mercado_nome,
        bookmaker_id: row.bookmaker_id ? Number(row.bookmaker_id) : 0,
        bookmaker_nome: row.bookmaker_nome || null,
        linha_principal: linhaNum,
        linha_raw: row.linha_raw,
        odd: oddNum,
        selecao_codigo: selecao.selecao_codigo,
        selecao_nome: selecao.selecao_nome,
        selecao_ordem: selecao.selecao_ordem,
        source_href: oddItem.href || null,
        raw_title: oddItem.title || null,
        raw_class_name: oddItem.class_name || null,
        row_html: row.row_html || null,
      });
    }
  }

  return coletadas;
}

async function coletarMercadoEmAba(context, mercado) {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);

  try {
    console.log(`🔎 Abrindo mercado [${mercado.mercado_codigo}] ${mercado.url_mercado}`);

    await page.goto(mercado.url_mercado, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    const oddsDaPagina = await extrairTodasOddsDaPagina(page, mercado);

    console.log(`📊 Mercado ${mercado.mercado_codigo}: ${oddsDaPagina.length} odd(s) coletada(s)`);

    return oddsDaPagina.map((odd) => ({
      ...odd,
      mercado_url: mercado.url_mercado,
    }));
  } finally {
    await page.close().catch(() => {});
  }
}

async function coletarMercadosEmLotes(context, mercadosComUrl) {
  const todasOddsColetadas = [];
  const lotes = chunkArray(mercadosComUrl, MARKET_BATCH_SIZE);

  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i];

    console.log(
      `\n🚚 Lote ${i + 1}/${lotes.length} | mercados: ${lote
        .map((m) => m.mercado_codigo)
        .join(', ')}\n`
    );

    const resultados = await Promise.allSettled(
      lote.map((mercado) => coletarMercadoEmAba(context, mercado))
    );

    for (const resultado of resultados) {
      if (resultado.status === 'fulfilled') {
        for (const odd of resultado.value) {
          todasOddsColetadas.push(odd);
        }
      } else {
        console.log(
          `⚠️ Falha em uma aba de mercado: ${resultado.reason?.message || resultado.reason}`
        );
      }
    }

    if (i < lotes.length - 1 && WAIT_BETWEEN_BATCHES_MS > 0) {
      console.log(`⏳ Aguardando ${WAIT_BETWEEN_BATCHES_MS}ms antes do próximo lote...`);
      await sleep(WAIT_BETWEEN_BATCHES_MS);
    }
  }

  return todasOddsColetadas;
}

// ======================================================
// HELPERS BANCO
// ======================================================
async function lockProximoJogo(client) {
  const res = await client.query(SQL_LOCK_PROXIMO_JOGO);
  return res.rows[0] || null;
}

async function marcarSucesso(client, analiseId) {
  await client.query(SQL_MARCAR_SUCESSO, [analiseId]);
}

async function marcarFalha(client, analiseId) {
  await client.query(SQL_MARCAR_FALHA, [analiseId]);
}

async function atualizarMelhoresOddsNaAnalisesJogos(client, flashscoreIdJogo) {
  const res = await client.query(SQL_ATUALIZAR_MELHORES_ODDS_ANALISES_JOGOS, [
    flashscoreIdJogo
  ]);

  return res.rows[0] || null;
}

async function salvarOddNoHistorico(client, jogo, mercadoUrl, oddData) {
  const bookmakerId = Number(oddData.bookmaker_id || 0);
  const bookmakerMatchId = String(jogo.flashscore_id);

  const sameActive = await client.query(SQL_BUSCAR_ODD_ATIVA_IGUAL, [
    bookmakerId,
    bookmakerMatchId,
    oddData.mercado_codigo,
    oddData.linha_principal,
    oddData.selecao_codigo,
    oddData.odd,
  ]);

  if (sameActive.rows[0]?.id) {
    await client.query(SQL_CONFIRMAR_ODD_ATIVA_IGUAL, [sameActive.rows[0].id]);
    return {
      acao: 'confirmada',
      odds_linha_tempo_id: sameActive.rows[0].id,
    };
  }

  await client.query(SQL_FECHAR_ODD_ATIVA_DIFERENTE, [
    bookmakerId,
    bookmakerMatchId,
    oddData.mercado_codigo,
    oddData.linha_principal,
    oddData.selecao_codigo,
  ]);

  const extraJson = {
    analises_jogos_id: jogo.id,
    flashscore_url_base: jogo.url_base_flashscore,
    mercado_url: mercadoUrl,
    source_href: oddData.source_href,
    raw_title: oddData.raw_title,
    raw_class_name: oddData.raw_class_name,
    linha_raw: oddData.linha_raw,
    row_html: oddData.row_html,
  };

  const insertRes = await client.query(SQL_INSERIR_ODD, [
    bookmakerId,
    oddData.bookmaker_nome,
    bookmakerMatchId,
    String(jogo.flashscore_id),
    jogo.flashscore_slug_liga,
    jogo.mandante_nome || null,
    jogo.visitante_nome || null,
    jogo.id_time_casa || null,
    jogo.id_time_fora || null,
    jogo.flashscore_id_casa || null,
    jogo.flashscore_id_fora || null,
    jogo.data_jogo,
    jogo.hora_jogo,
    oddData.mercado_codigo,
    oddData.mercado_nome,
    oddData.linha_principal,
    oddData.selecao_codigo,
    oddData.selecao_nome,
    oddData.selecao_ordem,
    oddData.odd,
    mercadoUrl,
    EXECUCAO_ID,
    JSON.stringify(extraJson),
  ]);

  return {
    acao: 'inserida',
    odds_linha_tempo_id: insertRes.rows[0].id,
  };
}

// ======================================================
// PROCESSAMENTO DE UM JOGO
// ======================================================
async function processarUmJogo(context, client, jogo) {
  console.log('\n============================================================');
  console.log('🎯 JOGO BLOQUEADO PARA PROCESSAMENTO');
  console.log(`ID analises_jogos: ${jogo.id}`);
  console.log(`Flashscore ID jogo: ${jogo.flashscore_id}`);
  console.log(`Mandante: ${jogo.mandante_nome ?? 'null'} | id_time_casa=${jogo.id_time_casa ?? 'null'} | flashscore_id_casa=${jogo.flashscore_id_casa ?? 'null'}`);
  console.log(`Visitante: ${jogo.visitante_nome ?? 'null'} | id_time_fora=${jogo.id_time_fora ?? 'null'} | flashscore_id_fora=${jogo.flashscore_id_fora ?? 'null'}`);
  console.log(`Data: ${jogo.data_jogo} | Hora: ${jogo.hora_jogo ?? 'sem hora'}`);
  console.log(`Liga: ${jogo.flashscore_slug_liga ?? 'sem liga'}`);
  console.log(`URL base: ${jogo.url_base_flashscore}`);
  console.log('============================================================\n');

  const mercadosComUrl = MERCADOS.map((mercado) => ({
    ...mercado,
    url_mercado: montarUrlMercado(jogo.url_base_flashscore, mercado.slug_flashscore),
  })).filter((x) => x.url_mercado);

  if (!mercadosComUrl.length) {
    await marcarFalha(client, jogo.id);
    console.log('❌ Não foi possível gerar URLs de mercado para o jogo. odd_coletada = 2');
    return { sucesso: false, odds: 0 };
  }

  const todasOddsColetadas = await coletarMercadosEmLotes(context, mercadosComUrl);

  if (!todasOddsColetadas.length) {
    await marcarFalha(client, jogo.id);
    console.log('❌ Nenhuma odd foi coletada para esse jogo. odd_coletada = 2');
    return { sucesso: false, odds: 0 };
  }

  console.log(`\n💾 Total de odds coletadas para salvar no jogo ${jogo.flashscore_id}: ${todasOddsColetadas.length}\n`);

  await client.query('BEGIN');

  try {
    let totalInseridas = 0;
    let totalConfirmadas = 0;

    for (const oddData of todasOddsColetadas) {
      const saveRes = await salvarOddNoHistorico(
        client,
        jogo,
        oddData.mercado_url,
        oddData
      );

      if (saveRes.acao === 'inserida') totalInseridas += 1;
      if (saveRes.acao === 'confirmada') totalConfirmadas += 1;
    }

    const melhoresAtualizadas = await atualizarMelhoresOddsNaAnalisesJogos(
      client,
      jogo.flashscore_id
    );

    if (melhoresAtualizadas) {
      console.log('📈 Melhores odds atualizadas em analises_jogos:');
      console.log({
        flashscore_id_jogo: melhoresAtualizadas.flashscore_id_jogo,
        odd_mercado_casa: melhoresAtualizadas.odd_mercado_casa,
        odd_mercado_empate: melhoresAtualizadas.odd_mercado_empate,
        odd_mercado_fora: melhoresAtualizadas.odd_mercado_fora,
        odd_mercado_over15: melhoresAtualizadas.odd_mercado_over15,
        odd_mercado_under15: melhoresAtualizadas.odd_mercado_under15,
        odd_mercado_over25: melhoresAtualizadas.odd_mercado_over25,
        odd_mercado_under25: melhoresAtualizadas.odd_mercado_under25,
        odd_mercado_over35: melhoresAtualizadas.odd_mercado_over35,
        odd_mercado_under35: melhoresAtualizadas.odd_mercado_under35,
        odd_mercado_btts_sim: melhoresAtualizadas.odd_mercado_btts_sim,
        odd_mercado_btts_nao: melhoresAtualizadas.odd_mercado_btts_nao,
        p_mercado_casa: melhoresAtualizadas.p_mercado_casa,
        p_mercado_empate: melhoresAtualizadas.p_mercado_empate,
        p_mercado_fora: melhoresAtualizadas.p_mercado_fora,
        p_mercado_over15: melhoresAtualizadas.p_mercado_over15,
        p_mercado_under15: melhoresAtualizadas.p_mercado_under15,
        p_mercado_over25: melhoresAtualizadas.p_mercado_over25,
        p_mercado_under25: melhoresAtualizadas.p_mercado_under25,
        p_mercado_over35: melhoresAtualizadas.p_mercado_over35,
        p_mercado_under35: melhoresAtualizadas.p_mercado_under35,
        p_mercado_btts_sim: melhoresAtualizadas.p_mercado_btts_sim,
        p_mercado_btts_nao: melhoresAtualizadas.p_mercado_btts_nao,
      });
    } else {
      console.log('⚠️ Nenhuma linha de analises_jogos foi atualizada com melhores odds.');
    }

    await marcarSucesso(client, jogo.id);
    await client.query('COMMIT');

    console.log('✅ Jogo concluído com sucesso');
    console.log({
      analises_jogos_id: jogo.id,
      flashscore_id_jogo: jogo.flashscore_id,
      odds_coletadas: todasOddsColetadas.length,
      total_inseridas: totalInseridas,
      total_confirmadas: totalConfirmadas,
      melhores_odds_atualizadas: !!melhoresAtualizadas,
      odd_coletada: 1,
    });

    return { sucesso: true, odds: todasOddsColetadas.length };
  } catch (err) {
    await client.query('ROLLBACK');
    await marcarFalha(client, jogo.id);
    console.error(`❌ Erro salvando odds do jogo ${jogo.flashscore_id}:`, err);
    return { sucesso: false, odds: 0 };
  }
}

// ======================================================
// MAIN
// ======================================================
async function main() {
  const client = await pool.connect();
  let browser = null;

  try {
    const launchArgs = [
      '--no-first-run',
      '--no-default-browser-check',
    ];

    if (GUEST_MODE) {
      launchArgs.push('--guest');
    }

    const launchOptions = {
      headless: HEADLESS,
      args: launchArgs,
    };

    if (USE_SYSTEM_CHROME) {
      if (CHROME_EXECUTABLE_PATH) {
        launchOptions.executablePath = CHROME_EXECUTABLE_PATH;
      } else {
        launchOptions.channel = 'chrome';
      }
    }

    console.log('🌐 Abrindo navegador do computador...');
    console.log({
      use_system_chrome: USE_SYSTEM_CHROME,
      guest_mode: GUEST_MODE,
      headless: HEADLESS,
      executablePath: CHROME_EXECUTABLE_PATH || null,
      channel: launchOptions.channel || null,
      market_batch_size: MARKET_BATCH_SIZE,
      wait_between_batches_ms: WAIT_BETWEEN_BATCHES_MS,
    });

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      locale: 'pt-BR',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    });

    while (true) {
      const jogo = await lockProximoJogo(client);

      if (!jogo) {
        console.log('✅ Não há mais jogos pendentes com odd_coletada = 0.');
        break;
      }

      await processarUmJogo(context, client, jogo);
    }
  } catch (err) {
    console.error('❌ Erro geral na coleta bruta de odds:', err);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }

    client.release();
    await pool.end();
  }
}

main();