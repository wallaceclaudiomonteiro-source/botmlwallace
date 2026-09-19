require('dotenv').config();

const { Pool } = require('pg');

// =========================================================
// CONFIGURAÇÃO FIXA
// =========================================================

const DATA_ALVO = '2026-06-10';
const LOOKBACK_DAYS = 60;

// =========================================================
// POSTGRES
// =========================================================

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl:
          process.env.PGSSLMODE === 'require'
            ? { rejectUnauthorized: false }
            : undefined,
      }
    : {
        host: process.env.PGHOST || process.env.DB_HOST || 'localhost',
        port: Number(process.env.PGPORT || process.env.DB_PORT || 5432),
        database: process.env.PGDATABASE || process.env.DB_NAME,
        user: process.env.PGUSER || process.env.DB_USER,
        password: process.env.PGPASSWORD || process.env.DB_PASSWORD,
      }
);

// =========================================================
// HELPERS BÁSICOS
// =========================================================

function toNum(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function round2(v) {
  const n = toNum(v, null);
  if (n === null) return null;
  return Math.round(n * 100) / 100;
}

function round4(v) {
  const n = toNum(v, null);
  if (n === null) return null;
  return Math.round(n * 10000) / 10000;
}

function safeJson(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;

  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

function asArray(v) {
  return Array.isArray(v) ? v : [v];
}

function hasUsableValue(v) {
  return v !== null && v !== undefined && v !== '';
}

function getFirstValue(row, fields, fallback = null) {
  for (const f of asArray(fields)) {
    if (!f) continue;

    if (
      Object.prototype.hasOwnProperty.call(row, f) &&
      hasUsableValue(row[f])
    ) {
      return row[f];
    }
  }

  return fallback;
}

function normalizarEntrada(v) {
  return String(v || '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function isEntradaValida(entrada) {
  const e = normalizarEntrada(entrada);

  return (
    !!e &&
    e !== 'NO BET' &&
    e !== 'NOBET' &&
    e !== 'NULL' &&
    e !== 'SEM ENTRADA' &&
    e !== 'SEM_ENTRADA'
  );
}

function entradaMatchesAllowed(entrada, allowedEntradas) {
  if (!allowedEntradas || !allowedEntradas.length) return true;

  const e = normalizarEntrada(entrada);

  return allowedEntradas
    .map(normalizarEntrada)
    .includes(e);
}

function getEntradaForCfg(row, cfg) {
  /*
    Importante para 1X2:

    Se a tabela tiver entrada_1x2 = FORA,
    o mercado 1x2_casa NÃO pode pegar essa entrada.

    Por isso não basta pegar o primeiro campo existente.
    Precisamos procurar o primeiro campo válido que também pertença
    ao mercado configurado.
  */

  for (const f of asArray(cfg.entradaField)) {
    if (!f) continue;

    const v = row[f];

    if (!isEntradaValida(v)) {
      continue;
    }

    if (!entradaMatchesAllowed(v, cfg.allowedEntradas)) {
      continue;
    }

    return v;
  }

  return null;
}

function statusIsFinal(status) {
  return ['GREEN', 'RED'].includes(String(status || '').toUpperCase());
}

// =========================================================
// TELEMETRIA / ÂNCORA OPERACIONAL
// =========================================================

function getEntradaOperacional(row) {
  const t = safeJson(row.telemetria_anchor);

  /*
    Em algumas versões a telemetria pode estar direto em:
    telemetria_anchor.entrada_operacional

    Em outras pode estar dentro de:
    telemetria_anchor.anchor_mercados_aplicacao.entrada_operacional
  */

  return (
    t?.entrada_operacional ||
    t?.anchor_mercados_aplicacao?.entrada_operacional ||
    {}
  );
}

function getAnchorEntrada(row, anchorKey) {
  const op = getEntradaOperacional(row);
  const anchorEntrada = op?.anchor_entrada || {};

  for (const key of asArray(anchorKey)) {
    if (!key) continue;

    if (anchorEntrada[key]) {
      return anchorEntrada[key];
    }
  }

  return {};
}

function getVeto(row, anchorKey) {
  const op = getEntradaOperacional(row);
  const vetos = op?.vetos_operacionais || {};

  for (const key of asArray(anchorKey)) {
    if (!key) continue;

    if (vetos[key]) {
      return vetos[key];
    }
  }

  return {};
}

// =========================================================
// CONFIGURAÇÃO DOS MERCADOS
// =========================================================

const MERCADOS = [
  // =======================================================
  // 1X2 CASA
  // =======================================================
  {
    mercado: '1x2_casa',
    label: '1X2 Casa',

    /*
      Na telemetria operacional o 1X2 normalmente vem por lado:
      casa / fora / empate.

      Deixo fallbacks para versões diferentes.
    */
    anchorKey: ['casa', 'home', '1x2_casa'],

    entradaField: [
      'entrada_1x2',
      'entrada_casa',
      'entrada_home',
      'entrada_vencedor',
      'entrada_resultado',
    ],

    allowedEntradas: [
      'CASA',
      'HOME',
      'MANDANTE',
      'TIME CASA',
      'TIME_CASA',
      '1',
    ],

    statusField: [
      'status_1x2',
      'status_casa',
      'status_home',
      'status_vencedor',
      'status_resultado',
    ],

    probRoboField: [
      'p_home',
      'p_casa',
      'prob_home',
      'prob_casa',
      'p_1x2_casa',
      'prob_1x2_casa',
    ],

    oddJustaField: [
      'o_home',
      'o_casa',
      'odd_justa_home',
      'odd_justa_casa',
      'o_1x2_casa',
      'odd_justa_1x2_casa',
    ],

    probCasaField: [
      'p_mercado_home',
      'p_mercado_casa',
      'p_home_mercado',
      'p_casa_mercado',
      'p_mercado_1x2_casa',
      'prob_mercado_home',
      'prob_mercado_casa',
    ],

    oddCasaField: [
      'odd_mercado_home',
      'odd_mercado_casa',
      'odd_home_mercado',
      'odd_casa_mercado',
      'odd_mercado_1x2_casa',
    ],
  },

  // =======================================================
  // 1X2 FORA
  // =======================================================
  {
    mercado: '1x2_fora',
    label: '1X2 Fora',

    anchorKey: ['fora', 'away', '1x2_fora'],

    entradaField: [
      'entrada_1x2',
      'entrada_fora',
      'entrada_away',
      'entrada_vencedor',
      'entrada_resultado',
    ],

    allowedEntradas: [
      'FORA',
      'AWAY',
      'VISITANTE',
      'TIME FORA',
      'TIME_FORA',
      '2',
    ],

    statusField: [
      'status_1x2',
      'status_fora',
      'status_away',
      'status_vencedor',
      'status_resultado',
    ],

    probRoboField: [
      'p_away',
      'p_fora',
      'prob_away',
      'prob_fora',
      'p_1x2_fora',
      'prob_1x2_fora',
    ],

    oddJustaField: [
      'o_away',
      'o_fora',
      'odd_justa_away',
      'odd_justa_fora',
      'o_1x2_fora',
      'odd_justa_1x2_fora',
    ],

    probCasaField: [
      'p_mercado_away',
      'p_mercado_fora',
      'p_away_mercado',
      'p_fora_mercado',
      'p_mercado_1x2_fora',
      'prob_mercado_away',
      'prob_mercado_fora',
    ],

    oddCasaField: [
      'odd_mercado_away',
      'odd_mercado_fora',
      'odd_away_mercado',
      'odd_fora_mercado',
      'odd_mercado_1x2_fora',
    ],
  },

  // =======================================================
  // GOLS
  // =======================================================
  {
    mercado: 'over15',
    label: 'Over 1.5',
    anchorKey: 'over15',
    entradaField: 'entrada_over15',
    statusField: 'status_over15',
    probRoboField: 'p_over15',
    oddJustaField: 'o_over15',
    probCasaField: 'p_mercado_over15',
    oddCasaField: 'odd_mercado_over15',
  },
  {
    mercado: 'over25',
    label: 'Over 2.5',
    anchorKey: 'over25',
    entradaField: 'entrada_over25',
    statusField: 'status_over25',
    probRoboField: 'p_over25',
    oddJustaField: 'o_over25',
    probCasaField: 'p_mercado_over25',
    oddCasaField: 'odd_mercado_over25',
  },
  {
    mercado: 'over35',
    label: 'Over 3.5',
    anchorKey: 'over35',
    entradaField: 'entrada_over35',
    statusField: 'status_over35',
    probRoboField: 'p_over35',
    oddJustaField: 'o_over35',
    probCasaField: 'p_mercado_over35',
    oddCasaField: 'odd_mercado_over35',
  },
  {
    mercado: 'under25',
    label: 'Under 2.5',
    anchorKey: 'under25',
    entradaField: 'entrada_under25',
    statusField: 'status_under25',
    probRoboField: 'p_under25',
    oddJustaField: 'o_under25',
    probCasaField: 'p_mercado_under25',
    oddCasaField: 'odd_mercado_under25',
  },
  {
    mercado: 'under35',
    label: 'Under 3.5',
    anchorKey: 'under35',
    entradaField: 'entrada_under35',
    statusField: 'status_under35',
    probRoboField: 'p_under35',
    oddJustaField: 'o_under35',
    probCasaField: 'p_mercado_under35',
    oddCasaField: 'odd_mercado_under35',
  },
  {
    mercado: 'btts_sim',
    label: 'BTTS Sim',
    anchorKey: 'btts_sim',
    entradaField: 'entrada_btts',
    statusField: 'status_btts',
    probRoboField: 'p_btts_sim',
    oddJustaField: 'o_btts_sim',
    probCasaField: 'p_mercado_btts_sim',
    oddCasaField: 'odd_mercado_btts_sim',
  },
  {
    mercado: 'btts_nao',
    label: 'BTTS Não',
    anchorKey: 'btts_nao',
    entradaField: 'entrada_btts_nao',
    statusField: 'status_btts_nao',
    probRoboField: 'p_btts_nao',
    oddJustaField: 'o_btts_nao',
    probCasaField: 'p_mercado_btts_nao',
    oddCasaField: 'odd_mercado_btts_nao',
  },
];

// =========================================================
// CLASSIFICAÇÃO / EXPLICAÇÃO
// =========================================================

function classificarEntradaOperacional({
  mercado,
  grupo,
  confianca,
  scoreFinal,
  auditHitRate,
  auditN,
}) {
  const g = String(grupo || '');
  const c = String(confianca || '');
  const s = toNum(scoreFinal, 0);

  /*
    Classe operacional para a tabela de aposta.
    Isso não muda a entrada. Só etiqueta a qualidade.
  */

  if (auditN >= 10 && auditHitRate >= 78) {
    return 'PREMIUM_AUDITADO';
  }

  if (auditN >= 10 && auditHitRate >= 70) {
    return 'FORTE_AUDITADO';
  }

  if (g.includes('3_confirmacoes') && s >= 70) {
    return 'PREMIUM_3_CONFIRMACOES';
  }

  if (c.includes('forte') || c.includes('premium')) {
    return 'FORTE';
  }

  if (mercado === 'over25' && g.includes('3_confirmacoes')) {
    return 'FORTE';
  }

  if (mercado === 'under35' && g.includes('lambda_casa')) {
    return 'FORTE';
  }

  if (mercado === '1x2_casa' && s >= 70) {
    return 'FORTE_1X2_CASA';
  }

  if (mercado === '1x2_fora' && s >= 70) {
    return 'FORTE_1X2_FORA';
  }

  if (s >= 75) {
    return 'SCORE_ALTO_COM_PADRAO';
  }

  return 'VALIDA';
}

function descricaoPadraoBase({ mercado, grupo, motivo, confianca }) {
  const g = String(grupo || '');
  const m = String(motivo || '');
  const c = String(confianca || '');

  const byGroup = {
    over25_3_confirmacoes:
      'Over 2.5 aprovado porque lambda, âncora produtiva e casa confirmaram a mesma direção.',
    over25_lambda_ancora:
      'Over 2.5 aprovado porque lambda e âncora confirmaram força ofensiva, mesmo sem depender da casa.',
    over25_lambda_casa_forte:
      'Over 2.5 aprovado porque o lambda veio médio/forte e a casa confirmou valor no mesmo lado.',

    under25_3_confirmacoes:
      'Under 2.5 aprovado porque lambda, âncora e casa confirmaram cenário de jogo mais amarrado.',
    under25_lambda_ancora:
      'Under 2.5 aprovado porque lambda e âncora confirmaram tendência de baixa produção.',

    under35_lambda_casa:
      'Under 3.5 aprovado porque o lambda veio forte e a casa confirmou valor no under; foi um dos melhores padrões auditados.',
    under35_3_confirmacoes:
      'Under 3.5 aprovado porque lambda, âncora e casa confirmaram a mesma direção.',
    under35_lambda_ancora_premium:
      'Under 3.5 aprovado porque lambda forte e âncora média/forte confirmaram o under em nível premium.',

    btts_sim_3_confirmacoes_lambda_medio:
      'BTTS Sim aprovado porque houve três confirmações e o lambda veio pelo menos médio.',
    btts_sim_lambda_casa:
      'BTTS Sim aprovado porque lambda e casa confirmaram ambos marcam.',

    btts_nao_3_confirmacoes:
      'BTTS Não aprovado porque lambda, âncora e casa confirmaram tendência contra ambos marcam.',
    btts_nao_lambda_casa:
      'BTTS Não aprovado porque lambda e casa confirmaram tendência contra ambos marcam.',
  };

  if (byGroup[g]) return byGroup[g];

  if (mercado === '1x2_casa') {
    if (m) {
      return `1X2 Casa aprovado pelo padrão operacional "${g || 'sem_grupo'}": ${m}.`;
    }

    return `1X2 Casa aprovado pelo padrão operacional "${g || 'sem_grupo'}", confiança ${c || 'neutra'}.`;
  }

  if (mercado === '1x2_fora') {
    if (m) {
      return `1X2 Fora aprovado pelo padrão operacional "${g || 'sem_grupo'}": ${m}.`;
    }

    return `1X2 Fora aprovado pelo padrão operacional "${g || 'sem_grupo'}", confiança ${c || 'neutra'}.`;
  }

  if (m) {
    return `Entrada aprovada pelo padrão operacional "${g || 'sem_grupo'}": ${m}.`;
  }

  return `Entrada aprovada pelo padrão operacional "${g || 'sem_grupo'}", confiança ${c || 'neutra'}.`;
}

function montarExplicacaoEntrada({
  mercado,
  mercadoLabel,
  entrada,
  grupo,
  motivo,
  confianca,
  scoreFinal,
  probRobo,
  probCasa,
  audit,
}) {
  const partes = [];

  partes.push(descricaoPadraoBase({ mercado, grupo, motivo, confianca }));

  if (audit && audit.n > 0) {
    partes.push(
      `Na auditoria recente desse mesmo padrão: ${audit.green} GREEN, ${audit.red} RED, hit rate ${round2(
        audit.hitRate
      )}% em ${audit.n} jogos.`
    );
  } else {
    partes.push(
      'Ainda sem amostra histórica suficiente desse padrão dentro da janela usada; entrada mantida porque passou nas regras operacionais atuais.'
    );
  }

  partes.push(
    `Score final ${round2(scoreFinal)}. Probabilidade do robô ${round2(probRobo)}%.`
  );

  if (probCasa !== null && probCasa !== undefined) {
    partes.push(`Casa/mercado em ${round2(probCasa)}%.`);
  }

  partes.push(`Entrada gerada: ${entrada} em ${mercadoLabel}.`);

  return partes.join(' ');
}

// =========================================================
// QUERIES
// =========================================================

async function carregarJogosDaData(data) {
  const sql = `
    SELECT *
    FROM analises_jogos
    WHERE data_jogo::date = $1::date
    ORDER BY hora_jogo NULLS LAST, time_casa, time_fora
  `;

  const { rows } = await pool.query(sql, [data]);
  return rows;
}

async function carregarHistoricoParaAuditoria(data, lookbackDays) {
  const sql = `
    SELECT *
    FROM analises_jogos
    WHERE data_jogo::date < $1::date
      AND data_jogo::date >= ($1::date - ($2::int || ' days')::interval)::date
    ORDER BY data_jogo DESC
  `;

  const { rows } = await pool.query(sql, [data, lookbackDays]);
  return rows;
}

// =========================================================
// AUDITORIA DE PADRÕES HISTÓRICOS
// =========================================================

function montarStatsPadroes(rowsHistorico) {
  const stats = new Map();

  for (const row of rowsHistorico) {
    for (const cfg of MERCADOS) {
      const entrada = getEntradaForCfg(row, cfg);

      if (!entrada) {
        continue;
      }

      const status = String(
        getFirstValue(row, cfg.statusField, '') || ''
      ).toUpperCase();

      if (!statusIsFinal(status)) {
        continue;
      }

      const anchor = getAnchorEntrada(row, cfg.anchorKey);
      const grupo = anchor?.grupo_padrao_operacional || 'sem_grupo';

      const key = `${cfg.mercado}::${grupo}`;

      if (!stats.has(key)) {
        stats.set(key, {
          mercado: cfg.mercado,
          grupo,
          n: 0,
          green: 0,
          red: 0,
        });
      }

      const item = stats.get(key);
      item.n += 1;

      if (status === 'GREEN') item.green += 1;
      if (status === 'RED') item.red += 1;
    }
  }

  for (const item of stats.values()) {
    item.hitRate = item.n > 0 ? (100 * item.green) / item.n : null;
  }

  return stats;
}

// =========================================================
// EXTRAÇÃO DA ENTRADA APROVADA
// =========================================================

function extrairEntradaAprovada(row, cfg, statsPadroes) {
  const entrada = getEntradaForCfg(row, cfg);

  if (!entrada) {
    return null;
  }

  const anchor = getAnchorEntrada(row, cfg.anchorKey);
  const veto = getVeto(row, cfg.anchorKey);

  /*
    Segurança extra:
    Se por algum motivo a tabela analises_jogos ainda tiver entrada,
    mas a telemetria diz que o padrão foi vetado, não copiamos.
  */

  if (anchor?.veto_operacional === true) {
    return null;
  }

  if (anchor?.padrao_operacional_permitido === false) {
    return null;
  }

  if (veto?.mudou === true || String(veto?.entrada_depois || '') === 'NO BET') {
    return null;
  }

  const grupo = anchor?.grupo_padrao_operacional || null;
  const motivo = anchor?.motivo_padrao_operacional || null;
  const confianca = anchor?.confianca_padrao_operacional || null;

  const scoreAntes = round2(anchor?.score_antes_ancora);
  const scoreFinal = round2(anchor?.score_final);

  const anchorDelta = round2(anchor?.anchor_delta_entrada);
  const casaDelta = round2(anchor?.casa_delta_entrada);
  const deltaTotal = round2(anchor?.delta_total_entrada);

  const probRobo = round2(getFirstValue(row, cfg.probRoboField));
  const oddJusta = round4(getFirstValue(row, cfg.oddJustaField));

  const probCasa = round2(getFirstValue(row, cfg.probCasaField));
  const oddCasa = round4(getFirstValue(row, cfg.oddCasaField));

  const statKey = `${cfg.mercado}::${grupo || 'sem_grupo'}`;
  const audit = statsPadroes.get(statKey) || {
    n: 0,
    green: 0,
    red: 0,
    hitRate: null,
  };

  const classeEntrada = classificarEntradaOperacional({
    mercado: cfg.mercado,
    grupo,
    confianca,
    scoreFinal,
    auditHitRate: audit.hitRate,
    auditN: audit.n,
  });

  const explicacao = montarExplicacaoEntrada({
    mercado: cfg.mercado,
    mercadoLabel: cfg.label,
    entrada,
    grupo,
    motivo,
    confianca,
    scoreFinal,
    probRobo,
    probCasa,
    audit,
  });

  return {
    flashscore_id_jogo: row.flashscore_id_jogo,
    data_jogo: row.data_jogo,
    hora_jogo: row.hora_jogo,
    flashscore_slug_liga: row.flashscore_slug_liga,

    time_casa: row.time_casa,
    time_fora: row.time_fora,
    url: row.url,

    id_time_casa: row.id_time_casa,
    id_time_fora: row.id_time_fora,
    flashscore_id_casa: row.flashscore_id_casa,
    flashscore_id_fora: row.flashscore_id_fora,

    mercado: cfg.mercado,
    mercado_label: cfg.label,
    entrada,

    status_resultado:
      getFirstValue(row, cfg.statusField, 'PENDENTE') || 'PENDENTE',

    prob_robo: probRobo,
    odd_justa: oddJusta,

    prob_casa: probCasa,
    odd_casa: oddCasa,

    score_antes: scoreAntes,
    score_final: scoreFinal,

    anchor_delta: anchorDelta,
    casa_delta: casaDelta,
    delta_total: deltaTotal,

    grupo_padrao_operacional: grupo,
    motivo_padrao_operacional: motivo,
    confianca_padrao_operacional: confianca,

    classe_entrada: classeEntrada,
    explicacao_entrada: explicacao,

    padrao_auditoria_n: audit.n || 0,
    padrao_auditoria_green: audit.green || 0,
    padrao_auditoria_red: audit.red || 0,
    padrao_auditoria_hit_rate: round2(audit.hitRate),

    telemetria_entrada: {
      anchor,
      veto,
      entrada_operacional: getEntradaOperacional(row),
      auditoria_padrao: audit,
      mercado_config: {
        mercado: cfg.mercado,
        label: cfg.label,
        anchorKey: cfg.anchorKey,
        entradaField: cfg.entradaField,
        statusField: cfg.statusField,
        probRoboField: cfg.probRoboField,
        oddJustaField: cfg.oddJustaField,
        probCasaField: cfg.probCasaField,
        oddCasaField: cfg.oddCasaField,
      },
    },
  };
}

// =========================================================
// LIMPEZA / INSERT
// =========================================================

async function limparEntradasDaData(data) {
  await pool.query(
    `
    DELETE FROM entradas_aprovadas
    WHERE data_jogo::date = $1::date
    `,
    [data]
  );
}

async function inserirEntrada(e) {
  const sql = `
    INSERT INTO entradas_aprovadas (
      flashscore_id_jogo,
      data_jogo,
      hora_jogo,
      flashscore_slug_liga,

      time_casa,
      time_fora,
      url,

      id_time_casa,
      id_time_fora,
      flashscore_id_casa,
      flashscore_id_fora,

      mercado,
      mercado_label,
      entrada,

      status_resultado,

      prob_robo,
      odd_justa,

      prob_casa,
      odd_casa,

      score_antes,
      score_final,

      anchor_delta,
      casa_delta,
      delta_total,

      grupo_padrao_operacional,
      motivo_padrao_operacional,
      confianca_padrao_operacional,

      classe_entrada,
      explicacao_entrada,

      padrao_auditoria_n,
      padrao_auditoria_green,
      padrao_auditoria_red,
      padrao_auditoria_hit_rate,

      telemetria_entrada,
      atualizado_em
    )
    VALUES (
      $1, $2, $3, $4,
      $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14,
      $15,
      $16, $17,
      $18, $19,
      $20, $21,
      $22, $23, $24,
      $25, $26, $27,
      $28, $29,
      $30, $31, $32, $33,
      $34::jsonb,
      NOW()
    )
    ON CONFLICT (data_jogo, flashscore_id_jogo, mercado)
    DO UPDATE SET
      hora_jogo = EXCLUDED.hora_jogo,
      flashscore_slug_liga = EXCLUDED.flashscore_slug_liga,

      time_casa = EXCLUDED.time_casa,
      time_fora = EXCLUDED.time_fora,
      url = EXCLUDED.url,

      id_time_casa = EXCLUDED.id_time_casa,
      id_time_fora = EXCLUDED.id_time_fora,
      flashscore_id_casa = EXCLUDED.flashscore_id_casa,
      flashscore_id_fora = EXCLUDED.flashscore_id_fora,

      mercado_label = EXCLUDED.mercado_label,
      entrada = EXCLUDED.entrada,

      status_resultado = EXCLUDED.status_resultado,

      prob_robo = EXCLUDED.prob_robo,
      odd_justa = EXCLUDED.odd_justa,

      prob_casa = EXCLUDED.prob_casa,
      odd_casa = EXCLUDED.odd_casa,

      score_antes = EXCLUDED.score_antes,
      score_final = EXCLUDED.score_final,

      anchor_delta = EXCLUDED.anchor_delta,
      casa_delta = EXCLUDED.casa_delta,
      delta_total = EXCLUDED.delta_total,

      grupo_padrao_operacional = EXCLUDED.grupo_padrao_operacional,
      motivo_padrao_operacional = EXCLUDED.motivo_padrao_operacional,
      confianca_padrao_operacional = EXCLUDED.confianca_padrao_operacional,

      classe_entrada = EXCLUDED.classe_entrada,
      explicacao_entrada = EXCLUDED.explicacao_entrada,

      padrao_auditoria_n = EXCLUDED.padrao_auditoria_n,
      padrao_auditoria_green = EXCLUDED.padrao_auditoria_green,
      padrao_auditoria_red = EXCLUDED.padrao_auditoria_red,
      padrao_auditoria_hit_rate = EXCLUDED.padrao_auditoria_hit_rate,

      telemetria_entrada = EXCLUDED.telemetria_entrada,
      atualizado_em = NOW()
  `;

  await pool.query(sql, [
    e.flashscore_id_jogo,
    e.data_jogo,
    e.hora_jogo,
    e.flashscore_slug_liga,

    e.time_casa,
    e.time_fora,
    e.url,

    e.id_time_casa,
    e.id_time_fora,
    e.flashscore_id_casa,
    e.flashscore_id_fora,

    e.mercado,
    e.mercado_label,
    e.entrada,

    e.status_resultado,

    e.prob_robo,
    e.odd_justa,

    e.prob_casa,
    e.odd_casa,

    e.score_antes,
    e.score_final,

    e.anchor_delta,
    e.casa_delta,
    e.delta_total,

    e.grupo_padrao_operacional,
    e.motivo_padrao_operacional,
    e.confianca_padrao_operacional,

    e.classe_entrada,
    e.explicacao_entrada,

    e.padrao_auditoria_n,
    e.padrao_auditoria_green,
    e.padrao_auditoria_red,
    e.padrao_auditoria_hit_rate,

    JSON.stringify(e.telemetria_entrada || {}),
  ]);
}

// =========================================================
// DIAGNÓSTICO RÁPIDO DO 1X2
// =========================================================

function diagnosticar1x2(jogos, entradas) {
  const linhasComEntrada1x2 = jogos.filter(row => {
    const v = getFirstValue(row, [
      'entrada_1x2',
      'entrada_casa',
      'entrada_home',
      'entrada_fora',
      'entrada_away',
      'entrada_vencedor',
      'entrada_resultado',
    ]);

    return isEntradaValida(v);
  });

  const entradasCasa = entradas.filter(e => e.mercado === '1x2_casa');
  const entradasFora = entradas.filter(e => e.mercado === '1x2_fora');

  console.log('\n🔎 Diagnóstico 1X2:');
  console.log(`   Linhas com alguma entrada 1X2 em analises_jogos: ${linhasComEntrada1x2.length}`);
  console.log(`   Entradas 1X2_CASA geradas: ${entradasCasa.length}`);
  console.log(`   Entradas 1X2_FORA geradas: ${entradasFora.length}`);

  if (linhasComEntrada1x2.length > 0 && entradasCasa.length === 0 && entradasFora.length === 0) {
    console.log('   ⚠️ Existe entrada 1X2 na analises_jogos, mas nenhuma passou para entradas_aprovadas.');
    console.log('   Verificar se a telemetria usa anchor_entrada.casa / anchor_entrada.fora ou outro nome.');
  }
}

// =========================================================
// MAIN
// =========================================================

async function main() {
  const data = DATA_ALVO;
  const lookbackDays = LOOKBACK_DAYS;

  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    throw new Error(`DATA_ALVO inválida: ${data}`);
  }

  console.log(`\n🚀 Gerando entradas aprovadas para ${data}`);
  console.log(`📚 Janela de auditoria histórica: últimos ${lookbackDays} dias antes da data.`);

  const jogos = await carregarJogosDaData(data);
  console.log(`📌 Jogos encontrados em analises_jogos: ${jogos.length}`);

  if (!jogos.length) {
    console.log('⚠️ Nada para processar.');
    return;
  }

  const historico = await carregarHistoricoParaAuditoria(data, lookbackDays);
  console.log(`📚 Jogos históricos carregados para auditoria: ${historico.length}`);

  const statsPadroes = montarStatsPadroes(historico);

  const entradas = [];

  for (const row of jogos) {
    for (const cfg of MERCADOS) {
      const entrada = extrairEntradaAprovada(row, cfg, statsPadroes);

      if (entrada) {
        entradas.push(entrada);
      }
    }
  }

  await limparEntradasDaData(data);

  for (const e of entradas) {
    await inserirEntrada(e);
  }

  const porMercado = new Map();

  for (const e of entradas) {
    if (!porMercado.has(e.mercado)) {
      porMercado.set(e.mercado, 0);
    }

    porMercado.set(e.mercado, porMercado.get(e.mercado) + 1);
  }

  console.log(`\n✅ Entradas aprovadas geradas: ${entradas.length}`);

  for (const [mercado, qtd] of [...porMercado.entries()].sort()) {
    console.log(`   ${mercado}: ${qtd}`);
  }

  diagnosticar1x2(jogos, entradas);

  console.log('\n🏁 Finalizado.');
}

main()
  .catch(err => {
    console.error('❌ Erro:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch {}
  });