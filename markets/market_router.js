function parsePerfil(perfil) {
  if (!perfil) return {};
  if (typeof perfil === 'string') {
    try {
      return JSON.parse(perfil);
    } catch {
      return {};
    }
  }
  return perfil;
}

function parseJsonSafe(v, fallback = null) {
  if (!v) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}

async function buscarFeatures(db, id_time, venue, _id_competicao_atual) {
  // =========================================================
  // ORIGEM UNIFICADA:
  // rating_times.casa_market_features / fora_market_features
  // =========================================================
  const res = await db.query(
    `
      SELECT
        casa_market_features,
        fora_market_features
      FROM rating_times
      WHERE id_time = $1
      LIMIT 1
    `,
    [id_time]
  );

  if (!res.rows || res.rows.length === 0) {
    return { f: null, l: null, g: null };
  }

  const row = res.rows[0];
  const raw =
    venue === 'casa'
      ? row.casa_market_features
      : row.fora_market_features;

  const parsed = parseJsonSafe(raw, null);

  return {
    f: parsed,
    l: null,
    g: null,
  };
}

const logit = (p) => {
  if (p <= 0.001) return -6.9;
  if (p >= 0.999) return 6.9;
  return Math.log(p / (1 - p));
};

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clamp = (val, min, max) => Math.min(Math.max(val, min), max);
const ratio = (num, den) => (num || 0) / (den || 0.1);

const shrink = (value, sample, prior = 0, k = 4) =>
  ((sample * value) + (k * prior)) / (sample + k);

// ==============================================================
/* REGRESSÃO DE CONFIANÇA */
// ==============================================================
function applyTacticalEdge(pBasePct, tacticalEdgeLogit) {
  const baseLogit = logit(pBasePct / 100);

  const EDGE_CAP = 0.45;
  let safeEdge = Math.max(-EDGE_CAP, Math.min(EDGE_CAP, tacticalEdgeLogit));

  // respeita o Poisson
  safeEdge = safeEdge * 0.50;

  const finalProb = sigmoid(baseLogit + safeEdge) * 100;
  return Math.round(finalProb);
}

function z(value, statKey, baseLiga) {
  if (value == null || !baseLiga || baseLiga[`mean_${statKey}`] == null) return 0;

  const mean = parseFloat(baseLiga[`mean_${statKey}`]);
  const std = parseFloat(baseLiga[`std_${statKey}`]);

  if (!Number.isFinite(mean) || !Number.isFinite(std) || std === 0) return 0;

  return (value - mean) / std;
}

// ==============================================================
/* FALLBACK DE RATING ALTERNATIVO REMOVIDO */
// O projeto passa a confiar apenas no xG/xGOT como base de qualidade.
// Qualquer contexto extra continua disponível em storage, mas não entra
// no ajuste final de probabilidade.
// ==============================================================
function buildProxies(_data, _perfilRating, _baseLiga) {
  return {
    attack_quality: 0,
    defensive_leak: 0,
    ameaca_sem_posse: 0,
    control_score: 0,
    ruthless: 0,
    shell_risk: 0,
    response_threat: 0,
    perfil_transicao: 0,
    perfil_resposta: 0,
    perfil_controle_esteril: 0,
    perfil_queda: 0,
  };
}

