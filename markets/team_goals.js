const { criarPool } = require('../db');
const math = require('../mathEngine');

const pool = criarPool('modelo', { 
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

async function closeDb() {
  await pool.end();
}
const MODEL_CONFIG = {
  matrixLimit: 12,
  minLambda: 0.35,
  minValidGames: 10,
  baseUniversal: 1.35,
};
const CONTEXTUAL_ANCHOR_CONFIG = {
  enabled: true,

  // últimos 40 jogos do time no mesmo mando
  limit: 40,

  // amostra efetiva mínima somando os dois lados
  minEffectiveSample: 4.0,

  // mínimo por lado para BTTS, porque BTTS depende dos dois times
  minSideEffectiveSample: 1.25,

  // jogos muito distantes não entram no cálculo
  minSimilarity: 0.20,

  // caps conservadores no começo
  maxDelta: {
    over15: 1.5,
    over25: 4.0,
    over35: 1.5,
    btts_sim: 4.0,
  },

  // tolerâncias de distância para achar jogos parecidos
  tolerancias: {
    lambda_time: 0.55,
    lambda_adversario: 0.55,
    total_lambda: 0.70,
    lambda_min: 0.50,
    lambda_diff: 0.70,
    prob_pct: 16,
  },

  // peso de recência dentro dos 40 jogos
  pesoRecencia: {
    jogos_1_10: 1.00,
    jogos_11_20: 0.85,
    jogos_21_40: 0.65,
  },
};

const LAMBDA_WEIGHT_CONFIG = {
  ataque: 0.60,
  defesa: 0.40,
};

const ANCHOR_MARKET_CONFIG = {
  useOldGoalsAnchor: false,
  useNewMarketAnchor: true,
  maxDelta: {
    over15: 3.0,
    over25: 5.0,
    over35: 4.0,
    btts_sim: 5.0,
  },
};

// NOVO:
// Blend da âncora de mercado.
// Só mexe em mercados de gols.
// Não mexe no 1x2.
const ANCHOR_BLEND_CONFIG = {
  mandoPeso: 0.70,
  geralPeso: 0.30,
};

const CLASSIFICACAO_CONTEXT_CONFIG = {
  enabled: true,

  // Ajuste pequeno e capado, igual conceito da âncora.
  // Não força favorito; só reduz excesso do 1x2.
  maxDelta1x2: 3.0,

  // Não usa tabela com pouca rodada.
  minJogos: 6,

  // Se a diferença estrutural for pequena, não mexe.
  deadZone: 0.08,

  pesos: {
    pontosPorJogo: 0.60,
    saldoGolsPorJogo: 0.30,
    posicao: 0.10,
  },

  temporada: process.env.TEMPORADA_CLASSIFICACAO || '2026',
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toFiniteNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function strOrNull(v) {
  if (v === undefined || v === null) return null;
  return String(v);
}

function extrairCamposAnchorContextual(resultadoAnalise) {
  const anchor =
    resultadoAnalise?.telemetria?.anchor_mercados_aplicacao || null;

  const contextual = anchor?.contextual || {};
  const mercados = contextual?.mercados || {};
  const historico = contextual?.historico || {};
  const deltas = anchor?.deltas || {};

  return {
    anchor_tipo: strOrNull(anchor?.tipo),

    anchor_delta_over15: numOrNull(deltas?.over15),
    anchor_delta_over25: numOrNull(deltas?.over25),
    anchor_delta_over35: numOrNull(deltas?.over35),
    anchor_delta_btts: numOrNull(deltas?.btts_sim),

    anchor_hist_casa_qtd: intOrNull(historico?.casa_qtd),
    anchor_hist_fora_qtd: intOrNull(historico?.fora_qtd),

    anchor_over25_motivo: strOrNull(
      mercados?.over25?.combinado?.motivo
    ),

    anchor_btts_motivo: strOrNull(
      mercados?.btts_sim?.combinado?.motivo
    ),

    // Under 3.5 é espelho do Over 3.5.
    // Então o motivo vem do mercado over35.
    anchor_under35_motivo: strOrNull(
      mercados?.over35?.combinado?.motivo
    ),

    telemetria_anchor: anchor ? JSON.stringify(anchor) : null,
  };
}
async function atualizarTelemetriaAnchorAnalise(db, flashscoreIdJogo, resultadoAnalise) {
  if (!flashscoreIdJogo) return;

  const campos = extrairCamposAnchorContextual(resultadoAnalise);

  await db.query(
    `
      UPDATE analises_jogos
      SET
        anchor_tipo = $2,
        anchor_delta_over15 = $3,
        anchor_delta_over25 = $4,
        anchor_delta_over35 = $5,
        anchor_delta_btts = $6,

        anchor_hist_casa_qtd = $7,
        anchor_hist_fora_qtd = $8,

        anchor_over25_motivo = $9,
        anchor_btts_motivo = $10,
        anchor_under35_motivo = $11,

        telemetria_anchor = $12::jsonb
      WHERE flashscore_id_jogo = $1
    `,
    [
      flashscoreIdJogo,

      campos.anchor_tipo,

      campos.anchor_delta_over15,
      campos.anchor_delta_over25,
      campos.anchor_delta_over35,
      campos.anchor_delta_btts,

      campos.anchor_hist_casa_qtd,
      campos.anchor_hist_fora_qtd,

      campos.anchor_over25_motivo,
      campos.anchor_btts_motivo,
      campos.anchor_under35_motivo,

      campos.telemetria_anchor,
    ]
  );
}
function resolveLeagueBase(jogo) {
  const mediaLigaTotal = toFiniteNumber(jogo?.media_gols_por_jogo, null);

  if (mediaLigaTotal !== null && mediaLigaTotal > 0) {
    return mediaLigaTotal / 2;
  }

  return MODEL_CONFIG.baseUniversal;
}

function parseAnchor(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parsePerfil(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizePerfil(perfil) {
  if (!perfil) return null;

  return {
    perfil_ativo: Number(perfil.perfil_ativo || 0),
    sample_total: Number(perfil.sample_total || 0),
    sample_low_pos: Number(perfil.sample_low_pos || 0),
    ameaca_transicao: Number(perfil.ameaca_transicao || 0),
    controle_esteril: Number(perfil.controle_esteril || 0),
  };
}

function buildPerfilContext(perfilCasa, perfilFora) {
  const casaAtivo = Number(perfilCasa?.perfil_ativo || 0) === 1;
  const foraAtivo = Number(perfilFora?.perfil_ativo || 0) === 1;

  const casaTransicao = Number(perfilCasa?.ameaca_transicao || 0);
  const foraTransicao = Number(perfilFora?.ameaca_transicao || 0);

  const casaEsteril = Number(perfilCasa?.controle_esteril || 0);
  const foraEsteril = Number(perfilFora?.controle_esteril || 0);

  const casaTransicaoForte = casaAtivo && casaTransicao >= 1.0;
  const foraTransicaoForte = foraAtivo && foraTransicao >= 1.0;

  const casaControleEsterilAlto = casaAtivo && casaEsteril >= 0.05;
  const foraControleEsterilAlto = foraAtivo && foraEsteril >= 0.05;

  let over25Contexto = 'NEUTRO';

  if (casaControleEsterilAlto && foraControleEsterilAlto) {
    over25Contexto = 'ALERTA_ESTERIL_DUPLO';
  } else if (casaControleEsterilAlto || foraControleEsterilAlto) {
    over25Contexto = 'ALERTA_ESTERIL';
  } else if (casaTransicaoForte && foraTransicaoForte) {
    over25Contexto = 'FAVORAVEL_DUPLA_TRANSICAO';
  } else if (casaTransicaoForte || foraTransicaoForte) {
    over25Contexto = 'FAVORAVEL_TRANSICAO';
  }

  let bttsContexto = 'NEUTRO';

  if (casaControleEsterilAlto || foraControleEsterilAlto) {
    bttsContexto = 'ALERTA_ESTERIL';
  } else if (casaTransicaoForte && foraTransicaoForte) {
    bttsContexto = 'FAVORAVEL_DUPLA_TRANSICAO';
  } else if (casaTransicaoForte && !foraControleEsterilAlto) {
    bttsContexto = 'CASA_AGRIDE';
  } else if (foraTransicaoForte && !casaControleEsterilAlto) {
    bttsContexto = 'FORA_AGRIDE';
  }

  return {
    casa: {
      perfil_ativo: casaAtivo ? 1 : 0,
      ameaca_transicao: +casaTransicao.toFixed(3),
      controle_esteril: +casaEsteril.toFixed(3),
      transicao_forte: casaTransicaoForte ? 1 : 0,
      controle_esteril_alto: casaControleEsterilAlto ? 1 : 0,
    },
    fora: {
      perfil_ativo: foraAtivo ? 1 : 0,
      ameaca_transicao: +foraTransicao.toFixed(3),
      controle_esteril: +foraEsteril.toFixed(3),
      transicao_forte: foraTransicaoForte ? 1 : 0,
      controle_esteril_alto: foraControleEsterilAlto ? 1 : 0,
    },
    leitura_mercado: {
      over25_contexto: over25Contexto,
      btts_contexto: bttsContexto,
    },
  };
}

// =========================================================
// HELPERS DA ÂNCORA DE MERCADO
// =========================================================

function safeDiv(a, b) {
  return b > 0 ? a / b : 0;
}

function getMarket(anchor, key) {
  return anchor?.mercados?.[key] || {};
}

function getMarketRate(anchor, key) {
  return Number(getMarket(anchor, key).rate || 0);
}

function getPlacar(anchor, key) {
  return Number(anchor?.placares?.[key] || 0);
}

function getPadrao(anchor, key) {
  return Number(anchor?.padroes?.[key] || 0);
}

function countRate(count, sample) {
  return safeDiv(Number(count || 0), Math.max(Number(sample || 0), 1));
}

function centeredRate(rate, pivot = 0.5, spread = 0.25) {
  return clamp(
    (Number(rate || 0) - pivot) / Math.max(spread, 0.0001),
    -1,
    1
  );
}

function diffSignal(pos, neg, scale = 0.5) {
  return clamp(
    (Number(pos || 0) - Number(neg || 0)) / Math.max(scale, 0.0001),
    -1,
    1
  );
}

function buildAxisSignal(current, hitRef, missRef) {
  const cur = toFiniteNumber(current, null);
  const hit = toFiniteNumber(hitRef, null);
  const miss = toFiniteNumber(missRef, null);

  if (cur === null || hit === null || miss === null) {
    return {
      signal: 0,
      sep: 0,
      dist_hit: null,
      dist_miss: null,
      hit_ref: hit,
      miss_ref: miss,
    };
  }

  const sep = Math.abs(hit - miss);

  if (sep < 0.08) {
    return {
      signal: 0,
      sep,
      dist_hit: +Math.abs(cur - hit).toFixed(3),
      dist_miss: +Math.abs(cur - miss).toFixed(3),
      hit_ref: hit,
      miss_ref: miss,
    };
  }

  const distHit = Math.abs(cur - hit);
  const distMiss = Math.abs(cur - miss);
  const raw = (distMiss - distHit) / Math.max(distHit + distMiss, 0.0001);
  const sepWeight = clamp(sep / 0.45, 0, 1);

  return {
    signal: +(raw * sepWeight).toFixed(3),
    sep: +sep.toFixed(3),
    dist_hit: +distHit.toFixed(3),
    dist_miss: +distMiss.toFixed(3),
    hit_ref: hit,
    miss_ref: miss,
  };
}

function buildContextSignal(market, oppAtkAtual, oppDefAtual, weights = { atk: 0.2, def: 0.8 }) {
  const atkAxis = buildAxisSignal(
    oppAtkAtual,
    market?.qualidade_adv_ataque_media_hits,
    market?.qualidade_adv_ataque_media_miss
  );

  const defAxis = buildAxisSignal(
    oppDefAtual,
    market?.qualidade_adv_defesa_media_hits,
    market?.qualidade_adv_defesa_media_miss
  );

  const atkWeight = Number(weights.atk || 0);
  const defWeight = Number(weights.def || 0);
  const totalWeight = atkWeight + defWeight;

  if (totalWeight <= 0) {
    return {
      signal: 0,
      sep_score: 0,
      axes: {
        ataque: atkAxis,
        defesa: defAxis,
      },
    };
  }

  const signal =
    ((atkAxis.signal * atkWeight) + (defAxis.signal * defWeight)) / totalWeight;

  const sepScore =
    (((Math.min(atkAxis.sep / 0.45, 1)) * atkWeight) +
      ((Math.min(defAxis.sep / 0.45, 1)) * defWeight)) / totalWeight;

  return {
    signal: +signal.toFixed(3),
    sep_score: +sepScore.toFixed(3),
    axes: {
      ataque: atkAxis,
      defesa: defAxis,
    },
  };
}

function buildReliability(sample, rate, hits, misses, sepScore = 0) {
  const sampleW = clamp(Number(sample || 0) / 20, 0, 1);
  const hitsMissW = clamp(Math.min(Number(hits || 0), Number(misses || 0)) / 5, 0, 1);
  const rateW = clamp(0.35 + (Math.abs(Number(rate || 0) - 0.5) * 2 * 0.65), 0, 1);
  const sepW = clamp(0.5 + (Number(sepScore || 0) * 0.5), 0, 1);

  return +(
    (sampleW * 0.45) +
    (hitsMissW * 0.20) +
    (rateW * 0.25) +
    (sepW * 0.10)
  ).toFixed(3);
}

function defaultAnchorSideResult(sample = 0, rate = 0) {
  return {
    delta: 0,
    score: 0,
    reliability: 0,
    sample,
    rate,
    hits: 0,
    misses: 0,
    context_signal: 0,
    context_axes: null,
    components: {},
  };
}

function buildOverConcedeSignal(anchor, market, sample, profile = {}) {
  const bn = getMarket(anchor, 'btts_nao');

  const weights = {
    timeSofreu: profile.timeSofreu ?? 0.45,
    bttsSim: profile.bttsSim ?? 0.25,
    trocacao: profile.trocacao ?? 0.30,

    cleanSheet: profile.cleanSheet ?? 0.30,
    bttsNao: profile.bttsNao ?? 0.25,
    placarMagro: profile.placarMagro ?? 0.30,
    vitoriaSemSofrer: profile.vitoriaSemSofrer ?? 0.10,
    derrotaSemMarcar: profile.derrotaSemMarcar ?? 0.05,

    scale: profile.scale ?? 0.55,
  };

  const timeSofreuRate = countRate(market?.time_sofreu_hits, sample);
  const bttsSimRate = getMarketRate(anchor, 'btts_sim');
  const bttsNaoRate = getMarketRate(anchor, 'btts_nao');

  const cleanSheetRate = countRate(bn.clean_sheet_hits, sample);

  const trocacaoRate = countRate(getPadrao(anchor, 'jogo_trocacao'), sample);
  const placarMagroRate = countRate(getPadrao(anchor, 'placar_magro'), sample);
  const vitoriaSemSofrerRate = countRate(getPadrao(anchor, 'vitoria_sem_sofrer'), sample);
  const derrotaSemMarcarRate = countRate(getPadrao(anchor, 'derrota_sem_marcar'), sample);

  const concedePositive =
    (timeSofreuRate * weights.timeSofreu) +
    (bttsSimRate * weights.bttsSim) +
    (trocacaoRate * weights.trocacao);

  const concedeNegative =
    (cleanSheetRate * weights.cleanSheet) +
    (bttsNaoRate * weights.bttsNao) +
    (placarMagroRate * weights.placarMagro) +
    (vitoriaSemSofrerRate * weights.vitoriaSemSofrer) +
    (derrotaSemMarcarRate * weights.derrotaSemMarcar);

  const signal = diffSignal(concedePositive, concedeNegative, weights.scale);

  return {
    signal,
    components: {
      concede_signal: +signal.toFixed(3),
      concede_positive: +concedePositive.toFixed(3),
      concede_negative: +concedeNegative.toFixed(3),

      time_sofreu_rate: +timeSofreuRate.toFixed(3),
      btts_sim_rate: +bttsSimRate.toFixed(3),
      btts_nao_rate: +bttsNaoRate.toFixed(3),
      clean_sheet_rate: +cleanSheetRate.toFixed(3),
      trocacao_rate: +trocacaoRate.toFixed(3),
      placar_magro_rate: +placarMagroRate.toFixed(3),
      vitoria_sem_sofrer_rate: +vitoriaSemSofrerRate.toFixed(3),
      derrota_sem_marcar_rate: +derrotaSemMarcarRate.toFixed(3),
    },
  };
}

function calcOver15AnchorSide(anchor, oppAtkAtual, oppDefAtual, maxDelta) {
  const sample = Number(anchor?.sample || 0);
  const m = getMarket(anchor, 'over15');
  const hits = Number(m.hits || 0);
  const misses = Math.max(sample - hits, 0);
  const rate = Number(m.rate || 0);

  if (sample < 10 || !m) {
    return defaultAnchorSideResult(sample, rate);
  }

  const under05Rate = getMarketRate(anchor, 'under05');
  const under15Rate = getMarketRate(anchor, 'under15');

  const timeMarcouRate = countRate(m.time_marcou_hits, sample);
  const time2plusRate = countRate(m.time_2plus_hits, sample);

  const p00 = countRate(getPlacar(anchor, '00'), sample);
  const p10 = countRate(getPlacar(anchor, '10'), sample);
  const p01 = countRate(getPlacar(anchor, '01'), sample);
  const p11 = countRate(getPlacar(anchor, '11'), sample);
  const p20 = countRate(getPlacar(anchor, '20'), sample);
  const p02 = countRate(getPlacar(anchor, '02'), sample);
  const p21 = countRate(getPlacar(anchor, '21'), sample);
  const p12 = countRate(getPlacar(anchor, '12'), sample);
  const p22 = countRate(getPlacar(anchor, '22'), sample);

  const placarMagroRate = countRate(getPadrao(anchor, 'placar_magro'), sample);

  const rateSignal = centeredRate(rate, 0.55, 0.25);

  const ownPositive = (timeMarcouRate * 0.65) + (time2plusRate * 0.35);
  const ownNegative = (under15Rate * 0.65) + (under05Rate * 0.35);
  const ownSignal = diffSignal(ownPositive, ownNegative, 0.55);

  const patternPositive = p11 + p20 + p02 + p21 + p12 + p22;
  const patternNegative = p00 + p10 + p01 + (placarMagroRate * 0.60);
  const patternSignal = diffSignal(patternPositive, patternNegative, 0.65);

  const concede = buildOverConcedeSignal(anchor, m, sample, {
    timeSofreu: 0.35,
    bttsSim: 0.20,
    trocacao: 0.20,

    cleanSheet: 0.25,
    bttsNao: 0.20,
    placarMagro: 0.40,
    vitoriaSemSofrer: 0.10,
    derrotaSemMarcar: 0.05,

    scale: 0.55,
  });

  const concedeSignal = concede.signal;

  const score =
    (rateSignal * 0.40) +
    (ownSignal * 0.30) +
    (concedeSignal * 0.10) +
    (patternSignal * 0.20);

  const reliability = buildReliability(sample, rate, hits, misses, 0);
  const delta = clamp(score * reliability * maxDelta, -maxDelta, maxDelta);

  return {
    delta: +delta.toFixed(3),
    score: +score.toFixed(3),
    reliability,
    sample,
    rate: +rate.toFixed(3),
    hits,
    misses,
    context_signal: 0,
    context_axes: null,
    components: {
      rate_signal: +rateSignal.toFixed(3),
      own_signal: +ownSignal.toFixed(3),
      pattern_signal: +patternSignal.toFixed(3),

      own_positive: +ownPositive.toFixed(3),
      own_negative: +ownNegative.toFixed(3),
      pattern_positive: +patternPositive.toFixed(3),
      pattern_negative: +patternNegative.toFixed(3),

      under05_rate: +under05Rate.toFixed(3),
      under15_rate: +under15Rate.toFixed(3),
      time_marcou_rate: +timeMarcouRate.toFixed(3),
      time_2plus_rate: +time2plusRate.toFixed(3),
      placar_magro_rate: +placarMagroRate.toFixed(3),

      ...concede.components,
    },
  };
}

function calcOver25AnchorSide(anchor, oppAtkAtual, oppDefAtual, maxDelta) {
  const sample = Number(anchor?.sample || 0);
  const m = getMarket(anchor, 'over25');
  const hits = Number(m.hits || 0);
  const misses = Math.max(sample - hits, 0);
  const rate = Number(m.rate || 0);

  if (sample < 10 || !m) {
    return defaultAnchorSideResult(sample, rate);
  }

  const under05Rate = getMarketRate(anchor, 'under05');
  const under15Rate = getMarketRate(anchor, 'under15');

  const time2plusRate = countRate(m.time_2plus_hits, sample);
  const time3plusRate = countRate(m.time_3plus_hits, sample);

  const p00 = countRate(getPlacar(anchor, '00'), sample);
  const p10 = countRate(getPlacar(anchor, '10'), sample);
  const p01 = countRate(getPlacar(anchor, '01'), sample);
  const p11 = countRate(getPlacar(anchor, '11'), sample);
  const p21 = countRate(getPlacar(anchor, '21'), sample);
  const p12 = countRate(getPlacar(anchor, '12'), sample);
  const p22 = countRate(getPlacar(anchor, '22'), sample);

  const trocacaoRate = countRate(getPadrao(anchor, 'jogo_trocacao'), sample);
  const placarMagroRate = countRate(getPadrao(anchor, 'placar_magro'), sample);

  const rateSignal = centeredRate(rate, 0.50, 0.25);

  const ownPositive = (time2plusRate * 0.50) + (time3plusRate * 0.50);
  const ownNegative = (under15Rate * 0.70) + (under05Rate * 0.30);
  const ownSignal = diffSignal(ownPositive, ownNegative, 0.55);

  const patternPositive = p21 + p12 + p22 + (trocacaoRate * 0.70);
  const patternNegative = p00 + p10 + p01 + p11 + (placarMagroRate * 0.70);
  const patternSignal = diffSignal(patternPositive, patternNegative, 0.60);

  const concede = buildOverConcedeSignal(anchor, m, sample, {
    timeSofreu: 0.45,
    bttsSim: 0.25,
    trocacao: 0.30,

    cleanSheet: 0.25,
    bttsNao: 0.25,
    placarMagro: 0.35,
    vitoriaSemSofrer: 0.10,
    derrotaSemMarcar: 0.05,

    scale: 0.55,
  });

  const concedeSignal = concede.signal;

  const score =
    (rateSignal * 0.30) +
    (ownSignal * 0.30) +
    (concedeSignal * 0.20) +
    (patternSignal * 0.20);

  const reliability = buildReliability(sample, rate, hits, misses, 0);
  const delta = clamp(score * reliability * maxDelta, -maxDelta, maxDelta);

  return {
    delta: +delta.toFixed(3),
    score: +score.toFixed(3),
    reliability,
    sample,
    rate: +rate.toFixed(3),
    hits,
    misses,
    context_signal: 0,
    context_axes: null,
    components: {
      rate_signal: +rateSignal.toFixed(3),
      own_signal: +ownSignal.toFixed(3),
      pattern_signal: +patternSignal.toFixed(3),

      own_positive: +ownPositive.toFixed(3),
      own_negative: +ownNegative.toFixed(3),
      pattern_positive: +patternPositive.toFixed(3),
      pattern_negative: +patternNegative.toFixed(3),

      under05_rate: +under05Rate.toFixed(3),
      under15_rate: +under15Rate.toFixed(3),
      time_2plus_rate: +time2plusRate.toFixed(3),
      time_3plus_rate: +time3plusRate.toFixed(3),
      trocacao_rate: +trocacaoRate.toFixed(3),
      placar_magro_rate: +placarMagroRate.toFixed(3),

      ...concede.components,
    },
  };
}

function calcOver35AnchorSide(anchor, oppAtkAtual, oppDefAtual, maxDelta) {
  const sample = Number(anchor?.sample || 0);
  const m = getMarket(anchor, 'over35');
  const m25 = getMarket(anchor, 'over25');
  const hits = Number(m.hits || 0);
  const misses = Math.max(sample - hits, 0);
  const rate = Number(m.rate || 0);

  if (sample < 10 || !m) {
    return defaultAnchorSideResult(sample, rate);
  }

  const under15Rate = getMarketRate(anchor, 'under15');
  const placarMagroRate = countRate(getPadrao(anchor, 'placar_magro'), sample);
  const trocacaoRate = countRate(getPadrao(anchor, 'jogo_trocacao'), sample);

  const time3plusRate = countRate(m.time_3plus_hits, sample);
  const time3plusOver25Rate = countRate(m25.time_3plus_hits, sample);

  const p00 = countRate(getPlacar(anchor, '00'), sample);
  const p10 = countRate(getPlacar(anchor, '10'), sample);
  const p01 = countRate(getPlacar(anchor, '01'), sample);
  const p11 = countRate(getPlacar(anchor, '11'), sample);
  const p20 = countRate(getPlacar(anchor, '20'), sample);
  const p02 = countRate(getPlacar(anchor, '02'), sample);
  const p21 = countRate(getPlacar(anchor, '21'), sample);
  const p12 = countRate(getPlacar(anchor, '12'), sample);
  const p22 = countRate(getPlacar(anchor, '22'), sample);

  const rateSignal = centeredRate(rate, 0.25, 0.20);

  const ownPositive = (time3plusRate * 0.70) + (time3plusOver25Rate * 0.30);
  const ownNegative = (under15Rate * 0.70) + (placarMagroRate * 0.30);
  const ownSignal = diffSignal(ownPositive, ownNegative, 0.50);

  const patternPositive = p21 + p12 + p22 + (trocacaoRate * 0.90);
  const patternNegative = p00 + p10 + p01 + p11 + p20 + p02 + (placarMagroRate * 0.80);
  const patternSignal = diffSignal(patternPositive, patternNegative, 0.55);

  const concede = buildOverConcedeSignal(anchor, m, sample, {
    timeSofreu: 0.30,
    bttsSim: 0.20,
    trocacao: 0.50,

    cleanSheet: 0.20,
    bttsNao: 0.20,
    placarMagro: 0.45,
    vitoriaSemSofrer: 0.10,
    derrotaSemMarcar: 0.05,

    scale: 0.55,
  });

  const concedeSignal = concede.signal;

  const score =
    (rateSignal * 0.25) +
    (ownSignal * 0.30) +
    (concedeSignal * 0.15) +
    (patternSignal * 0.30);

  let reliability = buildReliability(sample, rate, hits, misses, 0);
  if (hits < 2) reliability = +(reliability * 0.50).toFixed(3);

  const delta = clamp(score * reliability * maxDelta, -maxDelta, maxDelta);

  return {
    delta: +delta.toFixed(3),
    score: +score.toFixed(3),
    reliability,
    sample,
    rate: +rate.toFixed(3),
    hits,
    misses,
    context_signal: 0,
    context_axes: null,
    components: {
      rate_signal: +rateSignal.toFixed(3),
      own_signal: +ownSignal.toFixed(3),
      pattern_signal: +patternSignal.toFixed(3),

      own_positive: +ownPositive.toFixed(3),
      own_negative: +ownNegative.toFixed(3),
      pattern_positive: +patternPositive.toFixed(3),
      pattern_negative: +patternNegative.toFixed(3),

      under15_rate: +under15Rate.toFixed(3),
      time_3plus_rate: +time3plusRate.toFixed(3),
      time_3plus_over25_rate: +time3plusOver25Rate.toFixed(3),
      trocacao_rate: +trocacaoRate.toFixed(3),
      placar_magro_rate: +placarMagroRate.toFixed(3),

      ...concede.components,
    },
  };
}

function calcBttsAnchorSide(anchor, oppAtkAtual, oppDefAtual, maxDelta) {
  const sample = Number(anchor?.sample || 0);
  const m = getMarket(anchor, 'btts_sim');
  const bn = getMarket(anchor, 'btts_nao');
  const hits = Number(m.hits || 0);
  const misses = Math.max(sample - hits, 0);
  const rate = Number(m.rate || 0);

  if (sample < 10 || !m) {
    return defaultAnchorSideResult(sample, rate);
  }

  const under05Rate = getMarketRate(anchor, 'under05');
  const under15Rate = getMarketRate(anchor, 'under15');

  const timeMarcouRate = countRate(m.time_marcou_hits, sample);
  const timeSofreuRate = countRate(m.time_sofreu_hits, sample);
  const passouEmBrancoRate = countRate(bn.time_passou_em_branco_hits, sample);
  const cleanSheetRate = countRate(bn.clean_sheet_hits, sample);

  const p00 = countRate(getPlacar(anchor, '00'), sample);
  const p10 = countRate(getPlacar(anchor, '10'), sample);
  const p01 = countRate(getPlacar(anchor, '01'), sample);
  const p11 = countRate(getPlacar(anchor, '11'), sample);
  const p21 = countRate(getPlacar(anchor, '21'), sample);
  const p12 = countRate(getPlacar(anchor, '12'), sample);
  const p22 = countRate(getPlacar(anchor, '22'), sample);

  const trocacaoRate = countRate(getPadrao(anchor, 'jogo_trocacao'), sample);
  const placarMagroRate = countRate(getPadrao(anchor, 'placar_magro'), sample);
  const vitoriaSemSofrerRate = countRate(getPadrao(anchor, 'vitoria_sem_sofrer'), sample);
  const derrotaSemMarcarRate = countRate(getPadrao(anchor, 'derrota_sem_marcar'), sample);

  const rateSignal = centeredRate(rate, 0.45, 0.25);

  const markPositive =
    (timeMarcouRate * 0.70) +
    ((p11 + p21 + p12 + p22) * 0.30);

  const markNegative =
    (passouEmBrancoRate * 0.65) +
    ((p00 + p10 + p01) * 0.35);

  const markSignal = diffSignal(markPositive, markNegative, 0.55);

  const concedePositive =
    (timeSofreuRate * 0.60) +
    (trocacaoRate * 0.40);

  const concedeNegative =
    (cleanSheetRate * 0.70) +
    (vitoriaSemSofrerRate * 0.30);

  const concedeSignal = diffSignal(concedePositive, concedeNegative, 0.55);

  const patternPositive =
    (p11 + p21 + p12 + p22) +
    (trocacaoRate * 0.70);

  const patternNegative =
    (p00 + p10 + p01) +
    (placarMagroRate * 0.60) +
    (vitoriaSemSofrerRate * 0.40) +
    (derrotaSemMarcarRate * 0.40) +
    (under05Rate * 0.40) +
    (under15Rate * 0.60);

  const patternSignal = diffSignal(patternPositive, patternNegative, 0.70);

  const score =
    (rateSignal * 0.25) +
    (markSignal * 0.30) +
    (concedeSignal * 0.20) +
    (patternSignal * 0.25);

  const reliability = buildReliability(sample, rate, hits, misses, 0);
  const delta = clamp(score * reliability * maxDelta, -maxDelta, maxDelta);

  return {
    delta: +delta.toFixed(3),
    score: +score.toFixed(3),
    reliability,
    sample,
    rate: +rate.toFixed(3),
    hits,
    misses,
    context_signal: 0,
    context_axes: null,
    components: {
      rate_signal: +rateSignal.toFixed(3),
      mark_signal: +markSignal.toFixed(3),
      concede_signal: +concedeSignal.toFixed(3),
      pattern_signal: +patternSignal.toFixed(3),

      mark_positive: +markPositive.toFixed(3),
      mark_negative: +markNegative.toFixed(3),
      concede_positive: +concedePositive.toFixed(3),
      concede_negative: +concedeNegative.toFixed(3),
      pattern_positive: +patternPositive.toFixed(3),
      pattern_negative: +patternNegative.toFixed(3),

      under05_rate: +under05Rate.toFixed(3),
      under15_rate: +under15Rate.toFixed(3),
      time_marcou_rate: +timeMarcouRate.toFixed(3),
      time_sofreu_rate: +timeSofreuRate.toFixed(3),
      passou_em_branco_rate: +passouEmBrancoRate.toFixed(3),
      clean_sheet_rate: +cleanSheetRate.toFixed(3),
      trocacao_rate: +trocacaoRate.toFixed(3),
      placar_magro_rate: +placarMagroRate.toFixed(3),
      vitoria_sem_sofrer_rate: +vitoriaSemSofrerRate.toFixed(3),
      derrota_sem_marcar_rate: +derrotaSemMarcarRate.toFixed(3),
    },
  };
}

function combineAverageReinforced(homeSide, awaySide, maxDelta) {
  const dHome = Number(homeSide?.delta || 0);
  const dAway = Number(awaySide?.delta || 0);

  let combined = (dHome + dAway) / 2;

  if (dHome !== 0 && dAway !== 0) {
    if (Math.sign(dHome) === Math.sign(dAway)) {
      combined *= 1.20;
    } else {
      combined *= 0.55;
    }
  }

  return clamp(combined, -maxDelta, maxDelta);
}

function combineBttsDelta(homeSide, awaySide, maxDelta) {
  const sHome = Number(homeSide?.score || 0) * Number(homeSide?.reliability || 0);
  const sAway = Number(awaySide?.score || 0) * Number(awaySide?.reliability || 0);

  const minSide = Math.min(sHome, sAway);
  const avgSide = (sHome + sAway) / 2;

  const combinedScore = (minSide * 0.70) + (avgSide * 0.30);
  return clamp(combinedScore * maxDelta, -maxDelta, maxDelta);
}

// NOVO:
// Mistura a âncora específica de mando com a âncora geral 40.
// Só usada nos mercados de gols.
function blendAnchorDelta(deltaMando, deltaGeral, maxDelta) {
  const dMando = Number(deltaMando || 0);
  const dGeral = Number(deltaGeral || 0);

  const blended =
    (dMando * ANCHOR_BLEND_CONFIG.mandoPeso) +
    (dGeral * ANCHOR_BLEND_CONFIG.geralPeso);

  return clamp(blended, -maxDelta, maxDelta);
}

// =========================================================
// CLASSIFICAÇÃO 1X2 - AJUSTE PÓS-MATRIZ
// =========================================================

async function buscarClassificacaoDoJogo(jogo) {
  if (!CLASSIFICACAO_CONTEXT_CONFIG.enabled) {
    return {
      casa: null,
      fora: null,
      totalTimesLiga: 0,
      motivo: 'classificacao_desligada',
    };
  }

  const temporada = CLASSIFICACAO_CONTEXT_CONFIG.temporada;

  if (jogo.id_competicao) {
    const res = await pool.query(
      `
        SELECT *
        FROM classificacao_geral_2026
        WHERE temporada = $1
          AND classificacao_tipo = 'Geral'
          AND id_competicao = $2
          AND id_time IN ($3, $4)
      `,
      [
        temporada,
        jogo.id_competicao,
        jogo.id_time_casa,
        jogo.id_time_fora,
      ]
    );

    const totalRes = await pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM classificacao_geral_2026
        WHERE temporada = $1
          AND classificacao_tipo = 'Geral'
          AND id_competicao = $2
      `,
      [temporada, jogo.id_competicao]
    );

    return {
      casa: res.rows.find(r => Number(r.id_time) === Number(jogo.id_time_casa)) || null,
      fora: res.rows.find(r => Number(r.id_time) === Number(jogo.id_time_fora)) || null,
      totalTimesLiga: Number(totalRes.rows[0]?.total || 0),
      motivo: 'por_id_competicao',
    };
  }

  const res = await pool.query(
    `
      SELECT *
      FROM classificacao_geral_2026
      WHERE temporada = $1
        AND classificacao_tipo = 'Geral'
        AND id_time IN ($2, $3)
ORDER BY id DESC    `,
    [
      temporada,
      jogo.id_time_casa,
      jogo.id_time_fora,
    ]
  );

  const casa = res.rows.find(r => Number(r.id_time) === Number(jogo.id_time_casa)) || null;
  const fora = res.rows.find(r => Number(r.id_time) === Number(jogo.id_time_fora)) || null;

  let totalTimesLiga = 0;

  const idCompeticaoRef = casa?.id_competicao || fora?.id_competicao || null;

  if (idCompeticaoRef) {
    const totalRes = await pool.query(
      `
        SELECT COUNT(*)::int AS total
        FROM classificacao_geral_2026
        WHERE temporada = $1
          AND classificacao_tipo = 'Geral'
          AND id_competicao = $2
      `,
      [temporada, idCompeticaoRef]
    );

    totalTimesLiga = Number(totalRes.rows[0]?.total || 0);
  }

  return {
    casa,
    fora,
    totalTimesLiga,
    motivo: 'fallback_por_id_time',
  };
}

function calcularScoreClassificacao(row, totalTimesLiga = 20) {
  if (!row) {
    return {
      ativo: false,
      score: 0,
      motivo: 'sem_classificacao',
    };
  }

  const jogos = Number(row.jogos || 0);

  if (jogos < CLASSIFICACAO_CONTEXT_CONFIG.minJogos) {
    return {
      ativo: false,
      score: 0,
      motivo: 'amostra_baixa',
      jogos,
    };
  }

  const totalTimes = Number(totalTimesLiga || 20) > 1
    ? Number(totalTimesLiga || 20)
    : 20;

  const ppg = Number(row.pontos_por_jogo || 0);
  const saldoPg = Number(row.saldo_gols_por_jogo || 0);
  const posicao = Number(row.posicao_final || totalTimes);

  const posNorm =
    totalTimes > 1
      ? 1 - ((posicao - 1) / (totalTimes - 1))
      : 0.5;

  const ppgNorm = clamp(ppg / 3, 0, 1);

  // saldo por jogo:
  // -2 vira 0, 0 vira 0.5, +2 vira 1.
  const saldoNorm = clamp((saldoPg + 2) / 4, 0, 1);

  const pesos = CLASSIFICACAO_CONTEXT_CONFIG.pesos;

  const score =
    (ppgNorm * pesos.pontosPorJogo) +
    (saldoNorm * pesos.saldoGolsPorJogo) +
    (posNorm * pesos.posicao);

  return {
    ativo: true,
    score: +score.toFixed(4),
    jogos,
    ppg: +ppg.toFixed(3),
    saldo_pg: +saldoPg.toFixed(3),
    posicao,
    pos_norm: +posNorm.toFixed(4),
    ppg_norm: +ppgNorm.toFixed(4),
    saldo_norm: +saldoNorm.toFixed(4),
    nome_time: row.nome_time,
    id_time: row.id_time,
    id_competicao: row.id_competicao,
  };
}

function calcularDeltaClassificacao(classCasa, classFora, totalTimesLiga) {
  if (!CLASSIFICACAO_CONTEXT_CONFIG.enabled) {
    return {
      aplicado: false,
      delta: 0,
      motivo: 'classificacao_desligada',
    };
  }

  const casa = calcularScoreClassificacao(classCasa, totalTimesLiga);
  const fora = calcularScoreClassificacao(classFora, totalTimesLiga);

  if (!casa.ativo || !fora.ativo) {
    return {
      aplicado: false,
      delta: 0,
      motivo: 'score_inativo',
      casa,
      fora,
    };
  }

  // positivo favorece casa, negativo favorece fora
  const edge = casa.score - fora.score;

  if (Math.abs(edge) < CLASSIFICACAO_CONTEXT_CONFIG.deadZone) {
    return {
      aplicado: false,
      delta: 0,
      motivo: 'dead_zone',
      edge: +edge.toFixed(4),
      casa,
      fora,
    };
  }

  // edge 0.30 é uma diferença estrutural forte e já bate no maxDelta.
  const signal = clamp(edge / 0.30, -1, 1);

  const sampleMin = Math.min(casa.jogos, fora.jogos);
  const reliability = clamp(sampleMin / 12, 0, 1);

  const delta = clamp(
    signal * reliability * CLASSIFICACAO_CONTEXT_CONFIG.maxDelta1x2,
    -CLASSIFICACAO_CONTEXT_CONFIG.maxDelta1x2,
    CLASSIFICACAO_CONTEXT_CONFIG.maxDelta1x2
  );

  return {
    aplicado: true,
    delta: +delta.toFixed(3),
    edge: +edge.toFixed(4),
    signal: +signal.toFixed(3),
    reliability: +reliability.toFixed(3),
    max_delta: CLASSIFICACAO_CONTEXT_CONFIG.maxDelta1x2,
    casa,
    fora,
  };
}

function aplicarClassificacaoNo1x2(probHomePct, probDrawPct, probAwayPct, classCasa, classFora, totalTimesLiga) {
  const contexto = calcularDeltaClassificacao(classCasa, classFora, totalTimesLiga);

  const raw = {
    home: +Number(probHomePct || 0).toFixed(2),
    draw: +Number(probDrawPct || 0).toFixed(2),
    away: +Number(probAwayPct || 0).toFixed(2),
  };

  if (!contexto.aplicado || Number(contexto.delta || 0) === 0) {
    return {
      home: raw.home,
      draw: raw.draw,
      away: raw.away,
      raw,
      contexto,
    };
  }

  const delta = Number(contexto.delta || 0);

  let home = raw.home + delta;
  let away = raw.away - delta;

  // Empate mexe pouco.
  let draw = raw.draw - Math.abs(delta) * 0.10;

  home = clamp(home, 0.1, 99.8);
  draw = clamp(draw, 0.1, 99.8);
  away = clamp(away, 0.1, 99.8);

  const soma = home + draw + away;

  return {
    home: +(home / soma * 100).toFixed(2),
    draw: +(draw / soma * 100).toFixed(2),
    away: +(away / soma * 100).toFixed(2),
    raw,
    contexto,
  };
}

function oddJustaFromPct(probPct) {
  const p = Number(probPct);

  if (!Number.isFinite(p) || p <= 0) return 0;

  // Protege numeric(5,2)
  return Math.min(999.99, +(100 / p).toFixed(2));
}

// =========================================================
// MOTOR PRINCIPAL
// =========================================================
function getJsonNumber(obj, path, fallback = 0) {
  try {
    const parts = path.split('.');
    let cur = obj;

    for (const p of parts) {
      if (cur == null) return fallback;
      cur = cur[p];
    }

    const n = Number(cur);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function extrairTelemetriaHistoricaAnchor(ctxHist) {
  const n = (path) => getJsonNumber(ctxHist, path, null);

  const lado = ctxHist?.lado_time;
  const isCasa = lado === 'casa';

  const casaRatingAtaque = n('rating_usado.casa_rating_ataque');
  const casaRatingDefesa = n('rating_usado.casa_rating_defesa');
  const foraRatingAtaque = n('rating_usado.fora_rating_ataque');
  const foraRatingDefesa = n('rating_usado.fora_rating_defesa');

  return {
    // Placar real
    gols_home: n('metricas_reais.gols_home'),
    gols_away: n('metricas_reais.gols_away'),
    gols_total: n('metricas_reais.gols_total'),

    // xG separado
    xg_home: n('metricas_reais.xg_home'),
    xg_away: n('metricas_reais.xg_away'),
    xg_time: n('metricas_reais.xg_time'),
    xg_adversario: n('metricas_reais.xg_adversario'),
    xg_total: n('metricas_reais.xg_total'),

    // xGOT separado
    xgot_home: n('metricas_reais.xgot_home'),
    xgot_away: n('metricas_reais.xgot_away'),
    xgot_time: n('metricas_reais.xgot_time'),
    xgot_adversario: n('metricas_reais.xgot_adversario'),
    xgot_total: n('metricas_reais.xgot_total'),

    // xG contra separado
    xg_contra_home: n('metricas_reais.xg_contra_home'),
    xg_contra_away: n('metricas_reais.xg_contra_away'),
    xg_contra_time: n('metricas_reais.xg_contra_time'),
    xg_contra_adversario: n('metricas_reais.xg_contra_adversario'),
    xg_contra_total: n('metricas_reais.xg_contra_total'),

    // xGA no banco = xGOT enfrentado
    xga_home: n('metricas_reais.xga_home'),
    xga_away: n('metricas_reais.xga_away'),
    xga_time: n('metricas_reais.xga_time'),
    xga_adversario: n('metricas_reais.xga_adversario'),
    xga_total: n('metricas_reais.xga_total'),

    // Rating bruto do confronto
    casa_rating_ataque: casaRatingAtaque,
    casa_rating_defesa: casaRatingDefesa,
    fora_rating_ataque: foraRatingAtaque,
    fora_rating_defesa: foraRatingDefesa,

    // Rating pela perspectiva do lado analisado
    rating_time_ataque: isCasa ? casaRatingAtaque : foraRatingAtaque,
    rating_time_defesa: isCasa ? casaRatingDefesa : foraRatingDefesa,
    rating_adversario_ataque: isCasa ? foraRatingAtaque : casaRatingAtaque,
    rating_adversario_defesa: isCasa ? foraRatingDefesa : casaRatingDefesa,

    pesos_lambda: ctxHist?.rating_usado?.pesos_lambda || null,
  };
}
function scoreDistancia(valorAtual, valorHist, tolerancia) {
  const atual = Number(valorAtual);
  const hist = Number(valorHist);

  if (!Number.isFinite(atual) || !Number.isFinite(hist)) return 0;

  const dist = Math.abs(atual - hist);
  return clamp(1 - (dist / Math.max(tolerancia, 0.0001)), 0, 1);
}

function pesoRecenciaContextual(idx) {
  if (idx < 10) return CONTEXTUAL_ANCHOR_CONFIG.pesoRecencia.jogos_1_10;
  if (idx < 20) return CONTEXTUAL_ANCHOR_CONFIG.pesoRecencia.jogos_11_20;
  return CONTEXTUAL_ANCHOR_CONFIG.pesoRecencia.jogos_21_40;
}

function classificarRegimeLambdaContextual(lA, lB) {
  const lambdaA = Number(lA || 0);
  const lambdaB = Number(lB || 0);

  const total = lambdaA + lambdaB;
  const minL = Math.min(lambdaA, lambdaB);
  const diff = Math.abs(lambdaA - lambdaB);

  if (total < 2.40) return 'baixo_total';

  if (total >= 2.70 && minL >= 1.00 && diff <= 0.65) {
    return 'trocacao';
  }

  if (total >= 2.70 && diff > 0.80) {
    return 'dominio_favorito';
  }

  return 'neutro';
}

function scoreRegimeContextual(regimeAtual, regimeHist) {
  if (!regimeAtual || !regimeHist) return 0;

  if (regimeAtual === regimeHist) return 1;

  // Neutro conversa um pouco com todos.
  if (regimeAtual === 'neutro' || regimeHist === 'neutro') return 0.45;

  // Trocação e domínio são ambos jogos de total alto, mas natureza diferente.
  if (
    (regimeAtual === 'trocacao' && regimeHist === 'dominio_favorito') ||
    (regimeAtual === 'dominio_favorito' && regimeHist === 'trocacao')
  ) {
    return 0.25;
  }

  return 0.10;
}

function montarContextoAtualLado({ lado, lTime, lAdv, probO15Raw, probO25Raw, probO35Raw, probBTTSRaw }) {
  const lambdaTime = Number(lTime || 0);
  const lambdaAdv = Number(lAdv || 0);
  const total = lambdaTime + lambdaAdv;
  const lambdaMin = Math.min(lambdaTime, lambdaAdv);
  const lambdaMax = Math.max(lambdaTime, lambdaAdv);
  const lambdaDiff = Math.abs(lambdaTime - lambdaAdv);

  return {
    lado,

    lambda_time: lambdaTime,
    lambda_adversario: lambdaAdv,

    total_lambda: total,
    lambda_min: lambdaMin,
    lambda_max: lambdaMax,
    lambda_diff: lambdaDiff,

    p_over15: Number(probO15Raw || 0),
    p_over25: Number(probO25Raw || 0),
    p_over35: Number(probO35Raw || 0),
    p_under35: 100 - Number(probO35Raw || 0),
    p_btts_sim: Number(probBTTSRaw || 0),

    regime: classificarRegimeLambdaContextual(lambdaTime, lambdaAdv),
  };
}

function montarContextoHistoricoLado(ctx) {
  const lado = ctx?.lado_time;

  const lHome = getJsonNumber(ctx, 'l_home_modelo', 0);
  const lAway = getJsonNumber(ctx, 'l_away_modelo', 0);

  const isCasa = lado === 'casa';

  const lambdaTime = isCasa ? lHome : lAway;
  const lambdaAdv = isCasa ? lAway : lHome;

  const total = getJsonNumber(ctx, 'lambda_total_modelo', lHome + lAway);
  const lambdaMin = getJsonNumber(ctx, 'lambda_min_modelo', Math.min(lHome, lAway));
  const lambdaMax = getJsonNumber(ctx, 'lambda_max_modelo', Math.max(lHome, lAway));
  const lambdaDiff = getJsonNumber(ctx, 'lambda_diff_modelo', Math.abs(lHome - lAway));

  return {
    lado,

    lambda_time: lambdaTime,
    lambda_adversario: lambdaAdv,

    total_lambda: total,
    lambda_min: lambdaMin,
    lambda_max: lambdaMax,
    lambda_diff: lambdaDiff,

    p_over15: getJsonNumber(ctx, 'p_over15_modelo', 0),
    p_over25: getJsonNumber(ctx, 'p_over25_modelo', 0),
    p_over35: getJsonNumber(ctx, 'p_over35_modelo', 0),
    p_under35: getJsonNumber(ctx, 'p_under35_modelo', 0),
    p_btts_sim: getJsonNumber(ctx, 'p_btts_sim_modelo', 0),

    regime: classificarRegimeLambdaContextual(lHome, lAway),
  };
}

function getPesosSimilaridadeMercado(mercado) {
  if (mercado === 'btts_sim') {
    return {
      lambda_min: 0.30,
      lambda_time: 0.20,
      lambda_adversario: 0.20,
      lambda_diff: 0.15,
      prob: 0.10,
      regime: 0.05,
      total_lambda: 0.00,
    };
  }

  if (mercado === 'over25') {
    return {
      lambda_time: 0.20,
      lambda_adversario: 0.20,
      total_lambda: 0.20,
      lambda_min: 0.15,
      lambda_diff: 0.10,
      prob: 0.10,
      regime: 0.05,
    };
  }

  if (mercado === 'over35') {
    return {
      total_lambda: 0.30,
      lambda_time: 0.15,
      lambda_adversario: 0.15,
      lambda_min: 0.15,
      lambda_diff: 0.10,
      prob: 0.10,
      regime: 0.05,
    };
  }

  // over15
  return {
    total_lambda: 0.25,
    lambda_time: 0.20,
    lambda_adversario: 0.15,
    lambda_min: 0.10,
    lambda_diff: 0.10,
    prob: 0.15,
    regime: 0.05,
  };
}

function getProbMercadoContexto(ctx, mercado) {
  if (mercado === 'over15') return Number(ctx.p_over15 || 0);
  if (mercado === 'over25') return Number(ctx.p_over25 || 0);
  if (mercado === 'over35') return Number(ctx.p_over35 || 0);
  if (mercado === 'btts_sim') return Number(ctx.p_btts_sim || 0);
  return 0;
}

function getResidualMercadoHistorico(ctx, mercado) {
  if (mercado === 'over15') {
    return getJsonNumber(ctx, 'residual_real_vs_modelo.over15_hit_menos_prob', 0);
  }

  if (mercado === 'over25') {
    return getJsonNumber(ctx, 'residual_real_vs_modelo.over25_hit_menos_prob', 0);
  }

  if (mercado === 'over35') {
    return getJsonNumber(ctx, 'residual_real_vs_modelo.over35_hit_menos_prob', 0);
  }

  if (mercado === 'btts_sim') {
    return getJsonNumber(ctx, 'residual_real_vs_modelo.btts_hit_menos_prob', 0);
  }

  return 0;
}

function getHitMercadoHistorico(ctx, mercado) {
  if (mercado === 'over15') {
    return getJsonNumber(ctx, 'resultado_real.over15', 0);
  }

  if (mercado === 'over25') {
    return getJsonNumber(ctx, 'resultado_real.over25', 0);
  }

  if (mercado === 'over35') {
    return getJsonNumber(ctx, 'resultado_real.over35', 0);
  }

  if (mercado === 'btts_sim') {
    return getJsonNumber(ctx, 'resultado_real.btts_sim', 0);
  }

  return 0;
}

function calcularSimilaridadeContextual(ctxAtual, ctxHist, mercado) {
  const pesos = getPesosSimilaridadeMercado(mercado);
  const tol = CONTEXTUAL_ANCHOR_CONFIG.tolerancias;

  const probAtual = getProbMercadoContexto(ctxAtual, mercado);
  const probHist = getProbMercadoContexto(ctxHist, mercado);

  const scores = {
    lambda_time: scoreDistancia(
      ctxAtual.lambda_time,
      ctxHist.lambda_time,
      tol.lambda_time
    ),

    lambda_adversario: scoreDistancia(
      ctxAtual.lambda_adversario,
      ctxHist.lambda_adversario,
      tol.lambda_adversario
    ),

    total_lambda: scoreDistancia(
      ctxAtual.total_lambda,
      ctxHist.total_lambda,
      tol.total_lambda
    ),

    lambda_min: scoreDistancia(
      ctxAtual.lambda_min,
      ctxHist.lambda_min,
      tol.lambda_min
    ),

    lambda_diff: scoreDistancia(
      ctxAtual.lambda_diff,
      ctxHist.lambda_diff,
      tol.lambda_diff
    ),

    prob: scoreDistancia(
      probAtual,
      probHist,
      tol.prob_pct
    ),

    regime: scoreRegimeContextual(
      ctxAtual.regime,
      ctxHist.regime
    ),
  };

  let soma = 0;
  let pesoTotal = 0;

  for (const [k, peso] of Object.entries(pesos)) {
    if (peso <= 0) continue;
    soma += Number(scores[k] || 0) * peso;
    pesoTotal += peso;
  }

  const similaridade = pesoTotal > 0 ? soma / pesoTotal : 0;

  return {
    similaridade: +similaridade.toFixed(4),
    scores,
    pesos,
  };
}

function calcularProducaoScoreContextual(ctx, mercado) {
  const prod = ctx?.residual_producao_vs_modelo || {};
  const met = ctx?.metricas_reais || {};

  const xgTotalMenosLambda = Number(prod.xg_total_menos_lambda || 0);
  const xgotTotalMenosLambda = Number(prod.xgot_total_menos_lambda || 0);
  const golsMenosXg = Number(prod.gols_total_menos_xg || 0);
  const xgotMenosXg = Number(prod.xgot_total_menos_xg_total || 0);

  if (mercado === 'btts_sim') {
    const xgHome = Number(met.xg_home || 0);
    const xgAway = Number(met.xg_away || 0);
    const xgotHome = Number(met.xgot_home || 0);
    const xgotAway = Number(met.xgot_away || 0);

    const minXg = Math.min(xgHome, xgAway);
    const minXgot = Math.min(xgotHome, xgotAway);

    const minXgScore = clamp((minXg - 0.75) / 0.75, -1, 1);
    const minXgotScore = clamp((minXgot - 0.45) / 0.65, -1, 1);

    return clamp((minXgScore * 0.65) + (minXgotScore * 0.35), -1, 1);
  }

  // Over 1.5 / 2.5 / 3.5:
  // xG e xGOT ajudam a saber se o placar foi sustentado.
  const xgScore = clamp(xgTotalMenosLambda / 1.20, -1, 1);
  const xgotScore = clamp(xgotTotalMenosLambda / 1.20, -1, 1);

  // Se saiu muito gol acima do xG, pode ter sido eficiência fora da curva.
  const overPerformancePenalty = clamp(Math.max(0, golsMenosXg) / 2.0, 0, 1);

  // Se xGOT ficou muito abaixo do xG, produção foi menos perigosa.
  const miraScore = clamp(xgotMenosXg / 1.20, -1, 1);

  return clamp(
    (xgScore * 0.50) +
    (xgotScore * 0.30) +
    (miraScore * 0.10) -
    (overPerformancePenalty * 0.10),
    -1,
    1
  );
}
function calcularEvidenciaProdutivaMercado({ hit, residual, producaoScore, mercado }) {
  const h = Number(hit || 0);
  const r = Number(residual || 0);
  const p = Number(producaoScore || 0);

  const isBtts = mercado === 'btts_sim';

  let evidencia = 0;
  let qualidade = 'neutra';

  const prodAlta = p >= 0.25;
  const prodOk = p >= 0.05;
  const prodBaixa = p <= -0.20;
  const prodMuitoBaixa = p <= -0.45;

  if (h === 1 && prodAlta) {
    evidencia = 1.00;
    qualidade = 'hit_confirmado_por_producao';
  } else if (h === 1 && prodOk) {
    evidencia = 0.70;
    qualidade = 'hit_com_producao_ok';
  } else if (h === 1 && prodBaixa) {
    evidencia = 0.15;
    qualidade = 'hit_sem_producao_forte';
  } else if (h === 1) {
    evidencia = 0.40;
    qualidade = 'hit_neutro';
  } else if (h === 0 && prodAlta) {
    evidencia = isBtts ? 0.25 : 0.35;
    qualidade = 'miss_mas_producao_aberta';
  } else if (h === 0 && prodMuitoBaixa) {
    evidencia = -1.00;
    qualidade = 'miss_confirmado_por_baixa_producao';
  } else if (h === 0 && prodBaixa) {
    evidencia = -0.70;
    qualidade = 'miss_com_baixa_producao';
  } else {
    evidencia = -0.35;
    qualidade = 'miss_neutro';
  }

  let residualAjustado = r;

  // Placar bateu, mas produção não sustentou: reduz força do residual positivo.
  if (h === 1 && prodBaixa && residualAjustado > 0) {
    residualAjustado *= 0.35;
  }

  // Placar não bateu, mas produção foi alta: não pune tanto o Over/BTTS.
  if (h === 0 && prodAlta && residualAjustado < 0) {
    residualAjustado *= 0.30;
  }

  return {
    evidencia: +clamp(evidencia, -1, 1).toFixed(3),
    residual_ajustado: +clamp(residualAjustado, -1, 1).toFixed(3),
    qualidade,
  };
}


function calcularLadoAncoraContextual({ historico, ctxAtual, mercado }) {
  const detalhes = [];

  let somaPeso = 0;

  let somaResidual = 0;
  let somaResidualAjustado = 0;

  let somaProducao = 0;
  let somaEvidenciaProdutiva = 0;

  let somaHit = 0;
  let somaProbModelo = 0;
  let somaSimilaridade = 0;

  for (const item of historico || []) {
    const ctxHist = item?.ctx;

    if (!ctxHist) {
      continue;
    }

    const ctxHistLado = montarContextoHistoricoLado(ctxHist);

    const simInfo = calcularSimilaridadeContextual(
      ctxAtual,
      ctxHistLado,
      mercado
    );

    const similaridade = Number(simInfo?.similaridade || 0);

    if (similaridade < CONTEXTUAL_ANCHOR_CONFIG.minSimilarity) {
      continue;
    }

    const recencia = pesoRecenciaContextual(item.idx);
    const pesoFinal = similaridade * recencia;

    if (!Number.isFinite(pesoFinal) || pesoFinal <= 0) {
      continue;
    }

    const residual = getResidualMercadoHistorico(ctxHist, mercado);
    const producaoScore = calcularProducaoScoreContextual(ctxHist, mercado);
    const hit = getHitMercadoHistorico(ctxHist, mercado);
    const probModelo = getProbMercadoContexto(ctxHistLado, mercado) / 100;

    const evidenciaProdutiva = calcularEvidenciaProdutivaMercado({
      hit,
      residual,
      producaoScore,
      mercado,
    });

    somaPeso += pesoFinal;

    somaResidual += Number(residual || 0) * pesoFinal;
    somaResidualAjustado += Number(evidenciaProdutiva.residual_ajustado || 0) * pesoFinal;

    somaProducao += Number(producaoScore || 0) * pesoFinal;
    somaEvidenciaProdutiva += Number(evidenciaProdutiva.evidencia || 0) * pesoFinal;

    somaHit += Number(hit || 0) * pesoFinal;
    somaProbModelo += Number(probModelo || 0) * pesoFinal;
    somaSimilaridade += similaridade * pesoFinal;

    detalhes.push({
      data_referencia: item.data_referencia,
      flashscore_id_jogo: ctxHist.flashscore_id_jogo,
      placar: ctxHist?.resultado_real?.placar || null,

      similaridade: +similaridade.toFixed(3),
      peso_recencia: +recencia.toFixed(3),
      peso_final: +pesoFinal.toFixed(3),

      regime_hist: ctxHistLado.regime,
      total_lambda_hist: +Number(ctxHistLado.total_lambda || 0).toFixed(3),
      lambda_time_hist: +Number(ctxHistLado.lambda_time || 0).toFixed(3),
      lambda_adversario_hist: +Number(ctxHistLado.lambda_adversario || 0).toFixed(3),
      lambda_min_hist: +Number(ctxHistLado.lambda_min || 0).toFixed(3),
      lambda_diff_hist: +Number(ctxHistLado.lambda_diff || 0).toFixed(3),

      prob_modelo_hist: +Number(probModelo * 100).toFixed(2),

      hit: Number(hit || 0),

      residual: +Number(residual || 0).toFixed(3),
      residual_ajustado: +Number(evidenciaProdutiva.residual_ajustado || 0).toFixed(3),

      producao_score: +Number(producaoScore || 0).toFixed(3),
      evidencia_produtiva: +Number(evidenciaProdutiva.evidencia || 0).toFixed(3),
      qualidade_evidencia: evidenciaProdutiva.qualidade,

      ...extrairTelemetriaHistoricaAnchor(ctxHist),
    });
  }

  if (somaPeso <= 0) {
    return {
      aplicado: false,
      sample_efetivo: 0,
      score: 0,

      residual_medio: 0,
      residual_score: 0,

      residual_ajustado_medio: 0,
      residual_ajustado_score: 0,

      producao_score_medio: 0,
      evidencia_produtiva_media: 0,

      hit_rate_contextual: 0,
      prob_modelo_media: 0,
      similaridade_media: 0,

      detalhes: [],
    };
  }

  const residualMedio = somaResidual / somaPeso;
  const residualAjustadoMedio = somaResidualAjustado / somaPeso;

  const producaoMedio = somaProducao / somaPeso;
  const evidenciaProdutivaMedia = somaEvidenciaProdutiva / somaPeso;

  const hitRateContextual = somaHit / somaPeso;
  const probModeloMedia = somaProbModelo / somaPeso;
  const similaridadeMedia = somaSimilaridade / somaPeso;

  const residualScore = clamp(residualMedio / 0.18, -1, 1);
  const residualAjustadoScore = clamp(residualAjustadoMedio / 0.18, -1, 1);

  /*
    Nova lógica:
    - evidenciaProdutivaMedia é o eixo principal.
    - residualAjustadoScore mantém a leitura de sub/superestimação,
      mas reduz placar enganoso.
    - producaoMedio entra como confirmação adicional.
  */
  const score =
    mercado === 'btts_sim'
      ? (
        (evidenciaProdutivaMedia * 0.55) +
        (residualAjustadoScore * 0.25) +
        (producaoMedio * 0.20)
      )
      : (
        (evidenciaProdutivaMedia * 0.60) +
        (residualAjustadoScore * 0.25) +
        (producaoMedio * 0.15)
      );

  return {
    aplicado: true,
    sample_efetivo: +somaPeso.toFixed(3),
    score: +clamp(score, -1, 1).toFixed(3),

    residual_medio: +residualMedio.toFixed(3),
    residual_score: +residualScore.toFixed(3),

    residual_ajustado_medio: +residualAjustadoMedio.toFixed(3),
    residual_ajustado_score: +residualAjustadoScore.toFixed(3),

    producao_score_medio: +producaoMedio.toFixed(3),
    evidencia_produtiva_media: +evidenciaProdutivaMedia.toFixed(3),

    hit_rate_contextual: +hitRateContextual.toFixed(3),
    prob_modelo_media: +probModeloMedia.toFixed(3),
    similaridade_media: +similaridadeMedia.toFixed(3),

    detalhes: detalhes
      .sort((a, b) => b.peso_final - a.peso_final)
      .slice(0, 12),
  };
}

async function carregarHistoricoContextualLambda({
  idTime,
  lado,
  dataJogo,
  flashscoreIdJogoAtual,
  limit,
}) {
  /*
    BLINDAGEM CONTRA VAZAMENTO:

    1. Usa data_referencia::date < dataJogo::date
       para impedir qualquer jogo do mesmo dia entrar no histórico.

    2. Exclui explicitamente o próprio flashscore_id_jogo atual.

    3. Faz a mesma exclusão de novo no JS, como trava extra.
  */

  const res = await pool.query(
    `
      SELECT
        data_referencia,
        lambda_jogo_contexto
      FROM rating_times_historico
      WHERE id_time = $1
        AND data_referencia::date < $2::date
        AND lambda_jogo_contexto IS NOT NULL
        AND lambda_jogo_contexto->>'lado_time' = $3
        AND COALESCE(lambda_jogo_contexto->>'flashscore_id_jogo', '') <> COALESCE($5, '')
      ORDER BY data_referencia DESC
      LIMIT $4
    `,
    [
      idTime,
      dataJogo,
      lado,
      limit,
      flashscoreIdJogoAtual || '',
    ]
  );

  return res.rows
    .map((r, idx) => {
      const ctx = typeof r.lambda_jogo_contexto === 'object'
        ? r.lambda_jogo_contexto
        : parseAnchor(r.lambda_jogo_contexto);

      return {
        idx,
        data_referencia: r.data_referencia,
        ctx,
      };
    })
    .filter((item) => {
      if (!item.ctx) return false;

      if (Number(item.ctx.lambda_ok || 0) !== 1) {
        return false;
      }

      const histId = String(item.ctx.flashscore_id_jogo || '');
      const atualId = String(flashscoreIdJogoAtual || '');

      if (atualId && histId && histId === atualId) {
        return false;
      }

      return true;
    });
}

function combinarLadosContextuais({ casa, fora, mercado }) {
  const maxDelta = CONTEXTUAL_ANCHOR_CONFIG.maxDelta[mercado] || 0;

  const sampleCasa = Number(casa?.sample_efetivo || 0);
  const sampleFora = Number(fora?.sample_efetivo || 0);
  const totalSample = sampleCasa + sampleFora;

  if (totalSample < CONTEXTUAL_ANCHOR_CONFIG.minEffectiveSample) {
    return {
      aplicado: false,
      motivo: 'sample_efetivo_baixo',
      delta: 0,
      score_final: 0,
      reliability: 0,
      total_sample_efetivo: +totalSample.toFixed(3),
    };
  }

  if (
    mercado === 'btts_sim' &&
    (
      sampleCasa < CONTEXTUAL_ANCHOR_CONFIG.minSideEffectiveSample ||
      sampleFora < CONTEXTUAL_ANCHOR_CONFIG.minSideEffectiveSample
    )
  ) {
    return {
      aplicado: false,
      motivo: 'btts_exige_dois_lados',
      delta: 0,
      score_final: 0,
      reliability: 0,
      total_sample_efetivo: +totalSample.toFixed(3),
    };
  }

  const scoreCasa = Number(casa?.score || 0);
  const scoreFora = Number(fora?.score || 0);

  let scoreFinal = 0;

  const temCasa = sampleCasa > 0;
  const temFora = sampleFora > 0;

  if (temCasa && temFora) {
    const media = (scoreCasa + scoreFora) / 2;

    const mesmoSinal =
      scoreCasa === 0 ||
      scoreFora === 0 ||
      Math.sign(scoreCasa) === Math.sign(scoreFora);

    if (mesmoSinal) {
      const conservador =
        media >= 0
          ? Math.min(scoreCasa, scoreFora)
          : Math.max(scoreCasa, scoreFora);

      if (mercado === 'btts_sim') {
        // BTTS depende muito dos dois lados.
        scoreFinal = (conservador * 0.70) + (media * 0.30);
      } else if (mercado === 'over25') {
        // Over 2.5 precisa de produção total, mas ainda precisa de contribuição mínima.
        scoreFinal = (media * 0.60) + (conservador * 0.40);
      } else {
        scoreFinal = (media * 0.70) + (conservador * 0.30);
      }
    } else {
      // Se os lados discordam, reduz bastante.
      scoreFinal = media * 0.35;
    }
  } else if (temCasa) {
    // Um lado sozinho pode ajudar, mas não deve mandar.
    scoreFinal = scoreCasa * 0.55;
  } else if (temFora) {
    scoreFinal = scoreFora * 0.55;
  }

  const reliability = clamp(
    totalSample / (CONTEXTUAL_ANCHOR_CONFIG.minEffectiveSample * 2),
    0,
    1
  );

  const delta = clamp(
    scoreFinal * reliability * maxDelta,
    -maxDelta,
    maxDelta
  );

  return {
    aplicado: true,
    motivo: 'ok',
    delta: +delta.toFixed(3),
    score_final: +scoreFinal.toFixed(3),
    reliability: +reliability.toFixed(3),
    total_sample_efetivo: +totalSample.toFixed(3),
  };
}

function classificarForcaAnchorMercado({
  mercado,
  delta,
  ladoCasa,
  ladoFora,
  combinado,
  atual,
}) {
  const d = Number(delta || 0);
  const absD = Math.abs(d);

  const evCasa = Number(ladoCasa?.evidencia_produtiva_media || 0);
  const evFora = Number(ladoFora?.evidencia_produtiva_media || 0);

  const resCasa = Number(ladoCasa?.residual_ajustado_score || 0);
  const resFora = Number(ladoFora?.residual_ajustado_score || 0);

  const prodCasa = Number(ladoCasa?.producao_score_medio || 0);
  const prodFora = Number(ladoFora?.producao_score_medio || 0);

  const hitCasa = Number(ladoCasa?.hit_rate_contextual || 0);
  const hitFora = Number(ladoFora?.hit_rate_contextual || 0);

  const sample = Number(combinado?.total_sample_efetivo || 0);
  const reliability = Number(combinado?.reliability || 0);
  const scoreFinal = Number(combinado?.score_final || 0);

  const regimeCasa = atual?.casa?.regime || null;
  const regimeFora = atual?.fora?.regime || null;

  const evMedia = (evCasa + evFora) / 2;
  const resMedia = (resCasa + resFora) / 2;
  const prodMedia = (prodCasa + prodFora) / 2;
  const hitMedia = (hitCasa + hitFora) / 2;

  const baixoTotal =
    regimeCasa === 'baixo_total' &&
    regimeFora === 'baixo_total';

  const neutroOuBaixo =
    ['baixo_total', 'neutro'].includes(regimeCasa) &&
    ['baixo_total', 'neutro'].includes(regimeFora);

  const trocacao =
    regimeCasa === 'trocacao' &&
    regimeFora === 'trocacao';

  const casaOverOk =
    evCasa >= 0.12 &&
    resCasa >= 0.10;

  const foraOverOk =
    evFora >= 0.12 &&
    resFora >= 0.10;

  const casaOverForte =
    evCasa >= 0.22 &&
    resCasa >= 0.25;

  const foraOverForte =
    evFora >= 0.22 &&
    resFora >= 0.25;

  const casaUnderOk =
    evCasa <= -0.08 &&
    resCasa <= -0.10;

  const foraUnderOk =
    evFora <= -0.08 &&
    resFora <= -0.10;

  const casaUnderForte =
    evCasa <= -0.18 &&
    resCasa <= -0.25;

  const foraUnderForte =
    evFora <= -0.18 &&
    resFora <= -0.25;

  const ambosOver = casaOverOk && foraOverOk;
  const umOverForte = casaOverForte || foraOverForte;

  const ambosUnder = casaUnderOk && foraUnderOk;
  const umUnderForte = casaUnderForte || foraUnderForte;

  const sinaisOver =
    Number(casaOverOk) +
    Number(foraOverOk) +
    Number(casaOverForte) +
    Number(foraOverForte) +
    Number(evMedia >= 0.15) +
    Number(resMedia >= 0.15) +
    Number(prodMedia >= 0.03) +
    Number(hitMedia >= 0.55);

  const sinaisUnder =
    Number(casaUnderOk) +
    Number(foraUnderOk) +
    Number(casaUnderForte) +
    Number(foraUnderForte) +
    Number(evMedia <= -0.06) +
    Number(resMedia <= -0.08) +
    Number(prodMedia <= -0.03) +
    Number(hitMedia <= 0.45);

  const sampleOk = sample >= 5 && reliability >= 0.60;
  const sampleBom = sample >= 8 && reliability >= 0.80;
  const sampleForte = sample >= 10 && reliability >= 0.90;
  const deltaMuitoPequeno = absD < 0.10;
  const deltaPequeno = absD < 0.25;

  const maxDelta = Number(
    CONTEXTUAL_ANCHOR_CONFIG?.maxDelta?.[mercado] || 1.5
  );

  function montarRetorno({
    decisao,
    direcao,
    peso,
    motivo,
    deltaBase,
  }) {
    const deltaAplicado = clamp(deltaBase * peso, -maxDelta, maxDelta);

    return {
      decisao,
      direcao,
      peso: +Number(peso || 0).toFixed(3),
      motivo,

      delta_original: +d.toFixed(3),
      delta_base: +Number(deltaBase || 0).toFixed(3),
      delta_ponderado: +deltaAplicado.toFixed(3),

      forca_bucket:
        Math.abs(deltaAplicado) >= 2.5 ? '04_muito_forte' :
          Math.abs(deltaAplicado) >= 1.5 ? '03_forte' :
            Math.abs(deltaAplicado) >= 0.75 ? '02_medio' :
              Math.abs(deltaAplicado) >= 0.25 ? '01_fraco' :
                '00_neutro',

      sample,
      reliability: +reliability.toFixed(3),
      score_final: +scoreFinal.toFixed(3),

      regime_casa: regimeCasa,
      regime_fora: regimeFora,
      baixo_total_duplo: baixoTotal,
      neutro_ou_baixo: neutroOuBaixo,
      trocacao_dupla: trocacao,

      ev_casa: +evCasa.toFixed(3),
      ev_fora: +evFora.toFixed(3),
      ev_media: +evMedia.toFixed(3),

      res_casa: +resCasa.toFixed(3),
      res_fora: +resFora.toFixed(3),
      res_media: +resMedia.toFixed(3),

      prod_casa: +prodCasa.toFixed(3),
      prod_fora: +prodFora.toFixed(3),
      prod_media: +prodMedia.toFixed(3),

      hit_casa: +hitCasa.toFixed(3),
      hit_fora: +hitFora.toFixed(3),
      hit_media: +hitMedia.toFixed(3),

      sinais_over: sinaisOver,
      sinais_under: sinaisUnder,

      casa_over_ok: casaOverOk,
      fora_over_ok: foraOverOk,
      casa_over_forte: casaOverForte,
      fora_over_forte: foraOverForte,

      casa_under_ok: casaUnderOk,
      fora_under_ok: foraUnderOk,
      casa_under_forte: casaUnderForte,
      fora_under_forte: foraUnderForte,
    };
  }

  if (!sampleOk) {
    return montarRetorno({
      decisao: 'ignorar',
      direcao: 'neutro',
      peso: 0,
      motivo: 'sample_ou_reliability_baixo',
      deltaBase: 0,
    });
  }

  /*
    OVER 1.5
    Mercado permissivo.
    A âncora confirma Over, mas quase nunca deve virar Under 1.5.
  */
  if (mercado === 'over15') {
    if (d > 0 && (sinaisOver >= 3 || ambosOver || umOverForte)) {
      const peso =
        sampleBom && sinaisOver >= 5 ? 0.75 :
          sinaisOver >= 4 ? 0.60 :
            0.45;

      return montarRetorno({
        decisao: 'favorece_over',
        direcao: 'over',
        peso,
        motivo: 'over15_confirmado_por_contexto_produtivo',
        deltaBase: d,
      });
    }

    if (d < 0 && ambosUnder && sinaisUnder >= 5) {
      return montarRetorno({
        decisao: 'reduz_over',
        direcao: 'under_leve',
        peso: 0.25,
        motivo: 'over15_pull_contra_mas_mercado_permissivo',
        deltaBase: d,
      });
    }

    return montarRetorno({
      decisao: 'ignorar',
      direcao: 'neutro',
      peso: 0,
      motivo: 'over15_sem_confirmacao_suficiente',
      deltaBase: 0,
    });
  }

  /*
    OVER 2.5 / UNDER 2.5
    Mercado principal da âncora.
  */
  if (mercado === 'over25') {
    if (d > 0 && !deltaMuitoPequeno && (ambosOver || umOverForte || sinaisOver >= 5)) {
      const peso =
        sampleForte && sinaisOver >= 6 && absD >= 1.5 ? 1.25 :
          sampleBom && sinaisOver >= 5 ? 1.00 :
            sinaisOver >= 4 ? 0.80 :
              0.55;

      return montarRetorno({
        decisao: 'favorece_over',
        direcao: 'over',
        peso,
        motivo: baixoTotal
          ? 'baixo_total_falso_confirmado_por_evidencia_produtiva'
          : 'over25_confirmado_por_evidencia_produtiva',
        deltaBase: d,
      });
    }

    if (d < 0 && !deltaMuitoPequeno && (ambosUnder || umUnderForte || sinaisUnder >= 5) && neutroOuBaixo) {
      const baseUnder = Math.max(absD, 0.35);

      const peso =
        sampleBom && sinaisUnder >= 6 ? 1.10 :
          sinaisUnder >= 5 ? 0.85 :
            0.65;

      return montarRetorno({
        decisao: 'favorece_under',
        direcao: 'under',
        peso,
        motivo: 'under25_confirmado_por_baixa_producao',
        deltaBase: -baseUnder,
      });
    }

    if (Math.abs(d) < 0.25 && baixoTotal && evMedia <= 0 && resMedia <= 0) {
      return montarRetorno({
        decisao: 'leve_under',
        direcao: 'under_leve',
        peso: 0.45,
        motivo: 'baixo_total_neutro_com_baixa_evidencia',
        deltaBase: -0.35,
      });
    }

    if (d > 0 && sinaisOver >= 3 && evMedia >= 0) {
      return montarRetorno({
        decisao: 'favorece_over_leve',
        direcao: 'over_leve',
        peso: 0.35,
        motivo: 'over25_push_fraco_com_alguma_confirmacao',
        deltaBase: d,
      });
    }

    return montarRetorno({
      decisao: 'ignorar',
      direcao: 'neutro',
      peso: 0,
      motivo: 'over25_contexto_conflitante_ou_fraco',
      deltaBase: 0,
    });
  }

  /*
    OVER 3.5 / UNDER 3.5
    Mercado explosivo.
    Só pesa forte quando a evidência é clara.
  */
  if (mercado === 'over35') {
    if (d > 0 && (ambosOver || umOverForte) && evMedia >= 0.15 && resMedia >= 0.10) {
      const peso =
        sampleBom && sinaisOver >= 6 ? 1.00 :
          sinaisOver >= 5 ? 0.75 :
            0.45;

      return montarRetorno({
        decisao: 'favorece_over',
        direcao: 'over',
        peso,
        motivo: 'over35_confirmado_por_contexto_explosivo',
        deltaBase: d,
      });
    }

    if (d < 0 && (ambosUnder || umUnderForte || sinaisUnder >= 5)) {
      const peso =
        sampleBom && sinaisUnder >= 6 ? 0.95 :
          sinaisUnder >= 5 ? 0.75 :
            0.45;

      return montarRetorno({
        decisao: 'favorece_under',
        direcao: 'under',
        peso,
        motivo: 'under35_confirmado_por_baixa_producao',
        deltaBase: d,
      });
    }

    return montarRetorno({
      decisao: 'ignorar',
      direcao: 'neutro',
      peso: 0,
      motivo: 'over35_sem_confirmacao_forte',
      deltaBase: 0,
    });
  }

  /*
    BTTS SIM / BTTS NÃO
    Precisa de leitura bilateral.
  */
  if (mercado === 'btts_sim') {
    if (d > 0 && ambosOver) {
      const peso =
        sampleBom && sinaisOver >= 6 ? 1.00 :
          sinaisOver >= 5 ? 0.75 :
            0.55;

      return montarRetorno({
        decisao: 'favorece_btts_sim',
        direcao: 'btts_sim',
        peso,
        motivo: 'btts_sim_confirmado_pelos_dois_lados',
        deltaBase: d,
      });
    }

    if (d > 0 && (casaOverForte || foraOverForte) && evMedia >= 0.05) {
      return montarRetorno({
        decisao: 'leve_btts_sim',
        direcao: 'btts_sim_leve',
        peso: 0.40,
        motivo: 'btts_sim_um_lado_forte_outro_nao_contra',
        deltaBase: d,
      });
    }

    if (d < 0 && (ambosUnder || umUnderForte) && sinaisUnder >= 4) {
      const peso =
        sampleBom && sinaisUnder >= 6 ? 0.90 :
          sinaisUnder >= 5 ? 0.70 :
            0.55;

      return montarRetorno({
        decisao: 'favorece_btts_nao',
        direcao: 'btts_nao',
        peso,
        motivo: 'btts_nao_confirmado_por_baixa_producao_bilateral',
        deltaBase: d,
      });
    }

    return montarRetorno({
      decisao: 'ignorar',
      direcao: 'neutro',
      peso: 0,
      motivo: 'btts_contexto_conflitante_ou_unilateral',
      deltaBase: 0,
    });
  }

  return montarRetorno({
    decisao: 'ignorar',
    direcao: 'neutro',
    peso: 0,
    motivo: 'mercado_sem_politica_anchor',
    deltaBase: 0,
  });
}
async function calcularAncoraContextualLambdaMercados({
  jogo,
  lHome,
  lAway,
  probO15Raw,
  probO25Raw,
  probO35Raw,
  probBTTSRaw,
}) {
  /*
    NOVA ÂNCORA: rating_batalhas_anchor

    Lógica:
    1. Não busca mais jogo completo parecido por lambda.
    2. Busca evidências em 4 blocos:
       - ataque_casa_vs_defesa_fora
       - defesa_fora_vs_ataque_casa
       - ataque_fora_vs_defesa_casa
       - defesa_casa_vs_ataque_fora
    3. Usa todos os jogos anteriores disponíveis até o limite.
    4. Não filtra por mando.
    5. Não usa o próprio jogo nem jogos do mesmo dia/futuros.
    6. Peso:
       peso_principal = similaridade do rating principal
       peso_secundario = similaridade do rating secundário
       peso_final = principal * (base + variavel * secundario)
  */

  const RATING_BATALHAS_CONFIG = {
    enabled: CONTEXTUAL_ANCHOR_CONFIG?.enabled !== false,

    limit: Number(CONTEXTUAL_ANCHOR_CONFIG?.limit || 40),

    tolerancia_rating: 0.35,
    peso_base_secundario: 0.35,
    peso_variavel_secundario: 0.65,

    topDetalhesPorBloco: 12,

    minEffectiveSample: Number(CONTEXTUAL_ANCHOR_CONFIG?.minEffectiveSample || 4.0),
    minSideEffectiveSample: Number(CONTEXTUAL_ANCHOR_CONFIG?.minSideEffectiveSample || 1.25),

    maxDelta: {
      over15: Number(CONTEXTUAL_ANCHOR_CONFIG?.maxDelta?.over15 || 1.5),
      over25: Number(CONTEXTUAL_ANCHOR_CONFIG?.maxDelta?.over25 || 4.0),
      over35: Number(CONTEXTUAL_ANCHOR_CONFIG?.maxDelta?.over35 || 1.5),
      btts_sim: Number(CONTEXTUAL_ANCHOR_CONFIG?.maxDelta?.btts_sim || 4.0),
    },
  };

  function round(v, casas = 3) {
    const n = Number(v);
    return Number.isFinite(n) ? +n.toFixed(casas) : 0;
  }

  function roundOrNull(v, casas = 3) {
    const n = Number(v);
    return Number.isFinite(n) ? +n.toFixed(casas) : null;
  }

  function safeDivNull(a, b) {
    const na = Number(a);
    const nb = Number(b);

    if (!Number.isFinite(na) || !Number.isFinite(nb) || nb === 0) {
      return null;
    }

    return na / nb;
  }

  function gapNull(a, b) {
    const na = Number(a);
    const nb = Number(b);

    if (!Number.isFinite(na) || !Number.isFinite(nb)) {
      return null;
    }

    return na - nb;
  }

  function minOrNull(a, b) {
    const na = Number(a);
    const nb = Number(b);

    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return Math.min(na, nb);
    }

    if (Number.isFinite(na)) return na;
    if (Number.isFinite(nb)) return nb;

    return null;
  }

  function maxOrNull(a, b) {
    const na = Number(a);
    const nb = Number(b);

    if (Number.isFinite(na) && Number.isFinite(nb)) {
      return Math.max(na, nb);
    }

    if (Number.isFinite(na)) return na;
    if (Number.isFinite(nb)) return nb;

    return null;
  }

  function classificarQualidadeFinalizacao({ xgTotal, xgotTotal, ratioTotal, gapTotal }) {
    const xg = Number(xgTotal);
    const xgot = Number(xgotTotal);
    const ratio = Number(ratioTotal);
    const gap = Number(gapTotal);

    const alertas = [];

    if (Number.isFinite(xg) && Number.isFinite(xgot) && xg >= 3.0 && xgot <= 2.0) {
      alertas.push('XG_ALTO_MAS_XGOT_BAIXO');
    }

    if (Number.isFinite(ratio) && ratio <= 0.65) {
      alertas.push('RATIO_XGOT_XG_BAIXO');
    }

    if (Number.isFinite(gap) && gap >= 1.20) {
      alertas.push('GAP_XG_XGOT_ALTO');
    }

    let nivel = 'sem_dado';
    let explicacao = 'Sem xGOT suficiente para explicar qualidade de finalização.';

    if (Number.isFinite(xg) && Number.isFinite(xgot)) {
      if (alertas.length > 0) {
        nivel = 'alerta_over_inflado';
        explicacao = 'O xG indica volume/expectativa alta, mas o xGOT está baixo em relação ao xG. Isso sinaliza risco de over inflado: muita expectativa teórica, pouca finalização perigosa.';
      } else if (Number.isFinite(ratio) && ratio >= 0.85) {
        nivel = 'finalizacao_forte';
        explicacao = 'O xGOT acompanha bem o xG. A qualidade de finalização parece coerente com o volume criado.';
      } else {
        nivel = 'normal';
        explicacao = 'O xGOT não mostrou alerta forte contra o xG. Qualidade de finalização sem distorção grande.';
      }
    }

    return {
      nivel,
      alerta_over_inflado: alertas.length > 0,
      alertas,
      explicacao,
    };
  }

  function toStr(v) {
    if (v === undefined || v === null) return '';
    return String(v);
  }

  function normalizarDataISO(v) {
    if (!v) return null;

    if (typeof v === 'string') {
      return v.slice(0, 10);
    }

    const d = new Date(v);

    if (Number.isNaN(d.getTime())) {
      return null;
    }

    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');

    return `${yyyy}-${mm}-${dd}`;
  }

  function pickNum(...values) {
    for (const v of values) {
      if (v === undefined || v === null || v === '') continue;

      const n = Number(v);

      if (Number.isFinite(n)) {
        return n;
      }
    }

    return null;
  }

  function pickStr(...values) {
    for (const v of values) {
      if (v === undefined || v === null || v === '') continue;
      return String(v);
    }

    return null;
  }

  function safeParseJson(v) {
    if (!v) return null;
    if (typeof v === 'object') return v;

    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }

  function parsePlacar(placar) {
    const s = String(placar || '').replace(/\s+/g, '');

    const m = s.match(/^(\d+)-(\d+)$/);

    if (!m) {
      return {
        home: null,
        away: null,
        total: null,
      };
    }

    const home = Number(m[1]);
    const away = Number(m[2]);

    return {
      home,
      away,
      total: home + away,
    };
  }

  function simGauss(diff, tolerancia) {
    const d = Math.abs(Number(diff));

    if (!Number.isFinite(d)) return 0;

    const t = Math.max(Number(tolerancia || 0), 0.0001);

    return Math.exp(-0.5 * Math.pow(d / t, 2));
  }

  function mediaPonderada(lista, getter) {
    let soma = 0;
    let peso = 0;

    for (const item of lista || []) {
      const p = Number(item?.peso_final || 0);
      const v = Number(getter(item));

      if (!Number.isFinite(p) || p <= 0) continue;
      if (!Number.isFinite(v)) continue;

      soma += v * p;
      peso += p;
    }

    return peso > 0 ? soma / peso : null;
  }

  function taxaPonderada(lista, getter) {
    const v = mediaPonderada(lista, getter);
    return v === null ? 0 : v;
  }

  function somaPeso(lista) {
    return (lista || []).reduce((acc, item) => {
      const p = Number(item?.peso_final || 0);
      return Number.isFinite(p) && p > 0 ? acc + p : acc;
    }, 0);
  }

  function clampLocal(n, min, max) {
    const x = Number(n);

    if (!Number.isFinite(x)) return min;

    return Math.max(min, Math.min(max, x));
  }

  function valorRecencia(rankRecencia) {
    const idx = Number(rankRecencia || 1);

    if (idx <= 10) return 1.00;
    if (idx <= 20) return 0.85;

    return 0.65;
  }

  function retornoAnchorDesligada(motivo) {
    return {
      deltaOver15: 0,
      deltaOver25: 0,
      deltaOver35: 0,
      deltaBTTS: 0,
      telemetry: {
        enabled: false,
        tipo: 'rating_batalhas_anchor',
        motivo,
      },
    };
  }

  if (!RATING_BATALHAS_CONFIG.enabled) {
    return retornoAnchorDesligada('contextual_anchor_disabled');
  }

  const dataJogo = normalizarDataISO(
    jogo?.data_jogo ||
    jogo?.data ||
    jogo?.DATA_ALVO ||
    jogo?.data_partida ||
    null
  );

  const flashscoreIdJogoAtual =
    jogo?.flashscore_id_jogo ||
    jogo?.flashscore_id ||
    jogo?.id_jogo ||
    jogo?.id ||
    null;

  const idCasa = toStr(jogo?.id_time_casa);
  const idFora = toStr(jogo?.id_time_fora);

  const fsCasa =
    jogo?.flashscore_id_time_casa ||
    jogo?.flashscore_id_casa ||
    jogo?.fs_casa ||
    null;

  const fsFora =
    jogo?.flashscore_id_time_fora ||
    jogo?.flashscore_id_fora ||
    jogo?.fs_fora ||
    null;

  const nomeCasa =
    jogo?.nome_time_casa ||
    jogo?.time_casa ||
    jogo?.mandante?.nome_time ||
    'CASA';

  const nomeFora =
    jogo?.nome_time_fora ||
    jogo?.time_fora ||
    jogo?.visitante?.nome_time ||
    'FORA';

  if (!dataJogo || !idCasa || !idFora) {
    return retornoAnchorDesligada('dados_jogo_insuficientes_para_anchor_rating');
  }

  async function buscarRatingAlvoTime({
    idTime,
    flashscoreIdTime,
    data,
    ladoAtual,
  }) {
    const campoAtaque = ladoAtual === 'casa'
      ? 'casa_rating_ataque'
      : 'fora_rating_ataque';

    const campoDefesa = ladoAtual === 'casa'
      ? 'casa_rating_defesa'
      : 'fora_rating_defesa';

    const resHist = await pool.query(
      `
        SELECT
          ${campoAtaque} AS rating_ataque,
          ${campoDefesa} AS rating_defesa,
          data_referencia
        FROM rating_times_historico
        WHERE
          (
            ($1::text <> '' AND flashscore_id_time = $1::text)
            OR
            ($2::text <> '' AND id_time::text = $2::text)
          )
          AND data_referencia::date = $3::date
        ORDER BY data_referencia DESC
        LIMIT 1
      `,
      [
        toStr(flashscoreIdTime),
        toStr(idTime),
        data,
      ]
    );

    if (resHist.rows[0]) {
      return {
        origem: 'rating_times_historico_data_jogo',
        ataque: pickNum(resHist.rows[0].rating_ataque),
        defesa: pickNum(resHist.rows[0].rating_defesa),
        data_referencia: resHist.rows[0].data_referencia,
      };
    }

    const resAtual = await pool.query(
      `
        SELECT
          ${campoAtaque} AS rating_ataque,
          ${campoDefesa} AS rating_defesa,
          atualizado_em AS data_referencia
        FROM rating_times
        WHERE
          (
            ($1::text <> '' AND flashscore_id_time = $1::text)
            OR
            ($2::text <> '' AND id_time::text = $2::text)
          )
        ORDER BY atualizado_em DESC NULLS LAST
        LIMIT 1
      `,
      [
        toStr(flashscoreIdTime),
        toStr(idTime),
      ]
    );

    if (resAtual.rows[0]) {
      return {
        origem: 'rating_times_atual_fallback',
        ataque: pickNum(resAtual.rows[0].rating_ataque),
        defesa: pickNum(resAtual.rows[0].rating_defesa),
        data_referencia: resAtual.rows[0].data_referencia,
      };
    }

    return {
      origem: 'nao_encontrado',
      ataque: null,
      defesa: null,
      data_referencia: null,
    };
  }

  async function carregarHistoricoRatingBatalhas({
    idTime,
    flashscoreIdTime,
    data,
    flashscoreIdJogoAtual,
    limit,
  }) {
    const res = await pool.query(
      `
        SELECT
          id_time,
          flashscore_id_time,
          nome_time,
          data_referencia,
          lambda_jogo_contexto
        FROM rating_times_historico
        WHERE
          (
            ($1::text <> '' AND flashscore_id_time = $1::text)
            OR
            ($2::text <> '' AND id_time::text = $2::text)
          )
          AND data_referencia::date < $3::date
          AND lambda_jogo_contexto IS NOT NULL
          AND COALESCE(lambda_jogo_contexto->>'flashscore_id_jogo', '') <> COALESCE($4::text, '')
        ORDER BY data_referencia DESC
        LIMIT $5
      `,
      [
        toStr(flashscoreIdTime),
        toStr(idTime),
        data,
        toStr(flashscoreIdJogoAtual),
        Number(limit || 40),
      ]
    );

    return res.rows
      .map((r, idx) => {
        const ctx = safeParseJson(r.lambda_jogo_contexto);

        return {
          idx,
          rank_recencia: idx + 1,
          id_time: r.id_time,
          flashscore_id_time: r.flashscore_id_time,
          nome_time: r.nome_time,
          data_referencia: r.data_referencia,
          ctx,
        };
      })
      .filter((item) => {
        if (!item.ctx) return false;

        const histId = String(item.ctx.flashscore_id_jogo || '');
        const atualId = String(flashscoreIdJogoAtual || '');

        if (atualId && histId && histId === atualId) {
          return false;
        }

        if (
          item.ctx.lambda_ok !== undefined &&
          Number(item.ctx.lambda_ok || 0) !== 1
        ) {
          return false;
        }

        return true;
      });
  }

  function extrairHistoricoPerspectiva(item) {
    const ctx = item?.ctx || {};
    const metricas = ctx.metricas_reais || {};
    const resultado = ctx.resultado_real || {};
    const rating = ctx.rating_usado || ctx.rating || {};

    const histFlashId = pickStr(
      ctx.flashscore_id_jogo,
      metricas.flashscore_id_jogo,
      resultado.flashscore_id_jogo
    );

    const ladoTime = pickStr(
      ctx.lado_time,
      metricas.lado_time,
      resultado.lado_time
    );

    const placar = pickStr(
      resultado.placar,
      metricas.placar,
      ctx.placar
    );

    const placarParse = parsePlacar(placar);

    const casaRatingAtaque = pickNum(
      rating.casa_rating_ataque,
      ctx.casa_rating_ataque
    );

    const casaRatingDefesa = pickNum(
      rating.casa_rating_defesa,
      ctx.casa_rating_defesa
    );

    const foraRatingAtaque = pickNum(
      rating.fora_rating_ataque,
      ctx.fora_rating_ataque
    );

    const foraRatingDefesa = pickNum(
      rating.fora_rating_defesa,
      ctx.fora_rating_defesa
    );

    if (
      !Number.isFinite(casaRatingAtaque) ||
      !Number.isFinite(casaRatingDefesa) ||
      !Number.isFinite(foraRatingAtaque) ||
      !Number.isFinite(foraRatingDefesa)
    ) {
      return null;
    }

    const ehCasa = ladoTime === 'casa';

    const histTimeAtaque = ehCasa ? casaRatingAtaque : foraRatingAtaque;
    const histTimeDefesa = ehCasa ? casaRatingDefesa : foraRatingDefesa;
    const histAdvAtaque = ehCasa ? foraRatingAtaque : casaRatingAtaque;
    const histAdvDefesa = ehCasa ? foraRatingDefesa : casaRatingDefesa;

    const golsHome = pickNum(
      metricas.gols_home,
      metricas.gols_casa,
      resultado.gols_home,
      resultado.gols_casa,
      placarParse.home
    );

    const golsAway = pickNum(
      metricas.gols_away,
      metricas.gols_fora,
      resultado.gols_away,
      resultado.gols_fora,
      placarParse.away
    );

    const golsTotal = pickNum(
      metricas.gols_total,
      resultado.gols_total,
      placarParse.total,
      (
        Number.isFinite(golsHome) && Number.isFinite(golsAway)
          ? golsHome + golsAway
          : null
      )
    );

    const golsMarcadosTime = ehCasa ? golsHome : golsAway;
    const golsSofridosTime = ehCasa ? golsAway : golsHome;

    const xgHome = pickNum(metricas.xg_home, ctx.xg_home);
    const xgAway = pickNum(metricas.xg_away, ctx.xg_away);

    const xgotHome = pickNum(metricas.xgot_home, ctx.xgot_home);
    const xgotAway = pickNum(metricas.xgot_away, ctx.xgot_away);

    const xgaHome = pickNum(metricas.xga_home, ctx.xga_home);
    const xgaAway = pickNum(metricas.xga_away, ctx.xga_away);

    const xgTime = pickNum(
      metricas.xg_time,
      ctx.xg_time,
      ehCasa ? xgHome : xgAway
    );

    const xgAdversario = pickNum(
      metricas.xg_adversario,
      ctx.xg_adversario,
      ehCasa ? xgAway : xgHome
    );

    const xgContraTime = pickNum(
      metricas.xg_contra_time,
      ctx.xg_contra_time,
      xgAdversario
    );

    const xgContraAdversario = pickNum(
      metricas.xg_contra_adversario,
      ctx.xg_contra_adversario,
      xgTime
    );

    const xgTotal = pickNum(
      metricas.xg_total,
      ctx.xg_total,
      (
        Number.isFinite(xgTime) && Number.isFinite(xgAdversario)
          ? xgTime + xgAdversario
          : null
      )
    );

    const xgotTime = pickNum(
      metricas.xgot_time,
      ctx.xgot_time,
      ehCasa ? xgotHome : xgotAway
    );

    const xgotAdversario = pickNum(
      metricas.xgot_adversario,
      ctx.xgot_adversario,
      ehCasa ? xgotAway : xgotHome
    );

    const xgotTotal = pickNum(
      metricas.xgot_total,
      ctx.xgot_total,
      (
        Number.isFinite(xgotTime) && Number.isFinite(xgotAdversario)
          ? xgotTime + xgotAdversario
          : null
      )
    );

    const xgaTime = pickNum(
      metricas.xga_time,
      ctx.xga_time,
      ehCasa ? xgaHome : xgaAway,
      xgotAdversario
    );

    const xgaAdversario = pickNum(
      metricas.xga_adversario,
      ctx.xga_adversario,
      ehCasa ? xgaAway : xgaHome,
      xgotTime
    );

    const xgaTotal = pickNum(
      metricas.xga_total,
      ctx.xga_total,
      (
        Number.isFinite(xgaTime) && Number.isFinite(xgaAdversario)
          ? xgaTime + xgaAdversario
          : null
      )
    );

    const hitOver15 = pickNum(
      resultado.over15,
      resultado.hit_over15,
      Number.isFinite(golsTotal) ? (golsTotal > 1 ? 1 : 0) : null
    );

    const hitOver25 = pickNum(
      resultado.over25,
      resultado.hit_over25,
      Number.isFinite(golsTotal) ? (golsTotal > 2 ? 1 : 0) : null
    );

    const hitOver35 = pickNum(
      resultado.over35,
      resultado.hit_over35,
      Number.isFinite(golsTotal) ? (golsTotal > 3 ? 1 : 0) : null
    );

    const hitUnder25 = pickNum(
      resultado.under25,
      resultado.hit_under25,
      Number.isFinite(golsTotal) ? (golsTotal <= 2 ? 1 : 0) : null
    );

    const hitUnder35 = pickNum(
      resultado.under35,
      resultado.hit_under35,
      Number.isFinite(golsTotal) ? (golsTotal <= 3 ? 1 : 0) : null
    );

    const hitBttsSim = pickNum(
      resultado.btts_sim,
      resultado.hit_btts_sim,
      (
        Number.isFinite(golsHome) && Number.isFinite(golsAway)
          ? (golsHome > 0 && golsAway > 0 ? 1 : 0)
          : null
      )
    );

    const hitBttsNao = pickNum(
      resultado.btts_nao,
      resultado.hit_btts_nao,
      (
        Number.isFinite(golsHome) && Number.isFinite(golsAway)
          ? (golsHome === 0 || golsAway === 0 ? 1 : 0)
          : null
      )
    );

    return {
      hist_flashscore_id_jogo: histFlashId,
      data_referencia: item.data_referencia,
      hist_lado_time: ladoTime,
      hist_placar: placar,

      hist_casa_rating_ataque: casaRatingAtaque,
      hist_casa_rating_defesa: casaRatingDefesa,
      hist_fora_rating_ataque: foraRatingAtaque,
      hist_fora_rating_defesa: foraRatingDefesa,

      hist_time_ataque: histTimeAtaque,
      hist_time_defesa: histTimeDefesa,
      hist_adversario_ataque: histAdvAtaque,
      hist_adversario_defesa: histAdvDefesa,

      gols_home: golsHome,
      gols_away: golsAway,
      gols_total: golsTotal,
      gols_marcados_time: golsMarcadosTime,
      gols_sofridos_time: golsSofridosTime,

      xg_time: xgTime,
      xg_adversario: xgAdversario,
      xg_total: xgTotal,

      xgot_time: xgotTime,
      xgot_adversario: xgotAdversario,
      xgot_total: xgotTotal,

      xg_contra_time: xgContraTime,
      xg_contra_adversario: xgContraAdversario,

      xga_time: xgaTime,
      xga_adversario: xgaAdversario,
      xga_total: xgaTotal,

      hit_over15: hitOver15,
      hit_over25: hitOver25,
      hit_over35: hitOver35,
      hit_under25: hitUnder25,
      hit_under35: hitUnder35,
      hit_btts_sim: hitBttsSim,
      hit_btts_nao: hitBttsNao,

      rank_recencia: item.rank_recencia,
      peso_recencia: valorRecencia(item.rank_recencia),
    };
  }

  function calcularBloco({
    bloco,
    tipo_bloco,
    nome_time_analisado,
    nome_adversario_atual,
    historico,
    alvo_principal,
    alvo_secundario,
  }) {
    const detalhes = [];

    for (const item of historico || []) {
      const h = extrairHistoricoPerspectiva(item);

      if (!h) continue;

      const histPrincipal =
        tipo_bloco === 'ATAQUE'
          ? h.hist_adversario_defesa
          : h.hist_adversario_ataque;

      const histSecundario =
        tipo_bloco === 'ATAQUE'
          ? h.hist_time_ataque
          : h.hist_time_defesa;

      if (
        !Number.isFinite(histPrincipal) ||
        !Number.isFinite(histSecundario) ||
        !Number.isFinite(alvo_principal) ||
        !Number.isFinite(alvo_secundario)
      ) {
        continue;
      }

      const deltaPrincipal = histPrincipal - alvo_principal;
      const diffPrincipal = Math.abs(deltaPrincipal);

      const deltaSecundario = histSecundario - alvo_secundario;
      const diffSecundario = Math.abs(deltaSecundario);

      const simPrincipal = simGauss(
        diffPrincipal,
        RATING_BATALHAS_CONFIG.tolerancia_rating
      );

      const simSecundario = simGauss(
        diffSecundario,
        RATING_BATALHAS_CONFIG.tolerancia_rating
      );

      const pesoFinal =
        simPrincipal *
        (
          RATING_BATALHAS_CONFIG.peso_base_secundario +
          RATING_BATALHAS_CONFIG.peso_variavel_secundario * simSecundario
        );

      const xgBloco =
        tipo_bloco === 'ATAQUE'
          ? h.xg_time
          : h.xg_contra_time;

      const xgotOuXgaBloco =
        tipo_bloco === 'ATAQUE'
          ? h.xgot_time
          : h.xga_time;

      const golsBloco =
        tipo_bloco === 'ATAQUE'
          ? h.gols_marcados_time
          : h.gols_sofridos_time;

      detalhes.push({
        bloco,
        tipo_bloco,
        nome_time_analisado,
        nome_adversario_atual,

        hist_flashscore_id_jogo: h.hist_flashscore_id_jogo,
        data_historica: normalizarDataISO(h.data_referencia),
        hist_lado_time: h.hist_lado_time,
        hist_placar: h.hist_placar,
        rank_recencia: h.rank_recencia,

        alvo_principal: round(alvo_principal, 3),
        hist_principal: round(histPrincipal, 3),
        delta_principal: round(deltaPrincipal, 3),
        diff_principal: round(diffPrincipal, 3),
        sim_principal: round(simPrincipal, 3),

        alvo_secundario: round(alvo_secundario, 3),
        hist_secundario: round(histSecundario, 3),
        delta_secundario: round(deltaSecundario, 3),
        diff_secundario: round(diffSecundario, 3),
        sim_secundario: round(simSecundario, 3),

        peso_final: round(pesoFinal, 3),

        xg_bloco: roundOrNull(xgBloco, 2),
        xgot_ou_xga_bloco: roundOrNull(xgotOuXgaBloco, 2),
        gols_bloco: roundOrNull(golsBloco, 0),

        xg_time: roundOrNull(h.xg_time, 2),
        xg_adversario: roundOrNull(h.xg_adversario, 2),
        xg_total: roundOrNull(h.xg_total, 2),

        xgot_time: roundOrNull(h.xgot_time, 2),
        xgot_adversario: roundOrNull(h.xgot_adversario, 2),
        xgot_total: roundOrNull(h.xgot_total, 2),

        xg_contra_time: roundOrNull(h.xg_contra_time, 2),
        xg_contra_adversario: roundOrNull(h.xg_contra_adversario, 2),

        xga_time: roundOrNull(h.xga_time, 2),
        xga_adversario: roundOrNull(h.xga_adversario, 2),
        xga_total: roundOrNull(h.xga_total, 2),

        gols_total: roundOrNull(h.gols_total, 0),

        hit_over15: Number(h.hit_over15 || 0),
        hit_over25: Number(h.hit_over25 || 0),
        hit_over35: Number(h.hit_over35 || 0),
        hit_under25: Number(h.hit_under25 || 0),
        hit_under35: Number(h.hit_under35 || 0),
        hit_btts_sim: Number(h.hit_btts_sim || 0),
        hit_btts_nao: Number(h.hit_btts_nao || 0),
      });
    }

    detalhes.sort((a, b) => {
      const p = Number(b.peso_final || 0) - Number(a.peso_final || 0);
      if (p !== 0) return p;

      return Number(a.rank_recencia || 999) - Number(b.rank_recencia || 999);
    });

    const pesoTotal = somaPeso(detalhes);
    const qtdJogos = detalhes.length;
    const pesoMedio = qtdJogos > 0 ? pesoTotal / qtdJogos : 0;

    const resumo = {
      bloco,
      tipo_bloco,
      nome_time_analisado,
      nome_adversario_atual,

      qtd_jogos: qtdJogos,
      peso_total: round(pesoTotal, 3),
      peso_medio: round(pesoMedio, 3),

      xg_ponderado: roundOrNull(mediaPonderada(detalhes, d => d.xg_bloco), 3),
      xgot_ou_xga_ponderado: roundOrNull(mediaPonderada(detalhes, d => d.xgot_ou_xga_bloco), 3),
      gols_ponderado: roundOrNull(mediaPonderada(detalhes, d => d.gols_bloco), 3),

      over15_rate: round(taxaPonderada(detalhes, d => d.hit_over15), 3),
      over25_rate: round(taxaPonderada(detalhes, d => d.hit_over25), 3),
      over35_rate: round(taxaPonderada(detalhes, d => d.hit_over35), 3),
      under25_rate: round(taxaPonderada(detalhes, d => d.hit_under25), 3),
      under35_rate: round(taxaPonderada(detalhes, d => d.hit_under35), 3),
      btts_sim_rate: round(taxaPonderada(detalhes, d => d.hit_btts_sim), 3),
      btts_nao_rate: round(taxaPonderada(detalhes, d => d.hit_btts_nao), 3),

      top_jogos: detalhes.slice(0, RATING_BATALHAS_CONFIG.topDetalhesPorBloco),
    };

    return resumo;
  }

  function combinarDoisBlocos(blocoA, blocoB) {
    const pesoA = Number(blocoA?.peso_total || 0);
    const pesoB = Number(blocoB?.peso_total || 0);
    const peso = pesoA + pesoB;

    function comb(chave) {
      const a = Number(blocoA?.[chave]);
      const b = Number(blocoB?.[chave]);

      if (peso > 0) {
        let soma = 0;
        let somaPesoLocal = 0;

        if (Number.isFinite(a) && pesoA > 0) {
          soma += a * pesoA;
          somaPesoLocal += pesoA;
        }

        if (Number.isFinite(b) && pesoB > 0) {
          soma += b * pesoB;
          somaPesoLocal += pesoB;
        }

        return somaPesoLocal > 0 ? soma / somaPesoLocal : null;
      }

      if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
      if (Number.isFinite(a)) return a;
      if (Number.isFinite(b)) return b;

      return null;
    }

    return {
      peso_total: round(peso, 3),
      peso_medio: round(
        (
          Number(blocoA?.peso_medio || 0) +
          Number(blocoB?.peso_medio || 0)
        ) / 2,
        3
      ),

      xg: comb('xg_ponderado'),

      // Mantém o nome antigo para compatibilidade,
      // mas agora também sobe aliases claros.
      // Em bloco ATAQUE esse valor vem de xGOT do ataque.
      // Em bloco DEFESA esse valor vem de xGA/xGOT permitido pela defesa.
      xgot_ou_xga: comb('xgot_ou_xga_ponderado'),
      xgot: comb('xgot_ou_xga_ponderado'),
      xga_permitido: comb('xgot_ou_xga_ponderado'),

      gols: comb('gols_ponderado'),
    };
  }

  function calcularTaxasGerais(blocos) {
    const todos = Object.values(blocos || {})
      .flatMap(b => Array.isArray(b?.top_jogos) ? b.top_jogos : []);

    return {
      over15_rate: round(taxaPonderada(todos, d => d.hit_over15), 3),
      over25_rate: round(taxaPonderada(todos, d => d.hit_over25), 3),
      over35_rate: round(taxaPonderada(todos, d => d.hit_over35), 3),
      under25_rate: round(taxaPonderada(todos, d => d.hit_under25), 3),
      under35_rate: round(taxaPonderada(todos, d => d.hit_under35), 3),
      btts_sim_rate: round(taxaPonderada(todos, d => d.hit_btts_sim), 3),
      btts_nao_rate: round(taxaPonderada(todos, d => d.hit_btts_nao), 3),
    };
  }

  function classificarConfianca({ pesoTotal, pesoMedio, qtdTotal }) {
    if (pesoTotal >= 12 && pesoMedio >= 0.25 && qtdTotal >= 20) {
      return 'boa';
    }

    if (pesoTotal >= 7 && pesoMedio >= 0.18 && qtdTotal >= 12) {
      return 'media';
    }

    if (pesoTotal >= 4) {
      return 'baixa_util';
    }

    return 'baixa';
  }

  function bucketForca(deltaAbs) {
    const d = Math.abs(Number(deltaAbs || 0));

    if (d >= 3.0) return '04_muito_forte';
    if (d >= 2.0) return '03_forte';
    if (d >= 1.0) return '02_moderado';
    if (d >= 0.25) return '01_leve';

    return '00_neutro';
  }

  function montarLadoCompat({
    lado,
    producao,
    blocosLado,
    mercado,
  }) {
    const detalhes = [];

    for (const b of blocosLado || []) {
      for (const d of b?.top_jogos || []) {
        detalhes.push({
          hit:
            mercado === 'over15' ? d.hit_over15 :
              mercado === 'over25' ? d.hit_over25 :
                mercado === 'over35' ? d.hit_over35 :
                  mercado === 'btts_sim' ? d.hit_btts_sim :
                    d.hit_over25,

          placar: d.hist_placar,

          xg_total: d.xg_total,
          xgot_total: d.xgot_total,
          gols_total: d.gols_total,

          peso_final: d.peso_final,

          flashscore_id_jogo: d.hist_flashscore_id_jogo,
          data_referencia: d.data_historica,

          bloco: d.bloco,
          tipo_bloco: d.tipo_bloco,

          xg_bloco: d.xg_bloco,
          xgot_ou_xga_bloco: d.xgot_ou_xga_bloco,
          gols_bloco: d.gols_bloco,

          alvo_principal: d.alvo_principal,
          hist_principal: d.hist_principal,
          delta_principal: d.delta_principal,
          sim_principal: d.sim_principal,

          alvo_secundario: d.alvo_secundario,
          hist_secundario: d.hist_secundario,
          delta_secundario: d.delta_secundario,
          sim_secundario: d.sim_secundario,

          qualidade_evidencia: 'rating_batalhas',
        });
      }
    }

    detalhes.sort((a, b) => Number(b.peso_final || 0) - Number(a.peso_final || 0));

    const xg = Number(producao?.xg || 0);
    const scoreProd = clampLocal((xg - 1.10) / 0.80, -1, 1);

    return {
      aplicado: Number(producao?.peso_total || 0) > 0,
      lado,

      sample_efetivo: round(Number(producao?.peso_total || 0), 3),
      similaridade_media: round(Number(producao?.peso_medio || 0), 3),

      score: round(scoreProd, 3),

      residual_medio: round(scoreProd, 3),
      residual_score: round(scoreProd, 3),
      residual_ajustado_medio: round(scoreProd, 3),
      residual_ajustado_score: round(scoreProd, 3),

      producao_score_medio: round(scoreProd, 3),
      evidencia_produtiva_media: round(scoreProd, 3),

      hit_rate_contextual: round(taxaPonderada(detalhes, d => d.hit), 3),
      prob_modelo_media: null,

      xg_anchor: roundOrNull(producao?.xg, 3),

      // NOVO: alias claro para leitura humana.
      // xgot_ou_xga_anchor fica mantido para compatibilidade com auditorias antigas.
      xgot_anchor: roundOrNull(producao?.xgot_ou_xga, 3),
      xgot_ou_xga_anchor: roundOrNull(producao?.xgot_ou_xga, 3),
      ratio_xgot_xg: roundOrNull(safeDivNull(producao?.xgot_ou_xga, producao?.xg), 3),
      gap_xg_xgot: roundOrNull(gapNull(producao?.xg, producao?.xgot_ou_xga), 3),

      gols_anchor: roundOrNull(producao?.gols, 3),

      detalhes: detalhes.slice(0, RATING_BATALHAS_CONFIG.topDetalhesPorBloco),
    };
  }

  function montarPoliticaAnchor({
    mercado,
    resumo,
    taxas,
    ladoCasaCompat,
    ladoForaCompat,
  }) {
    const xgCasa = Number(resumo.xg_casa_anchor || 0);
    const xgFora = Number(resumo.xg_fora_anchor || 0);
    const xgTotal = Number(resumo.xg_total_anchor || 0);

    const xgotCasa = Number(resumo.xgot_casa_anchor || 0);
    const xgotFora = Number(resumo.xgot_fora_anchor || 0);
    const xgotTotal = Number(resumo.xgot_total_anchor || 0);

    const minXg = Math.min(xgCasa, xgFora);
    const minXgot = Math.min(xgotCasa, xgotFora);
    const maxXgot = Math.max(xgotCasa, xgotFora);
    const ratioXgotXgTotal = safeDivNull(xgotTotal, xgTotal);
    const gapXgXgotTotal = gapNull(xgTotal, xgotTotal);

    const over15Rate = Number(taxas.over15_rate || 0);
    const over25Rate = Number(taxas.over25_rate || 0);
    const over35Rate = Number(taxas.over35_rate || 0);
    const under25Rate = Number(taxas.under25_rate || 0);
    const under35Rate = Number(taxas.under35_rate || 0);
    const bttsRate = Number(taxas.btts_sim_rate || 0);
    const bttsNaoRate = Number(taxas.btts_nao_rate || 0);

    const pesoTotal = Number(resumo.peso_total || 0);
    const confiancaGeral = resumo.confianca;

    const fatorConfianca =
      confiancaGeral === 'boa' ? 1.00 :
        confiancaGeral === 'media' ? 0.80 :
          confiancaGeral === 'baixa_util' ? 0.55 :
            0.25;

    const prodScore = clampLocal((xgTotal - 2.50) / 1.20, -1, 1);
    const bilateralScore = clampLocal((minXg - 0.95) / 0.65, -1, 1);

    const casaOverOk = xgCasa >= 1.05;
    const foraOverOk = xgFora >= 1.05;
    const casaOverForte = xgCasa >= 1.35;
    const foraOverForte = xgFora >= 1.35;

    const casaUnderOk = xgCasa <= 1.10;
    const foraUnderOk = xgFora <= 1.10;
    const casaUnderForte = xgCasa <= 0.85;
    const foraUnderForte = xgFora <= 0.85;

    let sinaisOver = 0;
    let sinaisUnder = 0;

    if (xgTotal >= 2.20) sinaisOver++;
    if (xgTotal >= 2.60) sinaisOver++;
    if (over15Rate >= 0.65) sinaisOver++;
    if (over25Rate >= 0.50) sinaisOver++;
    if (bttsRate >= 0.50) sinaisOver++;
    if (casaOverOk && foraOverOk) sinaisOver++;
    if (casaOverForte || foraOverForte) sinaisOver++;

    if (xgTotal <= 2.35) sinaisUnder++;
    if (xgTotal <= 2.05) sinaisUnder++;
    if (under25Rate >= 0.55) sinaisUnder++;
    if (under35Rate >= 0.70) sinaisUnder++;
    if (bttsNaoRate >= 0.55) sinaisUnder++;
    if (casaUnderOk || foraUnderOk) sinaisUnder++;
    if (casaUnderForte || foraUnderForte) sinaisUnder++;

    function montarRetorno({
      decisao,
      direcao,
      motivo,
      deltaBase,
      evMedia,
      resMedia,
      prodMedia,
    }) {
      const maxDelta =
        mercado === 'over15' ? RATING_BATALHAS_CONFIG.maxDelta.over15 :
          mercado === 'over25' ? RATING_BATALHAS_CONFIG.maxDelta.over25 :
            mercado === 'over35' ? RATING_BATALHAS_CONFIG.maxDelta.over35 :
              RATING_BATALHAS_CONFIG.maxDelta.btts_sim;

      const deltaPonderado = clampLocal(deltaBase * fatorConfianca, -maxDelta, maxDelta);

      return {
        decisao,
        direcao,
        motivo,

        peso: round(fatorConfianca, 3),
        delta_base: round(deltaBase, 3),
        delta_ponderado: round(deltaPonderado, 3),

        ev_media: round(evMedia, 3),
        res_media: round(resMedia, 3),
        prod_media: round(prodMedia, 3),

        sinais_over: sinaisOver,
        sinais_under: sinaisUnder,

        casa_over_ok: casaOverOk,
        fora_over_ok: foraOverOk,
        casa_over_forte: casaOverForte,
        fora_over_forte: foraOverForte,

        casa_under_ok: casaUnderOk,
        fora_under_ok: foraUnderOk,
        casa_under_forte: casaUnderForte,
        fora_under_forte: foraUnderForte,

        forca_bucket: bucketForca(deltaPonderado),

        xg_casa_anchor: round(xgCasa, 3),
        xg_fora_anchor: round(xgFora, 3),
        xg_total_anchor: round(xgTotal, 3),

        xgot_casa_anchor: roundOrNull(xgotCasa, 3),
        xgot_fora_anchor: roundOrNull(xgotFora, 3),
        xgot_total_anchor: roundOrNull(xgotTotal, 3),

        min_xg_lado: round(minXg, 3),
        min_xgot_lado: roundOrNull(minXgot, 3),
        max_xgot_lado: roundOrNull(maxXgot, 3),
        ratio_xgot_xg_total: roundOrNull(ratioXgotXgTotal, 3),
        gap_xg_xgot_total: roundOrNull(gapXgXgotTotal, 3),
        qualidade_finalizacao: resumo.qualidade_finalizacao || null,

        sample_efetivo: round(pesoTotal, 3),
        confianca_amostra: confiancaGeral,
      };
    }

    if (mercado === 'over15') {
      if (xgTotal >= 2.00 || over15Rate >= 0.65) {
        const intensidade = clampLocal(
          ((xgTotal - 1.80) * 0.90) + ((over15Rate - 0.60) * 4.00),
          0.15,
          1.00
        );

        return montarRetorno({
          decisao: 'favorece_over',
          direcao: 'over',
          motivo: 'over15_confirmado_por_rating_batalhas',
          deltaBase: intensidade * RATING_BATALHAS_CONFIG.maxDelta.over15,
          evMedia: prodScore,
          resMedia: prodScore,
          prodMedia: prodScore,
        });
      }

      if (xgTotal <= 1.65 && over15Rate <= 0.55) {
        return montarRetorno({
          decisao: 'reduz_over',
          direcao: 'under',
          motivo: 'over15_reduzido_por_baixa_producao_rating_batalhas',
          deltaBase: -0.75,
          evMedia: prodScore,
          resMedia: prodScore,
          prodMedia: prodScore,
        });
      }
    }

    if (mercado === 'over25') {
      if (xgTotal >= 2.65 || over25Rate >= 0.56) {
        const intensidade = clampLocal(
          ((xgTotal - 2.40) * 0.70) + ((over25Rate - 0.48) * 3.00),
          0.20,
          1.00
        );

        return montarRetorno({
          decisao: 'favorece_over',
          direcao: 'over',
          motivo: 'over25_confirmado_por_producao_rating_batalhas',
          deltaBase: intensidade * RATING_BATALHAS_CONFIG.maxDelta.over25,
          evMedia: prodScore,
          resMedia: prodScore,
          prodMedia: prodScore,
        });
      }

      if (xgTotal <= 2.25 && over25Rate <= 0.45) {
        const intensidade = clampLocal(
          ((2.45 - xgTotal) * 0.75) + ((0.52 - over25Rate) * 2.50),
          0.20,
          1.00
        );

        return montarRetorno({
          decisao: 'favorece_under',
          direcao: 'under',
          motivo: 'under25_confirmado_por_baixa_producao_rating_batalhas',
          deltaBase: -intensidade * RATING_BATALHAS_CONFIG.maxDelta.over25,
          evMedia: prodScore,
          resMedia: prodScore,
          prodMedia: prodScore,
        });
      }
    }

    if (mercado === 'over35') {
      if (xgTotal >= 3.30 && over35Rate >= 0.28) {
        const intensidade = clampLocal(
          ((xgTotal - 3.05) * 0.55) + ((over35Rate - 0.25) * 2.00),
          0.20,
          1.00
        );

        return montarRetorno({
          decisao: 'favorece_over',
          direcao: 'over',
          motivo: 'over35_confirmado_por_teto_alto_rating_batalhas',
          deltaBase: intensidade * RATING_BATALHAS_CONFIG.maxDelta.over35,
          evMedia: prodScore,
          resMedia: prodScore,
          prodMedia: prodScore,
        });
      }

      if (xgTotal <= 3.00 && under35Rate >= 0.65) {
        const intensidade = clampLocal(
          ((3.20 - xgTotal) * 0.45) + ((under35Rate - 0.60) * 1.80),
          0.20,
          1.00
        );

        return montarRetorno({
          decisao: 'favorece_under',
          direcao: 'under',
          motivo: 'under35_confirmado_por_teto_controlado_rating_batalhas',
          deltaBase: -intensidade * RATING_BATALHAS_CONFIG.maxDelta.over35,
          evMedia: prodScore,
          resMedia: prodScore,
          prodMedia: prodScore,
        });
      }
    }

    if (mercado === 'btts_sim') {
      if (xgCasa >= 1.00 && xgFora >= 1.00 && bttsRate >= 0.50) {
        const intensidade = clampLocal(
          ((minXg - 0.90) * 0.90) + ((bttsRate - 0.48) * 2.50),
          0.20,
          1.00
        );

        return montarRetorno({
          decisao: 'favorece_btts_sim',
          direcao: 'btts_sim',
          motivo: 'btts_sim_confirmado_por_producao_bilateral_rating_batalhas',
          deltaBase: intensidade * RATING_BATALHAS_CONFIG.maxDelta.btts_sim,
          evMedia: bilateralScore,
          resMedia: bilateralScore,
          prodMedia: bilateralScore,
        });
      }

      if ((xgCasa <= 0.85 || xgFora <= 0.85) && bttsRate <= 0.48) {
        const intensidade = clampLocal(
          ((0.95 - minXg) * 0.90) + ((0.52 - bttsRate) * 2.00),
          0.20,
          1.00
        );

        return montarRetorno({
          decisao: 'favorece_btts_nao',
          direcao: 'btts_nao',
          motivo: 'btts_nao_confirmado_por_baixa_bilateral_rating_batalhas',
          deltaBase: -intensidade * RATING_BATALHAS_CONFIG.maxDelta.btts_sim,
          evMedia: bilateralScore,
          resMedia: bilateralScore,
          prodMedia: bilateralScore,
        });
      }
    }

    return montarRetorno({
      decisao: 'ignorar',
      direcao: 'neutro',
      motivo: 'rating_batalhas_contexto_neutro_ou_conflitante',
      deltaBase: 0,
      evMedia: mercado === 'btts_sim' ? bilateralScore : prodScore,
      resMedia: mercado === 'btts_sim' ? bilateralScore : prodScore,
      prodMedia: mercado === 'btts_sim' ? bilateralScore : prodScore,
    });
  }

  const ratingCasaAlvo = await buscarRatingAlvoTime({
    idTime: idCasa,
    flashscoreIdTime: fsCasa,
    data: dataJogo,
    ladoAtual: 'casa',
  });

  const ratingForaAlvo = await buscarRatingAlvoTime({
    idTime: idFora,
    flashscoreIdTime: fsFora,
    data: dataJogo,
    ladoAtual: 'fora',
  });

  if (
    !Number.isFinite(ratingCasaAlvo.ataque) ||
    !Number.isFinite(ratingCasaAlvo.defesa) ||
    !Number.isFinite(ratingForaAlvo.ataque) ||
    !Number.isFinite(ratingForaAlvo.defesa)
  ) {
    return retornoAnchorDesligada('ratings_alvo_nao_encontrados');
  }

  const historicoCasa = await carregarHistoricoRatingBatalhas({
    idTime: idCasa,
    flashscoreIdTime: fsCasa,
    data: dataJogo,
    flashscoreIdJogoAtual,
    limit: RATING_BATALHAS_CONFIG.limit,
  });

  const historicoFora = await carregarHistoricoRatingBatalhas({
    idTime: idFora,
    flashscoreIdTime: fsFora,
    data: dataJogo,
    flashscoreIdJogoAtual,
    limit: RATING_BATALHAS_CONFIG.limit,
  });

  const blocos = {
    ataque_casa_vs_defesa_fora: calcularBloco({
      bloco: 'ataque_casa_vs_defesa_fora',
      tipo_bloco: 'ATAQUE',
      nome_time_analisado: nomeCasa,
      nome_adversario_atual: nomeFora,
      historico: historicoCasa,
      alvo_principal: ratingForaAlvo.defesa,
      alvo_secundario: ratingCasaAlvo.ataque,
    }),

    defesa_fora_vs_ataque_casa: calcularBloco({
      bloco: 'defesa_fora_vs_ataque_casa',
      tipo_bloco: 'DEFESA',
      nome_time_analisado: nomeFora,
      nome_adversario_atual: nomeCasa,
      historico: historicoFora,
      alvo_principal: ratingCasaAlvo.ataque,
      alvo_secundario: ratingForaAlvo.defesa,
    }),

    ataque_fora_vs_defesa_casa: calcularBloco({
      bloco: 'ataque_fora_vs_defesa_casa',
      tipo_bloco: 'ATAQUE',
      nome_time_analisado: nomeFora,
      nome_adversario_atual: nomeCasa,
      historico: historicoFora,
      alvo_principal: ratingCasaAlvo.defesa,
      alvo_secundario: ratingForaAlvo.ataque,
    }),

    defesa_casa_vs_ataque_fora: calcularBloco({
      bloco: 'defesa_casa_vs_ataque_fora',
      tipo_bloco: 'DEFESA',
      nome_time_analisado: nomeCasa,
      nome_adversario_atual: nomeFora,
      historico: historicoCasa,
      alvo_principal: ratingForaAlvo.ataque,
      alvo_secundario: ratingCasaAlvo.defesa,
    }),
  };

  const prodCasa = combinarDoisBlocos(
    blocos.ataque_casa_vs_defesa_fora,
    blocos.defesa_fora_vs_ataque_casa
  );

  const prodFora = combinarDoisBlocos(
    blocos.ataque_fora_vs_defesa_casa,
    blocos.defesa_casa_vs_ataque_fora
  );

  const xgCasaAnchor = Number(prodCasa.xg || 0);
  const xgForaAnchor = Number(prodFora.xg || 0);
  const xgTotalAnchor = xgCasaAnchor + xgForaAnchor;

  const xgotCasaAnchor = Number(prodCasa.xgot_ou_xga || 0);
  const xgotForaAnchor = Number(prodFora.xgot_ou_xga || 0);
  const xgotTotalAnchor = xgotCasaAnchor + xgotForaAnchor;

  const minXgotLado = minOrNull(xgotCasaAnchor, xgotForaAnchor);
  const maxXgotLado = maxOrNull(xgotCasaAnchor, xgotForaAnchor);

  const ratioXgotXgCasa = safeDivNull(xgotCasaAnchor, xgCasaAnchor);
  const ratioXgotXgFora = safeDivNull(xgotForaAnchor, xgForaAnchor);
  const ratioXgotXgTotal = safeDivNull(xgotTotalAnchor, xgTotalAnchor);

  const gapXgXgotCasa = gapNull(xgCasaAnchor, xgotCasaAnchor);
  const gapXgXgotFora = gapNull(xgForaAnchor, xgotForaAnchor);
  const gapXgXgotTotal = gapNull(xgTotalAnchor, xgotTotalAnchor);

  const qualidadeFinalizacao = classificarQualidadeFinalizacao({
    xgTotal: xgTotalAnchor,
    xgotTotal: xgotTotalAnchor,
    ratioTotal: ratioXgotXgTotal,
    gapTotal: gapXgXgotTotal,
  });

  const golsCasaAnchor = Number(prodCasa.gols || 0);
  const golsForaAnchor = Number(prodFora.gols || 0);
  const golsTotalAnchor = golsCasaAnchor + golsForaAnchor;

  const pesoTotal = Object.values(blocos)
    .reduce((acc, b) => acc + Number(b?.peso_total || 0), 0);

  const qtdTotal = Object.values(blocos)
    .reduce((acc, b) => acc + Number(b?.qtd_jogos || 0), 0);

  const pesoMedio = qtdTotal > 0 ? pesoTotal / qtdTotal : 0;

  const taxasGerais = calcularTaxasGerais(blocos);

  const resumoGeral = {
    xg_casa_anchor: round(xgCasaAnchor, 3),
    xg_fora_anchor: round(xgForaAnchor, 3),
    xg_total_anchor: round(xgTotalAnchor, 3),

    xgot_casa_anchor: roundOrNull(xgotCasaAnchor, 3),
    xgot_fora_anchor: roundOrNull(xgotForaAnchor, 3),
    xgot_total_anchor: roundOrNull(xgotTotalAnchor, 3),

    min_xgot_lado: roundOrNull(minXgotLado, 3),
    max_xgot_lado: roundOrNull(maxXgotLado, 3),

    ratio_xgot_xg_casa: roundOrNull(ratioXgotXgCasa, 3),
    ratio_xgot_xg_fora: roundOrNull(ratioXgotXgFora, 3),
    ratio_xgot_xg_total: roundOrNull(ratioXgotXgTotal, 3),

    gap_xg_xgot_casa: roundOrNull(gapXgXgotCasa, 3),
    gap_xg_xgot_fora: roundOrNull(gapXgXgotFora, 3),
    gap_xg_xgot_total: roundOrNull(gapXgXgotTotal, 3),

    qualidade_finalizacao: qualidadeFinalizacao,

    gols_casa_anchor: round(golsCasaAnchor, 3),
    gols_fora_anchor: round(golsForaAnchor, 3),
    gols_total_anchor: round(golsTotalAnchor, 3),

    peso_casa: round(Number(prodCasa.peso_total || 0), 3),
    peso_fora: round(Number(prodFora.peso_total || 0), 3),
    peso_total: round(pesoTotal, 3),

    peso_medio: round(pesoMedio, 3),

    qtd_casa: historicoCasa.length,
    qtd_fora: historicoFora.length,
    qtd_total: qtdTotal,

    confianca: classificarConfianca({
      pesoTotal,
      pesoMedio,
      qtdTotal,
    }),
  };

  const ladoCasaCompatBase = montarLadoCompat({
    lado: 'casa',
    producao: prodCasa,
    blocosLado: [
      blocos.ataque_casa_vs_defesa_fora,
      blocos.defesa_fora_vs_ataque_casa,
    ],
    mercado: 'over25',
  });

  const ladoForaCompatBase = montarLadoCompat({
    lado: 'fora',
    producao: prodFora,
    blocosLado: [
      blocos.ataque_fora_vs_defesa_casa,
      blocos.defesa_casa_vs_ataque_fora,
    ],
    mercado: 'over25',
  });

  const mercados = ['over15', 'over25', 'over35', 'btts_sim'];

  const saida = {
    over15: null,
    over25: null,
    over35: null,
    btts_sim: null,
  };

  for (const mercado of mercados) {
    const ladoCasa = montarLadoCompat({
      lado: 'casa',
      producao: prodCasa,
      blocosLado: [
        blocos.ataque_casa_vs_defesa_fora,
        blocos.defesa_fora_vs_ataque_casa,
      ],
      mercado,
    });

    const ladoFora = montarLadoCompat({
      lado: 'fora',
      producao: prodFora,
      blocosLado: [
        blocos.ataque_fora_vs_defesa_casa,
        blocos.defesa_casa_vs_ataque_fora,
      ],
      mercado,
    });

    const politicaAnchor = montarPoliticaAnchor({
      mercado,
      resumo: resumoGeral,
      taxas: taxasGerais,
      ladoCasaCompat: ladoCasa,
      ladoForaCompat: ladoFora,
    });

    const combinado = {
      aplicado: politicaAnchor.decisao !== 'ignorar',
      motivo: politicaAnchor.motivo,
      delta: Number(politicaAnchor.delta_base || 0),
      score_final: Number(politicaAnchor.ev_media || 0),
      reliability:
        resumoGeral.confianca === 'boa' ? 1 :
          resumoGeral.confianca === 'media' ? 0.80 :
            resumoGeral.confianca === 'baixa_util' ? 0.55 :
              0.25,
      total_sample_efetivo: resumoGeral.peso_total,

      delta_original: Number(politicaAnchor.delta_base || 0),
      delta_ponderado: Number(politicaAnchor.delta_ponderado || 0),

      politica_decisao: politicaAnchor.decisao,
      politica_peso: Number(politicaAnchor.peso || 0),
      politica_motivo: politicaAnchor.motivo,
    };

    const probMercadoAtual =
      mercado === 'over15' ? round(probO15Raw, 2) :
        mercado === 'over25' ? round(probO25Raw, 2) :
          mercado === 'over35' ? round(probO35Raw, 2) :
            round(probBTTSRaw, 2);

    const atualMercado = {
      casa: {
        lado: 'casa',

        lambda_time: round(lHome, 3),
        lambda_adversario: round(lAway, 3),
        total_lambda: round(Number(lHome || 0) + Number(lAway || 0), 3),
        lambda_min: round(Math.min(Number(lHome || 0), Number(lAway || 0)), 3),
        lambda_diff: round(Math.abs(Number(lHome || 0) - Number(lAway || 0)), 3),

        prob_mercado: probMercadoAtual,

        xg_anchor: roundOrNull(xgCasaAnchor, 3),
        xgot_anchor: roundOrNull(xgotCasaAnchor, 3),
        ratio_xgot_xg: roundOrNull(ratioXgotXgCasa, 3),
        gap_xg_xgot: roundOrNull(gapXgXgotCasa, 3),

        leitura_finalizacao:
          qualidadeFinalizacao?.alerta_over_inflado
            ? 'alerta_xgot_baixo_para_xg'
            : 'sem_alerta_forte_xgot',
      },

      fora: {
        lado: 'fora',

        lambda_time: round(lAway, 3),
        lambda_adversario: round(lHome, 3),
        total_lambda: round(Number(lHome || 0) + Number(lAway || 0), 3),
        lambda_min: round(Math.min(Number(lHome || 0), Number(lAway || 0)), 3),
        lambda_diff: round(Math.abs(Number(lHome || 0) - Number(lAway || 0)), 3),

        prob_mercado: probMercadoAtual,

        xg_anchor: roundOrNull(xgForaAnchor, 3),
        xgot_anchor: roundOrNull(xgotForaAnchor, 3),
        ratio_xgot_xg: roundOrNull(ratioXgotXgFora, 3),
        gap_xg_xgot: roundOrNull(gapXgXgotFora, 3),

        leitura_finalizacao:
          qualidadeFinalizacao?.alerta_over_inflado
            ? 'alerta_xgot_baixo_para_xg'
            : 'sem_alerta_forte_xgot',
      },
    };

    saida[mercado] = {
      mercado,
      atual: atualMercado,

      lado_casa: ladoCasa,
      lado_fora: ladoFora,

      combinado,
      politica_anchor: politicaAnchor,
    };
  }

  const deltaOver15 = Number(saida.over15?.politica_anchor?.delta_ponderado || 0);
  const deltaOver25 = Number(saida.over25?.politica_anchor?.delta_ponderado || 0);
  const deltaOver35 = Number(saida.over35?.politica_anchor?.delta_ponderado || 0);
  const deltaBTTS = Number(saida.btts_sim?.politica_anchor?.delta_ponderado || 0);

  return {
    deltaOver15,
    deltaOver25,
    deltaOver35,
    deltaBTTS,

    telemetry: {
      enabled: true,
      tipo: 'rating_batalhas_anchor',

      config: {
        limit: RATING_BATALHAS_CONFIG.limit,
        tolerancia_rating: RATING_BATALHAS_CONFIG.tolerancia_rating,
        peso_base_secundario: RATING_BATALHAS_CONFIG.peso_base_secundario,
        peso_variavel_secundario: RATING_BATALHAS_CONFIG.peso_variavel_secundario,
        minEffectiveSample: RATING_BATALHAS_CONFIG.minEffectiveSample,
        minSideEffectiveSample: RATING_BATALHAS_CONFIG.minSideEffectiveSample,
        maxDelta: RATING_BATALHAS_CONFIG.maxDelta,
        observacao: 'ancora_por_rating_em_4_blocos_ataque_vs_defesa_e_defesa_vs_ataque_sem_filtro_de_mando',
      },

      anti_leak: {
        enabled: true,
        flashscore_id_jogo_atual: flashscoreIdJogoAtual,
        data_jogo_atual: dataJogo,
        regra_data: 'data_referencia::date < data_jogo::date',
        exclui_proprio_flashscore_id: true,
        sem_filtro_mando: true,
        observacao: 'historico_rating_batalhas_nao_inclui_o_proprio_jogo_nem_jogos_do_mesmo_dia_ou_futuros',
      },

      rating_alvo: {
        casa: {
          id_time: idCasa,
          flashscore_id_time: fsCasa,
          nome_time: nomeCasa,
          origem: ratingCasaAlvo.origem,
          rating_ataque: round(ratingCasaAlvo.ataque, 3),
          rating_defesa: round(ratingCasaAlvo.defesa, 3),
        },
        fora: {
          id_time: idFora,
          flashscore_id_time: fsFora,
          nome_time: nomeFora,
          origem: ratingForaAlvo.origem,
          rating_ataque: round(ratingForaAlvo.ataque, 3),
          rating_defesa: round(ratingForaAlvo.defesa, 3),
        },
      },

      resumo: resumoGeral,

      qualidade_finalizacao_anchor: qualidadeFinalizacao,

      xgot_anchor_resumo: {
        xg_casa_anchor: round(xgCasaAnchor, 3),
        xg_fora_anchor: round(xgForaAnchor, 3),
        xg_total_anchor: round(xgTotalAnchor, 3),

        xgot_casa_anchor: roundOrNull(xgotCasaAnchor, 3),
        xgot_fora_anchor: roundOrNull(xgotForaAnchor, 3),
        xgot_total_anchor: roundOrNull(xgotTotalAnchor, 3),

        min_xgot_lado: roundOrNull(minXgotLado, 3),
        max_xgot_lado: roundOrNull(maxXgotLado, 3),

        ratio_xgot_xg_casa: roundOrNull(ratioXgotXgCasa, 3),
        ratio_xgot_xg_fora: roundOrNull(ratioXgotXgFora, 3),
        ratio_xgot_xg_total: roundOrNull(ratioXgotXgTotal, 3),

        gap_xg_xgot_casa: roundOrNull(gapXgXgotCasa, 3),
        gap_xg_xgot_fora: roundOrNull(gapXgXgotFora, 3),
        gap_xg_xgot_total: roundOrNull(gapXgXgotTotal, 3),
      },

      mercados_rating_batalhas: taxasGerais,

      blocos,

      compatibilidade_operacional: {
        observacao: 'campos_contextual.mercados_preservados_para_calcularDeltaEntradaPorAncora',
        lado_casa_base: ladoCasaCompatBase,
        lado_fora_base: ladoForaCompatBase,
      },

      politica_pesos: {
        enabled: true,
        observacao: 'delta_final_da_ancora_agora_vem_da_ancora_rating_batalhas',
        deltas_originais: {
          over15: round(deltaOver15, 3),
          over25: round(deltaOver25, 3),
          over35: round(deltaOver35, 3),
          btts_sim: round(deltaBTTS, 3),
          under15: round(-deltaOver15, 3),
          under25: round(-deltaOver25, 3),
          under35: round(-deltaOver35, 3),
          btts_nao: round(-deltaBTTS, 3),
        },
        deltas_ponderados: {
          over15: round(deltaOver15, 3),
          over25: round(deltaOver25, 3),
          over35: round(deltaOver35, 3),
          btts_sim: round(deltaBTTS, 3),
          under15: round(-deltaOver15, 3),
          under25: round(-deltaOver25, 3),
          under35: round(-deltaOver35, 3),
          btts_nao: round(-deltaBTTS, 3),
        },
      },

      historico: {
        casa_qtd: historicoCasa.length,
        fora_qtd: historicoFora.length,
      },

      mercados: saida,
    },
  };
}
function montarTelemetriaRatingPrincipalLambda({
  rCasa,
  rFora,
  base,
  lHome,
  lAway,
  lHomeBase,
  lAwayBase,
  anchorMarketsTelemetry,
}) {
  function n(v) {
    if (v === undefined || v === null || v === '') return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }

  function roundOrNull(v, casas = 4) {
    const x = n(v);
    return x === null ? null : +x.toFixed(casas);
  }

  function somaNull(a, b, casas = 4) {
    const na = n(a);
    const nb = n(b);

    if (na === null || nb === null) return null;

    return +(na + nb).toFixed(casas);
  }

  function diffNull(a, b, casas = 4) {
    const na = n(a);
    const nb = n(b);

    if (na === null || nb === null) return null;

    return +(na - nb).toFixed(casas);
  }

  function ratioNull(a, b, casas = 4) {
    const na = n(a);
    const nb = n(b);

    if (na === null || nb === null || nb === 0) return null;

    return +(na / nb).toFixed(casas);
  }

  function jsonObj(v) {
    if (!v) return {};
    if (typeof v === 'object') return v;

    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function firstNum(...vals) {
    for (const v of vals) {
      const x = n(v);
      if (x !== null) return x;
    }

    return null;
  }

  const mfCasa = jsonObj(rCasa?.casa_market_features);
  const mfFora = jsonObj(rFora?.fora_market_features);

  // =========================================================
  // CASA - rating principal usado no lambda quando o time joga em casa
  // =========================================================

  const casaRatingAtaque = n(rCasa?.casa_rating_ataque);
  const casaRatingDefesa = n(rCasa?.casa_rating_defesa);

  const casaXg = firstNum(
    rCasa?.casa_ewma_xg,
    mfCasa?.xg
  );

  // ewma_xga no rating atual representa xG contra estrutural.
  const casaXgaEstrutural = firstNum(
    rCasa?.casa_ewma_xga,
    mfCasa?.xg_contra,
    mfCasa?.opp_xg
  );

  // xGOT bruto ofensivo da forma recente.
  // Na sua tabela está dentro de casa_market_features.xgot.
  const casaXgotBruto = firstNum(
    mfCasa?.xgot
  );

  // xGA/xGOT enfrentado.
  // Na sua tabela aparece como casa_market_features.xga e também opp_xgot.
  const casaXgotContra = firstNum(
    mfCasa?.opp_xgot,
    mfCasa?.xga
  );

  const casaFatorMira = firstNum(
    rCasa?.casa_fator_mira,
    casaRatingAtaque !== null && casaXg !== null && casaXg > 0
      ? casaRatingAtaque / casaXg
      : null
  );

  const casaFatorDefesaImplicito = firstNum(
    casaRatingDefesa !== null && casaXgaEstrutural !== null && casaXgaEstrutural > 0
      ? casaRatingDefesa / casaXgaEstrutural
      : null
  );

  // Esse é o xG ajustado pela mira que realmente vira rating de ataque.
  // Na prática, deve bater com casa_rating_ataque.
  const casaXgotAjustadoPelaMira =
    casaXg !== null && casaFatorMira !== null
      ? casaXg * casaFatorMira
      : null;

  // =========================================================
  // FORA - rating principal usado no lambda quando o time joga fora
  // =========================================================

  const foraRatingAtaque = n(rFora?.fora_rating_ataque);
  const foraRatingDefesa = n(rFora?.fora_rating_defesa);

  const foraXg = firstNum(
    rFora?.fora_ewma_xg,
    mfFora?.xg
  );

  const foraXgaEstrutural = firstNum(
    rFora?.fora_ewma_xga,
    mfFora?.xg_contra,
    mfFora?.opp_xg
  );

  const foraXgotBruto = firstNum(
    mfFora?.xgot
  );

  const foraXgotContra = firstNum(
    mfFora?.opp_xgot,
    mfFora?.xga
  );

  const foraFatorMira = firstNum(
    rFora?.fora_fator_mira,
    foraRatingAtaque !== null && foraXg !== null && foraXg > 0
      ? foraRatingAtaque / foraXg
      : null
  );

  const foraFatorDefesaImplicito = firstNum(
    foraRatingDefesa !== null && foraXgaEstrutural !== null && foraXgaEstrutural > 0
      ? foraRatingDefesa / foraXgaEstrutural
      : null
  );

  const foraXgotAjustadoPelaMira =
    foraXg !== null && foraFatorMira !== null
      ? foraXg * foraFatorMira
      : null;

  // =========================================================
  // Totais do rating principal
  // =========================================================

  const xgTotalRating = somaNull(casaXg, foraXg, 4);
  const xgotBrutoTotalRating = somaNull(casaXgotBruto, foraXgotBruto, 4);
  const xgotAjustadoTotalRating = somaNull(casaXgotAjustadoPelaMira, foraXgotAjustadoPelaMira, 4);
  const xgaEstruturalTotalRating = somaNull(casaXgaEstrutural, foraXgaEstrutural, 4);
  const xgotContraTotalRating = somaNull(casaXgotContra, foraXgotContra, 4);

  const ratingAtaqueTotalUsado = somaNull(casaRatingAtaque, foraRatingAtaque, 4);
  const ratingDefesaTotalUsado = somaNull(casaRatingDefesa, foraRatingDefesa, 4);

  // Sinal bruto de confronto pelo rating principal:
  // casa ataca contra defesa fora; fora ataca contra defesa casa.
  const sinalGolCasaRating =
    casaRatingAtaque !== null && foraRatingDefesa !== null
      ? Math.min(casaRatingAtaque, foraRatingDefesa)
      : null;

  const sinalGolForaRating =
    foraRatingAtaque !== null && casaRatingDefesa !== null
      ? Math.min(foraRatingAtaque, casaRatingDefesa)
      : null;

  const totalSinalGolRating = somaNull(sinalGolCasaRating, sinalGolForaRating, 4);
  const minSinalGolRating =
    sinalGolCasaRating !== null && sinalGolForaRating !== null
      ? Math.min(sinalGolCasaRating, sinalGolForaRating)
      : null;
  const maxSinalGolRating =
    sinalGolCasaRating !== null && sinalGolForaRating !== null
      ? Math.max(sinalGolCasaRating, sinalGolForaRating)
      : null;

  // =========================================================
  // Dados da âncora contextual já calculada
  // =========================================================

  const anchorResumo = anchorMarketsTelemetry?.contextual?.resumo || {};
  const anchorBlocos = anchorMarketsTelemetry?.contextual?.blocos || {};

  const xgCasaAnchor = n(anchorResumo?.xg_casa_anchor);
  const xgForaAnchor = n(anchorResumo?.xg_fora_anchor);
  const xgTotalAnchor = n(anchorResumo?.xg_total_anchor);

  const xgotCasaAnchor = n(anchorResumo?.xgot_casa_anchor);
  const xgotForaAnchor = n(anchorResumo?.xgot_fora_anchor);
  const xgotTotalAnchor = n(anchorResumo?.xgot_total_anchor);

  const casaAtaqueXgAnchor = n(
    anchorBlocos?.ataque_casa_vs_defesa_fora?.xg_ponderado
  );
  const foraDefesaXgaAnchor = n(
    anchorBlocos?.defesa_fora_vs_ataque_casa?.xgot_ou_xga_ponderado
  );

  const foraAtaqueXgAnchor = n(
    anchorBlocos?.ataque_fora_vs_defesa_casa?.xg_ponderado
  );
  const casaDefesaXgaAnchor = n(
    anchorBlocos?.defesa_casa_vs_ataque_fora?.xgot_ou_xga_ponderado
  );

  const sinalGolCasaAnchor =
    casaAtaqueXgAnchor !== null && foraDefesaXgaAnchor !== null
      ? Math.min(casaAtaqueXgAnchor, foraDefesaXgaAnchor)
      : null;

  const sinalGolForaAnchor =
    foraAtaqueXgAnchor !== null && casaDefesaXgaAnchor !== null
      ? Math.min(foraAtaqueXgAnchor, casaDefesaXgaAnchor)
      : null;

  const totalSinalGolAnchor = somaNull(sinalGolCasaAnchor, sinalGolForaAnchor, 4);

  // =========================================================
  // Fatores do cálculo de lambda
  // =========================================================

  const fatorAtaqueCasa =
    casaRatingAtaque !== null && base > 0
      ? Math.pow(casaRatingAtaque / base, LAMBDA_WEIGHT_CONFIG.ataque)
      : null;

  const fatorDefesaFora =
    foraRatingDefesa !== null && base > 0
      ? Math.pow(foraRatingDefesa / base, LAMBDA_WEIGHT_CONFIG.defesa)
      : null;

  const fatorAtaqueFora =
    foraRatingAtaque !== null && base > 0
      ? Math.pow(foraRatingAtaque / base, LAMBDA_WEIGHT_CONFIG.ataque)
      : null;

  const fatorDefesaCasa =
    casaRatingDefesa !== null && base > 0
      ? Math.pow(casaRatingDefesa / base, LAMBDA_WEIGHT_CONFIG.defesa)
      : null;

  const lambdaCasaRecalculado =
    fatorAtaqueCasa !== null && fatorDefesaFora !== null
      ? base * fatorAtaqueCasa * fatorDefesaFora
      : null;

  const lambdaForaRecalculado =
    fatorAtaqueFora !== null && fatorDefesaCasa !== null
      ? base * fatorAtaqueFora * fatorDefesaCasa
      : null;

  return {
    versao: 'rating_principal_lambda_telemetria_v1',
    tipo: 'fotografia_pura_do_rating_principal_que_gerou_lambda',

    observacao:
      'Telemetria pura. Não altera lambda, não altera probabilidade e não altera filtro. Salva xG, xGOT, xGA, rating e fatores que já estavam no cálculo do lambda principal.',

    config: {
      base_usada: roundOrNull(base, 4),
      min_lambda: MODEL_CONFIG.minLambda,
      matrix_limit: MODEL_CONFIG.matrixLimit,
      peso_ataque_lambda: LAMBDA_WEIGHT_CONFIG.ataque,
      peso_defesa_lambda: LAMBDA_WEIGHT_CONFIG.defesa,
    },

    lambda: {
      l_home: roundOrNull(lHome, 4),
      l_away: roundOrNull(lAway, 4),
      total_lambda: somaNull(lHome, lAway, 4),

      l_home_base: roundOrNull(lHomeBase, 4),
      l_away_base: roundOrNull(lAwayBase, 4),
      total_lambda_base: somaNull(lHomeBase, lAwayBase, 4),
    },

    rating_usado_no_lambda: {
      casa_rating_ataque: roundOrNull(casaRatingAtaque, 4),
      casa_rating_defesa: roundOrNull(casaRatingDefesa, 4),
      fora_rating_ataque: roundOrNull(foraRatingAtaque, 4),
      fora_rating_defesa: roundOrNull(foraRatingDefesa, 4),

      casa_amostra: roundOrNull(rCasa?.casa_amostra, 0),
      fora_amostra: roundOrNull(rFora?.fora_amostra, 0),

      rating_ataque_total_usado: ratingAtaqueTotalUsado,
      rating_defesa_total_usado: ratingDefesaTotalUsado,
    },

    metricas_rating_principal: {
      casa: {
        xg: roundOrNull(casaXg, 4),

        // xGOT bruto recente salvo em casa_market_features.xgot.
        xgot_bruto: roundOrNull(casaXgotBruto, 4),

        // xG ajustado pelo fator_mira.
        // Esse é o número que vira rating de ataque.
        xgot_ajustado_pela_mira: roundOrNull(casaXgotAjustadoPelaMira, 4),

        // xGA estrutural = xG contra recente.
        xga_estrutural: roundOrNull(casaXgaEstrutural, 4),

        // xGOT contra / xGA do banco.
        xgot_contra: roundOrNull(casaXgotContra, 4),

        fator_mira: roundOrNull(casaFatorMira, 4),
        fator_defesa_implicito: roundOrNull(casaFatorDefesaImplicito, 4),

        ratio_xgot_bruto_xg: ratioNull(casaXgotBruto, casaXg, 4),
        ratio_xgot_ajustado_xg: ratioNull(casaXgotAjustadoPelaMira, casaXg, 4),
        ratio_xgot_contra_xga: ratioNull(casaXgotContra, casaXgaEstrutural, 4),

        dificuldade_defensiva_enfrentada: roundOrNull(
          rCasa?.casa_dificuldade_defensiva_enfrentada,
          4
        ),
        forca_ofensiva_enfrentada: roundOrNull(
          rCasa?.casa_forca_ofensiva_enfrentada,
          4
        ),
        qtd_adv_rating: roundOrNull(rCasa?.casa_qtd_adv_rating, 0),
      },

      fora: {
        xg: roundOrNull(foraXg, 4),
        xgot_bruto: roundOrNull(foraXgotBruto, 4),
        xgot_ajustado_pela_mira: roundOrNull(foraXgotAjustadoPelaMira, 4),
        xga_estrutural: roundOrNull(foraXgaEstrutural, 4),
        xgot_contra: roundOrNull(foraXgotContra, 4),

        fator_mira: roundOrNull(foraFatorMira, 4),
        fator_defesa_implicito: roundOrNull(foraFatorDefesaImplicito, 4),

        ratio_xgot_bruto_xg: ratioNull(foraXgotBruto, foraXg, 4),
        ratio_xgot_ajustado_xg: ratioNull(foraXgotAjustadoPelaMira, foraXg, 4),
        ratio_xgot_contra_xga: ratioNull(foraXgotContra, foraXgaEstrutural, 4),

        dificuldade_defensiva_enfrentada: roundOrNull(
          rFora?.fora_dificuldade_defensiva_enfrentada,
          4
        ),
        forca_ofensiva_enfrentada: roundOrNull(
          rFora?.fora_forca_ofensiva_enfrentada,
          4
        ),
        qtd_adv_rating: roundOrNull(rFora?.fora_qtd_adv_rating, 0),
      },

      totais: {
        xg_total_rating: xgTotalRating,

        // xGOT bruto recente, vindo de market_features.
        xgot_bruto_total_rating: xgotBrutoTotalRating,

        // xG * fator_mira. Isso deve bater com soma dos ratings de ataque.
        xgot_ajustado_total_rating: xgotAjustadoTotalRating,

        xga_estrutural_total_rating: xgaEstruturalTotalRating,
        xgot_contra_total_rating: xgotContraTotalRating,

        ratio_xgot_bruto_xg_total_rating: ratioNull(
          xgotBrutoTotalRating,
          xgTotalRating,
          4
        ),

        ratio_xgot_ajustado_xg_total_rating: ratioNull(
          xgotAjustadoTotalRating,
          xgTotalRating,
          4
        ),

        ratio_xgot_contra_xga_total_rating: ratioNull(
          xgotContraTotalRating,
          xgaEstruturalTotalRating,
          4
        ),
      },
    },

    sinal_gol_rating_principal: {
      casa_sinal_gol_rating: roundOrNull(sinalGolCasaRating, 4),
      fora_sinal_gol_rating: roundOrNull(sinalGolForaRating, 4),
      total_sinal_gol_rating: totalSinalGolRating,
      min_sinal_gol_rating: roundOrNull(minSinalGolRating, 4),
      max_sinal_gol_rating: roundOrNull(maxSinalGolRating, 4),
    },

    lambda_calculo: {
      fator_ataque_casa: roundOrNull(fatorAtaqueCasa, 6),
      fator_defesa_fora: roundOrNull(fatorDefesaFora, 6),
      fator_ataque_fora: roundOrNull(fatorAtaqueFora, 6),
      fator_defesa_casa: roundOrNull(fatorDefesaCasa, 6),

      lambda_casa_recalculado_pela_foto: roundOrNull(lambdaCasaRecalculado, 4),
      lambda_fora_recalculado_pela_foto: roundOrNull(lambdaForaRecalculado, 4),

      diff_lambda_casa_real_vs_recalculado: diffNull(lHome, lambdaCasaRecalculado, 6),
      diff_lambda_fora_real_vs_recalculado: diffNull(lAway, lambdaForaRecalculado, 6),
    },

    comparativo_anchor_vs_rating: {
      xg_casa_anchor: roundOrNull(xgCasaAnchor, 4),
      xg_fora_anchor: roundOrNull(xgForaAnchor, 4),
      xg_total_anchor: roundOrNull(xgTotalAnchor, 4),

      xgot_casa_anchor: roundOrNull(xgotCasaAnchor, 4),
      xgot_fora_anchor: roundOrNull(xgotForaAnchor, 4),
      xgot_total_anchor: roundOrNull(xgotTotalAnchor, 4),

      xg_total_rating: xgTotalRating,
      xgot_bruto_total_rating: xgotBrutoTotalRating,
      xgot_ajustado_total_rating: xgotAjustadoTotalRating,
      xga_estrutural_total_rating: xgaEstruturalTotalRating,
      xgot_contra_total_rating: xgotContraTotalRating,

      diff_xg_anchor_menos_rating: diffNull(xgTotalAnchor, xgTotalRating, 4),
      diff_xgot_anchor_menos_xgot_bruto_rating: diffNull(
        xgotTotalAnchor,
        xgotBrutoTotalRating,
        4
      ),
      diff_xgot_anchor_menos_xgot_ajustado_rating: diffNull(
        xgotTotalAnchor,
        xgotAjustadoTotalRating,
        4
      ),

      sinal_gol_casa_anchor: roundOrNull(sinalGolCasaAnchor, 4),
      sinal_gol_fora_anchor: roundOrNull(sinalGolForaAnchor, 4),
      total_sinal_gol_anchor: totalSinalGolAnchor,

      diff_total_sinal_anchor_menos_rating: diffNull(
        totalSinalGolAnchor,
        totalSinalGolRating,
        4
      ),
    },

    leitura_para_auditoria: {
      objetivo:
        'comparar rating principal que gerou lambda contra ancora contextual e contra xG/xGOT real pós-jogo',
      nao_usar_como_filtro_ainda: true,
    },
  };
}

async function analyzeTeamGolsFromFiltered(jogo) {
  try {
    const queryRatings = `
  SELECT
    id_time,

    casa_rating_ataque,
    casa_rating_defesa,
    fora_rating_ataque,
    fora_rating_defesa,

    casa_amostra,
    fora_amostra,

    casa_ewma_xg,
    casa_ewma_xga,
    casa_fator_mira,

    fora_ewma_xg,
    fora_ewma_xga,
    fora_fator_mira,

    casa_market_features,
    fora_market_features,

    casa_dificuldade_defensiva_enfrentada,
    casa_forca_ofensiva_enfrentada,
    fora_dificuldade_defensiva_enfrentada,
    fora_forca_ofensiva_enfrentada,
    casa_qtd_adv_rating,
    fora_qtd_adv_rating,

    casa_perfil,
    fora_perfil,

    casa_anchor_ult5,
    fora_anchor_ult5,

    casa_anchor_mercados,
    fora_anchor_mercados,
    anchor_mercados_geral_40
  FROM rating_times
  WHERE id_time IN ($1, $2)
`;

    const resRatings = await pool.query(queryRatings, [
      jogo.id_time_casa,
      jogo.id_time_fora,
    ]);

    const rCasa = resRatings.rows.find(
      r => Number(r.id_time) === Number(jogo.id_time_casa)
    );

    const rFora = resRatings.rows.find(
      r => Number(r.id_time) === Number(jogo.id_time_fora)
    );

    if (!rCasa || !rFora) {
      return {
        jogo_id: jogo.flashscore_id,
        status: 'skipped',
        motivo: 'Ratings não encontrados',
      };
    }

    const classificacaoJogo = await buscarClassificacaoDoJogo(jogo);

    const perfilCasa = parsePerfil(rCasa.casa_perfil);
    const perfilFora = parsePerfil(rFora.fora_perfil);

    const perfilCasaNormalizado = normalizePerfil(perfilCasa);
    const perfilForaNormalizado = normalizePerfil(perfilFora);

    const perfilContext = buildPerfilContext(perfilCasa, perfilFora);

    if (
      Number(rCasa.casa_amostra) < MODEL_CONFIG.minValidGames ||
      Number(rFora.fora_amostra) < MODEL_CONFIG.minValidGames
    ) {
      return {
        jogo_id: jogo.flashscore_id,
        status: 'skipped',
        motivo: 'Amostra insuficiente',
        telemetria: {
          amostra_casa: Number(rCasa.casa_amostra || 0),
          amostra_fora: Number(rFora.fora_amostra || 0),
          perfil_casa: perfilCasaNormalizado,
          perfil_fora: perfilForaNormalizado,
          perfil_contexto: perfilContext,
        },
      };
    }

    // =========================================================
    // CÁLCULO DE LAMBDA PURO
    // A classificação NÃO mexe aqui.
    // A nova âncora contextual também NÃO mexe aqui.
    // =========================================================

    const base = MODEL_CONFIG.baseUniversal;

    let lHomeBase =
      base *
      Math.pow(
        Number(rCasa.casa_rating_ataque) / base,
        LAMBDA_WEIGHT_CONFIG.ataque
      ) *
      Math.pow(
        Number(rFora.fora_rating_defesa) / base,
        LAMBDA_WEIGHT_CONFIG.defesa
      );

    let lAwayBase =
      base *
      Math.pow(
        Number(rFora.fora_rating_ataque) / base,
        LAMBDA_WEIGHT_CONFIG.ataque
      ) *
      Math.pow(
        Number(rCasa.casa_rating_defesa) / base,
        LAMBDA_WEIGHT_CONFIG.defesa
      );

    lHomeBase = clamp(lHomeBase, MODEL_CONFIG.minLambda, 3.8);
    lAwayBase = clamp(lAwayBase, MODEL_CONFIG.minLambda, 3.8);

    const lHome = lHomeBase;
    const lAway = lAwayBase;

    // =========================================================
    // ÂNCORAS ANTIGAS
    // Mantidas apenas para telemetria/comparação.
    // Não ajustam mais probabilidades.
    // =========================================================

    const anchorCasa = parseAnchor(rCasa.casa_anchor_ult5);
    const anchorFora = parseAnchor(rFora.fora_anchor_ult5);

    const anchorMercadosCasa = parseAnchor(rCasa.casa_anchor_mercados);
    const anchorMercadosFora = parseAnchor(rFora.fora_anchor_mercados);

    const anchorMercadosGeralCasa = parseAnchor(rCasa.anchor_mercados_geral_40);
    const anchorMercadosGeralFora = parseAnchor(rFora.anchor_mercados_geral_40);

    const fatorAncoraHome = 1.0;
    const fatorAncoraAway = 1.0;
    const ancoraHome = null;
    const ancoraAway = null;

    // =========================================================
    // MATRIZ POISSON + DIXON-COLES
    // =========================================================

    const matrizTemp = [];
    let somaProb = 0;

    const rho =
      (lHome + lAway < 2.2)
        ? -0.15
        : (lHome + lAway > 3.0 ? -0.05 : -0.10);

    for (let i = 0; i < MODEL_CONFIG.matrixLimit; i++) {
      matrizTemp[i] = [];

      for (let j = 0; j < MODEL_CONFIG.matrixLimit; j++) {
        let prob =
          math.probPoissonExact(lHome, i) *
          math.probPoissonExact(lAway, j);

        if (i === 0 && j === 0) prob *= 1 - lHome * lAway * rho;
        else if (i === 0 && j === 1) prob *= 1 + lHome * rho;
        else if (i === 1 && j === 0) prob *= 1 + lAway * rho;
        else if (i === 1 && j === 1) prob *= 1 - rho;

        prob = Math.max(0, prob);
        matrizTemp[i][j] = prob;
        somaProb += prob;
      }
    }

    const matrizFinal = matrizTemp.map(row => row.map(p => p / somaProb));

    let prob1 = 0;
    let probX = 0;
    let prob2 = 0;

    let probBTTS = 0;
    let probO15 = 0;
    let probO25 = 0;
    let probO35 = 0;

    for (let i = 0; i < MODEL_CONFIG.matrixLimit; i++) {
      for (let j = 0; j < MODEL_CONFIG.matrixLimit; j++) {
        const p = matrizFinal[i][j];

        if (i > j) prob1 += p;
        else if (i === j) probX += p;
        else prob2 += p;

        if (i > 0 && j > 0) probBTTS += p;
        if (i + j > 1.5) probO15 += p;
        if (i + j > 2.5) probO25 += p;
        if (i + j > 3.5) probO35 += p;
      }
    }

    // =========================================================
    // PROBABILIDADES BRUTAS DE GOLS
    // =========================================================

    const probO15Raw = +(probO15 * 100).toFixed(2);
    const probO25Raw = +(probO25 * 100).toFixed(2);
    const probO35Raw = +(probO35 * 100).toFixed(2);
    const probBTTSRaw = +(probBTTS * 100).toFixed(2);

    let probO15Final = probO15Raw;
    let probO25Final = probO25Raw;
    let probO35Final = probO35Raw;
    let probBTTSFinal = probBTTSRaw;

    let anchorMarketsTelemetry = null;

    // =========================================================
    // NOVA ÂNCORA CONTEXTUAL POR LAMBDA
    //
    // Substitui a âncora antiga de mercado.
    // Ajusta mercados de gols.
    // Não mexe no lambda.
    // Não mexe no 1x2.
    //
    // Usa histórico anterior ao jogo:
    // rating_times_historico.lambda_jogo_contexto
    // =========================================================

    const anchorContextual = await calcularAncoraContextualLambdaMercados({
      jogo,
      lHome,
      lAway,
      probO15Raw,
      probO25Raw,
      probO35Raw,
      probBTTSRaw,
    });

    probO15Final = +clamp(
      probO15Raw + Number(anchorContextual.deltaOver15 || 0),
      0,
      100
    ).toFixed(2);

    probO25Final = +clamp(
      probO25Raw + Number(anchorContextual.deltaOver25 || 0),
      0,
      100
    ).toFixed(2);

    probO35Final = +clamp(
      probO35Raw + Number(anchorContextual.deltaOver35 || 0),
      0,
      100
    ).toFixed(2);

    probBTTSFinal = +clamp(
      probBTTSRaw + Number(anchorContextual.deltaBTTS || 0),
      0,
      100
    ).toFixed(2);

    anchorMarketsTelemetry = {
      tipo: 'contextual_lambda_anchor',
      substitui_ancora_antiga: true,

      observacao:
        'ancora_contextual_usa_jogos_historicos_parecidos_por_lambda_time_lambda_adversario_total_lambda_lambda_min_lambda_diff_prob_mercado_e_regime',

      raw: {
        over15: probO15Raw,
        over25: probO25Raw,
        over35: probO35Raw,
        btts_sim: probBTTSRaw,

        under15: +(100 - probO15Raw).toFixed(2),
        under25: +(100 - probO25Raw).toFixed(2),
        under35: +(100 - probO35Raw).toFixed(2),
        btts_nao: +(100 - probBTTSRaw).toFixed(2),
      },

      deltas: {
        over15: +Number(anchorContextual.deltaOver15 || 0).toFixed(3),
        over25: +Number(anchorContextual.deltaOver25 || 0).toFixed(3),
        over35: +Number(anchorContextual.deltaOver35 || 0).toFixed(3),
        btts_sim: +Number(anchorContextual.deltaBTTS || 0).toFixed(3),

        under15: -Number(anchorContextual.deltaOver15 || 0),
        under25: -Number(anchorContextual.deltaOver25 || 0),
        under35: -Number(anchorContextual.deltaOver35 || 0),
        btts_nao: -Number(anchorContextual.deltaBTTS || 0),
      },

      final: {
        over15: probO15Final,
        over25: probO25Final,
        over35: probO35Final,
        btts_sim: probBTTSFinal,

        under15: +(100 - probO15Final).toFixed(2),
        under25: +(100 - probO25Final).toFixed(2),
        under35: +(100 - probO35Final).toFixed(2),
        btts_nao: +(100 - probBTTSFinal).toFixed(2),
      },

      contextual: anchorContextual.telemetry,

      antiga_somente_telemetria: {
        anchor_ult5_casa: anchorCasa,
        anchor_ult5_fora: anchorFora,
        anchor_mercados_casa: anchorMercadosCasa,
        anchor_mercados_fora: anchorMercadosFora,
        anchor_mercados_geral_40_casa: anchorMercadosGeralCasa,
        anchor_mercados_geral_40_fora: anchorMercadosGeralFora,
      },
    };

    // =========================================================
    // CLASSIFICAÇÃO NO 1X2
    // Entra depois da matriz.
    // Não mexe no lambda.
    // Não mexe em gols.
    // A nova âncora contextual NÃO mexe aqui.
    // =========================================================

    const probHomeRawPct = +(prob1 * 100).toFixed(2);
    const probDrawRawPct = +(probX * 100).toFixed(2);
    const probAwayRawPct = +(prob2 * 100).toFixed(2);

    const ajusteClassificacao1x2 = aplicarClassificacaoNo1x2(
      probHomeRawPct,
      probDrawRawPct,
      probAwayRawPct,
      classificacaoJogo.casa,
      classificacaoJogo.fora,
      classificacaoJogo.totalTimesLiga
    );
    anchorMarketsTelemetry.rating_principal_lambda = montarTelemetriaRatingPrincipalLambda({
      rCasa,
      rFora,
      base,
      lHome,
      lAway,
      lHomeBase,
      lAwayBase,
      anchorMarketsTelemetry,
    });

    return {
      jogo_id: jogo.flashscore_id,
      status: 'success',

      previsao: {
        // 1x2 bruto da matriz
        win_home_prob_raw: ajusteClassificacao1x2.raw.home,
        draw_prob_raw: ajusteClassificacao1x2.raw.draw,
        win_away_prob_raw: ajusteClassificacao1x2.raw.away,

        // 1x2 final ajustado pela classificação
        win_home_prob: ajusteClassificacao1x2.home,
        draw_prob: ajusteClassificacao1x2.draw,
        win_away_prob: ajusteClassificacao1x2.away,

        // Mercados de gols finais
        over_1_5_prob: probO15Final,
        over_2_5_prob: probO25Final,
        over_3_5_prob: probO35Final,
        btts_prob: probBTTSFinal,

        // Odds justas 1x2 usando probabilidade final ajustada
        odd_justa_home: oddJustaFromPct(ajusteClassificacao1x2.home),
        odd_justa_draw: oddJustaFromPct(ajusteClassificacao1x2.draw),
        odd_justa_away: oddJustaFromPct(ajusteClassificacao1x2.away),

        // Odds justas de gols
        odd_justa_over_2_5: oddJustaFromPct(probO25Final),
        odd_justa_btts: oddJustaFromPct(probBTTSFinal),
      },
      anchor_db: extrairCamposAnchorContextual({
        telemetria: {
          anchor_mercados_aplicacao: anchorMarketsTelemetry,
        },
      }),
      telemetria: {
        lHome: +lHome.toFixed(4),
        lAway: +lAway.toFixed(4),
        total_lambda: +(lHome + lAway).toFixed(4),

        lHome_base: +lHomeBase.toFixed(4),
        lAway_base: +lAwayBase.toFixed(4),
        total_lambda_base: +(lHomeBase + lAwayBase).toFixed(4),

        lambda_contexto_atual: {
          casa: {
            lambda_time: +lHome.toFixed(4),
            lambda_adversario: +lAway.toFixed(4),
            total_lambda: +(lHome + lAway).toFixed(4),
            lambda_min: +Math.min(lHome, lAway).toFixed(4),
            lambda_max: +Math.max(lHome, lAway).toFixed(4),
            lambda_diff: +Math.abs(lHome - lAway).toFixed(4),
          },
          fora: {
            lambda_time: +lAway.toFixed(4),
            lambda_adversario: +lHome.toFixed(4),
            total_lambda: +(lHome + lAway).toFixed(4),
            lambda_min: +Math.min(lHome, lAway).toFixed(4),
            lambda_max: +Math.max(lHome, lAway).toFixed(4),
            lambda_diff: +Math.abs(lHome - lAway).toFixed(4),
          },
        },

        probabilidades_gols_raw: {
          over15: probO15Raw,
          over25: probO25Raw,
          over35: probO35Raw,
          btts_sim: probBTTSRaw,

          under15: +(100 - probO15Raw).toFixed(2),
          under25: +(100 - probO25Raw).toFixed(2),
          under35: +(100 - probO35Raw).toFixed(2),
          btts_nao: +(100 - probBTTSRaw).toFixed(2),
        },

        probabilidades_gols_final: {
          over15: probO15Final,
          over25: probO25Final,
          over35: probO35Final,
          btts_sim: probBTTSFinal,

          under15: +(100 - probO15Final).toFixed(2),
          under25: +(100 - probO25Final).toFixed(2),
          under35: +(100 - probO35Final).toFixed(2),
          btts_nao: +(100 - probBTTSFinal).toFixed(2),
        },

        pesos_lambda: {
          ataque: LAMBDA_WEIGHT_CONFIG.ataque,
          defesa: LAMBDA_WEIGHT_CONFIG.defesa,
        },

        fator_ancora_home: +fatorAncoraHome.toFixed(4),
        fator_ancora_away: +fatorAncoraAway.toFixed(4),

        ancora_home: ancoraHome !== null ? +ancoraHome.toFixed(4) : null,
        ancora_away: ancoraAway !== null ? +ancoraAway.toFixed(4) : null,

        amostra_casa: Number(rCasa.casa_amostra || 0),
        amostra_fora: Number(rFora.fora_amostra || 0),

        perfil_casa: perfilCasaNormalizado,
        perfil_fora: perfilForaNormalizado,
        perfil_contexto: perfilContext,

        anchor_mercados_aplicacao: anchorMarketsTelemetry,

        classificacao_1x2: {
          busca: {
            motivo: classificacaoJogo.motivo,
            total_times_liga: classificacaoJogo.totalTimesLiga,
            temporada: CLASSIFICACAO_CONTEXT_CONFIG.temporada,
          },
          ajuste: ajusteClassificacao1x2.contexto,
          raw: ajusteClassificacao1x2.raw,
          final: {
            home: ajusteClassificacao1x2.home,
            draw: ajusteClassificacao1x2.draw,
            away: ajusteClassificacao1x2.away,
          },
          observacao: '1x2_nao_recebe_ancora_contextual_lambda',
        },
      },
    };
  } catch (error) {
    return {
      jogo_id: jogo?.flashscore_id || null,
      status: 'error',
      error: error.message,
    };
  }
}

module.exports = {
  analyzeTeamGolsFromFiltered,
  closeDb,
};