const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: '100.114.225.110',
  database: 'stats_futebol',
  password: 'Wallace@22',
  port: 5432,
});

const METRICAS_PERFIL = [
  'posse_bola_mediana_wma',
  'xg_mediana_wma',
  'xg_contra_mediana_wma',
  'passes_terco_final_porcentagem_mediana_wma',
  'cruzamentos_total_mediana_wma',
  'desarmes_porcentagem_mediana_wma',
  'faltas_mediana_wma',
];

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round4(value) {
  return Number(toNum(value, 0).toFixed(4));
}

function median(values) {
  const numbers = values.filter((value) => Number.isFinite(Number(value))).map((value) => Number(value));
  if (!numbers.length) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function classificarPerfilTime(perfil) {
  const posse = toNum(perfil?.posse_bola_mediana_wma, 0);
  const xg = toNum(perfil?.xg_mediana_wma, 0);
  const xgContra = toNum(perfil?.xg_contra_mediana_wma, 0);
  const passesTerco = toNum(perfil?.passes_terco_final_porcentagem_mediana_wma, 0);
  const cruzamentos = toNum(perfil?.cruzamentos_total_mediana_wma, 0);
  const desarmes = toNum(perfil?.desarmes_porcentagem_mediana_wma, 0);
  const faltas = toNum(perfil?.faltas_mediana_wma, 0);

  if (posse >= 55 && xg >= 1.2) return 'posse_ataque';
  if (posse <= 45 && xg >= 1.0 && xgContra >= 0.9 && desarmes >= 55) return 'pressao_transicao';
  if (passesTerco >= 33 && xg >= 1.0) return 'organizado_territorial';
  if (cruzamentos >= 24 && xg <= 1.1) return 'cruzamentos';
  if (faltas >= 16 && xg <= 0.9) return 'jogo_truncado';
  if (xg >= 1.2 && xgContra <= 0.95) return 'ataque_pesado';
  if (xg <= 0.9 && xgContra <= 0.9) return 'equilibrado';
  if (xgContra >= 1.2 && xg <= 0.95) return 'defesa_fraca';
  return 'misto';
}

function classificarDuelo(casaPerfil, foraPerfil, deltaPosse, deltaXg) {
  if (casaPerfil === 'posse_ataque' && foraPerfil === 'posse_ataque') return 'posse_vs_posse';
  if (casaPerfil === 'pressao_transicao' && foraPerfil === 'pressao_transicao') return 'pressao_vs_pressao';
  if (casaPerfil === 'posse_ataque' && foraPerfil === 'pressao_transicao') return 'posse_vs_pressao';
  if (casaPerfil === 'pressao_transicao' && foraPerfil === 'posse_ataque') return 'pressao_vs_posse';
  if (casaPerfil === 'organizado_territorial' && foraPerfil === 'organizado_territorial') return 'organizado_vs_organizado';
  if (casaPerfil === 'jogo_truncado' || foraPerfil === 'jogo_truncado') return 'truncado_vs_truncado';
  if (deltaPosse >= 8 && deltaXg >= 0.2) return 'posse_ataque_vs_organizado';
  if (deltaPosse <= -8 && deltaXg <= -0.2) return 'pressao_vs_posse_ataque';
  if (deltaXg >= 0.25) return 'ataque_forte_vs_defesa_fraca';
  if (deltaXg <= -0.25) return 'ataque_fraco_vs_defesa_forte';
  return 'duelo_misto';
}

async function prepararTabelas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS analise_duelo_perfil_detalhada (
      id BIGSERIAL PRIMARY KEY,
      data_jogo DATE,
      flashscore_id_jogo TEXT,
      mercado TEXT,
      resultado_mercado TEXT,
      probabilidade NUMERIC(10,4),
      nome_time_casa TEXT,
      nome_time_fora TEXT,
      id_time_casa INT,
      id_time_fora INT,
      perfil_casa TEXT,
      perfil_fora TEXT,
      tipo_duelo TEXT,
      casa_posse_pre NUMERIC(10,4),
      fora_posse_pre NUMERIC(10,4),
      casa_xg_pre NUMERIC(10,4),
      fora_xg_pre NUMERIC(10,4),
      casa_xg_contra_pre NUMERIC(10,4),
      fora_xg_contra_pre NUMERIC(10,4),
      casa_posse_real NUMERIC(10,4),
      fora_posse_real NUMERIC(10,4),
      casa_xg_real NUMERIC(10,4),
      fora_xg_real NUMERIC(10,4),
      casa_xg_contra_real NUMERIC(10,4),
      fora_xg_contra_real NUMERIC(10,4),
      casa_gols_real INT,
      fora_gols_real INT,
      total_gols_real INT,
      casa_faltas_real INT,
      fora_faltas_real INT,
      total_cartoes_real INT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS analise_duelo_perfil_resumo (
      id BIGSERIAL PRIMARY KEY,
      mercado TEXT,
      resultado_mercado TEXT,
      perfil_casa TEXT,
      perfil_fora TEXT,
      tipo_duelo TEXT,
      total_jogos INT,
      media_probabilidade NUMERIC(10,4),
      mediana_probabilidade NUMERIC(10,4),
      media_posse_casa_pre NUMERIC(10,4),
      media_posse_fora_pre NUMERIC(10,4),
      media_xg_casa_pre NUMERIC(10,4),
      media_xg_fora_pre NUMERIC(10,4),
      media_xg_contra_casa_pre NUMERIC(10,4),
      media_xg_contra_fora_pre NUMERIC(10,4),
      media_posse_casa_real NUMERIC(10,4),
      media_posse_fora_real NUMERIC(10,4),
      media_xg_casa_real NUMERIC(10,4),
      media_xg_fora_real NUMERIC(10,4),
      media_xg_contra_casa_real NUMERIC(10,4),
      media_xg_contra_fora_real NUMERIC(10,4),
      media_gols_total_reais NUMERIC(10,4),
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query('TRUNCATE TABLE analise_duelo_perfil_detalhada;');
  await pool.query('TRUNCATE TABLE analise_duelo_perfil_resumo;');
}

async function carregarRegistros() {
  const q = `
    SELECT
      d.*
    FROM diagnostico_mercados d
    WHERE d.resultado IN ('GREEN', 'RED')
      AND d.mercado IS NOT NULL
      AND d.data_jogo >= '2024-01-01'
    ORDER BY d.data_jogo DESC;
  `;

  const { rows } = await pool.query(q);
  return rows;
}

async function carregarPerfisPreJogo() {
  const q = `
    SELECT
      a.id_time,
      a.data_jogo,
      a.casa_fora,
      a.tipo_analise,
      a.posse_bola_mediana_wma,
      a.xg_mediana_wma,
      a.xg_contra_mediana_wma,
      a.passes_terco_final_porcentagem_mediana_wma,
      a.cruzamentos_total_mediana_wma,
      a.desarmes_porcentagem_mediana_wma,
      a.faltas_mediana_wma
    FROM analise_comportamento_times a
    WHERE a.periodo = 'GE'
      AND a.tipo_analise IN (
        'ATAQUE_TIME',
        'DEFESA_TIME',
        'ATAQUE_CONTRA',
        'DEFESA_CONTRA',
        'ATAQUE_DEFESA_TOTAL_TIME',
        'ATAQUE_DEFESA_TOTAL_CONTRA'
      )
      AND a.data_jogo >= '2024-01-01';
  `;

  const { rows } = await pool.query(q);
  const map = new Map();

  for (const row of rows) {
    const chave = `${row.id_time}|${row.data_jogo}|${row.casa_fora}`;
    const atual = map.get(chave) || {};
    map.set(chave, { ...atual, ...row });
  }

  return map;
}

async function carregarEstatisticasReal(flashscoreIds) {
  if (!flashscoreIds.length) return new Map();

  const q = `
    SELECT
      e.flashscore_id_jogo,
      e.id_time,
      e.posse_bola,
      e.xg,
      e.xga,
      e.xg_contra,
      e.gols_marcados,
      e.gols_sofridos,
      e.faltas,
      e.cartoes_amarelos,
      e.cartao_vermelho
    FROM estatisticas_geral e
    WHERE e.flashscore_id_jogo = ANY($1);
  `;

  const { rows } = await pool.query(q, [flashscoreIds]);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.flashscore_id_jogo}|${row.id_time}`, row);
  }
  return map;
}

function buscarPerfilMerge(perfilAtual) {
  if (!perfilAtual) return {};
  const merged = { ...perfilAtual };
  return merged;
}

async function processarTudo() {
  await prepararTabelas();

  const registros = await carregarRegistros();
  const perfis = await carregarPerfisPreJogo();
  const flashscoreIds = [...new Set(registros.map((r) => r.flashscore_id_jogo).filter(Boolean))];
  const estatisticas = await carregarEstatisticasReal(flashscoreIds);

  for (const registro of registros) {
    const chaveCasa = `${registro.id_time}|${registro.data_jogo}|${registro.mando}`;
    const chaveFora = `${registro.id_time_adversario}|${registro.data_jogo}|${registro.mando === 'C' ? 'F' : 'C'}`;

    const perfilCasaRaw = perfis.get(chaveCasa);
    const perfilForaRaw = perfis.get(chaveFora);

    if (!perfilCasaRaw || !perfilForaRaw) continue;

    const perfilCasa = buscarPerfilMerge(perfilCasaRaw);
    const perfilFora = buscarPerfilMerge(perfilForaRaw);

    const casaPerfil = classificarPerfilTime(perfilCasa);
    const foraPerfil = classificarPerfilTime(perfilFora);

    const casaPossePre = toNum(perfilCasa.posse_bola_mediana_wma, 0);
    const foraPossePre = toNum(perfilFora.posse_bola_mediana_wma, 0);
    const casaXgPre = toNum(perfilCasa.xg_mediana_wma, 0);
    const foraXgPre = toNum(perfilFora.xg_mediana_wma, 0);
    const casaXgContraPre = toNum(perfilCasa.xg_contra_mediana_wma, 0);
    const foraXgContraPre = toNum(perfilFora.xg_contra_mediana_wma, 0);

    const statCasa = estatisticas.get(`${registro.flashscore_id_jogo}|${registro.id_time}`);
    const statFora = estatisticas.get(`${registro.flashscore_id_jogo}|${registro.id_time_adversario}`);

    if (!statCasa || !statFora) continue;

    const realCasaPosse = toNum(statCasa.posse_bola, 0);
    const realForaPosse = toNum(statFora.posse_bola, 0);
    const realCasaXg = toNum(statCasa.xg, 0);
    const realForaXg = toNum(statFora.xg, 0);
    const realCasaXgContra = toNum(statCasa.xg_contra, 0);
    const realForaXgContra = toNum(statFora.xg_contra, 0);
    const casaGolsReal = toNum(statCasa.gols_marcados, 0);
    const foraGolsReal = toNum(statFora.gols_marcados, 0);
    const totalGolsReal = casaGolsReal + foraGolsReal;
    const casaFaltas = toNum(statCasa.faltas, 0);
    const foraFaltas = toNum(statFora.faltas, 0);
    const totalCartoes = toNum(statCasa.cartoes_amarelos, 0) + toNum(statCasa.cartao_vermelho, 0) + toNum(statFora.cartoes_amarelos, 0) + toNum(statFora.cartao_vermelho, 0);

    const deltaPosse = casaPossePre - foraPossePre;
    const deltaXg = casaXgPre - foraXgPre;
    const tipoDuelo = classificarDuelo(casaPerfil, foraPerfil, deltaPosse, deltaXg);

    await pool.query(`
      INSERT INTO analise_duelo_perfil_detalhada (
        data_jogo,
        flashscore_id_jogo,
        mercado,
        resultado_mercado,
        probabilidade,
        nome_time_casa,
        nome_time_fora,
        id_time_casa,
        id_time_fora,
        perfil_casa,
        perfil_fora,
        tipo_duelo,
        casa_posse_pre,
        fora_posse_pre,
        casa_xg_pre,
        fora_xg_pre,
        casa_xg_contra_pre,
        fora_xg_contra_pre,
        casa_posse_real,
        fora_posse_real,
        casa_xg_real,
        fora_xg_real,
        casa_xg_contra_real,
        fora_xg_contra_real,
        casa_gols_real,
        fora_gols_real,
        total_gols_real,
        casa_faltas_real,
        fora_faltas_real,
        total_cartoes_real
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
      );
    `, [
      registro.data_jogo,
      registro.flashscore_id_jogo,
      registro.mercado,
      registro.resultado,
      toNum(registro.probabilidade, 0),
      registro.nome_time,
      registro.nome_time_adversario,
      registro.id_time,
      registro.id_time_adversario,
      casaPerfil,
      foraPerfil,
      tipoDuelo,
      round4(casaPossePre),
      round4(foraPossePre),
      round4(casaXgPre),
      round4(foraXgPre),
      round4(casaXgContraPre),
      round4(foraXgContraPre),
      round4(realCasaPosse),
      round4(realForaPosse),
      round4(realCasaXg),
      round4(realForaXg),
      round4(realCasaXgContra),
      round4(realForaXgContra),
      casaGolsReal,
      foraGolsReal,
      totalGolsReal,
      casaFaltas,
      foraFaltas,
      totalCartoes,
    ]);
  }

  await pool.query(`
    INSERT INTO analise_duelo_perfil_resumo (
      mercado,
      resultado_mercado,
      perfil_casa,
      perfil_fora,
      tipo_duelo,
      total_jogos,
      media_probabilidade,
      mediana_probabilidade,
      media_posse_casa_pre,
      media_posse_fora_pre,
      media_xg_casa_pre,
      media_xg_fora_pre,
      media_xg_contra_casa_pre,
      media_xg_contra_fora_pre,
      media_posse_casa_real,
      media_posse_fora_real,
      media_xg_casa_real,
      media_xg_fora_real,
      media_xg_contra_casa_real,
      media_xg_contra_fora_real,
      media_gols_total_reais
    )
    SELECT
      mercado,
      resultado_mercado,
      perfil_casa,
      perfil_fora,
      tipo_duelo,
      COUNT(*) AS total_jogos,
      ROUND(CAST(AVG(probabilidade) AS NUMERIC), 4) AS media_probabilidade,
      ROUND(CAST(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY probabilidade) AS NUMERIC), 4) AS mediana_probabilidade,
      ROUND(CAST(AVG(casa_posse_pre) AS NUMERIC), 4) AS media_posse_casa_pre,
      ROUND(CAST(AVG(fora_posse_pre) AS NUMERIC), 4) AS media_posse_fora_pre,
      ROUND(CAST(AVG(casa_xg_pre) AS NUMERIC), 4) AS media_xg_casa_pre,
      ROUND(CAST(AVG(fora_xg_pre) AS NUMERIC), 4) AS media_xg_fora_pre,
      ROUND(CAST(AVG(casa_xg_contra_pre) AS NUMERIC), 4) AS media_xg_contra_casa_pre,
      ROUND(CAST(AVG(fora_xg_contra_pre) AS NUMERIC), 4) AS media_xg_contra_fora_pre,
      ROUND(CAST(AVG(casa_posse_real) AS NUMERIC), 4) AS media_posse_casa_real,
      ROUND(CAST(AVG(fora_posse_real) AS NUMERIC), 4) AS media_posse_fora_real,
      ROUND(CAST(AVG(casa_xg_real) AS NUMERIC), 4) AS media_xg_casa_real,
      ROUND(CAST(AVG(fora_xg_real) AS NUMERIC), 4) AS media_xg_fora_real,
      ROUND(CAST(AVG(casa_xg_contra_real) AS NUMERIC), 4) AS media_xg_contra_casa_real,
      ROUND(CAST(AVG(fora_xg_contra_real) AS NUMERIC), 4) AS media_xg_contra_fora_real,
      ROUND(CAST(AVG(total_gols_real) AS NUMERIC), 4) AS media_gols_total_reais
    FROM analise_duelo_perfil_detalhada
    GROUP BY mercado, resultado_mercado, perfil_casa, perfil_fora, tipo_duelo
    ORDER BY mercado, resultado_mercado, tipo_duelo;
  `);

  console.log('Tabela pronta: analise_duelo_perfil_detalhada');
  console.log('Tabela pronta: analise_duelo_perfil_resumo');
}

async function main() {
  try {
    await processarTudo();
  } catch (error) {
    console.error('Erro ao processar análise de duelo por perfil:', error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