function calcularSinaisFinais(
  analiseBase,
  dataHome,
  dataAway,
  ratingHome,
  ratingAway,
  baselineLiga
) {
  const lHome = parseFloat(analiseBase.l_home ?? 0);
  const lAway = parseFloat(analiseBase.l_away ?? 0);

  const pHomeBase = parseFloat(analiseBase.p_casa ?? 0) / 100;
  const pEmpateBase = parseFloat(analiseBase.p_empate ?? 0) / 100;
  const pAwayBase = parseFloat(analiseBase.p_fora ?? 0) / 100;
  const pBTTSBase = parseFloat(analiseBase.p_btts_sim ?? 0) / 100;
  const pOver25Base = parseFloat(analiseBase.p_over25 ?? 0) / 100;

  const h = buildProxies(dataHome, ratingHome?.casa_perfil, baselineLiga);
  const a = buildProxies(dataAway, ratingAway?.fora_perfil, baselineLiga);

  const favIsHome = lHome >= lAway;
  const lambdaFav = favIsHome ? lHome : lAway;
  const attackFav = favIsHome ? h.attack_quality : a.attack_quality;
  const leakDog = favIsHome ? a.defensive_leak : h.defensive_leak;
  const ruthlessFav = favIsHome ? h.ruthless : a.ruthless;
  const shellRiskFav = favIsHome ? h.shell_risk : a.shell_risk;

  // ==============================================================
  // 1X2
  // ==============================================================
  const homeEdge =
    0.20 * (h.control_score - a.control_score) +
    0.15 * (h.attack_quality - a.defensive_leak) -
    0.10 * a.ameaca_sem_posse -
    0.05 * a.response_threat;

  const awayEdge =
    0.20 * (a.control_score - h.control_score) +
    0.15 * (a.attack_quality - h.defensive_leak) -
    0.10 * h.ameaca_sem_posse -
    0.05 * h.response_threat;

  const targetTotal = parseFloat(baselineLiga?.mean_match_lambda ?? 2.5);
  const stdTotal = Math.max(parseFloat(baselineLiga?.std_match_lambda ?? 1), 0.25);

  const lowGoalBias = (targetTotal - (lHome + lAway)) / stdTotal;
  const parity = -Math.abs(lHome - lAway);

  const drawEdge =
    0.20 * parity +
    0.18 * lowGoalBias -
    0.08 * Math.abs(h.control_score - a.control_score);

  // ==============================================================
  // OVER 2.5
  // ==============================================================
  const zLambdaFav = (lambdaFav - (targetTotal / 2)) / (stdTotal / 2);

  const bilateralAttack =
    0.24 * h.attack_quality +
    0.24 * a.attack_quality;

  const bilateralLeak =
    0.20 * h.defensive_leak +
    0.20 * a.defensive_leak;

  const transitionFuel =
    0.12 * (h.ameaca_sem_posse + a.ameaca_sem_posse) +
    0.08 * (h.response_threat + a.response_threat);

  const massacre =
    0.24 * zLambdaFav +
    0.18 * attackFav +
    0.16 * leakDog +
    0.14 * ruthlessFav -
    0.12 * shellRiskFav;

  const attackMean = (h.attack_quality + a.attack_quality) / 2;
  const leakMean = (h.defensive_leak + a.defensive_leak) / 2;
  const controlMean = (h.control_score + a.control_score) / 2;
  const controlGap = Math.abs(h.control_score - a.control_score);

  const sterileControlBrake =
    0.22 * Math.max(0, controlMean) *
    (1 - clamp((attackMean + 0.20) / 0.80, 0, 1));

  const unilateralBrake =
    0.14 * controlGap *
    (1 - clamp((Math.min(h.attack_quality, a.attack_quality) + 0.15) / 0.55, 0, 1));

  const dualOpenBoost =
    0.16 * Math.max(0, h.attack_quality) * Math.max(0, a.attack_quality) +
    0.14 * Math.max(0, h.defensive_leak) * Math.max(0, a.defensive_leak);

  // PERFIL DESLIGADO: sem residual boost/brake
  const adjOver25 =
    (0.38 * massacre) +
    bilateralAttack +
    bilateralLeak +
    transitionFuel +
    dualOpenBoost -
    sterileControlBrake -
    unilateralBrake;

  // ==============================================================
  // BTTS
  // ==============================================================
  const bilateralBTTS =
    0.24 * h.attack_quality +
    0.24 * a.attack_quality +
    0.18 * h.defensive_leak +
    0.18 * a.defensive_leak +
    0.10 * (h.response_threat + a.response_threat);

  const bttsSymmetryBoost =
    0.12 * Math.min(h.attack_quality, a.attack_quality) +
    0.10 * Math.min(h.defensive_leak, a.defensive_leak);

  const bttsDominationBrake =
    0.18 * controlGap +
    0.10 * Math.max(0, Math.max(h.control_score, a.control_score)) *
    (1 - clamp((Math.min(h.attack_quality, a.attack_quality) + 0.15) / 0.55, 0, 1));

  const bttsSterileBrake =
    0.12 * Math.max(0, controlMean) *
    (1 - clamp((attackMean + leakMean + 0.20) / 0.90, 0, 1));

  // PERFIL DESLIGADO: sem residual boost/brake
  const adjBTTS =
    bilateralBTTS +
    bttsSymmetryBoost -
    bttsDominationBrake -
    bttsSterileBrake;

  const pHomeFinal = applyTacticalEdge(pHomeBase * 100, homeEdge);
  const pDrawFinal = applyTacticalEdge(pEmpateBase * 100, drawEdge);
  const pAwayFinal = applyTacticalEdge(pAwayBase * 100, awayEdge);
  const pBttsFinal = applyTacticalEdge(pBTTSBase * 100, adjBTTS);
  const pOver25Final = applyTacticalEdge(pOver25Base * 100, adjOver25);

  const sum1x2 = Math.max(pHomeFinal + pDrawFinal + pAwayFinal, 1);

  return {
    vitoriaCasa: Math.round((pHomeFinal / sum1x2) * 100),
    empate: Math.round((pDrawFinal / sum1x2) * 100),
    vitoriaFora: Math.round((pAwayFinal / sum1x2) * 100),
    btts: pBttsFinal,
    over25: pOver25Final,
    raio_x: {
      h_attack: h.attack_quality,
      h_leak: h.defensive_leak,
      h_control: h.control_score,
      a_attack: a.attack_quality,
      a_leak: a.defensive_leak,
      a_control: a.control_score,

      h_residual_transicao: 0,
      h_residual_resposta: 0,
      h_residual_esteril: 0,
      h_residual_queda: 0,

      a_residual_transicao: 0,
      a_residual_resposta: 0,
      a_residual_esteril: 0,
      a_residual_queda: 0,

      edge_1x2: homeEdge,
      edge_over25: adjOver25,
      edge_btts: adjBTTS,
    }
  };
}

module.exports = { buscarFeatures, calcularSinaisFinais };