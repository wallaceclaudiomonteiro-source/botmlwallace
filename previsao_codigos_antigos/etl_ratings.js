//require('dotenv').config();
const { Pool } = require('pg');

// ==================================TimesDoDia =======================
// 🎯 DATA ALVO DA ANÁLISE
// =========================================================
const argDate = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
const DATA_ALVO = argDate || process.env.DATA_ALVO || '2026-09-06';

if (!/^\d{4}-\d{2}-\d{2}$/.test(DATA_ALVO)) {
  throw new Error(`DATA_ALVO inválida: ${DATA_ALVO}`);
}

// =========================================================
// 🔗 CONEXÃO
// =========================================================
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol',
  max: 20,
  idleTimeoutMillis: 30000,
});

// =========================================================
// ⚙️ CONFIGURAÇÕES MATEMÁTICAS
// =========================================================
const CONFIG = {
  limiteJogosRating: 10,

  // Âncora por mando
  limiteJogosAncora: 40,

  // Âncora geral sem depender de mando
  limiteJogosAncoraGeral: 40,

  // Peso temporal
  ewmaAlpha: 0.25,

  // Teto para evitar jogo absurdo destruir média
  tetoMetricas: 3.30,

  // ==============================
  // ATAQUE
  // ==============================
  // Ataque base = xG
  // Ajuste de mira = xGOT / xG
  shrinkageAlphaAtaque: 0.25,
  minFatorMira: 0.85,
  maxFatorMira: 1.30,

  // ==============================
  // DEFESA
  // ==============================
  // Defesa base = xG contra
  // Ajuste leve = xGA / xG contra
  //
  // Aqui o peso é menor porque xGA contra tem mais ruído:
  // goleiro, finalização adversária, variância e contexto.
  shrinkageAlphaDefesa: 0.08,
  minFatorDefesa: 0.92,
  maxFatorDefesa: 1.12,

  // Ajuste de rating pela qualidade dos adversários enfrentados
  usarAjusteQualidadeAdversarioNoRating: false,

  // Ataque reage mais, porque xG contra defesa fraca infla muito.
  pesoDificuldadeDefensivaEnfrentada: 0.35,

  // Defesa reage menos para não virar o modelo de cabeça para baixo.
  pesoForcaOfensivaEnfrentada: 0.20,

  minDificuldadeDefensiva: 0.50,
  maxDificuldadeDefensiva: 1.60,

  minForcaOfensiva: 0.60,
  maxForcaOfensiva: 1.80,
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round3(v) {
  return +toNum(v).toFixed(3);
}

function ordenarJogosRecentes(jogos) {
  return [...(jogos || [])].sort(
    (a, b) => new Date(b.data_jogo) - new Date(a.data_jogo)
  );
}

function pesoCanonico(jogo, idx) {
  let peso = Math.pow(1 - CONFIG.ewmaAlpha, idx);

  // Ruído leve se houve vermelho para o próprio time naquele jogo
  if (toNum(jogo.qtd_vermelhos, 0) > 0) {
    peso *= 0.85;
  }

  return peso;
}

function mediaPonderada(jogos, getter, filterFn = () => true) {
  if (!jogos || jogos.length === 0) return 0;

  let soma = 0;
  let somaPesos = 0;

  jogos.forEach((jogo, idx) => {
    if (!filterFn(jogo)) return;

    const valor = toNum(getter(jogo), 0);
    const peso = pesoCanonico(jogo, idx);

    soma += valor * peso;
    somaPesos += peso;
  });

  return somaPesos > 0 ? soma / somaPesos : 0;
}

function contar(jogos, filterFn = () => true) {
  return (jogos || []).filter(filterFn).length;
}

function normalizarDataISO(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);

  const d = new Date(v);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function mediaPonderadaItensComJogo(itens) {
  if (!itens || itens.length === 0) return 0;

  let soma = 0;
  let somaPesos = 0;

  itens.forEach((item, idx) => {
    const peso = pesoCanonico(item.jogo, idx);
    soma += toNum(item.valor, 0) * peso;
    somaPesos += peso;
  });

  return somaPesos > 0 ? soma / somaPesos : 0;
}

async function buscarSnapshotHistoricoAntes(client, flashscoreIdTime, dataJogo, cacheSnapshots) {
  const dataCorte = normalizarDataISO(dataJogo);
  const cacheKey = `${flashscoreIdTime}|${dataCorte}`;

  if (cacheSnapshots.has(cacheKey)) {
    return cacheSnapshots.get(cacheKey);
  }

  const res = await client.query(
    `
      SELECT
        data_referencia,
        casa_rating_ataque,
        casa_rating_defesa,
        fora_rating_ataque,
        fora_rating_defesa
      FROM rating_times_historico
      WHERE flashscore_id_time = $1
        AND data_referencia < $2
      ORDER BY data_referencia DESC
      LIMIT 1
    `,
    [flashscoreIdTime, dataCorte]
  );

  const snapshot = res.rows[0] || null;
  cacheSnapshots.set(cacheKey, snapshot);
  return snapshot;
}

async function calcularFatoresQualidadeAdversariosMando(client, jogos, cacheSnapshots) {
  const jogosOrd = ordenarJogosRecentes(jogos);

  if (!jogosOrd.length) {
    return {
      fator_qualidade_adv_ataque: 1,
      fator_qualidade_adv_defesa: 1,
      qtd_adv_rating: 0,
    };
  }

  const itensAtaque = [];
  const itensDefesa = [];

  for (const jogo of jogosOrd) {
    const fsIdAdversario =
      jogo.mando === 'casa'
        ? jogo.flashscore_id_time_fora
        : jogo.flashscore_id_time_casa;

    if (!fsIdAdversario) continue;

    const snapshotAdv = await buscarSnapshotHistoricoAntes(
      client,
      fsIdAdversario,
      jogo.data_jogo,
      cacheSnapshots
    );

    if (!snapshotAdv) continue;

    const advRatingDefesa =
      jogo.mando === 'casa'
        ? toNum(snapshotAdv.fora_rating_defesa, 0)
        : toNum(snapshotAdv.casa_rating_defesa, 0);

    const advRatingAtaque =
      jogo.mando === 'casa'
        ? toNum(snapshotAdv.fora_rating_ataque, 0)
        : toNum(snapshotAdv.casa_rating_ataque, 0);

    if (advRatingDefesa > 0) {
      itensAtaque.push({
        jogo,
        valor: 1 / advRatingDefesa,
      });
    }

    if (advRatingAtaque > 0) {
      itensDefesa.push({
        jogo,
        valor: advRatingAtaque,
      });
    }
  }

  return {
    fator_qualidade_adv_ataque: round3(
      itensAtaque.length ? mediaPonderadaItensComJogo(itensAtaque) : 1
    ),
    fator_qualidade_adv_defesa: round3(
      itensDefesa.length ? mediaPonderadaItensComJogo(itensDefesa) : 1
    ),
    qtd_adv_rating: Math.max(itensAtaque.length, itensDefesa.length),
  };
}

function aplicarAjusteQualidadeAdversarioNoRating(stats, fatores) {
  if (!CONFIG.usarAjusteQualidadeAdversarioNoRating) {
    return {
      ...stats,
      ataque_original: stats.ataque,
      defesa_original: stats.defesa,
      fator_ajuste_ataque_qualidade: 1,
      fator_ajuste_defesa_qualidade: 1,
    };
  }

  const dificuldadeDefensivaEnfrentada = clamp(
    toNum(fatores?.fator_qualidade_adv_ataque, 1),
    CONFIG.minDificuldadeDefensiva,
    CONFIG.maxDificuldadeDefensiva
  );

  const forcaOfensivaEnfrentada = clamp(
    toNum(fatores?.fator_qualidade_adv_defesa, 1),
    CONFIG.minForcaOfensiva,
    CONFIG.maxForcaOfensiva
  );

  const fatorAjusteAtaque = Math.pow(
    dificuldadeDefensivaEnfrentada,
    CONFIG.pesoDificuldadeDefensivaEnfrentada
  );

  const fatorAjusteDefesa = Math.pow(
    forcaOfensivaEnfrentada,
    CONFIG.pesoForcaOfensivaEnfrentada
  );

  const ataqueAjustado = clamp(
    toNum(stats.ataque, 0) * fatorAjusteAtaque,
    0.20,
    CONFIG.tetoMetricas
  );

  const defesaAjustada = clamp(
    toNum(stats.defesa, 0) / fatorAjusteDefesa,
    0.20,
    CONFIG.tetoMetricas
  );

  return {
    ...stats,

    ataque_original: stats.ataque,
    defesa_original: stats.defesa,

    ataque: ataqueAjustado,
    defesa: defesaAjustada,

    dificuldade_defensiva_enfrentada: round3(dificuldadeDefensivaEnfrentada),
    forca_ofensiva_enfrentada: round3(forcaOfensivaEnfrentada),

    fator_ajuste_ataque_qualidade: round3(fatorAjusteAtaque),
    fator_ajuste_defesa_qualidade: round3(fatorAjusteDefesa),
  };
}

// =========================================================
// 🧮 MOTOR DE CÁLCULO DE RATING
// =========================================================
function calcularEWMA(itens) {
  if (!itens || itens.length === 0) return 0;

  let somaPesada = 0;
  let somaPesos = 0;

  itens.forEach((item, idx) => {
    const peso = Math.pow(1 - CONFIG.ewmaAlpha, idx);
    somaPesada += item.valor * peso;
    somaPesos += peso;
  });

  return somaPesos > 0 ? somaPesada / somaPesos : 0;
}

function processarRatingMando(jogos) {
  if (!jogos || jogos.length < 10) {
    return {
      ataque: 0,
      defesa: 0,

      // ewmaXg = xG ofensivo
      ewmaXg: 0,

      // ewmaXga = xG contra estrutural
      ewmaXga: 0,

      fatorMira: 1,
      fatorDefesa: 1,

      amostra: jogos ? jogos.length : 0,
    };
  }

  jogos.sort((a, b) => new Date(b.data_jogo) - new Date(a.data_jogo));

  const xgLivre = [];
  const xgotLivre = [];

  // xG contra estrutural
  const xgContraLivre = [];

  // xGA antigo = xGOT enfrentado
  const xgaLivre = [];

  jogos.forEach((j) => {
    // Se não tiver xG ou xG Contra base, aí sim ignoramos o jogo
    if (j.xg == null || j.xg_contra == null) return;

    // 1. Base Ataque (xG)
    let valXg = Math.max(0.01, toNum(j.xg, 0));
    valXg = Math.min(valXg, CONFIG.tetoMetricas);

    // 2. Base Defesa (xG Contra)
    let valXgContra = Math.max(0.01, toNum(j.xg_contra, 0));
    valXgContra = Math.min(valXgContra, CONFIG.tetoMetricas);

    // 3. HÍBRIDO ATAQUE: Se xGOT for nulo, assumimos o valor do xG (fator = 1)
    let rawXgot = j.xgot != null ? j.xgot : j.xg;
    let valXgot = Math.max(0.01, toNum(rawXgot, 0));
    valXgot = Math.min(valXgot, CONFIG.tetoMetricas);

    // 4. HÍBRIDO DEFESA: Se xGA for nulo, assumimos o valor do xG Contra (fator = 1)
    let rawXga = j.xga != null ? j.xga : j.xg_contra;
    let valXga = Math.max(0.01, toNum(rawXga, 0));
    valXga = Math.min(valXga, CONFIG.tetoMetricas);

    xgLivre.push({ valor: valXg });
    xgotLivre.push({ valor: valXgot });
    xgContraLivre.push({ valor: valXgContra });
    xgaLivre.push({ valor: valXga });
  });

  const ewmaXg = calcularEWMA(xgLivre);
  const ewmaXgot = calcularEWMA(xgotLivre);

  // Aqui ewmaXga passa a significar xG contra.
  // Mantém o nome por compatibilidade com as colunas casa_ewma_xga/fora_ewma_xga.
  const ewmaXga = calcularEWMA(xgContraLivre);

  // xGA atual do banco = xGOT enfrentado.
  // Não vira base da defesa, só ajuste leve.
  const ewmaXgotContra = calcularEWMA(xgaLivre);

  const baseXg = ewmaXg <= 0 ? 0.01 : ewmaXg;

  const fatorMira = clamp(
    1 + CONFIG.shrinkageAlphaAtaque * ((ewmaXgot / baseXg) - 1),
    CONFIG.minFatorMira,
    CONFIG.maxFatorMira
  );

  const ataqueFinal = ewmaXg * fatorMira;

  const baseXgContra = ewmaXga <= 0 ? 0.01 : ewmaXga;

  const fatorDefesa = clamp(
    1 + CONFIG.shrinkageAlphaDefesa * ((ewmaXgotContra / baseXgContra) - 1),
    CONFIG.minFatorDefesa,
    CONFIG.maxFatorDefesa
  );

  const defesaFinal = ewmaXga * fatorDefesa;

  return {
    ataque: ataqueFinal,
    defesa: defesaFinal,

    ewmaXg,

    // Coluna continua se chamando ewma_xga,
    // mas agora guarda xG contra estrutural.
    ewmaXga,

    fatorMira,
    fatorDefesa,

    amostra: jogos.length,
  };
}

// =========================================================
// ⚓ ÂNCORA DOS ÚLTIMOS 12 DO HISTÓRICO DO RATING
// =========================================================
function calcularAncoraUlt12DoRating(jogos) {
  const jogosOrd = ordenarJogosRecentes(jogos).slice(0, 12);

  if (jogosOrd.length < 10) {
    return {
      sample: jogosOrd.length,

      media_gols_marcados: 0,
      media_gols_sofridos: 0,
      gols_marcados: [],
      gols_sofridos: [],

      media_gols_total: 0,
      taxa_over25: 0,
      gols_totais: [],
    };
  }

  const golsMarcados = jogosOrd.map((j) => toNum(j.gols_marcados_time, 0));
  const golsSofridos = jogosOrd.map((j) => toNum(j.gols_sofridos_time, 0));
  const golsTotais = jogosOrd.map((j) => toNum(j.gols_total_partida, 0));

  const somaMarcados = golsMarcados.reduce((acc, n) => acc + n, 0);
  const somaSofridos = golsSofridos.reduce((acc, n) => acc + n, 0);
  const somaTotais = golsTotais.reduce((acc, n) => acc + n, 0);

  const mediaMarcados = somaMarcados / golsMarcados.length;
  const mediaSofridos = somaSofridos / golsSofridos.length;
  const mediaTotal = somaTotais / golsTotais.length;

  const taxaOver25 =
    golsTotais.filter((g) => g > 2.5).length / golsTotais.length;

  return {
    sample: jogosOrd.length,

    media_gols_marcados: round3(mediaMarcados),
    media_gols_sofridos: round3(mediaSofridos),
    gols_marcados: golsMarcados,
    gols_sofridos: golsSofridos,

    media_gols_total: round3(mediaTotal),
    taxa_over25: round3(taxaOver25),
    gols_totais: golsTotais,
  };
}

// =========================================================
// 🧠 PERFIL RESIDUAL / COMPORTAMENTAL
// =========================================================
function calcularPerfilResidualMandoUnificado(jogos) {
  const jogosOrd = ordenarJogosRecentes(jogos);

  if (!jogosOrd.length) {
    return {
      sample_total: 0,
      sample_low_pos: 0,
      perfil_ativo: 0,
      ameaca_transicao: 0,
      controle_esteril: 0,
    };
  }

  const sampleTotal = jogosOrd.length;
  const sampleLowPos = contar(jogosOrd, (j) => toNum(j.posse, 50) <= 45);

  if (sampleTotal < 10) {
    return {
      sample_total: sampleTotal,
      sample_low_pos: sampleLowPos,
      perfil_ativo: 0,
      ameaca_transicao: 0,
      controle_esteril: 0,
    };
  }

  const avg = (getter, filterFn = () => true) =>
    mediaPonderada(jogosOrd, getter, filterFn);

  const lowPosXg = avg((j) => j.xg, (j) => toNum(j.posse, 50) <= 45);
  const lowPosBig = avg((j) => j.big_chances, (j) => toNum(j.posse, 50) <= 45);
  const lowPosDepth = avg((j) => j.depth_passes, (j) => toNum(j.posse, 50) <= 45);

  const ameacaTransicao =
    sampleLowPos >= 2
      ? (0.55 * lowPosXg) + (0.25 * lowPosBig) + (0.20 * lowPosDepth)
      : 0;

  const posse = avg((j) => j.posse);
  const passPct = avg((j) => j.pass_pct);
  const xg = avg((j) => j.xg);
  const boxTouches = avg((j) => j.box_touches);
  const big = avg((j) => j.big_chances);

  const controleEsteril =
    ((posse / 100) * 0.45 + (passPct / 100) * 0.35) -
    (xg * 0.12 + boxTouches * 0.015 + big * 0.10);

  return {
    sample_total: sampleTotal,
    sample_low_pos: sampleLowPos,
    perfil_ativo: 1,
    ameaca_transicao: round3(ameacaTransicao),
    controle_esteril: round3(controleEsteril),
  };
}

// =========================================================
// 📦 FEATURES DE MERCADO UNIFICADAS
// =========================================================
function calcularFeaturesMercadoMandoUnificadas(jogos) {
  const jogosOrd = ordenarJogosRecentes(jogos);

  if (!jogosOrd.length) {
    return {
      sample: 0,
      cnt_low_pos: 0,

      xg: 0,
      xgot: 0,

      // Defesa nova auditável
      xg_contra: 0,
      xga: 0,

      xa: 0,
      big_chances: 0,
      sot: 0,
      box_shots: 0,
      box_touches: 0,
      depth_passes: 0,

      opp_xg: 0,
      opp_xgot: 0,
      opp_sot: 0,
      opp_box_shots: 0,
      opp_box_touches: 0,

      errors_to_shot: 0,
      errors_goal: 0,
      goalkeeper_saves: 0,

      posse: 0,
      pass_pct: 0,
      final_third_pass_pct: 0,

      low_xg: 0,
      low_xgot: 0,
      low_big_chances: 0,
      low_box_shots: 0,
      low_box_touches: 0,
      low_depth_passes: 0,
    };
  }

  const avg = (getter, filterFn = () => true) =>
    round3(mediaPonderada(jogosOrd, getter, filterFn));

  return {
    sample: jogosOrd.length,
    cnt_low_pos: contar(jogosOrd, (j) => toNum(j.posse, 50) <= 45),

    xg: avg((j) => j.xg),
    xgot: avg((j) => j.xgot),

    // Defesa nova auditável
    xg_contra: avg((j) => j.xg_contra),
    xga: avg((j) => j.xga),

    xa: avg((j) => j.xa),
    big_chances: avg((j) => j.big_chances),
    sot: avg((j) => j.sot),
    box_shots: avg((j) => j.box_shots),
    box_touches: avg((j) => j.box_touches),
    depth_passes: avg((j) => j.depth_passes),

    opp_xg: avg((j) => j.opp_xg),
    opp_xgot: avg((j) => j.opp_xgot),
    opp_sot: avg((j) => j.opp_sot),
    opp_box_shots: avg((j) => j.opp_box_shots),
    opp_box_touches: avg((j) => j.opp_box_touches),

    errors_to_shot: avg((j) => j.errors_to_shot),
    errors_goal: avg((j) => j.errors_goal),
    goalkeeper_saves: avg((j) => j.goalkeeper_saves),

    posse: avg((j) => j.posse),
    pass_pct: avg((j) => j.pass_pct),
    final_third_pass_pct: avg((j) => j.final_third_pass_pct),

    low_xg: avg((j) => j.xg, (j) => toNum(j.posse, 50) <= 45),
    low_xgot: avg((j) => j.xgot, (j) => toNum(j.posse, 50) <= 45),
    low_big_chances: avg((j) => j.big_chances, (j) => toNum(j.posse, 50) <= 45),
    low_box_shots: avg((j) => j.box_shots, (j) => toNum(j.posse, 50) <= 45),
    low_box_touches: avg((j) => j.box_touches, (j) => toNum(j.posse, 50) <= 45),
    low_depth_passes: avg((j) => j.depth_passes, (j) => toNum(j.posse, 50) <= 45),
  };
}

function media(nums) {
  const arr = (nums || []).filter(n => Number.isFinite(n));
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function mediana(nums) {
  const arr = (nums || [])
    .filter(n => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (!arr.length) return 0;

  const mid = Math.floor(arr.length / 2);
  return arr.length % 2
    ? arr[mid]
    : (arr[mid - 1] + arr[mid]) / 2;
}

function pesoAncoraPorIndice(idx) {
  if (idx < 10) return 1.00;
  if (idx < 20) return 0.80;
  return 0.60;
}

function somaPeso(itens, filterFn = () => true) {
  return (itens || []).reduce((acc, item) => {
    if (!filterFn(item)) return acc;
    return acc + toNum(item.pesoAncora, 0);
  }, 0);
}

function mediaPonderadaAncora(itens, getter) {
  let soma = 0;
  let somaPesos = 0;

  for (const item of itens || []) {
    const valor = Number(getter(item));
    const peso = toNum(item.pesoAncora, 0);

    if (!Number.isFinite(valor) || peso <= 0) continue;

    soma += valor * peso;
    somaPesos += peso;
  }

  return somaPesos > 0 ? soma / somaPesos : 0;
}

function resumirMercado(itens, chaveHit, extras = {}) {
  const hitsRaw = itens.filter(i => i[chaveHit] === 1);
  const missesRaw = itens.filter(i => i[chaveHit] === 0);

  const pesoTotal = somaPeso(itens);
  const pesoHits = somaPeso(hitsRaw);
  const pesoMisses = somaPeso(missesRaw);

  const out = {
    hits: round3(pesoHits),
    rate: pesoTotal > 0 ? round3(pesoHits / pesoTotal) : 0,

    hits_raw: hitsRaw.length,
    misses_raw: missesRaw.length,
    hits_peso: round3(pesoHits),
    misses_peso: round3(pesoMisses),

    qualidade_adv_ataque_media_hits: round3(
      mediaPonderadaAncora(hitsRaw, i => i.advAtaque)
    ),
    qualidade_adv_defesa_media_hits: round3(
      mediaPonderadaAncora(hitsRaw, i => i.advDefesa)
    ),
    qualidade_adv_ataque_media_miss: round3(
      mediaPonderadaAncora(missesRaw, i => i.advAtaque)
    ),
    qualidade_adv_defesa_media_miss: round3(
      mediaPonderadaAncora(missesRaw, i => i.advDefesa)
    ),
  };

  if (extras.time_marcou) {
    out.time_marcou_hits = round3(somaPeso(hitsRaw, i => i.time_marcou === 1));
    out.time_marcou_hits_raw = hitsRaw.filter(i => i.time_marcou === 1).length;
  }

  if (extras.time_sofreu) {
    out.time_sofreu_hits = round3(somaPeso(hitsRaw, i => i.time_sofreu === 1));
    out.time_sofreu_hits_raw = hitsRaw.filter(i => i.time_sofreu === 1).length;
  }

  if (extras.clean_sheet) {
    out.clean_sheet_hits = round3(somaPeso(hitsRaw, i => i.clean_sheet === 1));
    out.clean_sheet_hits_raw = hitsRaw.filter(i => i.clean_sheet === 1).length;
  }

  if (extras.passouEmBranco) {
    out.time_passou_em_branco_hits = round3(
      somaPeso(hitsRaw, i => i.time_passou_em_branco === 1)
    );
    out.time_passou_em_branco_hits_raw =
      hitsRaw.filter(i => i.time_passou_em_branco === 1).length;
  }

  if (extras.time2plus) {
    out.time_2plus_hits = round3(somaPeso(hitsRaw, i => i.time_2plus === 1));
    out.time_2plus_hits_raw = hitsRaw.filter(i => i.time_2plus === 1).length;
  }

  if (extras.time3plus) {
    out.time_3plus_hits = round3(somaPeso(hitsRaw, i => i.time_3plus === 1));
    out.time_3plus_hits_raw = hitsRaw.filter(i => i.time_3plus === 1).length;
  }

  if (extras.time1golOuMenos) {
    out.time_1gol_ou_menos_hits = round3(
      somaPeso(hitsRaw, i => i.time_1gol_ou_menos === 1)
    );
    out.time_1gol_ou_menos_hits_raw =
      hitsRaw.filter(i => i.time_1gol_ou_menos === 1).length;
  }

  if (extras.time2golsOuMenos) {
    out.time_2gols_ou_menos_hits = round3(
      somaPeso(hitsRaw, i => i.time_2gols_ou_menos === 1)
    );
    out.time_2gols_ou_menos_hits_raw =
      hitsRaw.filter(i => i.time_2gols_ou_menos === 1).length;
  }

  return out;
}

async function calcularAncoraMercadosMando(client, jogos, cacheSnapshots) {
  const jogosOrd = ordenarJogosRecentes(jogos).slice(0, CONFIG.limiteJogosAncora);

  if (jogosOrd.length < 10) {
    return {
      sample: jogosOrd.length,
      sample_raw: jogosOrd.length,
      sample_peso_total: jogosOrd.length,
      pesos_modelo: {
        jogos_1_10: 1.00,
        jogos_11_20: 0.80,
        jogos_21_30_40: 0.60,
      },
      base: {
        media_gols_marcados: 0,
        media_gols_sofridos: 0,
        media_gols_totais: 0,
        mediana_gols_marcados: 0,
        mediana_gols_sofridos: 0,
        mediana_gols_totais: 0,
      },
      resultado_1x2: {
        sample: jogosOrd.length,
        sample_raw: jogosOrd.length,
        sample_peso_total: jogosOrd.length,

        vitorias: 0,
        empates: 0,
        derrotas: 0,

        vitorias_raw: 0,
        empates_raw: 0,
        derrotas_raw: 0,

        win_rate: 0,
        draw_rate: 0,
        loss_rate: 0,
      },
      mercados: {},
      placares: {
        "00": 0,
        "10": 0,
        "01": 0,
        "11": 0,
        "20": 0,
        "02": 0,
        "21": 0,
        "12": 0,
        "22": 0,
      },
      placares_raw: {
        "00": 0,
        "10": 0,
        "01": 0,
        "11": 0,
        "20": 0,
        "02": 0,
        "21": 0,
        "12": 0,
        "22": 0,
      },
      padroes: {
        zero_a_zero: 0,
        um_a_zero_ou_zero_a_um: 0,
        um_a_um: 0,
        placar_magro: 0,
        vitoria_sem_sofrer: 0,
        derrota_sem_marcar: 0,
        jogo_trocacao: 0,
      },
      padroes_raw: {
        zero_a_zero: 0,
        um_a_zero_ou_zero_a_um: 0,
        um_a_um: 0,
        placar_magro: 0,
        vitoria_sem_sofrer: 0,
        derrota_sem_marcar: 0,
        jogo_trocacao: 0,
      },
    };
  }

  const itens = [];

  for (const [idx, j] of jogosOrd.entries()) {
    const pesoAncora = pesoAncoraPorIndice(idx);

    const golsMarcados = toNum(j.gols_marcados_time, 0);
    const golsSofridos = toNum(j.gols_sofridos_time, 0);
    const golsTotais = toNum(j.gols_total_partida, 0);

    const fsIdAdversario =
      j.mando === 'casa'
        ? j.flashscore_id_time_fora
        : j.flashscore_id_time_casa;

    const snapshotAdv = fsIdAdversario
      ? await buscarSnapshotHistoricoAntes(
        client,
        fsIdAdversario,
        j.data_jogo,
        cacheSnapshots
      )
      : null;

    let advAtaque = null;
    let advDefesa = null;

    if (snapshotAdv) {
      advDefesa =
        j.mando === 'casa'
          ? toNum(snapshotAdv.fora_rating_defesa, 0)
          : toNum(snapshotAdv.casa_rating_defesa, 0);

      advAtaque =
        j.mando === 'casa'
          ? toNum(snapshotAdv.fora_rating_ataque, 0)
          : toNum(snapshotAdv.casa_rating_ataque, 0);
    }

    const hit_under05 = golsTotais === 0 ? 1 : 0;
    const hit_under15 = golsTotais <= 1 ? 1 : 0;
    const hit_over15 = golsTotais > 1 ? 1 : 0;
    const hit_over25 = golsTotais > 2 ? 1 : 0;
    const hit_over35 = golsTotais > 3 ? 1 : 0;

    const hit_btts_sim = golsMarcados > 0 && golsSofridos > 0 ? 1 : 0;
    const hit_btts_nao = hit_btts_sim ? 0 : 1;

    const time_marcou = golsMarcados > 0 ? 1 : 0;
    const time_sofreu = golsSofridos > 0 ? 1 : 0;

    const time_passou_em_branco = golsMarcados === 0 ? 1 : 0;
    const clean_sheet = golsSofridos === 0 ? 1 : 0;

    const time_2plus = golsMarcados >= 2 ? 1 : 0;
    const time_3plus = golsMarcados >= 3 ? 1 : 0;

    const time_1gol_ou_menos = golsMarcados <= 1 ? 1 : 0;
    const time_2gols_ou_menos = golsMarcados <= 2 ? 1 : 0;

    const zero_a_zero = golsMarcados === 0 && golsSofridos === 0 ? 1 : 0;

    const um_a_zero_ou_zero_a_um =
      (golsMarcados === 1 && golsSofridos === 0) ||
        (golsMarcados === 0 && golsSofridos === 1)
        ? 1
        : 0;

    const um_a_um = golsMarcados === 1 && golsSofridos === 1 ? 1 : 0;

    const placar_magro = golsTotais <= 2 ? 1 : 0;

    const vitoria_sem_sofrer =
      golsMarcados > golsSofridos && golsSofridos === 0 ? 1 : 0;

    const derrota_sem_marcar =
      golsMarcados < golsSofridos && golsMarcados === 0 ? 1 : 0;

    const jogo_trocacao =
      golsMarcados > 0 && golsSofridos > 0 && golsTotais >= 3 ? 1 : 0;

    const vitoria_1x2 = golsMarcados > golsSofridos ? 1 : 0;
    const empate_1x2 = golsMarcados === golsSofridos ? 1 : 0;
    const derrota_1x2 = golsMarcados < golsSofridos ? 1 : 0;

    itens.push({
      jogo: j,
      pesoAncora,

      golsMarcados,
      golsSofridos,
      golsTotais,

      advAtaque,
      advDefesa,

      hit_under05,
      hit_under15,
      hit_over15,
      hit_over25,
      hit_over35,
      hit_btts_sim,
      hit_btts_nao,

      time_marcou,
      time_sofreu,
      time_passou_em_branco,
      clean_sheet,

      time_2plus,
      time_3plus,
      time_1gol_ou_menos,
      time_2gols_ou_menos,

      zero_a_zero,
      um_a_zero_ou_zero_a_um,
      um_a_um,
      placar_magro,
      vitoria_sem_sofrer,
      derrota_sem_marcar,
      jogo_trocacao,

      vitoria_1x2,
      empate_1x2,
      derrota_1x2,
    });
  }

  const somaPesoLocal = (lista, filterFn = () => true) => {
    return round3(
      lista
        .filter(filterFn)
        .reduce((acc, item) => acc + Number(item.pesoAncora || 0), 0)
    );
  };

  const mediaPonderadaAncoraLocal = (lista, getter, filterFn = () => true) => {
    const filtrados = lista.filter(filterFn);

    const somaPesos = filtrados.reduce(
      (acc, item) => acc + Number(item.pesoAncora || 0),
      0
    );

    if (somaPesos <= 0) return 0;

    const soma = filtrados.reduce(
      (acc, item) => acc + toNum(getter(item), 0) * Number(item.pesoAncora || 0),
      0
    );

    return soma / somaPesos;
  };

  const medianaLocal = (arr) => {
    const vals = arr
      .map(v => toNum(v, null))
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b);

    if (!vals.length) return 0;

    const mid = Math.floor(vals.length / 2);

    if (vals.length % 2 === 0) {
      return (vals[mid - 1] + vals[mid]) / 2;
    }

    return vals[mid];
  };

  const pesoTotal = somaPesoLocal(itens);

  const montarMetricasMercado = (keyHit, extras = {}) => {
    const hitsPeso = somaPesoLocal(itens, i => i[keyHit] === 1);
    const hitsRaw = itens.filter(i => i[keyHit] === 1);
    const hitsRawCount = hitsRaw.length;

    const missesPeso = round3(Math.max(pesoTotal - hitsPeso, 0));
    const missesRawCount = Math.max(itens.length - hitsRawCount, 0);

    const out = {
      hits: hitsPeso,
      misses: missesPeso,
      hits_raw: hitsRawCount,
      misses_raw: missesRawCount,
      rate: round3(hitsPeso / Math.max(pesoTotal, 1)),
      rate_raw: round3(hitsRawCount / Math.max(itens.length, 1)),
    };

    if (extras.time_marcou) {
      out.time_marcou_hits = round3(
        somaPesoLocal(hitsRaw, i => i.time_marcou === 1)
      );
      out.time_marcou_hits_raw =
        hitsRaw.filter(i => i.time_marcou === 1).length;
    }

    if (extras.time_sofreu) {
      out.time_sofreu_hits = round3(
        somaPesoLocal(hitsRaw, i => i.time_sofreu === 1)
      );
      out.time_sofreu_hits_raw =
        hitsRaw.filter(i => i.time_sofreu === 1).length;
    }

    if (extras.clean_sheet) {
      out.clean_sheet_hits = round3(
        somaPesoLocal(hitsRaw, i => i.clean_sheet === 1)
      );
      out.clean_sheet_hits_raw =
        hitsRaw.filter(i => i.clean_sheet === 1).length;
    }

    if (extras.passouEmBranco) {
      out.time_passou_em_branco_hits = round3(
        somaPesoLocal(hitsRaw, i => i.time_passou_em_branco === 1)
      );
      out.time_passou_em_branco_hits_raw =
        hitsRaw.filter(i => i.time_passou_em_branco === 1).length;
    }

    if (extras.time2plus) {
      out.time_2plus_hits = round3(
        somaPesoLocal(hitsRaw, i => i.time_2plus === 1)
      );
      out.time_2plus_hits_raw =
        hitsRaw.filter(i => i.time_2plus === 1).length;
    }

    if (extras.time3plus) {
      out.time_3plus_hits = round3(
        somaPesoLocal(hitsRaw, i => i.time_3plus === 1)
      );
      out.time_3plus_hits_raw =
        hitsRaw.filter(i => i.time_3plus === 1).length;
    }

    if (extras.time1golOuMenos) {
      out.time_1gol_ou_menos_hits = round3(
        somaPesoLocal(hitsRaw, i => i.time_1gol_ou_menos === 1)
      );
      out.time_1gol_ou_menos_hits_raw =
        hitsRaw.filter(i => i.time_1gol_ou_menos === 1).length;
    }

    if (extras.time2golsOuMenos) {
      out.time_2gols_ou_menos_hits = round3(
        somaPesoLocal(hitsRaw, i => i.time_2gols_ou_menos === 1)
      );
      out.time_2gols_ou_menos_hits_raw =
        hitsRaw.filter(i => i.time_2gols_ou_menos === 1).length;
    }

    const hitsComAdvRating = hitsRaw.filter(
      i => Number.isFinite(Number(i.advAtaque)) && Number.isFinite(Number(i.advDefesa))
    );

    const missesRaw = itens.filter(i => i[keyHit] !== 1);

    const missesComAdvRating = missesRaw.filter(
      i => Number.isFinite(Number(i.advAtaque)) && Number.isFinite(Number(i.advDefesa))
    );

    if (hitsComAdvRating.length > 0) {
      out.qualidade_adv_ataque_media_hits = round3(
        mediaPonderadaAncoraLocal(hitsComAdvRating, i => i.advAtaque)
      );

      out.qualidade_adv_defesa_media_hits = round3(
        mediaPonderadaAncoraLocal(hitsComAdvRating, i => i.advDefesa)
      );
    } else {
      out.qualidade_adv_ataque_media_hits = null;
      out.qualidade_adv_defesa_media_hits = null;
    }

    if (missesComAdvRating.length > 0) {
      out.qualidade_adv_ataque_media_miss = round3(
        mediaPonderadaAncoraLocal(missesComAdvRating, i => i.advAtaque)
      );

      out.qualidade_adv_defesa_media_miss = round3(
        mediaPonderadaAncoraLocal(missesComAdvRating, i => i.advDefesa)
      );
    } else {
      out.qualidade_adv_ataque_media_miss = null;
      out.qualidade_adv_defesa_media_miss = null;
    }

    return out;
  };

  const contarFlagPeso = (key) =>
    round3(somaPesoLocal(itens, i => i[key] === 1));

  const contarFlagRaw = (key) =>
    itens.filter(i => i[key] === 1).length;

  const vitoriasPeso = contarFlagPeso('vitoria_1x2');
  const empatesPeso = contarFlagPeso('empate_1x2');
  const derrotasPeso = contarFlagPeso('derrota_1x2');

  const vitoriasRaw = contarFlagRaw('vitoria_1x2');
  const empatesRaw = contarFlagRaw('empate_1x2');
  const derrotasRaw = contarFlagRaw('derrota_1x2');

  return {
    sample: round3(pesoTotal),
    sample_raw: itens.length,
    sample_peso_total: round3(pesoTotal),

    pesos_modelo: {
      jogos_1_10: 1.00,
      jogos_11_20: 0.80,
      jogos_21_30_40: 0.60,
    },

    base: {
      media_gols_marcados: round3(
        mediaPonderadaAncoraLocal(itens, i => i.golsMarcados)
      ),
      media_gols_sofridos: round3(
        mediaPonderadaAncoraLocal(itens, i => i.golsSofridos)
      ),
      media_gols_totais: round3(
        mediaPonderadaAncoraLocal(itens, i => i.golsTotais)
      ),

      mediana_gols_marcados: round3(
        medianaLocal(itens.map(i => i.golsMarcados))
      ),
      mediana_gols_sofridos: round3(
        medianaLocal(itens.map(i => i.golsSofridos))
      ),
      mediana_gols_totais: round3(
        medianaLocal(itens.map(i => i.golsTotais))
      ),
    },

    resultado_1x2: {
      sample: round3(pesoTotal),
      sample_raw: itens.length,
      sample_peso_total: round3(pesoTotal),

      vitorias: vitoriasPeso,
      empates: empatesPeso,
      derrotas: derrotasPeso,

      vitorias_raw: vitoriasRaw,
      empates_raw: empatesRaw,
      derrotas_raw: derrotasRaw,

      win_rate: round3(vitoriasPeso / Math.max(pesoTotal, 1)),
      draw_rate: round3(empatesPeso / Math.max(pesoTotal, 1)),
      loss_rate: round3(derrotasPeso / Math.max(pesoTotal, 1)),

      win_rate_raw: round3(vitoriasRaw / Math.max(itens.length, 1)),
      draw_rate_raw: round3(empatesRaw / Math.max(itens.length, 1)),
      loss_rate_raw: round3(derrotasRaw / Math.max(itens.length, 1)),
    },

    mercados: {
      under05: montarMetricasMercado('hit_under05', {
        time_marcou: true,
        time_sofreu: true,
        clean_sheet: true,
        passouEmBranco: true,
        time1golOuMenos: true,
        time2golsOuMenos: true,
      }),

      under15: montarMetricasMercado('hit_under15', {
        time_marcou: true,
        time_sofreu: true,
        clean_sheet: true,
        passouEmBranco: true,
        time1golOuMenos: true,
        time2golsOuMenos: true,
      }),

      over15: montarMetricasMercado('hit_over15', {
        time_marcou: true,
        time_sofreu: true,
        time2plus: true,
        time3plus: true,
      }),

      over25: montarMetricasMercado('hit_over25', {
        time_marcou: true,
        time_sofreu: true,
        time2plus: true,
        time3plus: true,
      }),

      over35: montarMetricasMercado('hit_over35', {
        time_marcou: true,
        time_sofreu: true,
        time2plus: true,
        time3plus: true,
      }),

      btts_sim: montarMetricasMercado('hit_btts_sim', {
        time_marcou: true,
        time_sofreu: true,
        time2plus: true,
        time3plus: true,
      }),

      btts_nao: montarMetricasMercado('hit_btts_nao', {
        time_marcou: true,
        time_sofreu: true,
        clean_sheet: true,
        passouEmBranco: true,
        time1golOuMenos: true,
        time2golsOuMenos: true,
      }),
    },

    placares: {
      "00": contarFlagPeso('zero_a_zero'),
      "10": round3(somaPesoLocal(itens, i => i.golsMarcados === 1 && i.golsSofridos === 0)),
      "01": round3(somaPesoLocal(itens, i => i.golsMarcados === 0 && i.golsSofridos === 1)),
      "11": contarFlagPeso('um_a_um'),
      "20": round3(somaPesoLocal(itens, i => i.golsMarcados === 2 && i.golsSofridos === 0)),
      "02": round3(somaPesoLocal(itens, i => i.golsMarcados === 0 && i.golsSofridos === 2)),
      "21": round3(somaPesoLocal(itens, i => i.golsMarcados === 2 && i.golsSofridos === 1)),
      "12": round3(somaPesoLocal(itens, i => i.golsMarcados === 1 && i.golsSofridos === 2)),
      "22": round3(somaPesoLocal(itens, i => i.golsMarcados === 2 && i.golsSofridos === 2)),
    },

    placares_raw: {
      "00": contarFlagRaw('zero_a_zero'),
      "10": itens.filter(i => i.golsMarcados === 1 && i.golsSofridos === 0).length,
      "01": itens.filter(i => i.golsMarcados === 0 && i.golsSofridos === 1).length,
      "11": contarFlagRaw('um_a_um'),
      "20": itens.filter(i => i.golsMarcados === 2 && i.golsSofridos === 0).length,
      "02": itens.filter(i => i.golsMarcados === 0 && i.golsSofridos === 2).length,
      "21": itens.filter(i => i.golsMarcados === 2 && i.golsSofridos === 1).length,
      "12": itens.filter(i => i.golsMarcados === 1 && i.golsSofridos === 2).length,
      "22": itens.filter(i => i.golsMarcados === 2 && i.golsSofridos === 2).length,
    },

    padroes: {
      zero_a_zero: contarFlagPeso('zero_a_zero'),
      um_a_zero_ou_zero_a_um: contarFlagPeso('um_a_zero_ou_zero_a_um'),
      um_a_um: contarFlagPeso('um_a_um'),
      placar_magro: contarFlagPeso('placar_magro'),
      vitoria_sem_sofrer: contarFlagPeso('vitoria_sem_sofrer'),
      derrota_sem_marcar: contarFlagPeso('derrota_sem_marcar'),
      jogo_trocacao: contarFlagPeso('jogo_trocacao'),
    },

    padroes_raw: {
      zero_a_zero: contarFlagRaw('zero_a_zero'),
      um_a_zero_ou_zero_a_um: contarFlagRaw('um_a_zero_ou_zero_a_um'),
      um_a_um: contarFlagRaw('um_a_um'),
      placar_magro: contarFlagRaw('placar_magro'),
      vitoria_sem_sofrer: contarFlagRaw('vitoria_sem_sofrer'),
      derrota_sem_marcar: contarFlagRaw('derrota_sem_marcar'),
      jogo_trocacao: contarFlagRaw('jogo_trocacao'),
    },
  };
}

function ladoGolParaPerspectivaTime(jogo, ladoGol) {
  if (!ladoGol) return null;

  const mando = String(jogo.mando || '').toLowerCase();
  const lado = String(ladoGol || '').toLowerCase();

  if (mando === 'casa' && lado === 'casa') return 'TIME';
  if (mando === 'casa' && lado === 'fora') return 'ADVERSARIO';

  if (mando === 'fora' && lado === 'fora') return 'TIME';
  if (mando === 'fora' && lado === 'casa') return 'ADVERSARIO';

  return null;
}

function rateSeguroRoteiro(numerador, denominador) {
  const n = toNum(numerador, 0);
  const d = toNum(denominador, 0);

  if (d <= 0) return 0;

  return round3(n / d);
}

function rateBayesRoteiro(acertos, sample, prior = 0.35, pesoPrior = 8) {
  const a = toNum(acertos, 0);
  const s = toNum(sample, 0);

  if (s <= 0) return round3(prior);

  return round3((a + prior * pesoPrior) / (s + pesoPrior));
}

function confiancaAmostraRoteiro(sample, alvo = 12) {
  const s = toNum(sample, 0);
  return round3(clamp(s / alvo, 0, 1));
}

function labelConfiancaRoteiro(conf) {
  const c = toNum(conf, 0);

  if (c >= 0.85) return 'ALTA';
  if (c >= 0.55) return 'MEDIA';
  if (c > 0) return 'BAIXA';

  return 'SEM_DADO';
}

function mediaPonderadaRoteiro(itens, getter, filterFn = () => true) {
  let soma = 0;
  let somaPesos = 0;

  for (const item of itens || []) {
    if (!filterFn(item)) continue;

    const valor = Number(getter(item));
    const peso = toNum(item.pesoAncora, 0);

    if (!Number.isFinite(valor) || peso <= 0) continue;

    soma += valor * peso;
    somaPesos += peso;
  }

  if (somaPesos <= 0) return 0;

  return soma / somaPesos;
}

function somaPesoRoteiro(itens, filterFn = () => true) {
  return round3(
    (itens || []).reduce((acc, item) => {
      if (!filterFn(item)) return acc;
      return acc + toNum(item.pesoAncora, 0);
    }, 0)
  );
}

function somaRawRoteiro(itens, filterFn = () => true) {
  return (itens || []).filter(filterFn).length;
}

function classificarQuandoAbreRoteiro({
  continuaBuscaScore,
  travaAposAbrirScore,
  permiteReacaoScore,
  mataJogoScore,
  confianca,
}) {
  const conf = toNum(confianca, 0);
  const continua = toNum(continuaBuscaScore, 0);
  const trava = toNum(travaAposAbrirScore, 0);
  const reacao = toNum(permiteReacaoScore, 0);
  const mata = toNum(mataJogoScore, 0);

  if (conf < 0.35) return 'SEM_CONFIANCA';

  if (continua >= 0.60 && trava <= 0.38 && mata >= 0.55) {
    return 'ABRE_E_CONTINUA_BUSCANDO';
  }

  if (trava >= 0.55 && continua < 0.48) {
    return 'ABRE_E_TRAVA';
  }

  if (reacao >= 0.55 && continua < 0.55) {
    return 'ABRE_E_PERMITE_REACAO';
  }

  if (continua >= 0.52 && reacao >= 0.45) {
    return 'ABRE_E_JOGO_FICA_VIVO';
  }

  if (mata >= 0.58 && reacao <= 0.40) {
    return 'ABRE_E_MATA_JOGO';
  }

  return 'NEUTRO';
}

function classificarQuandoSofrePrimeiroRoteiro({
  reageScore,
  desmoronaScore,
  confianca,
}) {
  const conf = toNum(confianca, 0);
  const reage = toNum(reageScore, 0);
  const desmorona = toNum(desmoronaScore, 0);

  if (conf < 0.35) return 'SEM_CONFIANCA';

  if (reage >= 0.58 && desmorona <= 0.42) {
    return 'SOFRE_E_REAGE';
  }

  if (desmorona >= 0.58 && reage < 0.45) {
    return 'SOFRE_E_DESMORONA';
  }

  if (reage >= 0.50 && desmorona >= 0.50) {
    return 'SOFRE_E_JOGO_FICA_ABERTO';
  }

  return 'NEUTRO';
}

function calcularRoteiroGolsEventosAncora(jogos) {
  const jogosOrd = ordenarJogosRecentes(jogos).slice(0, CONFIG.limiteJogosAncora);

  const emptyVolume = () => ({
    xg_medio: 0,
    xgot_medio: 0,

    // xg_contra = volume/chance cedida
    xg_contra_medio: 0,

    // xga = xGOT contra/perigo real sofrido
    xga_medio: 0,
    xgot_contra_medio: 0,
    xga_contra_medio: 0,

    sot_medio: 0,
    big_chances_medio: 0,
    box_shots_medio: 0,
    box_touches_medio: 0,

    pct_xg_alto: 0,
    pct_xgot_alto: 0,
    pct_xg_baixo: 0,
    pct_xgot_baixo: 0,

    pct_cede_xg_alto: 0,
    pct_cede_xga_alto: 0,
    pct_cede_xgot_contra_alto: 0,

    pct_controla_xg_contra: 0,
    pct_controla_xga: 0,
    pct_controla_xgot_contra: 0,
  });

  if (!jogosOrd.length) {
    return {
      sample_raw: 0,
      sample_peso_total: 0,
      ativo: 0,
      observacao: 'sem_jogos',

      sample_com_roteiro_gol: 0,
      sample_com_roteiro_gol_raw: 0,

      confianca_roteiro_geral: 0,
      confianca_roteiro_geral_label: 'SEM_DADO',

      condicional_pos_primeiro_gol: {
        ativo: 0,
        observacao: 'sem_jogos',

        quando_abre: {
          sample: 0,
          sample_raw: 0,
          confianca: 0,
          confianca_label: 'SEM_DADO',
          placar: {},
          volume: emptyVolume(),
          comportamento: {},
          scores: {},
          leitura: 'SEM_DADO',
        },

        quando_sofre_primeiro: {
          sample: 0,
          sample_raw: 0,
          confianca: 0,
          confianca_label: 'SEM_DADO',
          placar: {},
          volume: emptyVolume(),
          comportamento: {},
          scores: {},
          leitura: 'SEM_DADO',
        },

        perfil_time_pos_primeiro_gol: {
          sample: 0,
          sample_raw: 0,
          confianca: 0,
          confianca_label: 'SEM_DADO',
          leitura: 'SEM_DADO',
        },

        scores_resumo: {},
      },
    };
  }

  const itens = [];

  for (const [idx, j] of jogosOrd.entries()) {
    const pesoAncora = pesoAncoraPorIndice(idx);

    const golsMarcados = toNum(j.gols_marcados_time, 0);
    const golsSofridos = toNum(j.gols_sofridos_time, 0);
    const golsTotais = toNum(j.gols_total_partida, golsMarcados + golsSofridos);

    const xgTime = toNum(j.xg, 0);
    const xgotTime = toNum(j.xgot, 0);

    // xg_contra = chance/volume cedido.
    const xgContra = toNum(j.xg_contra, 0);

    // xga no seu banco = xGOT contra/perigo real sofrido.
    const xgotContra = toNum(j.xga, 0);
    const xgaContra = xgotContra; // alias para compatibilidade.

    const sotTime = toNum(j.sot, 0);
    const bigChancesTime = toNum(j.big_chances, 0);
    const boxShotsTime = toNum(j.box_shots, 0);
    const boxTouchesTime = toNum(j.box_touches, 0);

    const oppXg = toNum(j.opp_xg, xgContra);
    const oppXgot = toNum(j.opp_xgot, xgotContra);
    const oppSot = toNum(j.opp_sot, 0);
    const oppBoxShots = toNum(j.opp_box_shots, 0);
    const oppBoxTouches = toNum(j.opp_box_touches, 0);

    const gol1 = ladoGolParaPerspectivaTime(j, j.gol_1_lado);
    const gol2 = ladoGolParaPerspectivaTime(j, j.gol_2_lado);
    const gol3 = ladoGolParaPerspectivaTime(j, j.gol_3_lado);
    const gol4 = ladoGolParaPerspectivaTime(j, j.gol_4_lado);

    const teveGolNoPlacar = golsTotais > 0 ? 1 : 0;
    const semGolPlacar = golsTotais === 0 ? 1 : 0;
    const temRoteiroGol = gol1 ? 1 : 0;

    const eventoGolFaltando =
      teveGolNoPlacar === 1 && temRoteiroGol === 0 ? 1 : 0;

    const abriuPlacar = gol1 === 'TIME' ? 1 : 0;
    const sofreuPrimeiro = gol1 === 'ADVERSARIO' ? 1 : 0;

    // =========================================================
    // 1) ROTEIRO DE PLACAR — quando o time abriu
    // =========================================================
    const abriuEAmpliou2x0 =
      abriuPlacar === 1 && gol2 === 'TIME' ? 1 : 0;

    const abriuESofre1x1 =
      abriuPlacar === 1 && gol2 === 'ADVERSARIO' ? 1 : 0;

    const abriuSofre1x1EFaz2x1 =
      abriuPlacar === 1 && gol2 === 'ADVERSARIO' && gol3 === 'TIME'
        ? 1
        : 0;

    const abriuSofre1x1EToma1x2 =
      abriuPlacar === 1 && gol2 === 'ADVERSARIO' && gol3 === 'ADVERSARIO'
        ? 1
        : 0;

    const abriuETerminou1x0 =
      abriuPlacar === 1 && golsMarcados === 1 && golsSofridos === 0
        ? 1
        : 0;

    const abriuEVenceu =
      abriuPlacar === 1 && golsMarcados > golsSofridos ? 1 : 0;

    const abriuEEmpatou =
      abriuPlacar === 1 && golsMarcados === golsSofridos ? 1 : 0;

    const abriuEPerdeu =
      abriuPlacar === 1 && golsMarcados < golsSofridos ? 1 : 0;

    const abriuETomouVirada = abriuEPerdeu;

    const abriuEParouNoPlacar =
      abriuPlacar === 1 && abriuEAmpliou2x0 === 0 && golsMarcados === 1
        ? 1
        : 0;

    // =========================================================
    // 2) ROTEIRO DE PLACAR — quando o time sofreu primeiro
    // =========================================================
    const sofreuPrimeiroEBusca1x1 =
      sofreuPrimeiro === 1 && gol2 === 'TIME' ? 1 : 0;

    const sofreuPrimeiroEToma2x0 =
      sofreuPrimeiro === 1 && gol2 === 'ADVERSARIO' ? 1 : 0;

    const sofreuPrimeiroEToma3x0Mais =
      sofreuPrimeiro === 1 &&
        (
          (gol2 === 'ADVERSARIO' && gol3 === 'ADVERSARIO') ||
          (golsSofridos >= 3 && golsMarcados === 0)
        )
        ? 1
        : 0;

    const sofreuPrimeiroBusca1x1EFaz2x1 =
      sofreuPrimeiro === 1 && gol2 === 'TIME' && gol3 === 'TIME'
        ? 1
        : 0;

    const sofreuPrimeiroBusca1x1EToma1x2 =
      sofreuPrimeiro === 1 && gol2 === 'TIME' && gol3 === 'ADVERSARIO'
        ? 1
        : 0;

    const sofreuPrimeiroEVirou =
      sofreuPrimeiro === 1 && golsMarcados > golsSofridos ? 1 : 0;

    const sofreuPrimeiroEEmpatou =
      sofreuPrimeiro === 1 && golsMarcados === golsSofridos ? 1 : 0;

    const sofreuPrimeiroEPerdeu =
      sofreuPrimeiro === 1 && golsMarcados < golsSofridos ? 1 : 0;

    const sofreuPrimeiroEPerdeuSemMarcar =
      sofreuPrimeiro === 1 && golsMarcados === 0 && golsSofridos > 0
        ? 1
        : 0;

    const sofreuPrimeiroENaoBuscaGol =
      sofreuPrimeiro === 1 && golsMarcados === 0 ? 1 : 0;

    const sofreuPrimeiroSaiAtrasENaoEmpata =
      sofreuPrimeiro === 1 && sofreuPrimeiroEBusca1x1 === 0 ? 1 : 0;

    // =========================================================
    // 3) VOLUME / CONTROLE — métricas qualificam o roteiro
    // =========================================================
    const volumeOfensivoAlto =
      xgTime >= 1.40 ||
        xgotTime >= 1.00 ||
        bigChancesTime >= 2 ||
        sotTime >= 4 ||
        boxShotsTime >= 8 ||
        boxTouchesTime >= 20
        ? 1
        : 0;

    const volumeOfensivoBaixo =
      xgTime < 1.00 &&
        xgotTime < 0.65 &&
        bigChancesTime < 1 &&
        sotTime < 3
        ? 1
        : 0;

    const cedeuVolumeAlto =
      xgContra >= 1.00 ||
        xgotContra >= 0.80 ||
        oppXg >= 1.00 ||
        oppXgot >= 0.80 ||
        oppSot >= 4 ||
        oppBoxShots >= 8 ||
        oppBoxTouches >= 20
        ? 1
        : 0;

    const controlouAdversario =
      xgContra < 0.90 &&
        xgotContra < 0.60 &&
        oppXg < 0.90 &&
        oppXgot < 0.60
        ? 1
        : 0;

    // =========================================================
    // 4) PLACAR + MÉTRICAS — quando abriu
    // =========================================================
    const abriuEContinuouCriando =
      abriuPlacar === 1 && volumeOfensivoAlto === 1 ? 1 : 0;

    const abriuENaoAmpliouMasCriou =
      abriuPlacar === 1 && abriuEAmpliou2x0 === 0 && volumeOfensivoAlto === 1
        ? 1
        : 0;

    const abriuETravouBaixoVolume =
      abriuPlacar === 1 &&
        abriuEAmpliou2x0 === 0 &&
        abriuESofre1x1 === 0 &&
        volumeOfensivoBaixo === 1 &&
        controlouAdversario === 1
        ? 1
        : 0;

    const abriuECedeuReacaoReal =
      abriuPlacar === 1 &&
        (abriuESofre1x1 === 1 || cedeuVolumeAlto === 1)
        ? 1
        : 0;

    const abriuEControlouAdv =
      abriuPlacar === 1 && controlouAdversario === 1 ? 1 : 0;

    const abriuEAmpliouComDominio =
      abriuPlacar === 1 &&
        abriuEAmpliou2x0 === 1 &&
        volumeOfensivoAlto === 1 &&
        controlouAdversario === 1
        ? 1
        : 0;

    const abriuEAmpliouMasCedeu =
      abriuPlacar === 1 && abriuEAmpliou2x0 === 1 && cedeuVolumeAlto === 1
        ? 1
        : 0;

    const abriuEMatouJogo =
      abriuPlacar === 1 &&
        abriuEAmpliou2x0 === 1 &&
        abriuEVenceu === 1 &&
        controlouAdversario === 1
        ? 1
        : 0;

    const abriuEPerdeuControle =
      abriuPlacar === 1 &&
        (
          abriuETomouVirada === 1 ||
          (abriuESofre1x1 === 1 && cedeuVolumeAlto === 1)
        )
        ? 1
        : 0;

    // =========================================================
    // 5) PLACAR + MÉTRICAS — quando sofreu primeiro
    // =========================================================
    const sofreuPrimeiroECriouVolume =
      sofreuPrimeiro === 1 && volumeOfensivoAlto === 1 ? 1 : 0;

    const sofreuPrimeiroENaoCriou =
      sofreuPrimeiro === 1 && volumeOfensivoBaixo === 1 ? 1 : 0;

    const sofreuPrimeiroEControlouDepois =
      sofreuPrimeiro === 1 &&
        controlouAdversario === 1 &&
        sofreuPrimeiroEToma2x0 === 0
        ? 1
        : 0;

    const sofreuPrimeiroEContinuouCedendo =
      sofreuPrimeiro === 1 &&
        (cedeuVolumeAlto === 1 || sofreuPrimeiroEToma2x0 === 1)
        ? 1
        : 0;

    const sofreuPrimeiroReageMasCedeEspaco =
      sofreuPrimeiro === 1 &&
        (sofreuPrimeiroEBusca1x1 === 1 || volumeOfensivoAlto === 1) &&
        (cedeuVolumeAlto === 1 || sofreuPrimeiroEToma2x0 === 1)
        ? 1
        : 0;

    const sofreuPrimeiroEDesmoronou =
      sofreuPrimeiro === 1 &&
        (
          sofreuPrimeiroEToma2x0 === 1 ||
          sofreuPrimeiroEToma3x0Mais === 1 ||
          sofreuPrimeiroEPerdeuSemMarcar === 1
        ) &&
        volumeOfensivoBaixo === 1
        ? 1
        : 0;

    const sofreuPrimeiroETomaMaisMasCria =
      sofreuPrimeiro === 1 &&
        (sofreuPrimeiroEToma2x0 === 1 || sofreuPrimeiroEToma3x0Mais === 1) &&
        volumeOfensivoAlto === 1
        ? 1
        : 0;

    // Compatibilidade com campos antigos.
    const abriuEContinuouComVolume = abriuEContinuouCriando;
    const abriuETravou = abriuETravouBaixoVolume;
    const abriuEPermitiuReacao = abriuECedeuReacaoReal;

    const sofreuPrimeiroEReagiuComVolume =
      sofreuPrimeiro === 1 &&
        (sofreuPrimeiroEBusca1x1 === 1 || volumeOfensivoAlto === 1)
        ? 1
        : 0;

    const sofreuPrimeiroEMorreu =
      sofreuPrimeiro === 1 &&
        sofreuPrimeiroEBusca1x1 === 0 &&
        volumeOfensivoBaixo === 1
        ? 1
        : 0;

    itens.push({
      pesoAncora,

      flashscore_id_jogo: j.flashscore_id_jogo,
      data_jogo: j.data_jogo,
      mando: j.mando,

      golsMarcados,
      golsSofridos,
      golsTotais,

      xgTime,
      xgotTime,
      xgContra,
      xgaContra,
      xgotContra,

      sotTime,
      bigChancesTime,
      boxShotsTime,
      boxTouchesTime,

      oppXg,
      oppXgot,
      oppSot,
      oppBoxShots,
      oppBoxTouches,

      gol_1: gol1,
      gol_2: gol2,
      gol_3: gol3,
      gol_4: gol4,

      teve_gol_no_placar: teveGolNoPlacar,
      sem_gol_placar: semGolPlacar,
      tem_roteiro_gol: temRoteiroGol,
      evento_gol_faltando: eventoGolFaltando,

      abriu_placar: abriuPlacar,
      sofreu_primeiro: sofreuPrimeiro,

      abriu_e_fez_2x0: abriuEAmpliou2x0,
      abriu_e_ampliou_2x0: abriuEAmpliou2x0,
      abriu_e_sofreu_1x1: abriuESofre1x1,
      abriu_sofreu_1x1_e_fez_2x1: abriuSofre1x1EFaz2x1,
      abriu_sofreu_1x1_e_tomou_1x2: abriuSofre1x1EToma1x2,
      abriu_e_terminou_1x0: abriuETerminou1x0,
      abriu_e_venceu: abriuEVenceu,
      abriu_e_empatou: abriuEEmpatou,
      abriu_e_perdeu: abriuEPerdeu,
      abriu_e_tomou_virada: abriuETomouVirada,
      abriu_e_parou_no_placar: abriuEParouNoPlacar,

      abriu_e_continuou_criando: abriuEContinuouCriando,
      abriu_e_nao_ampliou_mas_criou: abriuENaoAmpliouMasCriou,
      abriu_e_travou_baixo_volume: abriuETravouBaixoVolume,
      abriu_e_cedeu_reacao_real: abriuECedeuReacaoReal,
      abriu_e_controlou_adv: abriuEControlouAdv,
      abriu_e_ampliou_com_dominio: abriuEAmpliouComDominio,
      abriu_e_ampliou_mas_cedeu: abriuEAmpliouMasCedeu,
      abriu_e_matou_jogo: abriuEMatouJogo,
      abriu_e_perdeu_controle: abriuEPerdeuControle,

      abriu_volume_ofensivo_alto: abriuPlacar === 1 && volumeOfensivoAlto === 1 ? 1 : 0,
      abriu_volume_ofensivo_baixo: abriuPlacar === 1 && volumeOfensivoBaixo === 1 ? 1 : 0,
      abriu_xg_alto: abriuPlacar === 1 && xgTime >= 1.40 ? 1 : 0,
      abriu_xgot_alto: abriuPlacar === 1 && xgotTime >= 1.00 ? 1 : 0,
      abriu_xg_baixo: abriuPlacar === 1 && xgTime < 1.00 ? 1 : 0,
      abriu_xgot_baixo: abriuPlacar === 1 && xgotTime < 0.65 ? 1 : 0,
      abriu_cedeu_xg_alto: abriuPlacar === 1 && xgContra >= 1.00 ? 1 : 0,
      abriu_cedeu_xga_alto: abriuPlacar === 1 && xgotContra >= 0.80 ? 1 : 0,
      abriu_controlou_xg_contra: abriuPlacar === 1 && xgContra < 0.90 ? 1 : 0,
      abriu_controlou_xga: abriuPlacar === 1 && xgotContra < 0.60 ? 1 : 0,

      sofreu_primeiro_e_busca_1x1: sofreuPrimeiroEBusca1x1,
      sofreu_primeiro_e_toma_2x0: sofreuPrimeiroEToma2x0,
      sofreu_primeiro_e_toma_3x0_mais: sofreuPrimeiroEToma3x0Mais,
      sofreu_primeiro_busca_1x1_e_faz_2x1: sofreuPrimeiroBusca1x1EFaz2x1,
      sofreu_primeiro_busca_1x1_e_toma_1x2: sofreuPrimeiroBusca1x1EToma1x2,
      sofreu_primeiro_e_virou: sofreuPrimeiroEVirou,
      sofreu_primeiro_e_empatou: sofreuPrimeiroEEmpatou,
      sofreu_primeiro_e_perdeu: sofreuPrimeiroEPerdeu,
      sofreu_primeiro_e_perdeu_sem_marcar: sofreuPrimeiroEPerdeuSemMarcar,
      sofreu_primeiro_e_nao_busca_gol: sofreuPrimeiroENaoBuscaGol,
      sofreu_primeiro_sai_atras_e_nao_empata: sofreuPrimeiroSaiAtrasENaoEmpata,

      sofreu_primeiro_e_criou_volume: sofreuPrimeiroECriouVolume,
      sofreu_primeiro_e_nao_criou: sofreuPrimeiroENaoCriou,
      sofreu_primeiro_e_controlou_depois: sofreuPrimeiroEControlouDepois,
      sofreu_primeiro_e_continuou_cedendo: sofreuPrimeiroEContinuouCedendo,
      sofreu_primeiro_reage_mas_cede_espaco: sofreuPrimeiroReageMasCedeEspaco,
      sofreu_primeiro_e_desmoronou: sofreuPrimeiroEDesmoronou,
      sofreu_primeiro_e_toma_mais_mas_cria: sofreuPrimeiroETomaMaisMasCria,

      sofreu_primeiro_volume_ofensivo_alto: sofreuPrimeiro === 1 && volumeOfensivoAlto === 1 ? 1 : 0,
      sofreu_primeiro_volume_ofensivo_baixo: sofreuPrimeiro === 1 && volumeOfensivoBaixo === 1 ? 1 : 0,
      sofreu_primeiro_xg_alto: sofreuPrimeiro === 1 && xgTime >= 1.40 ? 1 : 0,
      sofreu_primeiro_xgot_alto: sofreuPrimeiro === 1 && xgotTime >= 1.00 ? 1 : 0,
      sofreu_primeiro_xg_baixo: sofreuPrimeiro === 1 && xgTime < 1.00 ? 1 : 0,
      sofreu_primeiro_xgot_baixo: sofreuPrimeiro === 1 && xgotTime < 0.65 ? 1 : 0,
      sofreu_primeiro_cedeu_xg_alto: sofreuPrimeiro === 1 && xgContra >= 1.00 ? 1 : 0,
      sofreu_primeiro_cedeu_xga_alto: sofreuPrimeiro === 1 && xgotContra >= 0.80 ? 1 : 0,
      sofreu_primeiro_controlou_xg_contra: sofreuPrimeiro === 1 && xgContra < 0.90 ? 1 : 0,
      sofreu_primeiro_controlou_xga: sofreuPrimeiro === 1 && xgotContra < 0.60 ? 1 : 0,

      abriu_e_continuou_com_volume: abriuEContinuouComVolume,
      abriu_e_travou: abriuETravou,
      abriu_e_permitiu_reacao: abriuEPermitiuReacao,
      sofreu_primeiro_e_reagiu_com_volume: sofreuPrimeiroEReagiuComVolume,
      sofreu_primeiro_e_morreu: sofreuPrimeiroEMorreu,
    });
  }

  const pesoTotal = round3(
    itens.reduce((acc, i) => acc + toNum(i.pesoAncora, 0), 0)
  );

  const somaPeso = (key) => somaPesoRoteiro(itens, i => i[key] === 1);
  const somaRaw = (key) => somaRawRoteiro(itens, i => i[key] === 1);
  const rate = (numerador, denominador) => rateSeguroRoteiro(numerador, denominador);

  const stat = (key, denomPeso, denomRaw, prior = 0.35, pesoPrior = 8) => {
    const peso = somaPeso(key);
    const raw = somaRaw(key);

    return {
      peso,
      raw,
      pct: rate(peso, denomPeso),
      pct_raw: denomRaw > 0 ? round3(raw / denomRaw) : 0,
      pct_ajustado: rateBayesRoteiro(peso, denomPeso, prior, pesoPrior),
    };
  };

  const mediaCond = (getter, filterFn) =>
    round3(mediaPonderadaRoteiro(itens, getter, filterFn));

  const sampleComRoteiro = somaPeso('tem_roteiro_gol');
  const sampleComRoteiroRaw = somaRaw('tem_roteiro_gol');

  const abriuPeso = somaPeso('abriu_placar');
  const abriuRaw = somaRaw('abriu_placar');

  const sofreuPrimeiroPeso = somaPeso('sofreu_primeiro');
  const sofreuPrimeiroRaw = somaRaw('sofreu_primeiro');

  const confiancaAbriu = confiancaAmostraRoteiro(abriuPeso, 10);
  const confiancaSofreuPrimeiro = confiancaAmostraRoteiro(sofreuPrimeiroPeso, 10);
  const confiancaRoteiroGeral = confiancaAmostraRoteiro(sampleComRoteiro, 24);

  // =========================================================
  // Estatísticas — quando abre
  // =========================================================
  const stAbriuAmpliou = stat('abriu_e_ampliou_2x0', abriuPeso, abriuRaw, 0.32, 8);
  const stAbriuSofreu1x1 = stat('abriu_e_sofreu_1x1', abriuPeso, abriuRaw, 0.28, 8);
  const stAbriuTerminou1x0 = stat('abriu_e_terminou_1x0', abriuPeso, abriuRaw, 0.18, 8);
  const stAbriuVenceu = stat('abriu_e_venceu', abriuPeso, abriuRaw, 0.62, 8);
  const stAbriuEmpatou = stat('abriu_e_empatou', abriuPeso, abriuRaw, 0.22, 8);
  const stAbriuPerdeu = stat('abriu_e_perdeu', abriuPeso, abriuRaw, 0.10, 8);
  const stAbriuTomouVirada = stat('abriu_e_tomou_virada', abriuPeso, abriuRaw, 0.10, 8);
  const stAbriuParouPlacar = stat('abriu_e_parou_no_placar', abriuPeso, abriuRaw, 0.24, 8);

  const stAbriuContinuouCriando = stat('abriu_e_continuou_criando', abriuPeso, abriuRaw, 0.42, 8);
  const stAbriuNaoAmpliouMasCriou = stat('abriu_e_nao_ampliou_mas_criou', abriuPeso, abriuRaw, 0.25, 8);
  const stAbriuTravouBaixoVolume = stat('abriu_e_travou_baixo_volume', abriuPeso, abriuRaw, 0.20, 8);
  const stAbriuCedeuReacaoReal = stat('abriu_e_cedeu_reacao_real', abriuPeso, abriuRaw, 0.30, 8);
  const stAbriuControlouAdv = stat('abriu_e_controlou_adv', abriuPeso, abriuRaw, 0.45, 8);
  const stAbriuAmpliouComDominio = stat('abriu_e_ampliou_com_dominio', abriuPeso, abriuRaw, 0.22, 8);
  const stAbriuAmpliouMasCedeu = stat('abriu_e_ampliou_mas_cedeu', abriuPeso, abriuRaw, 0.18, 8);
  const stAbriuMatouJogo = stat('abriu_e_matou_jogo', abriuPeso, abriuRaw, 0.25, 8);
  const stAbriuPerdeuControle = stat('abriu_e_perdeu_controle', abriuPeso, abriuRaw, 0.18, 8);

  const stAbriuVolumeOfensivoAlto = stat('abriu_volume_ofensivo_alto', abriuPeso, abriuRaw, 0.42, 8);
  const stAbriuVolumeOfensivoBaixo = stat('abriu_volume_ofensivo_baixo', abriuPeso, abriuRaw, 0.25, 8);
  const stAbriuXgAlto = stat('abriu_xg_alto', abriuPeso, abriuRaw, 0.38, 8);
  const stAbriuXgotAlto = stat('abriu_xgot_alto', abriuPeso, abriuRaw, 0.32, 8);
  const stAbriuXgBaixo = stat('abriu_xg_baixo', abriuPeso, abriuRaw, 0.30, 8);
  const stAbriuXgotBaixo = stat('abriu_xgot_baixo', abriuPeso, abriuRaw, 0.30, 8);
  const stAbriuCedeuXgAlto = stat('abriu_cedeu_xg_alto', abriuPeso, abriuRaw, 0.30, 8);
  const stAbriuCedeuXgaAlto = stat('abriu_cedeu_xga_alto', abriuPeso, abriuRaw, 0.25, 8);
  const stAbriuControlouXgContra = stat('abriu_controlou_xg_contra', abriuPeso, abriuRaw, 0.45, 8);
  const stAbriuControlouXga = stat('abriu_controlou_xga', abriuPeso, abriuRaw, 0.45, 8);

  const xgMedioQuandoAbriu = mediaCond(i => i.xgTime, i => i.abriu_placar === 1);
  const xgotMedioQuandoAbriu = mediaCond(i => i.xgotTime, i => i.abriu_placar === 1);
  const xgContraMedioQuandoAbriu = mediaCond(i => i.xgContra, i => i.abriu_placar === 1);
  const xgaMedioQuandoAbriu = mediaCond(i => i.xgaContra, i => i.abriu_placar === 1);
  const sotMedioQuandoAbriu = mediaCond(i => i.sotTime, i => i.abriu_placar === 1);
  const bigChancesMedioQuandoAbriu = mediaCond(i => i.bigChancesTime, i => i.abriu_placar === 1);
  const boxShotsMedioQuandoAbriu = mediaCond(i => i.boxShotsTime, i => i.abriu_placar === 1);
  const boxTouchesMedioQuandoAbriu = mediaCond(i => i.boxTouchesTime, i => i.abriu_placar === 1);

  // =========================================================
  // Estatísticas — quando sofre primeiro
  // =========================================================
  const stSofreBusca1x1 = stat('sofreu_primeiro_e_busca_1x1', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.32, 8);
  const stSofreToma2x0 = stat('sofreu_primeiro_e_toma_2x0', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.30, 8);
  const stSofreToma3x0Mais = stat('sofreu_primeiro_e_toma_3x0_mais', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.12, 8);
  const stSofreVirou = stat('sofreu_primeiro_e_virou', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.12, 8);
  const stSofreEmpatou = stat('sofreu_primeiro_e_empatou', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.22, 8);
  const stSofrePerdeu = stat('sofreu_primeiro_e_perdeu', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.55, 8);
  const stSofrePerdeuSemMarcar = stat('sofreu_primeiro_e_perdeu_sem_marcar', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.28, 8);
  const stSofreNaoBuscaGol = stat('sofreu_primeiro_e_nao_busca_gol', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.30, 8);
  const stSofreSaiAtrasNaoEmpata = stat('sofreu_primeiro_sai_atras_e_nao_empata', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.52, 8);

  const stSofreCriouVolume = stat('sofreu_primeiro_e_criou_volume', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.38, 8);
  const stSofreNaoCriou = stat('sofreu_primeiro_e_nao_criou', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.30, 8);
  const stSofreControlouDepois = stat('sofreu_primeiro_e_controlou_depois', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.35, 8);
  const stSofreContinuouCedendo = stat('sofreu_primeiro_e_continuou_cedendo', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.35, 8);
  const stSofreReageMasCedeEspaco = stat('sofreu_primeiro_reage_mas_cede_espaco', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.25, 8);
  const stSofreDesmoronou = stat('sofreu_primeiro_e_desmoronou', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.25, 8);
  const stSofreTomaMaisMasCria = stat('sofreu_primeiro_e_toma_mais_mas_cria', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.15, 8);

  const stSofreVolumeOfensivoAlto = stat('sofreu_primeiro_volume_ofensivo_alto', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.38, 8);
  const stSofreVolumeOfensivoBaixo = stat('sofreu_primeiro_volume_ofensivo_baixo', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.30, 8);
  const stSofreXgAlto = stat('sofreu_primeiro_xg_alto', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.35, 8);
  const stSofreXgotAlto = stat('sofreu_primeiro_xgot_alto', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.30, 8);
  const stSofreXgBaixo = stat('sofreu_primeiro_xg_baixo', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.32, 8);
  const stSofreXgotBaixo = stat('sofreu_primeiro_xgot_baixo', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.32, 8);
  const stSofreCedeuXgAlto = stat('sofreu_primeiro_cedeu_xg_alto', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.35, 8);
  const stSofreCedeuXgaAlto = stat('sofreu_primeiro_cedeu_xga_alto', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.30, 8);
  const stSofreControlouXgContra = stat('sofreu_primeiro_controlou_xg_contra', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.35, 8);
  const stSofreControlouXga = stat('sofreu_primeiro_controlou_xga', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.35, 8);

  const xgMedioQuandoSofreuPrimeiro = mediaCond(i => i.xgTime, i => i.sofreu_primeiro === 1);
  const xgotMedioQuandoSofreuPrimeiro = mediaCond(i => i.xgotTime, i => i.sofreu_primeiro === 1);
  const xgContraMedioQuandoSofreuPrimeiro = mediaCond(i => i.xgContra, i => i.sofreu_primeiro === 1);
  const xgaMedioQuandoSofreuPrimeiro = mediaCond(i => i.xgaContra, i => i.sofreu_primeiro === 1);
  const sotMedioQuandoSofreuPrimeiro = mediaCond(i => i.sotTime, i => i.sofreu_primeiro === 1);
  const bigChancesMedioQuandoSofreuPrimeiro = mediaCond(i => i.bigChancesTime, i => i.sofreu_primeiro === 1);
  const boxShotsMedioQuandoSofreuPrimeiro = mediaCond(i => i.boxShotsTime, i => i.sofreu_primeiro === 1);
  const boxTouchesMedioQuandoSofreuPrimeiro = mediaCond(i => i.boxTouchesTime, i => i.sofreu_primeiro === 1);

  // =========================================================
  // Scores — quando abre
  // =========================================================
  const abreAmpliaScore = round3(
    0.45 * stAbriuAmpliou.pct_ajustado +
    0.20 * stAbriuAmpliouComDominio.pct_ajustado +
    0.15 * clamp(xgMedioQuandoAbriu / 2.00, 0, 1) +
    0.15 * clamp(xgotMedioQuandoAbriu / 1.40, 0, 1) +
    0.05 * stAbriuVolumeOfensivoAlto.pct_ajustado
  );

  const abreContinuaCriandoScore = round3(
    0.30 * stAbriuContinuouCriando.pct_ajustado +
    0.25 * stAbriuNaoAmpliouMasCriou.pct_ajustado +
    0.20 * clamp(xgMedioQuandoAbriu / 2.00, 0, 1) +
    0.15 * clamp(xgotMedioQuandoAbriu / 1.40, 0, 1) +
    0.10 * clamp(sotMedioQuandoAbriu / 5.00, 0, 1)
  );

  const abreTravaScore = round3(
    0.35 * stAbriuTravouBaixoVolume.pct_ajustado +
    0.25 * stAbriuTerminou1x0.pct_ajustado +
    0.15 * stAbriuParouPlacar.pct_ajustado +
    0.15 * stAbriuVolumeOfensivoBaixo.pct_ajustado +
    0.10 * stAbriuControlouAdv.pct_ajustado
  );

  const abreCedeReacaoScore = round3(
    0.35 * stAbriuCedeuReacaoReal.pct_ajustado +
    0.25 * stAbriuSofreu1x1.pct_ajustado +
    0.15 * stAbriuCedeuXgAlto.pct_ajustado +
    0.15 * stAbriuCedeuXgaAlto.pct_ajustado +
    0.10 * clamp(xgContraMedioQuandoAbriu / 1.40, 0, 1)
  );

  const abreControlaScore = round3(
    0.35 * stAbriuControlouAdv.pct_ajustado +
    0.25 * stAbriuControlouXgContra.pct_ajustado +
    0.25 * stAbriuControlouXga.pct_ajustado +
    0.15 * (1 - stAbriuCedeuReacaoReal.pct_ajustado)
  );

  const abreMataJogoScore = round3(
    0.30 * stAbriuMatouJogo.pct_ajustado +
    0.25 * stAbriuAmpliouComDominio.pct_ajustado +
    0.20 * stAbriuVenceu.pct_ajustado +
    0.15 * abreAmpliaScore +
    0.10 * abreControlaScore
  );

  const abrePerdeControleScore = round3(
    0.35 * stAbriuPerdeuControle.pct_ajustado +
    0.25 * stAbriuTomouVirada.pct_ajustado +
    0.20 * stAbriuSofreu1x1.pct_ajustado +
    0.20 * abreCedeReacaoScore
  );

  // Campos antigos/compatibilidade.
  const volumeQuandoAbreScore = abreContinuaCriandoScore;
  const continuaBuscaScore = abreContinuaCriandoScore;
  const travaAposAbrirScore = abreTravaScore;
  const permiteReacaoScore = abreCedeReacaoScore;
  const mataJogoScore = abreMataJogoScore;

  // =========================================================
  // Scores — quando sofre primeiro
  // =========================================================
  const sofreBuscaEmpateScore = round3(
    0.40 * stSofreBusca1x1.pct_ajustado +
    0.20 * stSofreCriouVolume.pct_ajustado +
    0.15 * clamp(xgMedioQuandoSofreuPrimeiro / 1.70, 0, 1) +
    0.15 * clamp(xgotMedioQuandoSofreuPrimeiro / 1.20, 0, 1) +
    0.10 * stSofreEmpatou.pct_ajustado
  );

  const sofreViraScore = round3(
    0.55 * stSofreVirou.pct_ajustado +
    0.25 * stat('sofreu_primeiro_busca_1x1_e_faz_2x1', sofreuPrimeiroPeso, sofreuPrimeiroRaw, 0.10, 8).pct_ajustado +
    0.20 * sofreBuscaEmpateScore
  );

  const sofreNaoBuscaScore = round3(
    0.35 * stSofreNaoBuscaGol.pct_ajustado +
    0.25 * stSofreNaoCriou.pct_ajustado +
    0.20 * stSofrePerdeuSemMarcar.pct_ajustado +
    0.20 * stSofreSaiAtrasNaoEmpata.pct_ajustado
  );

  const sofreTomaMaisScore = round3(
    0.40 * stSofreToma2x0.pct_ajustado +
    0.20 * stSofreToma3x0Mais.pct_ajustado +
    0.20 * stSofreContinuouCedendo.pct_ajustado +
    0.10 * stSofreCedeuXgAlto.pct_ajustado +
    0.10 * stSofreCedeuXgaAlto.pct_ajustado
  );

  const sofreDesmoronaScore = round3(
    0.35 * stSofreDesmoronou.pct_ajustado +
    0.25 * stSofreToma2x0.pct_ajustado +
    0.20 * stSofrePerdeuSemMarcar.pct_ajustado +
    0.20 * stSofreNaoCriou.pct_ajustado
  );

  const sofreReageMasCedeEspacoScore = round3(
    0.35 * stSofreReageMasCedeEspaco.pct_ajustado +
    0.25 * stSofreCriouVolume.pct_ajustado +
    0.20 * stSofreContinuouCedendo.pct_ajustado +
    0.20 * stSofreTomaMaisMasCria.pct_ajustado
  );

  const sofreControlaDepoisScore = round3(
    0.35 * stSofreControlouDepois.pct_ajustado +
    0.25 * stSofreControlouXgContra.pct_ajustado +
    0.25 * stSofreControlouXga.pct_ajustado +
    0.15 * (1 - stSofreToma2x0.pct_ajustado)
  );

  // Campos antigos/compatibilidade.
  const reageDepoisSofrerScore = sofreBuscaEmpateScore;
  const desmoronaDepoisSofrerScore = sofreDesmoronaScore;

  function classificarQuandoAbreNovo() {
    if (confiancaAbriu < 0.35) return 'SEM_CONFIANCA';

    if (abreMataJogoScore >= 0.62 && abreCedeReacaoScore <= 0.42) {
      return 'ABRE_E_MATA_COM_DOMINIO';
    }

    if (abreAmpliaScore >= 0.58 && abreCedeReacaoScore <= 0.45) {
      return 'ABRE_E_AMPLIA_COM_CONTROLE';
    }

    if (abreAmpliaScore >= 0.55 && abreCedeReacaoScore >= 0.52) {
      return 'ABRE_E_AMPLIA_MAS_CEDE_VOLUME';
    }

    if (abreCedeReacaoScore >= 0.58 && sofreBuscaEmpateScore >= 0.50) {
      return 'ABRE_E_CEDE_REACAO_REAL';
    }

    if (abreContinuaCriandoScore >= 0.58 && abreTravaScore <= 0.42) {
      return 'ABRE_E_NAO_AMPLIA_MAS_CONTINUA_CRIANDO';
    }

    if (abreTravaScore >= 0.55 && abreContinuaCriandoScore < 0.50) {
      return 'ABRE_E_TRAVA_COM_BAIXO_VOLUME';
    }

    if (abreControlaScore >= 0.60 && abreAmpliaScore < 0.50) {
      return 'ABRE_E_SEGURA_SEM_FORCAR';
    }

    if (abrePerdeControleScore >= 0.55) {
      return 'ABRE_E_PERDE_CONTROLE';
    }

    return 'NEUTRO';
  }

  function classificarQuandoSofreNovo() {
    if (confiancaSofreuPrimeiro < 0.35) return 'SEM_CONFIANCA';

    if (sofreViraScore >= 0.42 && sofreBuscaEmpateScore >= 0.55) {
      return 'SOFRE_E_VIRA_COM_VOLUME';
    }

    if (sofreBuscaEmpateScore >= 0.58 && sofreTomaMaisScore <= 0.48) {
      return 'SOFRE_E_BUSCA_EMPATE_COM_VOLUME';
    }

    if (sofreReageMasCedeEspacoScore >= 0.55 && sofreBuscaEmpateScore >= 0.48) {
      return 'SOFRE_E_REAGE_MAS_CEDE_ESPACO';
    }

    if (sofreTomaMaisScore >= 0.58 && sofreDesmoronaScore >= 0.50) {
      return 'SOFRE_E_TOMA_MAIS_E_DESMORONA';
    }

    if (sofreNaoBuscaScore >= 0.58 && sofreBuscaEmpateScore < 0.45) {
      return 'SOFRE_E_NAO_BUSCA_E_NAO_CRIA';
    }

    if (stSofreTomaMaisMasCria.pct_ajustado >= 0.35 && stSofreCriouVolume.pct_ajustado >= 0.45) {
      return 'SOFRE_E_TOMA_MAIS_MAS_TAMBEM_CRIA';
    }

    if (sofreControlaDepoisScore >= 0.58 && sofreBuscaEmpateScore < 0.50) {
      return 'SOFRE_E_CONTROLA_MAS_REAGE_POUCO';
    }

    return 'NEUTRO';
  }

  const leituraQuandoAbre = classificarQuandoAbreNovo();
  const leituraQuandoSofrePrimeiro = classificarQuandoSofreNovo();

  const samplePosPrimeiroGol = round3(abriuPeso + sofreuPrimeiroPeso);
  const samplePosPrimeiroGolRaw = abriuRaw + sofreuPrimeiroRaw;
  const confiancaPosPrimeiroGol = confiancaAmostraRoteiro(samplePosPrimeiroGol, 16);

  const jogoVivoPosPrimeiroGolScore = round3(
    0.30 * abreContinuaCriandoScore +
    0.25 * abreCedeReacaoScore +
    0.25 * sofreBuscaEmpateScore +
    0.20 * sofreReageMasCedeEspacoScore
  );

  const travaPosPrimeiroGolScore = round3(
    0.45 * abreTravaScore +
    0.30 * sofreNaoBuscaScore +
    0.25 * sofreDesmoronaScore
  );

  const dominioPosPrimeiroGolScore = round3(
    0.35 * abreMataJogoScore +
    0.25 * abreAmpliaScore +
    0.20 * abreControlaScore +
    0.20 * sofreTomaMaisScore
  );

  function classificarPerfilGeral() {
    if (confiancaPosPrimeiroGol < 0.35) return 'SEM_CONFIANCA_GERAL';

    if (jogoVivoPosPrimeiroGolScore >= 0.58 && travaPosPrimeiroGolScore <= 0.45) {
      return 'PERFIL_POS_1_GOL_JOGO_VIVO';
    }

    if (dominioPosPrimeiroGolScore >= 0.58 && sofreBuscaEmpateScore < 0.48) {
      return 'PERFIL_POS_1_GOL_DOMINIO_DO_TIME_QUE_ABRE';
    }

    if (travaPosPrimeiroGolScore >= 0.55 && jogoVivoPosPrimeiroGolScore < 0.48) {
      return 'PERFIL_POS_1_GOL_TRAVA';
    }

    if (abreCedeReacaoScore >= 0.55 && sofreBuscaEmpateScore >= 0.52) {
      return 'PERFIL_POS_1_GOL_REACAO_FORTE';
    }

    if (abreAmpliaScore >= 0.55 && sofreTomaMaisScore >= 0.55) {
      return 'PERFIL_POS_1_GOL_ABRE_CAMINHO_PARA_2X0';
    }

    return 'PERFIL_POS_1_GOL_NEUTRO';
  }

  const leituraPerfilGeral = classificarPerfilGeral();

  const perfilAntigo = {
    mata_jogo: round3(
      0.45 * stAbriuAmpliou.pct +
      0.35 * stAbriuVenceu.pct +
      0.20 * (1 - stAbriuSofreu1x1.pct)
    ),

    recua_depois_1x0: round3(
      0.45 * stAbriuSofreu1x1.pct +
      0.30 * stAbriuTerminou1x0.pct +
      0.25 * (1 - stAbriuAmpliou.pct)
    ),

    reage_depois_sofrer: round3(
      0.50 * stSofreBusca1x1.pct +
      0.30 * stSofreVirou.pct +
      0.20 * stSofreEmpatou.pct
    ),

    desmorona_depois_sofrer: round3(
      0.50 * stSofreToma2x0.pct +
      0.35 * stSofrePerdeu.pct +
      0.15 * (1 - stSofreBusca1x1.pct)
    ),
  };

  const volumeQuandoAbre = {
    xg_medio: xgMedioQuandoAbriu,
    xgot_medio: xgotMedioQuandoAbriu,

    xg_contra_medio: xgContraMedioQuandoAbriu,

    // xga = xGOT contra
    xga_medio: xgaMedioQuandoAbriu,
    xgot_contra_medio: xgaMedioQuandoAbriu,
    xga_contra_medio: xgaMedioQuandoAbriu,

    sot_medio: sotMedioQuandoAbriu,
    big_chances_medio: bigChancesMedioQuandoAbriu,
    box_shots_medio: boxShotsMedioQuandoAbriu,
    box_touches_medio: boxTouchesMedioQuandoAbriu,

    pct_xg_alto: stAbriuXgAlto.pct,
    pct_xgot_alto: stAbriuXgotAlto.pct,
    pct_xg_baixo: stAbriuXgBaixo.pct,
    pct_xgot_baixo: stAbriuXgotBaixo.pct,

    pct_cede_xg_alto: stAbriuCedeuXgAlto.pct,
    pct_cede_xga_alto: stAbriuCedeuXgaAlto.pct,
    pct_cede_xgot_contra_alto: stAbriuCedeuXgaAlto.pct,

    pct_controla_xg_contra: stAbriuControlouXgContra.pct,
    pct_controla_xga: stAbriuControlouXga.pct,
    pct_controla_xgot_contra: stAbriuControlouXga.pct,
  };

  const volumeQuandoSofrePrimeiro = {
    xg_medio: xgMedioQuandoSofreuPrimeiro,
    xgot_medio: xgotMedioQuandoSofreuPrimeiro,

    xg_contra_medio: xgContraMedioQuandoSofreuPrimeiro,

    // xga = xGOT contra
    xga_medio: xgaMedioQuandoSofreuPrimeiro,
    xgot_contra_medio: xgaMedioQuandoSofreuPrimeiro,
    xga_contra_medio: xgaMedioQuandoSofreuPrimeiro,

    sot_medio: sotMedioQuandoSofreuPrimeiro,
    big_chances_medio: bigChancesMedioQuandoSofreuPrimeiro,
    box_shots_medio: boxShotsMedioQuandoSofreuPrimeiro,
    box_touches_medio: boxTouchesMedioQuandoSofreuPrimeiro,

    pct_xg_alto: stSofreXgAlto.pct,
    pct_xgot_alto: stSofreXgotAlto.pct,
    pct_xg_baixo: stSofreXgBaixo.pct,
    pct_xgot_baixo: stSofreXgotBaixo.pct,

    pct_cede_xg_alto: stSofreCedeuXgAlto.pct,
    pct_cede_xga_alto: stSofreCedeuXgaAlto.pct,
    pct_cede_xgot_contra_alto: stSofreCedeuXgaAlto.pct,

    pct_controla_xg_contra: stSofreControlouXgContra.pct,
    pct_controla_xga: stSofreControlouXga.pct,
    pct_controla_xgot_contra: stSofreControlouXga.pct,
  };

  return {
    sample_raw: itens.length,
    sample_peso_total: pesoTotal,
    ativo: itens.length >= 10 ? 1 : 0,
    observacao: itens.length >= 10 ? 'ok' : 'amostra_menor_10',

    sample_com_roteiro_gol: sampleComRoteiro,
    sample_com_roteiro_gol_raw: sampleComRoteiroRaw,

    confianca_roteiro_geral: confiancaRoteiroGeral,
    confianca_roteiro_geral_label: labelConfiancaRoteiro(confiancaRoteiroGeral),

    sem_gol_placar: somaPeso('sem_gol_placar'),
    sem_gol_placar_raw: somaRaw('sem_gol_placar'),
    pct_sem_gol_placar: rate(somaPeso('sem_gol_placar'), pesoTotal),

    evento_gol_faltando: somaPeso('evento_gol_faltando'),
    evento_gol_faltando_raw: somaRaw('evento_gol_faltando'),

    abriu_placar: abriuPeso,
    abriu_placar_raw: abriuRaw,
    pct_abriu_placar_sobre_jogos_com_gol: rate(abriuPeso, sampleComRoteiro),
    pct_abriu_placar_sobre_total: rate(abriuPeso, pesoTotal),

    abriu_e_fez_2x0: stAbriuAmpliou.peso,
    abriu_e_fez_2x0_raw: stAbriuAmpliou.raw,
    pct_abriu_e_fez_2x0: stAbriuAmpliou.pct,
    pct_abriu_e_fez_2x0_ajustado: stAbriuAmpliou.pct_ajustado,

    abriu_e_ampliou_2x0: stAbriuAmpliou.peso,
    abriu_e_ampliou_2x0_raw: stAbriuAmpliou.raw,
    pct_abriu_e_ampliou_2x0: stAbriuAmpliou.pct,
    pct_abriu_e_ampliou_2x0_ajustado: stAbriuAmpliou.pct_ajustado,

    abriu_e_sofreu_1x1: stAbriuSofreu1x1.peso,
    abriu_e_sofreu_1x1_raw: stAbriuSofreu1x1.raw,
    pct_abriu_e_sofreu_1x1: stAbriuSofreu1x1.pct,
    pct_abriu_e_sofreu_1x1_ajustado: stAbriuSofreu1x1.pct_ajustado,

    abriu_sofreu_1x1_e_fez_2x1: somaPeso('abriu_sofreu_1x1_e_fez_2x1'),
    abriu_sofreu_1x1_e_fez_2x1_raw: somaRaw('abriu_sofreu_1x1_e_fez_2x1'),
    pct_pos_1x1_fez_2x1: rate(somaPeso('abriu_sofreu_1x1_e_fez_2x1'), stAbriuSofreu1x1.peso),

    abriu_sofreu_1x1_e_tomou_1x2: somaPeso('abriu_sofreu_1x1_e_tomou_1x2'),
    abriu_sofreu_1x1_e_tomou_1x2_raw: somaRaw('abriu_sofreu_1x1_e_tomou_1x2'),
    pct_pos_1x1_tomou_1x2: rate(somaPeso('abriu_sofreu_1x1_e_tomou_1x2'), stAbriuSofreu1x1.peso),

    abriu_e_terminou_1x0: stAbriuTerminou1x0.peso,
    abriu_e_terminou_1x0_raw: stAbriuTerminou1x0.raw,
    pct_abriu_e_terminou_1x0: stAbriuTerminou1x0.pct,
    pct_abriu_e_terminou_1x0_ajustado: stAbriuTerminou1x0.pct_ajustado,

    abriu_e_venceu: stAbriuVenceu.peso,
    abriu_e_venceu_raw: stAbriuVenceu.raw,
    pct_abriu_e_venceu: stAbriuVenceu.pct,
    pct_abriu_e_venceu_ajustado: stAbriuVenceu.pct_ajustado,

    abriu_e_empatou: stAbriuEmpatou.peso,
    abriu_e_empatou_raw: stAbriuEmpatou.raw,
    pct_abriu_e_empatou: stAbriuEmpatou.pct,
    pct_abriu_e_empatou_ajustado: stAbriuEmpatou.pct_ajustado,

    abriu_e_perdeu: stAbriuPerdeu.peso,
    abriu_e_perdeu_raw: stAbriuPerdeu.raw,
    pct_abriu_e_perdeu: stAbriuPerdeu.pct,
    pct_abriu_e_perdeu_ajustado: stAbriuPerdeu.pct_ajustado,

    sofreu_primeiro: sofreuPrimeiroPeso,
    sofreu_primeiro_raw: sofreuPrimeiroRaw,
    pct_sofreu_primeiro_sobre_jogos_com_gol: rate(sofreuPrimeiroPeso, sampleComRoteiro),
    pct_sofreu_primeiro_sobre_total: rate(sofreuPrimeiroPeso, pesoTotal),

    sofreu_primeiro_e_busca_1x1: stSofreBusca1x1.peso,
    sofreu_primeiro_e_busca_1x1_raw: stSofreBusca1x1.raw,
    pct_sofreu_primeiro_e_busca_1x1: stSofreBusca1x1.pct,
    pct_sofreu_primeiro_e_busca_1x1_ajustado: stSofreBusca1x1.pct_ajustado,

    sofreu_primeiro_e_toma_2x0: stSofreToma2x0.peso,
    sofreu_primeiro_e_toma_2x0_raw: stSofreToma2x0.raw,
    pct_sofreu_primeiro_e_toma_2x0: stSofreToma2x0.pct,
    pct_sofreu_primeiro_e_toma_2x0_ajustado: stSofreToma2x0.pct_ajustado,

    sofreu_primeiro_e_toma_3x0_mais: stSofreToma3x0Mais.peso,
    sofreu_primeiro_e_toma_3x0_mais_raw: stSofreToma3x0Mais.raw,
    pct_sofreu_primeiro_e_toma_3x0_mais: stSofreToma3x0Mais.pct,
    pct_sofreu_primeiro_e_toma_3x0_mais_ajustado: stSofreToma3x0Mais.pct_ajustado,

    sofreu_primeiro_busca_1x1_e_faz_2x1: somaPeso('sofreu_primeiro_busca_1x1_e_faz_2x1'),
    sofreu_primeiro_busca_1x1_e_faz_2x1_raw: somaRaw('sofreu_primeiro_busca_1x1_e_faz_2x1'),
    pct_pos_1x1_faz_2x1: rate(somaPeso('sofreu_primeiro_busca_1x1_e_faz_2x1'), stSofreBusca1x1.peso),

    sofreu_primeiro_busca_1x1_e_toma_1x2: somaPeso('sofreu_primeiro_busca_1x1_e_toma_1x2'),
    sofreu_primeiro_busca_1x1_e_toma_1x2_raw: somaRaw('sofreu_primeiro_busca_1x1_e_toma_1x2'),
    pct_pos_1x1_toma_1x2: rate(somaPeso('sofreu_primeiro_busca_1x1_e_toma_1x2'), stSofreBusca1x1.peso),

    sofreu_primeiro_e_virou: stSofreVirou.peso,
    sofreu_primeiro_e_virou_raw: stSofreVirou.raw,
    pct_sofreu_primeiro_e_virou: stSofreVirou.pct,
    pct_sofreu_primeiro_e_virou_ajustado: stSofreVirou.pct_ajustado,

    sofreu_primeiro_e_empatou: stSofreEmpatou.peso,
    sofreu_primeiro_e_empatou_raw: stSofreEmpatou.raw,
    pct_sofreu_primeiro_e_empatou: stSofreEmpatou.pct,
    pct_sofreu_primeiro_e_empatou_ajustado: stSofreEmpatou.pct_ajustado,

    sofreu_primeiro_e_perdeu: stSofrePerdeu.peso,
    sofreu_primeiro_e_perdeu_raw: stSofrePerdeu.raw,
    pct_sofreu_primeiro_e_perdeu: stSofrePerdeu.pct,
    pct_sofreu_primeiro_e_perdeu_ajustado: stSofrePerdeu.pct_ajustado,

    abriu_e_continuou_com_volume: stAbriuContinuouCriando.peso,
    abriu_e_continuou_com_volume_raw: stAbriuContinuouCriando.raw,
    pct_abriu_e_continuou_com_volume: stAbriuContinuouCriando.pct,
    pct_abriu_e_continuou_com_volume_ajustado: stAbriuContinuouCriando.pct_ajustado,

    abriu_e_travou: stAbriuTravouBaixoVolume.peso,
    abriu_e_travou_raw: stAbriuTravouBaixoVolume.raw,
    pct_abriu_e_travou: stAbriuTravouBaixoVolume.pct,
    pct_abriu_e_travou_ajustado: stAbriuTravouBaixoVolume.pct_ajustado,

    abriu_e_permitiu_reacao: stAbriuCedeuReacaoReal.peso,
    abriu_e_permitiu_reacao_raw: stAbriuCedeuReacaoReal.raw,
    pct_abriu_e_permitiu_reacao: stAbriuCedeuReacaoReal.pct,
    pct_abriu_e_permitiu_reacao_ajustado: stAbriuCedeuReacaoReal.pct_ajustado,

    sofreu_primeiro_e_reagiu_com_volume: somaPeso('sofreu_primeiro_e_reagiu_com_volume'),
    sofreu_primeiro_e_reagiu_com_volume_raw: somaRaw('sofreu_primeiro_e_reagiu_com_volume'),
    pct_sofreu_primeiro_e_reagiu_com_volume: rate(somaPeso('sofreu_primeiro_e_reagiu_com_volume'), sofreuPrimeiroPeso),
    pct_sofreu_primeiro_e_reagiu_com_volume_ajustado: rateBayesRoteiro(
      somaPeso('sofreu_primeiro_e_reagiu_com_volume'),
      sofreuPrimeiroPeso,
      0.38,
      8
    ),

    sofreu_primeiro_e_morreu: somaPeso('sofreu_primeiro_e_morreu'),
    sofreu_primeiro_e_morreu_raw: somaRaw('sofreu_primeiro_e_morreu'),
    pct_sofreu_primeiro_e_morreu: rate(somaPeso('sofreu_primeiro_e_morreu'), sofreuPrimeiroPeso),
    pct_sofreu_primeiro_e_morreu_ajustado: rateBayesRoteiro(
      somaPeso('sofreu_primeiro_e_morreu'),
      sofreuPrimeiroPeso,
      0.28,
      8
    ),

    perfil: {
      ...perfilAntigo,

      volume_quando_abre: volumeQuandoAbreScore,
      continua_busca_apos_abrir: continuaBuscaScore,
      trava_apos_abrir: travaAposAbrirScore,
      permite_reacao_apos_abrir: permiteReacaoScore,
      mata_jogo_ajustado: mataJogoScore,
      controla_apos_abrir: abreControlaScore,
      perde_controle_apos_abrir: abrePerdeControleScore,

      reage_depois_sofrer_ajustado: reageDepoisSofrerScore,
      busca_empate_depois_sofrer: sofreBuscaEmpateScore,
      vira_depois_sofrer: sofreViraScore,
      nao_busca_depois_sofrer: sofreNaoBuscaScore,
      toma_mais_depois_sofrer: sofreTomaMaisScore,
      desmorona_depois_sofrer_ajustado: desmoronaDepoisSofrerScore,
      reage_mas_cede_espaco_depois_sofrer: sofreReageMasCedeEspacoScore,

      leitura_quando_abre: leituraQuandoAbre,
      leitura_quando_sofre_primeiro: leituraQuandoSofrePrimeiro,
      leitura_geral_pos_primeiro_gol: leituraPerfilGeral,
    },

    condicional_pos_primeiro_gol: {
      ativo: itens.length >= 10 ? 1 : 0,
      observacao: itens.length >= 10 ? 'ok' : 'amostra_menor_10',

      sample_pos_primeiro_gol: samplePosPrimeiroGol,
      sample_pos_primeiro_gol_raw: samplePosPrimeiroGolRaw,
      confianca_pos_primeiro_gol: confiancaPosPrimeiroGol,
      confianca_pos_primeiro_gol_label: labelConfiancaRoteiro(confiancaPosPrimeiroGol),

      quando_abre: {
        sample: abriuPeso,
        sample_raw: abriuRaw,
        confianca: confiancaAbriu,
        confianca_label: labelConfiancaRoteiro(confiancaAbriu),
        pct_abriu_placar_sobre_jogos_com_gol: rate(abriuPeso, sampleComRoteiro),

        placar: {
          ampliou_2x0: stAbriuAmpliou.peso,
          ampliou_2x0_raw: stAbriuAmpliou.raw,
          pct_ampliou_2x0: stAbriuAmpliou.pct,
          pct_ampliou_2x0_ajustado: stAbriuAmpliou.pct_ajustado,

          sofreu_1x1: stAbriuSofreu1x1.peso,
          sofreu_1x1_raw: stAbriuSofreu1x1.raw,
          pct_sofreu_1x1: stAbriuSofreu1x1.pct,
          pct_sofreu_1x1_ajustado: stAbriuSofreu1x1.pct_ajustado,

          terminou_1x0: stAbriuTerminou1x0.peso,
          terminou_1x0_raw: stAbriuTerminou1x0.raw,
          pct_terminou_1x0: stAbriuTerminou1x0.pct,
          pct_terminou_1x0_ajustado: stAbriuTerminou1x0.pct_ajustado,

          venceu: stAbriuVenceu.peso,
          venceu_raw: stAbriuVenceu.raw,
          pct_venceu: stAbriuVenceu.pct,
          pct_venceu_ajustado: stAbriuVenceu.pct_ajustado,

          empatou: stAbriuEmpatou.peso,
          empatou_raw: stAbriuEmpatou.raw,
          pct_empatou: stAbriuEmpatou.pct,
          pct_empatou_ajustado: stAbriuEmpatou.pct_ajustado,

          perdeu: stAbriuPerdeu.peso,
          perdeu_raw: stAbriuPerdeu.raw,
          pct_perdeu: stAbriuPerdeu.pct,
          pct_perdeu_ajustado: stAbriuPerdeu.pct_ajustado,

          tomou_virada: stAbriuTomouVirada.peso,
          tomou_virada_raw: stAbriuTomouVirada.raw,
          pct_tomou_virada: stAbriuTomouVirada.pct,
          pct_tomou_virada_ajustado: stAbriuTomouVirada.pct_ajustado,

          parou_no_placar: stAbriuParouPlacar.peso,
          parou_no_placar_raw: stAbriuParouPlacar.raw,
          pct_parou_no_placar: stAbriuParouPlacar.pct,
          pct_parou_no_placar_ajustado: stAbriuParouPlacar.pct_ajustado,
        },

        volume: volumeQuandoAbre,

        comportamento: {
          continuou_criando: stAbriuContinuouCriando,
          nao_ampliou_mas_criou: stAbriuNaoAmpliouMasCriou,
          travou_baixo_volume: stAbriuTravouBaixoVolume,
          cedeu_reacao_real: stAbriuCedeuReacaoReal,
          controlou_adversario: stAbriuControlouAdv,
          ampliou_com_dominio: stAbriuAmpliouComDominio,
          ampliou_mas_cedeu: stAbriuAmpliouMasCedeu,
          matou_jogo: stAbriuMatouJogo,
          perdeu_controle: stAbriuPerdeuControle,
        },

        scores: {
          amplia_score: abreAmpliaScore,
          continua_criando_score: abreContinuaCriandoScore,
          trava_score: abreTravaScore,
          cede_reacao_score: abreCedeReacaoScore,
          controla_score: abreControlaScore,
          mata_jogo_score: abreMataJogoScore,
          perde_controle_score: abrePerdeControleScore,
        },

        pct_fez_2x0: stAbriuAmpliou.pct,
        pct_fez_2x0_ajustado: stAbriuAmpliou.pct_ajustado,
        pct_continuou_com_volume: stAbriuContinuouCriando.pct,
        pct_continuou_com_volume_ajustado: stAbriuContinuouCriando.pct_ajustado,
        pct_travou: stAbriuTravouBaixoVolume.pct,
        pct_travou_ajustado: stAbriuTravouBaixoVolume.pct_ajustado,
        pct_permitiu_reacao: stAbriuCedeuReacaoReal.pct,
        pct_permitiu_reacao_ajustado: stAbriuCedeuReacaoReal.pct_ajustado,
        pct_sofreu_1x1: stAbriuSofreu1x1.pct,
        pct_sofreu_1x1_ajustado: stAbriuSofreu1x1.pct_ajustado,
        pct_terminou_1x0: stAbriuTerminou1x0.pct,
        pct_terminou_1x0_ajustado: stAbriuTerminou1x0.pct_ajustado,
        pct_venceu: stAbriuVenceu.pct,
        pct_venceu_ajustado: stAbriuVenceu.pct_ajustado,
        pct_empatou: stAbriuEmpatou.pct,
        pct_perdeu: stAbriuPerdeu.pct,

        xg_medio: xgMedioQuandoAbriu,
        xgot_medio: xgotMedioQuandoAbriu,
        xg_contra_medio: xgContraMedioQuandoAbriu,

        // xga = xGOT contra
        xga_medio: xgaMedioQuandoAbriu,
        xga_contra_medio: xgaMedioQuandoAbriu,
        xgot_contra_medio: xgaMedioQuandoAbriu,

        sot_medio: sotMedioQuandoAbriu,
        big_chances_medio: bigChancesMedioQuandoAbriu,

        volume_score: volumeQuandoAbreScore,
        continua_busca_score: continuaBuscaScore,
        trava_apos_abrir_score: travaAposAbrirScore,
        permite_reacao_score: permiteReacaoScore,
        mata_jogo_score: mataJogoScore,

        leitura: leituraQuandoAbre,
      },

      quando_sofre_primeiro: {
        sample: sofreuPrimeiroPeso,
        sample_raw: sofreuPrimeiroRaw,
        confianca: confiancaSofreuPrimeiro,
        confianca_label: labelConfiancaRoteiro(confiancaSofreuPrimeiro),

        placar: {
          busca_1x1: stSofreBusca1x1.peso,
          busca_1x1_raw: stSofreBusca1x1.raw,
          pct_busca_1x1: stSofreBusca1x1.pct,
          pct_busca_1x1_ajustado: stSofreBusca1x1.pct_ajustado,

          virou: stSofreVirou.peso,
          virou_raw: stSofreVirou.raw,
          pct_virou: stSofreVirou.pct,
          pct_virou_ajustado: stSofreVirou.pct_ajustado,

          empatou: stSofreEmpatou.peso,
          empatou_raw: stSofreEmpatou.raw,
          pct_empatou: stSofreEmpatou.pct,
          pct_empatou_ajustado: stSofreEmpatou.pct_ajustado,

          tomou_2x0: stSofreToma2x0.peso,
          tomou_2x0_raw: stSofreToma2x0.raw,
          pct_tomou_2x0: stSofreToma2x0.pct,
          pct_tomou_2x0_ajustado: stSofreToma2x0.pct_ajustado,

          tomou_3x0_mais: stSofreToma3x0Mais.peso,
          tomou_3x0_mais_raw: stSofreToma3x0Mais.raw,
          pct_tomou_3x0_mais: stSofreToma3x0Mais.pct,
          pct_tomou_3x0_mais_ajustado: stSofreToma3x0Mais.pct_ajustado,

          perdeu: stSofrePerdeu.peso,
          perdeu_raw: stSofrePerdeu.raw,
          pct_perdeu: stSofrePerdeu.pct,
          pct_perdeu_ajustado: stSofrePerdeu.pct_ajustado,

          perdeu_sem_marcar: stSofrePerdeuSemMarcar.peso,
          perdeu_sem_marcar_raw: stSofrePerdeuSemMarcar.raw,
          pct_perdeu_sem_marcar: stSofrePerdeuSemMarcar.pct,
          pct_perdeu_sem_marcar_ajustado: stSofrePerdeuSemMarcar.pct_ajustado,

          nao_busca_gol: stSofreNaoBuscaGol.peso,
          nao_busca_gol_raw: stSofreNaoBuscaGol.raw,
          pct_nao_busca_gol: stSofreNaoBuscaGol.pct,
          pct_nao_busca_gol_ajustado: stSofreNaoBuscaGol.pct_ajustado,

          sai_atras_e_nao_empata: stSofreSaiAtrasNaoEmpata.peso,
          sai_atras_e_nao_empata_raw: stSofreSaiAtrasNaoEmpata.raw,
          pct_sai_atras_e_nao_empata: stSofreSaiAtrasNaoEmpata.pct,
          pct_sai_atras_e_nao_empata_ajustado: stSofreSaiAtrasNaoEmpata.pct_ajustado,
        },

        volume: volumeQuandoSofrePrimeiro,

        comportamento: {
          criou_volume: stSofreCriouVolume,
          nao_criou: stSofreNaoCriou,
          controlou_depois: stSofreControlouDepois,
          continuou_cedendo: stSofreContinuouCedendo,
          reage_mas_cede_espaco: stSofreReageMasCedeEspaco,
          desmoronou: stSofreDesmoronou,
          toma_mais_mas_cria: stSofreTomaMaisMasCria,
        },

        scores: {
          busca_empate_score: sofreBuscaEmpateScore,
          vira_score: sofreViraScore,
          nao_busca_score: sofreNaoBuscaScore,
          toma_mais_score: sofreTomaMaisScore,
          desmorona_score: sofreDesmoronaScore,
          reage_mas_cede_espaco_score: sofreReageMasCedeEspacoScore,
          controla_depois_score: sofreControlaDepoisScore,
        },

        pct_busca_1x1: stSofreBusca1x1.pct,
        pct_busca_1x1_ajustado: stSofreBusca1x1.pct_ajustado,
        pct_reagiu_com_volume: rate(somaPeso('sofreu_primeiro_e_reagiu_com_volume'), sofreuPrimeiroPeso),
        pct_reagiu_com_volume_ajustado: rateBayesRoteiro(
          somaPeso('sofreu_primeiro_e_reagiu_com_volume'),
          sofreuPrimeiroPeso,
          0.38,
          8
        ),
        pct_morreu: rate(somaPeso('sofreu_primeiro_e_morreu'), sofreuPrimeiroPeso),
        pct_morreu_ajustado: rateBayesRoteiro(
          somaPeso('sofreu_primeiro_e_morreu'),
          sofreuPrimeiroPeso,
          0.28,
          8
        ),
        pct_toma_2x0: stSofreToma2x0.pct,
        pct_toma_2x0_ajustado: stSofreToma2x0.pct_ajustado,
        pct_vira: stSofreVirou.pct,
        pct_vira_ajustado: stSofreVirou.pct_ajustado,
        pct_empata: stSofreEmpatou.pct,
        pct_empata_ajustado: stSofreEmpatou.pct_ajustado,
        pct_perde: stSofrePerdeu.pct,
        pct_perde_ajustado: stSofrePerdeu.pct_ajustado,

        xg_medio: xgMedioQuandoSofreuPrimeiro,
        xgot_medio: xgotMedioQuandoSofreuPrimeiro,
        xg_contra_medio: xgContraMedioQuandoSofreuPrimeiro,

        // xga = xGOT contra
        xga_medio: xgaMedioQuandoSofreuPrimeiro,
        xga_contra_medio: xgaMedioQuandoSofreuPrimeiro,
        xgot_contra_medio: xgaMedioQuandoSofreuPrimeiro,

        sot_medio: sotMedioQuandoSofreuPrimeiro,
        big_chances_medio: bigChancesMedioQuandoSofreuPrimeiro,

        reage_score: reageDepoisSofrerScore,
        busca_empate_score: sofreBuscaEmpateScore,
        vira_score: sofreViraScore,
        nao_busca_score: sofreNaoBuscaScore,
        toma_mais_score: sofreTomaMaisScore,
        desmorona_score: desmoronaDepoisSofrerScore,
        reage_mas_cede_espaco_score: sofreReageMasCedeEspacoScore,

        leitura: leituraQuandoSofrePrimeiro,
      },

      perfil_time_pos_primeiro_gol: {
        sample: samplePosPrimeiroGol,
        sample_raw: samplePosPrimeiroGolRaw,
        confianca: confiancaPosPrimeiroGol,
        confianca_label: labelConfiancaRoteiro(confiancaPosPrimeiroGol),

        jogo_vivo_score: jogoVivoPosPrimeiroGolScore,
        trava_score: travaPosPrimeiroGolScore,
        dominio_score: dominioPosPrimeiroGolScore,

        abre_amplia_score: abreAmpliaScore,
        abre_continua_criando_score: abreContinuaCriandoScore,
        abre_trava_score: abreTravaScore,
        abre_cede_reacao_score: abreCedeReacaoScore,
        abre_controla_score: abreControlaScore,
        abre_mata_jogo_score: abreMataJogoScore,

        sofre_busca_empate_score: sofreBuscaEmpateScore,
        sofre_vira_score: sofreViraScore,
        sofre_nao_busca_score: sofreNaoBuscaScore,
        sofre_toma_mais_score: sofreTomaMaisScore,
        sofre_desmorona_score: sofreDesmoronaScore,
        sofre_reage_mas_cede_espaco_score: sofreReageMasCedeEspacoScore,

        leitura: leituraPerfilGeral,
      },

      scores_resumo: {
        abre_continua_score: continuaBuscaScore,
        abre_trava_score: travaAposAbrirScore,
        abre_permite_reacao_score: permiteReacaoScore,
        mata_jogo_score: mataJogoScore,
        sofre_reage_score: reageDepoisSofrerScore,
        sofre_desmorona_score: desmoronaDepoisSofrerScore,

        jogo_vivo_pos_primeiro_gol_score: jogoVivoPosPrimeiroGolScore,
        trava_pos_primeiro_gol_score: travaPosPrimeiroGolScore,
        dominio_pos_primeiro_gol_score: dominioPosPrimeiroGolScore,
      },
    },
  };
}
// =========================================================
// 🚀 PIPELINE PRINCIPAL
// =========================================================
async function runETL() {
  console.log(`\n🚀 [ETL] Iniciando Motor Blindado Unificado para: ${DATA_ALVO}`);

  const client = await pool.connect();
  let emTransacao = false;

  try {
    const resChecagem = await client.query(
      `SELECT COUNT(*) FROM calendario WHERE data_jogo = $1`,
      [DATA_ALVO]
    );

    if (toNum(resChecagem.rows[0].count, 0) === 0) {
      console.log('ℹ️ Nenhum jogo encontrado para esta data.');
      return;
    }

    const dataMinHistorico = new Date(DATA_ALVO);
    dataMinHistorico.setFullYear(dataMinHistorico.getFullYear() - 1);

    const yyyy = dataMinHistorico.getFullYear();
    const mm = String(dataMinHistorico.getMonth() + 1).padStart(2, '0');
    const dd = String(dataMinHistorico.getDate()).padStart(2, '0');
    const DATA_MIN_HISTORICO = `${yyyy}-${mm}-${dd}`;

    await client.query('BEGIN');
    emTransacao = true;

    const queryMaster = `
      WITH TimesDoDia AS (
        SELECT
          c.id_time_casa AS id_time,
          c.flashscore_id_casa AS flashscore_id_time,
          c.flashscore_slug_liga AS liga_alvo,
          c.url AS url,
          c.hora_jogo AS hora_jogo
        FROM calendario c
        WHERE c.data_jogo = $2

        UNION

        SELECT
          c.id_time_fora AS id_time,
          c.flashscore_id_fora AS flashscore_id_time,
          c.flashscore_slug_liga AS liga_alvo,
          c.url AS url,
          c.hora_jogo AS hora_jogo
        FROM calendario c
        WHERE c.data_jogo = $2
      ),

      TimesDoDiaMando AS (
        SELECT
          td.id_time,
          td.flashscore_id_time,
          td.liga_alvo,
          td.url,
          td.hora_jogo,
          1 AS eh_casa
        FROM TimesDoDia td

        UNION ALL

        SELECT
          td.id_time,
          td.flashscore_id_time,
          td.liga_alvo,
          td.url,
          td.hora_jogo,
          0 AS eh_casa
        FROM TimesDoDia td
      ),

      /* 1) BASE GERAL BLINDADA: Filtra todos os jogos passados do time, mas SÓ deixa passar se tiver xG coletado */
      JogosHistoricosBase AS (
        SELECT
          tdm.id_time,
          tdm.flashscore_id_time,
          tdm.liga_alvo,
          tdm.url,
          tdm.hora_jogo,
          tdm.eh_casa,

          j.id AS id_jogo,
          j.flashscore_id AS flashscore_id_jogo,
          j.data_jogo,
          j.flashscore_slug_liga,
          j.flashscore_id_time_casa,
          j.flashscore_id_time_fora,
          COALESCE(j.placar_casa, 0) AS placar_casa,
          COALESCE(j.placar_fora, 0) AS placar_fora,

          -- Marca 1 se for da liga atual, 0 se for de outra liga/copa
          CASE WHEN j.flashscore_slug_liga = tdm.liga_alvo THEN 1 ELSE 0 END AS eh_mesma_liga

        FROM TimesDoDiaMando tdm
        JOIN jogos j
          ON j.estatisticas_coletadas = 1
         AND j.data_jogo < $2
         AND j.data_jogo >= $3
         AND (
           (tdm.eh_casa = 1 AND j.flashscore_id_time_casa = tdm.flashscore_id_time)
           OR
           (tdm.eh_casa = 0 AND j.flashscore_id_time_fora = tdm.flashscore_id_time)
         )
        /* O FILTRO CRÍTICO: Elimina "jogos fantasmas" da contagem */
        JOIN estatisticas_geral eg_filtro
          ON eg_filtro.flashscore_id_jogo = j.flashscore_id
         AND eg_filtro.id_time = tdm.id_time
         AND eg_filtro.eh_casa = tdm.eh_casa
         AND eg_filtro.xg IS NOT NULL
         AND eg_filtro.xg_contra IS NOT NULL
      ),

      /* 2) FILAS ORDENADAS */
      JogosHistoricosOrdenados AS (
        SELECT
          *,
          -- Fila Global (Todos os jogos válidos do time)
          ROW_NUMBER() OVER (
            PARTITION BY id_time, liga_alvo, eh_casa
            ORDER BY data_jogo DESC, id_jogo DESC
          ) AS rn_global,
          
          -- Fila Específica (Apenas os jogos válidos dentro da liga alvo)
          CASE WHEN eh_mesma_liga = 1 THEN
            ROW_NUMBER() OVER (
              PARTITION BY id_time, liga_alvo, eh_casa, eh_mesma_liga
              ORDER BY data_jogo DESC, id_jogo DESC
            ) 
          ELSE NULL END AS rn_liga
        FROM JogosHistoricosBase
      ),

      /* 3) CONTAGEM: Quantos jogos REAIS COM xG esse time tem na liga alvo? */
      AvaliacaoCenario AS (
        SELECT 
          id_time, 
          liga_alvo, 
          eh_casa,
          COUNT(CASE WHEN eh_mesma_liga = 1 THEN 1 END) AS total_jogos_liga_uteis
        FROM JogosHistoricosOrdenados
        GROUP BY id_time, liga_alvo, eh_casa
      ),

      /* 4) DISJUNTOR INTELIGENTE: Puxa o histórico adequado (Liga ou Global) limitando a $1 (40 jogos) */
      JogosTopContexto AS (
        SELECT f.*
        FROM JogosHistoricosOrdenados f
        JOIN AvaliacaoCenario a 
          ON a.id_time = f.id_time 
         AND a.liga_alvo = f.liga_alvo 
         AND a.eh_casa = f.eh_casa
        WHERE 
          -- Se tiver 10 ou mais jogos na mesma liga, usa SÓ os jogos da liga
          (a.total_jogos_liga_uteis >= 10 AND f.eh_mesma_liga = 1 AND f.rn_liga <= $1)
          OR 
          -- Se tiver MENOS de 10 jogos na liga, entra o FALLBACK GLOBAL
          (a.total_jogos_liga_uteis < 10 AND f.rn_global <= $1)
      ),

      /* A partir daqui, reengatamos nas lógicas de roteiro de gols do seu ETL */
      JogosTopIds AS (
        SELECT DISTINCT
          flashscore_id_jogo
        FROM JogosTopContexto
        WHERE flashscore_id_jogo IS NOT NULL
      ),

      GolsOrdenados AS (
        SELECT
          e.flashscore_id_jogo,
          e.time AS lado_gol,
          e.minuto,
          e.minuto_extra,
          e.ordem_evento,
          e.id AS id_evento,

          ROW_NUMBER() OVER (
            PARTITION BY e.flashscore_id_jogo
            ORDER BY
              COALESCE(e.minuto, 0),
              COALESCE(e.minuto_extra, 0),
              COALESCE(e.ordem_evento, 0),
              e.id
          ) AS ordem_gol
        FROM eventos_jogo e
        JOIN JogosTopIds jt
          ON jt.flashscore_id_jogo = e.flashscore_id_jogo
        WHERE LOWER(COALESCE(e.tipo_evento, '')) = 'gol'
      ),

      RoteiroGols AS (
        SELECT
          flashscore_id_jogo,

          MAX(CASE WHEN ordem_gol = 1 THEN lado_gol END) AS gol_1_lado,
          MAX(CASE WHEN ordem_gol = 2 THEN lado_gol END) AS gol_2_lado,
          MAX(CASE WHEN ordem_gol = 3 THEN lado_gol END) AS gol_3_lado,
          MAX(CASE WHEN ordem_gol = 4 THEN lado_gol END) AS gol_4_lado,

          COUNT(*) AS qtd_gols_eventos
        FROM GolsOrdenados
        GROUP BY
          flashscore_id_jogo
      )

      SELECT
        jt.id_time,
        jt.flashscore_id_time AS flashscore_id_time,
        tnome.nome AS nome_time,
        jt.liga_alvo,
        jt.url,
        jt.hora_jogo,
        CASE WHEN jt.eh_casa = 1 THEN 'casa' ELSE 'fora' END AS mando,

        e.xg,
        e.xgot,
        e.xg_contra,
        e.xga,
        COALESCE(e.xa, 0) AS xa,
        COALESCE(e.chances_clara, 0) AS big_chances,
        COALESCE(e.finalizacoes_no_gol, 0) AS sot,
        COALESCE(e.finalizacoes_de_dentro_area, 0) AS box_shots,
        COALESCE(e.toques_area_adversaria, 0) AS box_touches,
        COALESCE(e.passes_profundidade_certos, 0) AS depth_passes,
        COALESCE(e.posse_bola, 50) AS posse,
        COALESCE(e.passes_porcentagem, 0) AS pass_pct,
        COALESCE(e.passes_terco_final_porcentagem, 0) AS final_third_pass_pct,
        COALESCE(e.erros_resultaram_finalizacao, 0) AS errors_to_shot,
        COALESCE(e.erros_resultaram_gol, 0) AS errors_goal,
        COALESCE(e.defesas_goleiro, 0) AS goalkeeper_saves,

        COALESCE(adv.xg, 0) AS opp_xg,
        COALESCE(adv.xgot, 0) AS opp_xgot,
        COALESCE(adv.finalizacoes_no_gol, 0) AS opp_sot,
        COALESCE(adv.finalizacoes_de_dentro_area, 0) AS opp_box_shots,
        COALESCE(adv.toques_area_adversaria, 0) AS opp_box_touches,

        0 AS qtd_vermelhos,
        0 AS qtd_penaltis,

        CASE
          WHEN jt.eh_casa = 1 THEN jt.placar_casa
          ELSE jt.placar_fora
        END AS gols_marcados_time,

        CASE
          WHEN jt.eh_casa = 1 THEN jt.placar_fora
          ELSE jt.placar_casa
        END AS gols_sofridos_time,

        (COALESCE(jt.placar_casa, 0) + COALESCE(jt.placar_fora, 0)) AS gols_total_partida,

        jt.data_jogo,
        jt.id_jogo AS id_partida_interna,
        jt.flashscore_id_jogo,
        jt.flashscore_slug_liga,
        jt.flashscore_id_time_casa,
        jt.flashscore_id_time_fora,

        rg.gol_1_lado,
        rg.gol_2_lado,
        rg.gol_3_lado,
        rg.gol_4_lado,
        COALESCE(rg.qtd_gols_eventos, 0) AS qtd_gols_eventos

      FROM JogosTopContexto jt
      LEFT JOIN times tnome
        ON tnome.id = jt.id_time

      JOIN estatisticas_geral e
        ON e.flashscore_id_jogo = jt.flashscore_id_jogo
       AND e.id_time = jt.id_time
       AND e.eh_casa = jt.eh_casa

      JOIN estatisticas_geral adv
        ON adv.flashscore_id_jogo = jt.flashscore_id_jogo
       AND adv.id_time <> jt.id_time

      LEFT JOIN RoteiroGols rg
        ON rg.flashscore_id_jogo = jt.flashscore_id_jogo

      ORDER BY
        jt.id_time,
        jt.eh_casa DESC,
        jt.data_jogo DESC,
        jt.id_jogo DESC;
    `;

    const resHists = await client.query(queryMaster, [
      CONFIG.limiteJogosAncora,
      DATA_ALVO,
      DATA_MIN_HISTORICO,
    ]);

    if (resHists.rows.length === 0) {
      console.log('ℹ️ Sem dados vinculados suficientes.');
      await client.query('ROLLBACK');
      emTransacao = false;
      return;
    }

    const totalComGolEvento = resHists.rows.filter(r => r.gol_1_lado).length;

    console.log(
      `🧪 [ROTEIRO_GOLS] queryMaster trouxe ${totalComGolEvento}/${resHists.rows.length} linhas históricas com gol_1_lado.`
    );

    const timesMap = new Map();

    resHists.rows.forEach((r) => {
      const k = String(r.id_time);

      if (!timesMap.has(k)) {
        timesMap.set(k, {
          id_original: r.id_time,
          fs_id: r.flashscore_id_time,
          nome: r.nome_time,
          liga_alvo: r.liga_alvo,
          casa: [],
          fora: [],
          geral: [],
        });
      }

      timesMap.get(k)[r.mando].push(r);
      timesMap.get(k).geral.push(r);
    });

    let countSalvos = 0;

    const flashIdsProcessados = [...timesMap.values()]
      .map((t) => t.fs_id)
      .filter(Boolean);

    if (flashIdsProcessados.length > 0) {
      await client.query(
        `DELETE FROM rating_times WHERE flashscore_id_time = ANY($1::varchar[])`,
        [flashIdsProcessados]
      );
    }

    const queryInsert = `
      INSERT INTO rating_times (
        id_time, flashscore_id_time, nome_time,
        casa_amostra, casa_rating_ataque, casa_rating_defesa, casa_ewma_xg, casa_ewma_xga, casa_fator_mira, casa_perfil, casa_market_features, casa_anchor_ult5, casa_anchor_mercados,
        casa_dificuldade_defensiva_enfrentada, casa_forca_ofensiva_enfrentada, casa_qtd_adv_rating,
        fora_amostra, fora_rating_ataque, fora_rating_defesa, fora_ewma_xg, fora_ewma_xga, fora_fator_mira, fora_perfil, fora_market_features, fora_anchor_ult5, fora_anchor_mercados,
        anchor_mercados_geral_40,
        fora_dificuldade_defensiva_enfrentada, fora_forca_ofensiva_enfrentada, fora_qtd_adv_rating,
        atualizado_em
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16,
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
        $27,
        $28, $29, $30,
        CURRENT_TIMESTAMP
      );
    `;

    const cacheSnapshotsHistoricos = new Map();

    for (const [, dados] of timesMap.entries()) {
      const casaJogosHistorico = ordenarJogosRecentes(dados.casa)
        .slice(0, CONFIG.limiteJogosAncora);

      const foraJogosHistorico = ordenarJogosRecentes(dados.fora)
        .slice(0, CONFIG.limiteJogosAncora);

      const geralJogosHistorico = ordenarJogosRecentes(dados.geral)
        .slice(0, CONFIG.limiteJogosAncoraGeral);

      const casaJogosRating = casaJogosHistorico
        .slice(0, CONFIG.limiteJogosRating);

      const foraJogosRating = foraJogosHistorico
        .slice(0, CONFIG.limiteJogosRating);

      const casaJogosAncora = casaJogosHistorico;
      const foraJogosAncora = foraJogosHistorico;

      const statsCBase = processarRatingMando(casaJogosRating);
      const statsFBase = processarRatingMando(foraJogosRating);

      if (
        Number(statsCBase.amostra) < 10 ||
        Number(statsFBase.amostra) < 10
      ) {
        continue;
      }

      const fatoresCasa = await calcularFatoresQualidadeAdversariosMando(
        client,
        casaJogosRating,
        cacheSnapshotsHistoricos
      );

      const fatoresFora = await calcularFatoresQualidadeAdversariosMando(
        client,
        foraJogosRating,
        cacheSnapshotsHistoricos
      );

      const statsC = aplicarAjusteQualidadeAdversarioNoRating(
        statsCBase,
        fatoresCasa
      );

      const statsF = aplicarAjusteQualidadeAdversarioNoRating(
        statsFBase,
        fatoresFora
      );

      const perfilCasa = calcularPerfilResidualMandoUnificado(casaJogosRating);
      const perfilFora = calcularPerfilResidualMandoUnificado(foraJogosRating);

      const featuresCasa = calcularFeaturesMercadoMandoUnificadas(casaJogosRating);
      const featuresFora = calcularFeaturesMercadoMandoUnificadas(foraJogosRating);

      const anchorCasa = calcularAncoraUlt12DoRating(casaJogosRating);
      const anchorFora = calcularAncoraUlt12DoRating(foraJogosRating);

      const anchorMercadosCasaBase = await calcularAncoraMercadosMando(
        client,
        casaJogosAncora,
        cacheSnapshotsHistoricos
      );

      const anchorMercadosForaBase = await calcularAncoraMercadosMando(
        client,
        foraJogosAncora,
        cacheSnapshotsHistoricos
      );

      const anchorMercadosGeral40Base = await calcularAncoraMercadosMando(
        client,
        geralJogosHistorico,
        cacheSnapshotsHistoricos
      );

      const roteiroGolsCasa = calcularRoteiroGolsEventosAncora(casaJogosAncora);
      const roteiroGolsFora = calcularRoteiroGolsEventosAncora(foraJogosAncora);
      const roteiroGolsGeral40 = calcularRoteiroGolsEventosAncora(geralJogosHistorico);

      const anchorMercadosCasaFinal = {
        ...anchorMercadosCasaBase,
        roteiro_gols: roteiroGolsCasa,
      };

      const anchorMercadosForaFinal = {
        ...anchorMercadosForaBase,
        roteiro_gols: roteiroGolsFora,
      };

      const anchorMercadosGeral40Final = {
        ...anchorMercadosGeral40Base,
        roteiro_gols: roteiroGolsGeral40,
      };

      if (
        !anchorMercadosCasaFinal.roteiro_gols ||
        !anchorMercadosForaFinal.roteiro_gols ||
        !anchorMercadosGeral40Final.roteiro_gols
      ) {
        throw new Error(`roteiro_gols não foi montado para o time ${dados.nome}`);
      }

      console.log(
        `🧪 [ROTEIRO_GOLS] ${dados.nome} | casa=${roteiroGolsCasa.sample_com_roteiro_gol_raw || 0}/${roteiroGolsCasa.sample_raw || 0} | fora=${roteiroGolsFora.sample_com_roteiro_gol_raw || 0}/${roteiroGolsFora.sample_raw || 0} | geral=${roteiroGolsGeral40.sample_com_roteiro_gol_raw || 0}/${roteiroGolsGeral40.sample_raw || 0}`
      );

      await client.query(queryInsert, [
        dados.id_original,
        dados.fs_id,
        dados.nome,

        statsC.amostra,
        statsC.ataque,
        statsC.defesa,
        statsC.ewmaXg,
        statsC.ewmaXga,
        statsC.fatorMira,
        JSON.stringify(perfilCasa),
        JSON.stringify(featuresCasa),
        JSON.stringify(anchorCasa),
        JSON.stringify(anchorMercadosCasaFinal),

        fatoresCasa.fator_qualidade_adv_ataque,
        fatoresCasa.fator_qualidade_adv_defesa,
        fatoresCasa.qtd_adv_rating,

        statsF.amostra,
        statsF.ataque,
        statsF.defesa,
        statsF.ewmaXg,
        statsF.ewmaXga,
        statsF.fatorMira,
        JSON.stringify(perfilFora),
        JSON.stringify(featuresFora),
        JSON.stringify(anchorFora),
        JSON.stringify(anchorMercadosForaFinal),

        JSON.stringify(anchorMercadosGeral40Final),

        fatoresFora.fator_qualidade_adv_ataque,
        fatoresFora.fator_qualidade_adv_defesa,
        fatoresFora.qtd_adv_rating,
      ]);

      countSalvos++;
    }

    const queryAuditoria = `
      INSERT INTO auditoria_metricas_detalhada (
        flashscore_id, data_jogo, id_time, nome_time, tipo, xg, xga, xgot, flashscore_slug_liga
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (flashscore_id, id_time) DO NOTHING;
    `;

    const jogosOrdenados = [...resHists.rows].sort((a, b) => {
      if (a.id_time !== b.id_time) return a.id_time - b.id_time;
      if (a.mando !== b.mando) return a.mando.localeCompare(b.mando);
      return new Date(b.data_jogo) - new Date(a.data_jogo);
    });

    let countAuditoria = 0;

    for (const jogo of jogosOrdenados) {
      await client.query(queryAuditoria, [
        jogo.flashscore_id_jogo,
        jogo.data_jogo,
        jogo.id_time,
        jogo.nome_time,
        jogo.mando,
        jogo.xg,
        jogo.xga,
        jogo.xgot,
        jogo.flashscore_slug_liga,
      ]);

      countAuditoria++;
    }

    await client.query('COMMIT');
    emTransacao = false;

    console.log(
      `✅ [AUDITORIA] ${countAuditoria} métricas salvas ordenadas por time!`
    );

    console.log(
      `✅ [SUCESSO] ${countSalvos} times atualizados com histórico por mesma liga + mando + anchor_mercados_geral_40 + roteiro_gols.`
    );
  } catch (e) {
    if (emTransacao) {
      await client.query('ROLLBACK').catch(() => { });
    }

    console.error('❌ Erro fatal:', e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

runETL();