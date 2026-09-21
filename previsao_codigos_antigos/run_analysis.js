const { pegaJogosDoDia, closeDb: closeDbGols } = require('./db_gols');
const { analyzeTeamGolsFromFiltered } = require('../markets/team_goals');
const { criarPool } = require('../../db'); // Lembre de ajustar o ../ de acordo com a pasta do arquivo

const pool = criarPool('modelo', { 
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function oddFromPercent(probPercent) {
  const p = toNum(probPercent, 0);
  return p > 0 ? +(100 / p).toFixed(2) : 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function buildPerfilEdge(previsao, perfilContexto) {
  const over25Ctx = perfilContexto?.leitura_mercado?.over25_contexto || 'NEUTRO';
  const bttsCtx = perfilContexto?.leitura_mercado?.btts_contexto || 'NEUTRO';

  const rawOver25 = toNum(previsao?.over_2_5_prob, 0);
  const rawBTTS = toNum(previsao?.btts_prob, 0);

  let edgeOver25 = 0;
  let edgeBTTS = 0;

  switch (over25Ctx) {
    case 'ALERTA_ESTERIL_DUPLO':
      edgeOver25 = -8;
      break;
    case 'ALERTA_ESTERIL':
      edgeOver25 = -4;
      break;
    case 'FAVORAVEL_DUPLA_TRANSICAO':
      edgeOver25 = +5;
      break;
    case 'FAVORAVEL_TRANSICAO':
      edgeOver25 = +2;
      break;
    default:
      edgeOver25 = 0;
      break;
  }

  if (rawOver25 < 40 && edgeOver25 > 0) edgeOver25 = Math.min(edgeOver25, 2);
  if (rawOver25 > 65 && edgeOver25 < 0) edgeOver25 = Math.max(edgeOver25, -2);

  switch (bttsCtx) {
    case 'ALERTA_ESTERIL':
      edgeBTTS = -6;
      break;
    case 'FAVORAVEL_DUPLA_TRANSICAO':
      edgeBTTS = +4;
      break;
    case 'CASA_AGRIDE':
    case 'FORA_AGRIDE':
      edgeBTTS = +1;
      break;
    default:
      edgeBTTS = 0;
      break;
  }

  if (rawBTTS < 40 && edgeBTTS > 0) edgeBTTS = Math.min(edgeBTTS, 1);
  if (rawBTTS > 65 && edgeBTTS < 0) edgeBTTS = Math.max(edgeBTTS, -2);

  const sugestaoOver25 =
    edgeOver25 <= -6 ? 'BLOQUEAR' :
      edgeOver25 < 0 ? 'REDUZIR' :
        edgeOver25 >= 5 ? 'REFORCAR' :
          edgeOver25 > 0 ? 'OBSERVAR_POSITIVO' :
            'NEUTRO';

  const sugestaoBTTS =
    edgeBTTS <= -5 ? 'BLOQUEAR' :
      edgeBTTS < 0 ? 'REDUZIR' :
        edgeBTTS >= 4 ? 'REFORCAR' :
          edgeBTTS > 0 ? 'OBSERVAR_POSITIVO' :
            'NEUTRO';

  return {
    edge_over25: clamp(edgeOver25, -10, 10),
    edge_btts: clamp(edgeBTTS, -10, 10),
    sugestao_over25: sugestaoOver25,
    sugestao_btts: sugestaoBTTS,
    over25_contexto: over25Ctx,
    btts_contexto: bttsCtx,
  };
}

function applyEdgeToScore(rawProb, edge, sugestao) {
  const baseScore = Math.round(toNum(rawProb, 0));

  if (sugestao === 'BLOQUEAR') {
    return 0;
  }

  return Math.round(clamp(baseScore + toNum(edge, 0), 0, 100));
}
function pickValue(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
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
  /*
    Essa função prepara os campos da âncora para salvar em analises_jogos.

    Importante:
    - NÃO pode reconstruir/capar o JSON da âncora.
    - Deve salvar o anchor inteiro, incluindo os campos novos:
        residual_score
        residual_ajustado_medio
        residual_ajustado_score
        evidencia_produtiva_media
        detalhes[].evidencia_produtiva
        detalhes[].residual_ajustado
        detalhes[].qualidade_evidencia

    Se esses campos não aparecerem no log, então o problema não é o INSERT:
    é que a função que calcula a âncora ainda está retornando o objeto antigo.
  */

  function isObj(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
  }

  function cloneJson(v) {
    if (!v) return null;

    try {
      return JSON.parse(JSON.stringify(v));
    } catch (err) {
      console.warn('⚠️ Não consegui clonar telemetria_anchor:', err.message);
      return v;
    }
  }

  function getPath(obj, path) {
    let cur = obj;

    for (const key of path) {
      if (!isObj(cur) && !Array.isArray(cur)) return undefined;
      cur = cur?.[key];
    }

    return cur;
  }

  function listKeys(obj) {
    if (!isObj(obj)) return [];
    return Object.keys(obj).sort();
  }

  function hasProdutivaFields(lado) {
    if (!isObj(lado)) {
      return false;
    }

    return (
      lado.evidencia_produtiva_media !== undefined ||
      lado.residual_ajustado_medio !== undefined ||
      lado.residual_ajustado_score !== undefined ||
      lado.residual_score !== undefined
    );
  }

  function hasDetalhesProdutivos(lado) {
    const detalhes = Array.isArray(lado?.detalhes) ? lado.detalhes : [];

    return detalhes.some((d) => (
      d &&
      typeof d === 'object' &&
      (
        d.evidencia_produtiva !== undefined ||
        d.residual_ajustado !== undefined ||
        d.qualidade_evidencia !== undefined
      )
    ));
  }

  function diagnosticarAnchorProdutiva(anchor) {
    const mercados = anchor?.contextual?.mercados || {};
    const mercadosBase = ['over15', 'over25', 'over35', 'btts_sim'];

    const diagnostico = {};

    for (const mercado of mercadosBase) {
      const m = mercados?.[mercado] || {};
      const ladoCasa = m?.lado_casa || {};
      const ladoFora = m?.lado_fora || {};

      diagnostico[mercado] = {
        lado_casa_keys: listKeys(ladoCasa),
        lado_fora_keys: listKeys(ladoFora),

        lado_casa_tem_produtiva: hasProdutivaFields(ladoCasa),
        lado_fora_tem_produtiva: hasProdutivaFields(ladoFora),

        lado_casa_detalhes_tem_produtiva: hasDetalhesProdutivos(ladoCasa),
        lado_fora_detalhes_tem_produtiva: hasDetalhesProdutivos(ladoFora),

        lado_casa_evidencia_produtiva_media: ladoCasa?.evidencia_produtiva_media ?? null,
        lado_fora_evidencia_produtiva_media: ladoFora?.evidencia_produtiva_media ?? null,

        lado_casa_residual_ajustado_medio: ladoCasa?.residual_ajustado_medio ?? null,
        lado_fora_residual_ajustado_medio: ladoFora?.residual_ajustado_medio ?? null,

        lado_casa_residual_ajustado_score: ladoCasa?.residual_ajustado_score ?? null,
        lado_fora_residual_ajustado_score: ladoFora?.residual_ajustado_score ?? null,
      };
    }

    return diagnostico;
  }

  /*
    Caminhos possíveis.
    O caminho principal do seu arquivo atual é:
      resultadoAnalise.telemetria.anchor_mercados_aplicacao

    Mas deixei fallback para evitar perder caso outro módulo retorne em outro lugar.
  */
  const anchorOriginal =
    resultadoAnalise?.telemetria?.anchor_mercados_aplicacao ||
    resultadoAnalise?.anchor_mercados_aplicacao ||
    resultadoAnalise?.anchorMercadosAplicacao ||
    resultadoAnalise?.telemetria_anchor ||
    resultadoAnalise?.telemetria?.telemetria_anchor ||
    null;

  const anchor = cloneJson(anchorOriginal);

  if (!anchor || !isObj(anchor)) {
    console.warn('⚠️ Sem anchor_mercados_aplicacao válido em resultadoAnalise.');

    return {
      anchor_tipo: null,

      anchor_delta_over15: null,
      anchor_delta_over25: null,
      anchor_delta_over35: null,
      anchor_delta_btts: null,

      anchor_hist_casa_qtd: null,
      anchor_hist_fora_qtd: null,

      anchor_over25_motivo: null,
      anchor_btts_motivo: null,
      anchor_under35_motivo: null,

      telemetria_anchor: null,
    };
  }

  const contextual = anchor?.contextual || {};
  const mercados = contextual?.mercados || {};
  const historico = contextual?.historico || {};
  const deltas = anchor?.deltas || {};

  const diagProdutiva = diagnosticarAnchorProdutiva(anchor);

  /*
    Salva o diagnóstico dentro do próprio JSON para facilitar auditoria.
    Isso não muda cálculo nenhum; só deixa explícito se a versão produtiva veio.
  */
  anchor._debug_anchor_produtiva_insert = {
    gerado_em: new Date().toISOString(),
    tem_over25_lado_casa_produtiva: !!diagProdutiva?.over25?.lado_casa_tem_produtiva,
    tem_over25_lado_fora_produtiva: !!diagProdutiva?.over25?.lado_fora_tem_produtiva,
    tem_over25_detalhes_casa_produtivos: !!diagProdutiva?.over25?.lado_casa_detalhes_tem_produtiva,
    tem_over25_detalhes_fora_produtivos: !!diagProdutiva?.over25?.lado_fora_detalhes_tem_produtiva,
    diagnostico_mercados: diagProdutiva,
  };

  const over25CasaProd = diagProdutiva?.over25?.lado_casa_tem_produtiva;
  const over25ForaProd = diagProdutiva?.over25?.lado_fora_tem_produtiva;
  const over25CasaDet = diagProdutiva?.over25?.lado_casa_detalhes_tem_produtiva;
  const over25ForaDet = diagProdutiva?.over25?.lado_fora_detalhes_tem_produtiva;

  if (!over25CasaProd && !over25ForaProd && !over25CasaDet && !over25ForaDet) {
    console.warn(
      '⚠️ [ANCHOR PRODUTIVA NÃO ENCONTRADA] over25 veio sem evidencia_produtiva/residual_ajustado. ' +
      'O INSERT vai salvar o JSON, mas o cálculo da âncora parece ainda ser o antigo.'
    );

    console.warn('   over25 lado_casa keys:', diagProdutiva?.over25?.lado_casa_keys);
    console.warn('   over25 lado_fora keys:', diagProdutiva?.over25?.lado_fora_keys);
  } else {
    console.log(
      '✅ [ANCHOR PRODUTIVA OK] over25 contém campos produtivos:',
      {
        casa_agregado: over25CasaProd,
        fora_agregado: over25ForaProd,
        casa_detalhes: over25CasaDet,
        fora_detalhes: over25ForaDet,
      }
    );
  }

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
    anchor_under35_motivo: strOrNull(
      mercados?.over35?.combinado?.motivo
    ),

    /*
      Salva o anchor inteiro.
      Se os campos novos existirem em lado_casa/lado_fora/detalhes,
      eles serão preservados aqui.
    */
    telemetria_anchor: JSON.stringify(anchor),
  };
}

// =========================================================
// FILTRO OPERACIONAL VALIDADO — AUDITORIA 1500 JOGOS
// =========================================================

const FILTRO_OPERACIONAL_VERSAO = 'v1_auditoria_1500';

function roundFiltro(v, casas = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(casas));
}

function getPathFiltro(obj, path, fallback = null) {
  let cur = obj; 

  for (const key of path) {
    if (cur === null || cur === undefined) return fallback;
    cur = cur[key];
  }

  return cur === undefined ? fallback : cur;
}

function numFiltro(v, fallback = null) {
  if (v === null || v === undefined || v === '') return fallback;

  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

/*
  Na auditoria, os rates da âncora podiam vir como:
  0.436  => 43.6%
  43.6   => 43.6%

  Essa função normaliza para porcentagem.
*/
function pctFiltro(v, fallback = null) {
  const n = numFiltro(v, fallback);

  if (n === null || n === undefined) return fallback;

  if (n >= 0 && n <= 1) {
    return n * 100;
  }

  return n;
}

function poissonFiltro(lambda, k) {
  const l = Math.max(0, numFiltro(lambda, 0));
  const kk = Math.max(0, Math.trunc(numFiltro(k, 0)));

  let fat = 1;
  for (let i = 2; i <= kk; i++) fat *= i;

  return Math.exp(-l) * Math.pow(l, kk) / fat;
}

/*
  Lambda puro usado pelo filtro.
  Isso NÃO é a probabilidade final do robô.
  É a confirmação matemática limpa usando l_home/l_away.
*/
function calcularLambdaPuroFiltro(lHome, lAway) {
  const lh = Math.max(0, numFiltro(lHome, 0));
  const la = Math.max(0, numFiltro(lAway, 0));
  const total = lh + la;

  const p0 = poissonFiltro(total, 0);
  const p1 = poissonFiltro(total, 1);
  const p2 = poissonFiltro(total, 2);
  const p3 = poissonFiltro(total, 3);

  const under15 = (p0 + p1) * 100;
  const over15 = 100 - under15;

  const under25 = (p0 + p1 + p2) * 100;
  const over25 = 100 - under25;

  const under35 = (p0 + p1 + p2 + p3) * 100;
  const over35 = 100 - under35;

  const bttsSim =
    (1 - Math.exp(-lh) - Math.exp(-la) + Math.exp(-(lh + la))) * 100;

  const bttsNao = 100 - bttsSim;

  let pCasa = 0;
  let pEmpate = 0;
  let pFora = 0;
  let soma = 0;

  const LIMITE = 10;

  for (let h = 0; h <= LIMITE; h++) {
    const ph = poissonFiltro(lh, h);

    for (let a = 0; a <= LIMITE; a++) {
      const pa = poissonFiltro(la, a);
      const p = ph * pa;

      soma += p;

      if (h > a) pCasa += p;
      else if (h === a) pEmpate += p;
      else pFora += p;
    }
  }

  if (soma > 0) {
    pCasa = pCasa / soma;
    pEmpate = pEmpate / soma;
    pFora = pFora / soma;
  }

  return {
    l_home: roundFiltro(lh, 3),
    l_away: roundFiltro(la, 3),
    total_lambda: roundFiltro(total, 3),

    over15: roundFiltro(over15),
    under15: roundFiltro(under15),

    over25: roundFiltro(over25),
    under25: roundFiltro(under25),

    over35: roundFiltro(over35),
    under35: roundFiltro(under35),

    btts_sim: roundFiltro(bttsSim),
    btts_nao: roundFiltro(bttsNao),

    casa: roundFiltro(pCasa * 100),
    empate: roundFiltro(pEmpate * 100),
    fora: roundFiltro(pFora * 100),
  };
}

/*
  Extrai do telemetria_anchor os mesmos campos que a auditoria usou:
  - mercados_rating_batalhas.*_rate
  - resumo.xg_*_anchor
  - blocos de ataque/xGA para calcular sinal_gol_casa e sinal_gol_fora
*/
function extrairMetricasFiltroOperacional({ previsao, telemetria, finalScores, lHome, lAway }) {
  const anchor =
    telemetria?.anchor_mercados_aplicacao ||
    telemetria?.telemetria_anchor ||
    telemetria?.anchor ||
    null;

  const contextual = anchor?.contextual || {};
  const rates = contextual?.mercados_rating_batalhas || {};
  const resumo = contextual?.resumo || {};
  const blocos = contextual?.blocos || {};

  const lambda = calcularLambdaPuroFiltro(lHome, lAway);

  const over15Rate = pctFiltro(
    rates?.over15_rate,
    numFiltro(finalScores?.scoreOver15, numFiltro(previsao?.over_1_5_prob, null))
  );

  const over25Rate = pctFiltro(
    rates?.over25_rate,
    numFiltro(finalScores?.scoreOver25, numFiltro(previsao?.over_2_5_prob, null))
  );

  const under25Rate = pctFiltro(
    rates?.under25_rate,
    100 - numFiltro(over25Rate, numFiltro(finalScores?.scoreOver25, 0))
  );

  const over35Rate = pctFiltro(
    rates?.over35_rate,
    numFiltro(finalScores?.scoreOver35, numFiltro(previsao?.over_3_5_prob, null))
  );

  const under35Rate = pctFiltro(
    rates?.under35_rate,
    100 - numFiltro(over35Rate, numFiltro(finalScores?.scoreOver35, 0))
  );

  const bttsSimRate = pctFiltro(
    rates?.btts_sim_rate,
    numFiltro(finalScores?.scoreBttsSim, numFiltro(previsao?.btts_prob, null))
  );

  const xgCasaAnchor = numFiltro(resumo?.xg_casa_anchor, 0);
  const xgForaAnchor = numFiltro(resumo?.xg_fora_anchor, 0);
  const xgTotalAnchor = numFiltro(resumo?.xg_total_anchor, xgCasaAnchor + xgForaAnchor);

  const minXgLado = Math.min(xgCasaAnchor, xgForaAnchor);
  const maxXgLado = Math.max(xgCasaAnchor, xgForaAnchor);

  const casaAtaqueXg = numFiltro(
    getPathFiltro(blocos, ['ataque_casa_vs_defesa_fora', 'xg_ponderado']),
    0
  );

  const foraXgaVsCasaXg = numFiltro(
    getPathFiltro(blocos, ['defesa_fora_vs_ataque_casa', 'xg_ponderado']),
    0
  );

  const foraAtaqueXg = numFiltro(
    getPathFiltro(blocos, ['ataque_fora_vs_defesa_casa', 'xg_ponderado']),
    0
  );

  const casaXgaVsForaXg = numFiltro(
    getPathFiltro(blocos, ['defesa_casa_vs_ataque_fora', 'xg_ponderado']),
    0
  );

  /*
    Igual à auditoria:
    sinal_gol_casa = min(casa_ataque_xg, fora_xga_vs_casa_xg)
    sinal_gol_fora = min(fora_ataque_xg, casa_xga_vs_fora_xg)
  */
  const sinalGolCasa = Math.min(casaAtaqueXg, foraXgaVsCasaXg);
  const sinalGolFora = Math.min(foraAtaqueXg, casaXgaVsForaXg);

  const minSinalGol = Math.min(sinalGolCasa, sinalGolFora);
  const maxSinalGol = Math.max(sinalGolCasa, sinalGolFora);

  const vantagemXgCasa = xgCasaAnchor - xgForaAnchor;
  const vantagemSinalCasa = sinalGolCasa - sinalGolFora;
  const vantagemLambdaCasa = numFiltro(lHome, 0) - numFiltro(lAway, 0);

  const vantagemXgFora = xgForaAnchor - xgCasaAnchor;
  const vantagemSinalFora = sinalGolFora - sinalGolCasa;
  const vantagemLambdaFora = numFiltro(lAway, 0) - numFiltro(lHome, 0);

  return {
    lambda,

    rates: {
      over15_rate: roundFiltro(over15Rate),
      over25_rate: roundFiltro(over25Rate),
      under25_rate: roundFiltro(under25Rate),
      over35_rate: roundFiltro(over35Rate),
      under35_rate: roundFiltro(under35Rate),
      btts_sim_rate: roundFiltro(bttsSimRate),
    },

    xg: {
      xg_casa_anchor: roundFiltro(xgCasaAnchor, 3),
      xg_fora_anchor: roundFiltro(xgForaAnchor, 3),
      xg_total_anchor: roundFiltro(xgTotalAnchor, 3),
      min_xg_lado: roundFiltro(minXgLado, 3),
      max_xg_lado: roundFiltro(maxXgLado, 3),
    },

    sinal: {
      casa_ataque_xg: roundFiltro(casaAtaqueXg, 3),
      fora_xga_vs_casa_xg: roundFiltro(foraXgaVsCasaXg, 3),
      fora_ataque_xg: roundFiltro(foraAtaqueXg, 3),
      casa_xga_vs_fora_xg: roundFiltro(casaXgaVsForaXg, 3),

      sinal_gol_casa: roundFiltro(sinalGolCasa, 3),
      sinal_gol_fora: roundFiltro(sinalGolFora, 3),
      min_sinal_gol: roundFiltro(minSinalGol, 3),
      max_sinal_gol: roundFiltro(maxSinalGol, 3),
    },

    x12: {
      p_casa: roundFiltro(numFiltro(previsao?.win_home_prob, finalScores?.score1x2 ?? null)),
      p_fora: roundFiltro(numFiltro(previsao?.win_away_prob, null)),

      vantagem_xg_casa: roundFiltro(vantagemXgCasa, 3),
      vantagem_sinal_casa: roundFiltro(vantagemSinalCasa, 3),
      vantagem_lambda_casa: roundFiltro(vantagemLambdaCasa, 3),

      vantagem_xg_fora: roundFiltro(vantagemXgFora, 3),
      vantagem_sinal_fora: roundFiltro(vantagemSinalFora, 3),
      vantagem_lambda_fora: roundFiltro(vantagemLambdaFora, 3),
    },

    debug: {
      anchor_encontrado: !!anchor,
      contextual_tipo: contextual?.tipo || null,
    },
  };
}

function avaliarPilarFiltro({ nome, valor, corte, tipo, escala = 1 }) {
  const v = numFiltro(valor, null);
  const c = numFiltro(corte, null);

  if (v === null || c === null) {
    return {
      nome,
      valor: v,
      corte: c,
      tipo,
      passou: false,
      folga: 0,
      motivo: 'valor_ausente',
    };
  }

  let passou = false;
  let folga = 0;

  if (tipo === 'min') {
    passou = v >= c;
    folga = (v - c) / Math.max(escala, 0.0001);
  } else {
    passou = v <= c;
    folga = (c - v) / Math.max(escala, 0.0001);
  }

  folga = clamp(folga, 0, 1);

  return {
    nome,
    valor: roundFiltro(v, 3),
    corte: c,
    tipo,
    passou,
    folga: roundFiltro(folga, 4),
    motivo: passou ? 'ok' : 'nao_bateu_corte',
  };
}

function classificarFiltroPassou(pilares) {
  const folgas = pilares.map(p => numFiltro(p.folga, 0));
  const mediaFolga = folgas.length
    ? folgas.reduce((a, b) => a + b, 0) / folgas.length
    : 0;

  if (mediaFolga >= 0.70) {
    return {
      nivel: 'PREMIUM',
      decisao: 'ENTRADA_PREMIUM',
      forca: roundFiltro(mediaFolga, 4),
    };
  }

  if (mediaFolga >= 0.30) {
    return {
      nivel: 'FORTE',
      decisao: 'ENTRADA_FORTE',
      forca: roundFiltro(mediaFolga, 4),
    };
  }

  return {
    nivel: 'VALIDADO',
    decisao: 'ENTRADA_VALIDADA',
    forca: roundFiltro(mediaFolga, 4),
  };
}

function avaliarFiltroMercado({ mercado, status, pilares }) {
  const passou = pilares.every(p => p.passou);

  if (!passou) {
    return {
      mercado,
      status,
      passou: false,
      nivel: 'BLOQUEADO',
      decisao: 'BLOQUEADO_FILTRO',
      forca: 0,
      pilares,
    };
  }

  const cls = classificarFiltroPassou(pilares);

  return {
    mercado,
    status,
    passou: true,
    nivel: cls.nivel,
    decisao: cls.decisao,
    forca: cls.forca,
    pilares,
  };
}

function aplicarFiltrosOperacionaisValidados({ previsao, telemetria, finalScores, lHome, lAway }) {
  const m = extrairMetricasFiltroOperacional({
    previsao,
    telemetria,
    finalScores,
    lHome,
    lAway,
  });

  const filtros = {};

  filtros.over15 = avaliarFiltroMercado({
    mercado: 'OVER15',
    status: 'APROVADO_FORTE',
    pilares: [
      avaliarPilarFiltro({ nome: 'over15_rate', valor: m.rates.over15_rate, corte: 60, tipo: 'min', escala: 20 }),
      avaliarPilarFiltro({ nome: 'lambda_over15', valor: m.lambda.over15, corte: 65, tipo: 'min', escala: 20 }),
      avaliarPilarFiltro({ nome: 'xg_total_anchor', valor: m.xg.xg_total_anchor, corte: 1.4, tipo: 'min', escala: 1.2 }),
      avaliarPilarFiltro({ nome: 'max_sinal_gol', valor: m.sinal.max_sinal_gol, corte: 0.8, tipo: 'min', escala: 1.0 }),
    ],
  });

  filtros.over25 = avaliarFiltroMercado({
    mercado: 'OVER25',
    status: 'APROVADO_FORTE',
    pilares: [
      avaliarPilarFiltro({ nome: 'over25_rate', valor: m.rates.over25_rate, corte: 40, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'lambda_over25', valor: m.lambda.over25, corte: 50, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'xg_total_anchor', valor: m.xg.xg_total_anchor, corte: 2.6, tipo: 'min', escala: 1.0 }),
      avaliarPilarFiltro({ nome: 'min_xg_lado', valor: m.xg.min_xg_lado, corte: 0.8, tipo: 'min', escala: 0.7 }),
      avaliarPilarFiltro({ nome: 'min_sinal_gol', valor: m.sinal.min_sinal_gol, corte: 0.5, tipo: 'min', escala: 0.6 }),
      avaliarPilarFiltro({ nome: 'max_sinal_gol', valor: m.sinal.max_sinal_gol, corte: 1.3, tipo: 'min', escala: 0.8 }),
    ],
  });

  filtros.under25 = avaliarFiltroMercado({
    mercado: 'UNDER25',
    status: 'APROVADO_MODERADO',
    pilares: [
      avaliarPilarFiltro({ nome: 'under25_rate', valor: m.rates.under25_rate, corte: 45, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'lambda_under25', valor: m.lambda.under25, corte: 50, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'xg_total_anchor', valor: m.xg.xg_total_anchor, corte: 2.4, tipo: 'max', escala: 1.0 }),
      avaliarPilarFiltro({ nome: 'max_xg_lado', valor: m.xg.max_xg_lado, corte: 2.0, tipo: 'max', escala: 0.8 }),
      avaliarPilarFiltro({ nome: 'max_sinal_gol', valor: m.sinal.max_sinal_gol, corte: 1.8, tipo: 'max', escala: 0.8 }),
    ],
  });

  filtros.under35 = avaliarFiltroMercado({
    mercado: 'UNDER35',
    status: 'APROVADO_FORTE',
    pilares: [
      avaliarPilarFiltro({ nome: 'under35_rate', valor: m.rates.under35_rate, corte: 55, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'lambda_under35', valor: m.lambda.under35, corte: 60, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'xg_total_anchor', valor: m.xg.xg_total_anchor, corte: 3.3, tipo: 'max', escala: 1.2 }),
      avaliarPilarFiltro({ nome: 'max_sinal_gol', valor: m.sinal.max_sinal_gol, corte: 1.8, tipo: 'max', escala: 0.9 }),
    ],
  });

  filtros.btts_sim = avaliarFiltroMercado({
    mercado: 'BTTS_SIM',
    status: 'APROVADO_MODERADO',
    pilares: [
      avaliarPilarFiltro({ nome: 'btts_sim_rate', valor: m.rates.btts_sim_rate, corte: 50, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'lambda_btts_sim', valor: m.lambda.btts_sim, corte: 40, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'xg_total_anchor', valor: m.xg.xg_total_anchor, corte: 1.8, tipo: 'min', escala: 1.2 }),
      avaliarPilarFiltro({ nome: 'min_xg_lado', valor: m.xg.min_xg_lado, corte: 0.8, tipo: 'min', escala: 0.7 }),
      avaliarPilarFiltro({ nome: 'min_sinal_gol', valor: m.sinal.min_sinal_gol, corte: 0.6, tipo: 'min', escala: 0.6 }),
    ],
  });

  filtros.casa = avaliarFiltroMercado({
    mercado: '1X2_CASA',
    status: 'APROVADO_FORTE',
    pilares: [
      avaliarPilarFiltro({ nome: 'p_casa', valor: m.x12.p_casa, corte: 35, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'lambda_p_casa', valor: m.lambda.casa, corte: 35, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'vantagem_xg_casa', valor: m.x12.vantagem_xg_casa, corte: 0.6, tipo: 'min', escala: 0.8 }),
      avaliarPilarFiltro({ nome: 'vantagem_sinal_casa', valor: m.x12.vantagem_sinal_casa, corte: 0.1, tipo: 'min', escala: 0.8 }),
      avaliarPilarFiltro({ nome: 'vantagem_lambda_casa', valor: m.x12.vantagem_lambda_casa, corte: 0.0, tipo: 'min', escala: 0.8 }),
    ],
  });

  filtros.fora = avaliarFiltroMercado({
    mercado: '1X2_FORA',
    status: 'APROVADO_FORTE',
    pilares: [
      avaliarPilarFiltro({ nome: 'p_fora', valor: m.x12.p_fora, corte: 35, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'lambda_p_fora', valor: m.lambda.fora, corte: 35, tipo: 'min', escala: 25 }),
      avaliarPilarFiltro({ nome: 'vantagem_xg_fora', valor: m.x12.vantagem_xg_fora, corte: 0.4, tipo: 'min', escala: 0.8 }),
      avaliarPilarFiltro({ nome: 'vantagem_sinal_fora', valor: m.x12.vantagem_sinal_fora, corte: 0.4, tipo: 'min', escala: 0.8 }),
      avaliarPilarFiltro({ nome: 'vantagem_lambda_fora', valor: m.x12.vantagem_lambda_fora, corte: 0.1, tipo: 'min', escala: 0.8 }),
    ],
  });

  const bloqueados = {
    under15: {
      mercado: 'UNDER15',
      passou: false,
      nivel: 'BLOQUEADO',
      decisao: 'BLOQUEADO_MERCADO_REPROVADO',
      motivo: 'Under 1.5 reprovado na auditoria 1500 jogos',
    },
    over35: {
      mercado: 'OVER35',
      passou: false,
      nivel: 'BLOQUEADO',
      decisao: 'BLOQUEADO_MERCADO_REPROVADO',
      motivo: 'Over 3.5 reprovado na auditoria 1500 jogos',
    },
    btts_nao: {
      mercado: 'BTTS_NAO',
      passou: false,
      nivel: 'BLOQUEADO',
      decisao: 'BLOQUEADO_MERCADO_REPROVADO',
      motivo: 'BTTS Não reprovado na auditoria 1500 jogos',
    },
    empate: {
      mercado: '1X2_EMPATE',
      passou: false,
      nivel: 'BLOQUEADO',
      decisao: 'BLOQUEADO_MERCADO_SEM_FILTRO_APROVADO',
      motivo: 'Empate não teve filtro operacional aprovado',
    },
  };

  const principal = escolherMercadoPrincipalFiltro(filtros);

  return {
    versao: FILTRO_OPERACIONAL_VERSAO,
    gerado_em: new Date().toISOString(),
    metricas: m,
    filtros,
    bloqueados,
    principal,
  };
}

function pesoNivelFiltro(nivel) {
  if (nivel === 'PREMIUM') return 4;
  if (nivel === 'FORTE') return 3;
  if (nivel === 'VALIDADO') return 2;
  return 0;
}

function melhorEntreFiltros(a, b) {
  if (!a?.passou && !b?.passou) return null;
  if (a?.passou && !b?.passou) return a;
  if (!a?.passou && b?.passou) return b;

  const pa = pesoNivelFiltro(a.nivel);
  const pb = pesoNivelFiltro(b.nivel);

  if (pa > pb) return a;
  if (pb > pa) return b;

  const fa = numFiltro(a.forca, 0);
  const fb = numFiltro(b.forca, 0);

  if (fa >= fb) return a;
  return b;
}

function escolherMercadoPrincipalFiltro(filtros) {
  const candidatos = [
    filtros.over15,
    filtros.under35,
    filtros.over25,
    filtros.casa,
    filtros.fora,
    filtros.btts_sim,
    filtros.under25,
  ].filter(f => f?.passou);

  if (!candidatos.length) {
    return {
      mercado: 'NO BET',
      nivel: 'BLOQUEADO',
      decisao: 'SEM_MERCADO_VALIDADO',
      forca: 0,
    };
  }

  candidatos.sort((a, b) => {
    const pb = pesoNivelFiltro(b.nivel);
    const pa = pesoNivelFiltro(a.nivel);

    if (pb !== pa) return pb - pa;

    return numFiltro(b.forca, 0) - numFiltro(a.forca, 0);
  });

  const melhor = candidatos[0];

  return {
    mercado: melhor.mercado,
    nivel: melhor.nivel,
    decisao: melhor.decisao,
    forca: melhor.forca,
  };
}

/*
  Essa função transforma o resultado do filtro em entrada final.
  Aqui o filtro operacional passa a mandar na entrada.

  Mercados liberados:
  - Over 1.5
  - Over 2.5
  - Under 2.5
  - Under 3.5
  - BTTS Sim
  - 1X2 Casa
  - 1X2 Fora

  Bloqueados:
  - Under 1.5
  - Over 3.5
  - BTTS Não
  - Empate
*/
function montarEntradasPeloFiltroOperacional(filtroOperacional) {
  const f = filtroOperacional?.filtros || {};
  const perfil = filtroOperacional?.perfil_contextual?.mercados || {};

  function perfilMercado(key) {
    return perfil?.[key] || null;
  }

  function mercadoVetadoPorPerfil(key) {
    const p = perfilMercado(key);
    return p?.status === 'VETO' || p?.decisao === 'NO_BET_PERFIL';
  }

  function mercadoResgatadoPorPerfil(key) {
    const p = perfilMercado(key);
    return p?.status === 'RESGATE_NO_BET' || p?.decisao === 'ENTRADA_RESGATE_PERFIL';
  }

  function mercadoPassaFinal(key, filtroItem) {
    if (mercadoVetadoPorPerfil(key)) return false;
    if (filtroItem?.passou) return true;
    if (mercadoResgatadoPorPerfil(key)) return true;
    return false;
  }

  function scoreEscolha(key, filtroItem) {
    const p = perfilMercado(key);

    const base = pesoNivelFiltro(filtroItem?.nivel);
    const forca = numFiltro(filtroItem?.forca, 0);
    const perfilScore = numFiltro(p?.score, 0);

    let bonus = 0;

    if (p?.status === 'PREMIUM') bonus += 1.5;
    if (p?.status === 'RESGATE_NO_BET') bonus += 1.0;
    if (p?.status === 'CAUTELOSA') bonus -= 0.5;
    if (p?.status === 'VETO') bonus -= 99;

    return base * 10 + forca + perfilScore + bonus;
  }

  const over15Passa = mercadoPassaFinal('over15', f.over15);
  const under35Passa = mercadoPassaFinal('under35', f.under35);
  const bttsPassa = mercadoPassaFinal('btts_sim', f.btts_sim);

  const over25Passa = mercadoPassaFinal('over25', f.over25);
  const under25Passa = mercadoPassaFinal('under25', f.under25);

  const casaPassa = mercadoPassaFinal('casa', f.casa);
  const foraPassa = mercadoPassaFinal('fora', f.fora);

  let entradaOver25 = 'NO BET';
  let entradaUnder25 = 'NO BET';

  if (over25Passa || under25Passa) {
    const scoreOver25 = over25Passa ? scoreEscolha('over25', f.over25) : -999;
    const scoreUnder25 = under25Passa ? scoreEscolha('under25', f.under25) : -999;

    if (scoreOver25 >= scoreUnder25) {
      entradaOver25 = 'OVER25';
    } else {
      entradaUnder25 = 'UNDER25';
    }
  }

  let entrada1x2 = 'NO BET';

  if (casaPassa || foraPassa) {
    const scoreCasa = casaPassa ? scoreEscolha('casa', f.casa) : -999;
    const scoreFora = foraPassa ? scoreEscolha('fora', f.fora) : -999;

    if (scoreCasa >= scoreFora) {
      entrada1x2 = 'CASA';
    } else {
      entrada1x2 = 'FORA';
    }
  }

  return {
    entrada_1x2: entrada1x2,

    entrada_over15: over15Passa ? 'OVER15' : 'NO BET',
    entrada_under15: 'NO BET',

    entrada_over25: entradaOver25,
    entrada_under25: entradaUnder25,

    entrada_over35: 'NO BET',
    entrada_under35: under35Passa ? 'UNDER35' : 'NO BET',

    entrada_btts: bttsPassa ? 'BTTS_SIM' : 'NO BET',
    entrada_btts_nao: 'NO BET',
  };
}

function colunasFiltroOperacionalParaInsert(filtroOperacional) {
  const f = filtroOperacional?.filtros || {};
  const p = filtroOperacional?.principal || {};
  const perfil = filtroOperacional?.perfil_contextual || null;

  if (!perfil) {
    console.error('❌ [INSERT] filtro_operacional vai ser salvo SEM perfil_contextual');
  } else {
    console.log('✅ [INSERT] filtro_operacional vai salvar perfil_contextual:', {
      versao: perfil?.versao || null,
      over15: perfil?.mercados?.over15?.status || null,
      over25: perfil?.mercados?.over25?.status || null,
      btts: perfil?.mercados?.btts_sim?.status || null,
      under35: perfil?.mercados?.under35?.status || null,
      casa: perfil?.mercados?.casa?.status || null,
      fora: perfil?.mercados?.fora?.status || null,
      casa_tem_roteiro: perfil?.ctx?.rg_casa_tem_roteiro_gols,
      fora_tem_roteiro: perfil?.ctx?.rg_fora_tem_roteiro_gols,
      geral_tem_roteiro: perfil?.ctx?.rg_geral_tem_roteiro_gols,
    });
  }

  return [
    FILTRO_OPERACIONAL_VERSAO,
    JSON.stringify(filtroOperacional || null),

    !!f.over15?.passou,
    f.over15?.nivel || null,
    f.over15?.decisao || null,

    !!f.over25?.passou,
    f.over25?.nivel || null,
    f.over25?.decisao || null,

    !!f.under25?.passou,
    f.under25?.nivel || null,
    f.under25?.decisao || null,

    !!f.under35?.passou,
    f.under35?.nivel || null,
    f.under35?.decisao || null,

    !!f.btts_sim?.passou,
    f.btts_sim?.nivel || null,
    f.btts_sim?.decisao || null,

    !!f.casa?.passou,
    f.casa?.nivel || null,
    f.casa?.decisao || null,

    !!f.fora?.passou,
    f.fora?.nivel || null,
    f.fora?.decisao || null,

    p.mercado || null,
    p.nivel || null,
    p.decisao || null,
  ];
}
// =========================================================
// CAMADA PERFIL CONTEXTUAL — V1 RESIDUAL
// Usa o perfil como camada operacional em cima de lambda + âncora.
// Não recalcula probabilidade.
// =========================================================

const PERFIL_CONTEXTUAL_VERSAO = 'v1_residual_garimpo_2026_05';

function perfilIsObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function perfilToNum(v, fallback = 0) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function perfilRound(v, casas = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(casas));
}

function perfilClamp(v, min = 0, max = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function perfilText(v, fallback = '') {
  if (v === null || v === undefined) return fallback;
  return String(v).trim();
}

function perfilGetPath(obj, path, fallback = null) {
  let cur = obj;

  for (const key of path) {
    if (!perfilIsObj(cur)) return fallback;
    cur = cur[key];
  }

  return cur === undefined ? fallback : cur;
}

function perfilFirst(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === '') continue;
    return v;
  }
  return null;
}

function perfilNumPath(obj, path, fallback = null) {
  return perfilToNum(perfilGetPath(obj, path, fallback), fallback);
}

function perfilTextPath(obj, path, fallback = '') {
  return perfilText(perfilGetPath(obj, path, fallback), fallback);
}

function perfilAvg(...vals) {
  const nums = vals
    .map(v => perfilToNum(v, null))
    .filter(v => v !== null && Number.isFinite(v));

  if (!nums.length) return 0;

  return perfilRound(nums.reduce((a, b) => a + b, 0) / nums.length, 4);
}

function perfilMax(...vals) {
  const nums = vals
    .map(v => perfilToNum(v, null))
    .filter(v => v !== null && Number.isFinite(v));

  if (!nums.length) return 0;

  return perfilRound(Math.max(...nums), 4);
}

function perfilMin(...vals) {
  const nums = vals
    .map(v => perfilToNum(v, null))
    .filter(v => v !== null && Number.isFinite(v));

  if (!nums.length) return 0;

  return perfilRound(Math.min(...nums), 4);
}

function rgFindRoteiroGolsPorLado(telemetria, lado) {
  const anchor =
    telemetria?.anchor_mercados_aplicacao ||
    telemetria?.telemetria_anchor ||
    telemetria?.anchor ||
    telemetria ||
    null;

  if (!perfilIsObj(anchor)) return {};

  let candidatos = [];

  if (lado === 'casa') {
    candidatos = [
      ['casa_anchor_mercados', 'roteiro_gols'],
      ['anchor_mercados_casa', 'roteiro_gols'],
      ['contextual', 'casa_anchor_mercados', 'roteiro_gols'],
      ['contextual', 'anchor_mercados_casa', 'roteiro_gols'],
      ['rating_times', 'casa_anchor_mercados', 'roteiro_gols'],
      ['rating_principal_lambda', 'casa_anchor_mercados', 'roteiro_gols'],
      ['rating_principal_lambda', 'rating_times', 'casa_anchor_mercados', 'roteiro_gols'],
      ['rating_principal_lambda', 'anchor_mercados_casa', 'roteiro_gols'],
      ['casa', 'anchor_mercados', 'roteiro_gols'],
      ['casa', 'roteiro_gols'],
    ];
  } else if (lado === 'fora') {
    candidatos = [
      ['fora_anchor_mercados', 'roteiro_gols'],
      ['anchor_mercados_fora', 'roteiro_gols'],
      ['contextual', 'fora_anchor_mercados', 'roteiro_gols'],
      ['contextual', 'anchor_mercados_fora', 'roteiro_gols'],
      ['rating_times', 'fora_anchor_mercados', 'roteiro_gols'],
      ['rating_principal_lambda', 'fora_anchor_mercados', 'roteiro_gols'],
      ['rating_principal_lambda', 'rating_times', 'fora_anchor_mercados', 'roteiro_gols'],
      ['rating_principal_lambda', 'anchor_mercados_fora', 'roteiro_gols'],
      ['fora', 'anchor_mercados', 'roteiro_gols'],
      ['fora', 'roteiro_gols'],
    ];
  } else {
    candidatos = [
      ['anchor_mercados_geral_40', 'roteiro_gols'],
      ['geral_anchor_mercados', 'roteiro_gols'],
      ['contextual', 'anchor_mercados_geral_40', 'roteiro_gols'],
      ['contextual', 'geral_anchor_mercados', 'roteiro_gols'],
      ['rating_times', 'anchor_mercados_geral_40', 'roteiro_gols'],
      ['rating_principal_lambda', 'anchor_mercados_geral_40', 'roteiro_gols'],
      ['rating_principal_lambda', 'rating_times', 'anchor_mercados_geral_40', 'roteiro_gols'],
      ['rating_principal_lambda', 'geral_anchor_mercados', 'roteiro_gols'],
      ['geral', 'roteiro_gols'],
    ];
  }

  for (const path of candidatos) {
    const achou = perfilGetPath(anchor, path, null);
    if (perfilIsObj(achou)) return achou;
  }

  function walk(x, caminho = '') {
    if (!perfilIsObj(x)) return {};

    if (perfilIsObj(x.roteiro_gols)) {
      const c = caminho.toLowerCase();

      if (lado === 'casa' && (c.includes('casa') || c.includes('home'))) {
        return x.roteiro_gols;
      }

      if (lado === 'fora' && (c.includes('fora') || c.includes('away'))) {
        return x.roteiro_gols;
      }

      if (lado === 'geral' && (c.includes('geral') || c.includes('40') || c.includes('global'))) {
        return x.roteiro_gols;
      }
    }

    for (const [k, v] of Object.entries(x)) {
      const r = walk(v, caminho ? `${caminho}.${k}` : String(k));
      if (perfilIsObj(r) && Object.keys(r).length) return r;
    }

    return {};
  }

  return walk(anchor);
}

function extrairRoteiroGolsLadoFlat(telemetria, lado) {
  const rg = rgFindRoteiroGolsPorLado(telemetria, lado);

  const out = {};
  out[`rg_${lado}_tem_roteiro_gols`] = perfilIsObj(rg) && Object.keys(rg).length > 0;

  const cp = perfilIsObj(rg?.condicional_pos_primeiro_gol)
    ? rg.condicional_pos_primeiro_gol
    : {};

  const qa = perfilIsObj(cp?.quando_abre)
    ? cp.quando_abre
    : {};

  const qs = perfilIsObj(cp?.quando_sofre_primeiro)
    ? cp.quando_sofre_primeiro
    : {};

  const pg = perfilIsObj(cp?.perfil_time_pos_primeiro_gol)
    ? cp.perfil_time_pos_primeiro_gol
    : {};

  const perfil = perfilIsObj(rg?.perfil)
    ? rg.perfil
    : {};

  // Leituras textuais.
  out[`rg_${lado}_abre_leitura`] = perfilTextPath(qa, ['leitura'], '');
  out[`rg_${lado}_sofre_leitura`] = perfilTextPath(qs, ['leitura'], '');
  out[`rg_${lado}_perfil_pos_1_gol_leitura`] = perfilTextPath(pg, ['leitura'], '');

  // Samples / confiança.
  out[`rg_${lado}_abre_sample`] = perfilNumPath(qa, ['sample'], null);
  out[`rg_${lado}_abre_sample_raw`] = perfilNumPath(qa, ['sample_raw'], null);
  out[`rg_${lado}_abre_confianca`] = perfilNumPath(qa, ['confianca'], null);
  out[`rg_${lado}_abre_confianca_label`] = perfilTextPath(qa, ['confianca_label'], '');

  out[`rg_${lado}_sofre_sample`] = perfilNumPath(qs, ['sample'], null);
  out[`rg_${lado}_sofre_sample_raw`] = perfilNumPath(qs, ['sample_raw'], null);
  out[`rg_${lado}_sofre_confianca`] = perfilNumPath(qs, ['confianca'], null);
  out[`rg_${lado}_sofre_confianca_label`] = perfilTextPath(qs, ['confianca_label'], '');

  // Quando abre: placar.
  out[`rg_${lado}_pct_abriu_placar_sobre_jogos_com_gol`] = perfilFirst(
    perfilNumPath(qa, ['pct_abriu_placar_sobre_jogos_com_gol'], null),
    perfilNumPath(rg, ['pct_abriu_placar_sobre_jogos_com_gol'], null)
  );

  out[`rg_${lado}_pct_abriu_e_fez_2x0`] = perfilFirst(
    perfilNumPath(rg, ['pct_abriu_e_fez_2x0'], null),
    perfilNumPath(rg, ['pct_abriu_e_ampliou_2x0'], null),
    perfilNumPath(qa, ['placar', 'pct_ampliou_2x0'], null),
    perfilNumPath(qa, ['pct_fez_2x0'], null)
  );

  out[`rg_${lado}_pct_abriu_e_fez_2x0_aj`] = perfilFirst(
    perfilNumPath(rg, ['pct_abriu_e_fez_2x0_ajustado'], null),
    perfilNumPath(rg, ['pct_abriu_e_ampliou_2x0_ajustado'], null),
    perfilNumPath(qa, ['placar', 'pct_ampliou_2x0_ajustado'], null),
    perfilNumPath(qa, ['pct_fez_2x0_ajustado'], null)
  );

  out[`rg_${lado}_abre_pct_sofreu_1x1`] = perfilFirst(
    perfilNumPath(qa, ['placar', 'pct_sofreu_1x1'], null),
    perfilNumPath(qa, ['pct_sofreu_1x1'], null),
    perfilNumPath(rg, ['pct_abriu_e_sofreu_1x1'], null)
  );

  out[`rg_${lado}_abre_pct_sofreu_1x1_aj`] = perfilFirst(
    perfilNumPath(qa, ['placar', 'pct_sofreu_1x1_ajustado'], null),
    perfilNumPath(qa, ['pct_sofreu_1x1_ajustado'], null),
    perfilNumPath(rg, ['pct_abriu_e_sofreu_1x1_ajustado'], null)
  );

  out[`rg_${lado}_abre_pct_terminou_1x0`] = perfilFirst(
    perfilNumPath(qa, ['placar', 'pct_terminou_1x0'], null),
    perfilNumPath(qa, ['pct_terminou_1x0'], null),
    perfilNumPath(rg, ['pct_abriu_e_terminou_1x0'], null)
  );

  out[`rg_${lado}_abre_pct_parou_no_placar`] = perfilFirst(
    perfilNumPath(qa, ['placar', 'pct_parou_no_placar'], null),
    perfilNumPath(qa, ['pct_parou_no_placar'], null)
  );

  out[`rg_${lado}_abre_pct_venceu`] = perfilFirst(
    perfilNumPath(qa, ['placar', 'pct_venceu'], null),
    perfilNumPath(qa, ['pct_venceu'], null),
    perfilNumPath(rg, ['pct_abriu_e_venceu'], null)
  );

  out[`rg_${lado}_abre_pct_empatou`] = perfilFirst(
    perfilNumPath(qa, ['placar', 'pct_empatou'], null),
    perfilNumPath(qa, ['pct_empatou'], null),
    perfilNumPath(rg, ['pct_abriu_e_empatou'], null)
  );

  out[`rg_${lado}_abre_pct_perdeu`] = perfilFirst(
    perfilNumPath(qa, ['placar', 'pct_perdeu'], null),
    perfilNumPath(qa, ['pct_perdeu'], null),
    perfilNumPath(rg, ['pct_abriu_e_perdeu'], null)
  );

  // Quando abre: comportamento / scores.
  out[`rg_${lado}_abre_amplia_score`] = perfilFirst(
    perfilNumPath(qa, ['scores', 'amplia_score'], null),
    perfilNumPath(pg, ['abre_amplia_score'], null)
  );

  out[`rg_${lado}_abre_continua_criando_score`] = perfilFirst(
    perfilNumPath(qa, ['scores', 'continua_criando_score'], null),
    perfilNumPath(qa, ['continua_busca_score'], null),
    perfilNumPath(pg, ['abre_continua_criando_score'], null),
    perfilNumPath(perfil, ['continua_busca_apos_abrir'], null)
  );

  out[`rg_${lado}_abre_trava_score`] = perfilFirst(
    perfilNumPath(qa, ['scores', 'trava_score'], null),
    perfilNumPath(qa, ['trava_apos_abrir_score'], null),
    perfilNumPath(pg, ['abre_trava_score'], null),
    perfilNumPath(perfil, ['trava_apos_abrir'], null)
  );

  out[`rg_${lado}_abre_cede_reacao_score`] = perfilFirst(
    perfilNumPath(qa, ['scores', 'cede_reacao_score'], null),
    perfilNumPath(qa, ['permite_reacao_score'], null),
    perfilNumPath(pg, ['abre_cede_reacao_score'], null),
    perfilNumPath(perfil, ['permite_reacao_apos_abrir'], null)
  );

  out[`rg_${lado}_abre_controla_score`] = perfilFirst(
    perfilNumPath(qa, ['scores', 'controla_score'], null),
    perfilNumPath(pg, ['abre_controla_score'], null),
    perfilNumPath(perfil, ['controla_apos_abrir'], null)
  );

  out[`rg_${lado}_abre_mata_jogo_score`] = perfilFirst(
    perfilNumPath(qa, ['scores', 'mata_jogo_score'], null),
    perfilNumPath(qa, ['mata_jogo_score'], null),
    perfilNumPath(pg, ['abre_mata_jogo_score'], null),
    perfilNumPath(perfil, ['mata_jogo_ajustado'], null),
    perfilNumPath(perfil, ['mata_jogo'], null)
  );

  out[`rg_${lado}_abre_perde_controle_score`] = perfilFirst(
    perfilNumPath(qa, ['scores', 'perde_controle_score'], null),
    perfilNumPath(pg, ['abre_perde_controle_score'], null),
    perfilNumPath(perfil, ['perde_controle_apos_abrir'], null)
  );

  out[`rg_${lado}_abre_comp_continuou_criando_aj`] = perfilFirst(
    perfilNumPath(qa, ['comportamento', 'continuou_criando', 'pct_ajustado'], null),
    perfilNumPath(qa, ['comportamento', 'nao_ampliou_mas_criou', 'pct_ajustado'], null),
    perfilNumPath(qa, ['pct_continuou_com_volume_ajustado'], null)
  );

  // Quando sofre primeiro: placar.
  out[`rg_${lado}_pct_sofreu_primeiro_sobre_jogos_com_gol`] = perfilFirst(
    perfilNumPath(qs, ['pct_sofreu_primeiro_sobre_jogos_com_gol'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_sobre_jogos_com_gol'], null)
  );

  out[`rg_${lado}_sofre_pct_busca_1x1`] = perfilFirst(
    perfilNumPath(qs, ['placar', 'pct_busca_1x1'], null),
    perfilNumPath(qs, ['pct_busca_1x1'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_e_busca_1x1'], null)
  );

  out[`rg_${lado}_sofre_pct_busca_1x1_aj`] = perfilFirst(
    perfilNumPath(qs, ['placar', 'pct_busca_1x1_ajustado'], null),
    perfilNumPath(qs, ['pct_busca_1x1_ajustado'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_e_busca_1x1_ajustado'], null)
  );

  out[`rg_${lado}_sofre_pct_toma_2x0`] = perfilFirst(
    perfilNumPath(qs, ['placar', 'pct_tomou_2x0'], null),
    perfilNumPath(qs, ['pct_toma_2x0'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_e_toma_2x0'], null)
  );

  out[`rg_${lado}_sofre_pct_virou`] = perfilFirst(
    perfilNumPath(qs, ['placar', 'pct_virou'], null),
    perfilNumPath(qs, ['pct_vira'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_e_virou'], null)
  );

  out[`rg_${lado}_sofre_pct_virou_aj`] = perfilFirst(
    perfilNumPath(qs, ['placar', 'pct_virou_ajustado'], null),
    perfilNumPath(qs, ['pct_vira_ajustado'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_e_virou_ajustado'], null)
  );

  out[`rg_${lado}_sofre_pct_empatou`] = perfilFirst(
    perfilNumPath(qs, ['placar', 'pct_empatou'], null),
    perfilNumPath(qs, ['pct_empata'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_e_empatou'], null)
  );

  out[`rg_${lado}_sofre_pct_perdeu_sem_marcar`] = perfilFirst(
    perfilNumPath(qs, ['placar', 'pct_perdeu_sem_marcar'], null),
    perfilNumPath(rg, ['pct_sofreu_primeiro_e_perdeu_sem_marcar'], null)
  );

  // Quando sofre primeiro: scores.
  out[`rg_${lado}_sofre_busca_empate_score`] = perfilFirst(
    perfilNumPath(qs, ['scores', 'busca_empate_score'], null),
    perfilNumPath(qs, ['busca_empate_score'], null),
    perfilNumPath(qs, ['reage_score'], null),
    perfilNumPath(pg, ['sofre_busca_empate_score'], null),
    perfilNumPath(perfil, ['busca_empate_depois_sofrer'], null)
  );

  out[`rg_${lado}_sofre_vira_score`] = perfilFirst(
    perfilNumPath(qs, ['scores', 'vira_score'], null),
    perfilNumPath(qs, ['vira_score'], null),
    perfilNumPath(pg, ['sofre_vira_score'], null),
    perfilNumPath(perfil, ['vira_depois_sofrer'], null)
  );

  out[`rg_${lado}_sofre_nao_busca_score`] = perfilFirst(
    perfilNumPath(qs, ['scores', 'nao_busca_score'], null),
    perfilNumPath(qs, ['nao_busca_score'], null),
    perfilNumPath(pg, ['sofre_nao_busca_score'], null),
    perfilNumPath(perfil, ['nao_busca_depois_sofrer'], null)
  );

  out[`rg_${lado}_sofre_toma_mais_score`] = perfilFirst(
    perfilNumPath(qs, ['scores', 'toma_mais_score'], null),
    perfilNumPath(qs, ['toma_mais_score'], null),
    perfilNumPath(pg, ['sofre_toma_mais_score'], null),
    perfilNumPath(perfil, ['toma_mais_depois_sofrer'], null)
  );

  out[`rg_${lado}_sofre_desmorona_score`] = perfilFirst(
    perfilNumPath(qs, ['scores', 'desmorona_score'], null),
    perfilNumPath(qs, ['desmorona_score'], null),
    perfilNumPath(pg, ['sofre_desmorona_score'], null),
    perfilNumPath(perfil, ['desmorona_depois_sofrer_ajustado'], null),
    perfilNumPath(perfil, ['desmorona_depois_sofrer'], null)
  );

  out[`rg_${lado}_sofre_reage_mas_cede_espaco_score`] = perfilFirst(
    perfilNumPath(qs, ['scores', 'reage_mas_cede_espaco_score'], null),
    perfilNumPath(qs, ['reage_mas_cede_espaco_score'], null),
    perfilNumPath(pg, ['sofre_reage_mas_cede_espaco_score'], null),
    perfilNumPath(perfil, ['reage_mas_cede_espaco_depois_sofrer'], null)
  );

  out[`rg_${lado}_sofre_controla_depois_score`] = perfilFirst(
    perfilNumPath(qs, ['scores', 'controla_depois_score'], null),
    perfilNumPath(pg, ['sofre_controla_depois_score'], null)
  );

  // Médias auxiliares.
  out[`rg_${lado}_sofre_big_chances_medio`] = perfilFirst(
    perfilNumPath(qs, ['volume', 'big_chances_medio'], null),
    perfilNumPath(qs, ['big_chances_medio'], null)
  );

  // Perfil geral pós-primeiro gol.
  out[`rg_${lado}_perfil_jogo_vivo_score`] = perfilNumPath(pg, ['jogo_vivo_score'], null);
  out[`rg_${lado}_perfil_trava_score`] = perfilNumPath(pg, ['trava_score'], null);
  out[`rg_${lado}_perfil_dominio_score`] = perfilNumPath(pg, ['dominio_score'], null);

  return out;
}

function montarPerfilContextualFlat(telemetria) {
  const out = {
    versao: PERFIL_CONTEXTUAL_VERSAO,
    gerado_em: new Date().toISOString(),
  };

  Object.assign(out, extrairRoteiroGolsLadoFlat(telemetria, 'casa'));
  Object.assign(out, extrairRoteiroGolsLadoFlat(telemetria, 'fora'));
  Object.assign(out, extrairRoteiroGolsLadoFlat(telemetria, 'geral'));

  // Máximos gerais.
  out.rg_max_abre_amplia_score = perfilMax(out.rg_casa_abre_amplia_score, out.rg_fora_abre_amplia_score);
  out.rg_max_abre_continua_criando_score = perfilMax(out.rg_casa_abre_continua_criando_score, out.rg_fora_abre_continua_criando_score);
  out.rg_max_abre_trava_score = perfilMax(out.rg_casa_abre_trava_score, out.rg_fora_abre_trava_score);
  out.rg_max_abre_cede_reacao_score = perfilMax(out.rg_casa_abre_cede_reacao_score, out.rg_fora_abre_cede_reacao_score);
  out.rg_max_abre_controla_score = perfilMax(out.rg_casa_abre_controla_score, out.rg_fora_abre_controla_score);
  out.rg_max_abre_mata_jogo_score = perfilMax(out.rg_casa_abre_mata_jogo_score, out.rg_fora_abre_mata_jogo_score);
  out.rg_max_abre_perde_controle_score = perfilMax(out.rg_casa_abre_perde_controle_score, out.rg_fora_abre_perde_controle_score);

  out.rg_max_sofre_busca_empate_score = perfilMax(out.rg_casa_sofre_busca_empate_score, out.rg_fora_sofre_busca_empate_score);
  out.rg_max_sofre_vira_score = perfilMax(out.rg_casa_sofre_vira_score, out.rg_fora_sofre_vira_score);
  out.rg_max_sofre_nao_busca_score = perfilMax(out.rg_casa_sofre_nao_busca_score, out.rg_fora_sofre_nao_busca_score);
  out.rg_max_sofre_toma_mais_score = perfilMax(out.rg_casa_sofre_toma_mais_score, out.rg_fora_sofre_toma_mais_score);
  out.rg_max_sofre_desmorona_score = perfilMax(out.rg_casa_sofre_desmorona_score, out.rg_fora_sofre_desmorona_score);
  out.rg_max_sofre_reage_mas_cede_espaco_score = perfilMax(out.rg_casa_sofre_reage_mas_cede_espaco_score, out.rg_fora_sofre_reage_mas_cede_espaco_score);

  function addMatchup(prefixTimeAbre, prefixAdvSofre, nome, labelPrefix) {
    const abreAmplia = perfilToNum(out[`rg_${prefixTimeAbre}_abre_amplia_score`], 0);
    const abreContinua = perfilToNum(out[`rg_${prefixTimeAbre}_abre_continua_criando_score`], 0);
    const abreTrava = perfilToNum(out[`rg_${prefixTimeAbre}_abre_trava_score`], 0);
    const abreCede = perfilToNum(out[`rg_${prefixTimeAbre}_abre_cede_reacao_score`], 0);
    const abreControla = perfilToNum(out[`rg_${prefixTimeAbre}_abre_controla_score`], 0);
    const abreMata = perfilToNum(out[`rg_${prefixTimeAbre}_abre_mata_jogo_score`], 0);
    const abrePerde = perfilToNum(out[`rg_${prefixTimeAbre}_abre_perde_controle_score`], 0);

    const advBusca = perfilToNum(out[`rg_${prefixAdvSofre}_sofre_busca_empate_score`], 0);
    const advVira = perfilToNum(out[`rg_${prefixAdvSofre}_sofre_vira_score`], 0);
    const advNaoBusca = perfilToNum(out[`rg_${prefixAdvSofre}_sofre_nao_busca_score`], 0);
    const advTomaMais = perfilToNum(out[`rg_${prefixAdvSofre}_sofre_toma_mais_score`], 0);
    const advDesmorona = perfilToNum(out[`rg_${prefixAdvSofre}_sofre_desmorona_score`], 0);
    const advReageCede = perfilToNum(out[`rg_${prefixAdvSofre}_sofre_reage_mas_cede_espaco_score`], 0);

    const overMotor = perfilRound(
      0.30 * abreContinua +
      0.25 * abreAmplia +
      0.15 * abreMata +
      0.15 * advBusca +
      0.15 * advReageCede,
      4
    );

    const bttsReacao = perfilRound(
      0.35 * abreCede +
      0.35 * advBusca +
      0.15 * advVira +
      0.15 * advReageCede,
      4
    );

    const trava = perfilRound(
      0.40 * abreTrava +
      0.25 * abreControla +
      0.25 * advNaoBusca +
      0.10 * advDesmorona,
      4
    );

    const dominioSeco = perfilRound(
      0.30 * abreControla +
      0.25 * abreMata +
      0.20 * advNaoBusca +
      0.15 * advDesmorona +
      0.10 * advTomaMais,
      4
    );

    const caminho2x0 = perfilRound(
      0.35 * abreAmplia +
      0.25 * abreMata +
      0.25 * advTomaMais +
      0.15 * advDesmorona,
      4
    );

    const perdeControle = perfilRound(
      0.45 * abrePerde +
      0.35 * abreCede +
      0.20 * advBusca,
      4
    );

    out[`rg_match_${nome}_over_motor_score`] = overMotor;
    out[`rg_match_${nome}_btts_reacao_score`] = bttsReacao;
    out[`rg_match_${nome}_trava_score`] = trava;
    out[`rg_match_${nome}_dominio_seco_score`] = dominioSeco;
    out[`rg_match_${nome}_caminho_2x0_score`] = caminho2x0;
    out[`rg_match_${nome}_perde_controle_score`] = perdeControle;

    let cenario = `${labelPrefix}_ABRE_NEUTRO`;

    if (bttsReacao >= 0.55 && overMotor >= 0.55) {
      cenario = `${labelPrefix}_ABRE_JOGO_VIVO_BTTS`;
    } else if (dominioSeco >= 0.55 && bttsReacao < 0.48) {
      cenario = `${labelPrefix}_ABRE_DOMINA_SECO`;
    } else if (trava >= 0.55 && overMotor < 0.50) {
      cenario = `${labelPrefix}_ABRE_TRAVA_1X0`;
    } else if (caminho2x0 >= 0.55) {
      cenario = `${labelPrefix}_ABRE_CAMINHO_2X0`;
    } else if (perdeControle >= 0.55) {
      cenario = `${labelPrefix}_ABRE_PERDE_CONTROLE`;
    } else if (bttsReacao >= 0.52) {
      cenario = `${labelPrefix}_ABRE_MAS_ADV_REAGE`;
    }

    out[`rg_match_${nome}_cenario`] = cenario;
  }

  addMatchup('casa', 'fora', 'se_casa_abrir', 'CASA');
  addMatchup('fora', 'casa', 'se_fora_abrir', 'FORA');

  // MAX / MIN / AVG por confronto.
  for (const base of [
    ['caminho_2x0', 'caminho_2x0_score'],
    ['over15_motor', 'over_motor_score'],
    ['btts_motor', 'btts_reacao_score'],
    ['trava_1x0', 'trava_score'],
    ['dominio_seco', 'dominio_seco_score'],
    ['perde_controle', 'perde_controle_score'],
  ]) {
    const nomeFinal = base[0];
    const suffix = base[1];

    const casa = out[`rg_match_se_casa_abrir_${suffix}`];
    const fora = out[`rg_match_se_fora_abrir_${suffix}`];

    out[`rg_matchup_${nomeFinal}_max_score`] = perfilMax(casa, fora);
    out[`rg_matchup_${nomeFinal}_min_score`] = perfilMin(casa, fora);
    out[`rg_matchup_${nomeFinal}_avg_score`] = perfilAvg(casa, fora);
    out[`rg_matchup_${nomeFinal}_diff_score`] = perfilRound(Math.abs(perfilToNum(casa, 0) - perfilToNum(fora, 0)), 4);
  }

  // Compatibilidade com nomes antigos do auditor.
  out.rg_matchup_over15_motor_score = out.rg_matchup_over15_motor_max_score;
  out.rg_matchup_btts_motor_score = out.rg_matchup_btts_motor_max_score;
  out.rg_matchup_trava_1x0_novo_score = out.rg_matchup_trava_1x0_max_score;
  out.rg_matchup_dominio_seco_score = out.rg_matchup_dominio_seco_max_score;
  out.rg_matchup_caminho_2x0_score = out.rg_matchup_caminho_2x0_max_score;
  out.rg_matchup_perde_controle_score = out.rg_matchup_perde_controle_max_score;

  // Peso de quem tende a abrir primeiro.
  const casaAbreHist = perfilToNum(out.rg_casa_pct_abriu_placar_sobre_jogos_com_gol, 0);
  const foraAbreHist = perfilToNum(out.rg_fora_pct_abriu_placar_sobre_jogos_com_gol, 0);
  const casaSofreHist = perfilToNum(out.rg_casa_pct_sofreu_primeiro_sobre_jogos_com_gol, 0);
  const foraSofreHist = perfilToNum(out.rg_fora_pct_sofreu_primeiro_sobre_jogos_com_gol, 0);

  const rawCasaAbre = perfilAvg(casaAbreHist, foraSofreHist);
  const rawForaAbre = perfilAvg(foraAbreHist, casaSofreHist);
  const somaAbre = rawCasaAbre + rawForaAbre;

  const pesoCasaAbre = somaAbre > 0 ? rawCasaAbre / somaAbre : 0.5;
  const pesoForaAbre = somaAbre > 0 ? rawForaAbre / somaAbre : 0.5;

  out.rg_peso_casa_abrir = perfilRound(pesoCasaAbre, 4);
  out.rg_peso_fora_abrir = perfilRound(pesoForaAbre, 4);

  function ponderar(suffix) {
    return perfilRound(
      perfilToNum(out[`rg_match_se_casa_abrir_${suffix}`], 0) * pesoCasaAbre +
      perfilToNum(out[`rg_match_se_fora_abrir_${suffix}`], 0) * pesoForaAbre,
      4
    );
  }

  out.rg_matchup_caminho_2x0_ponderado_score = ponderar('caminho_2x0_score');
  out.rg_matchup_over15_motor_ponderado_score = ponderar('over_motor_score');
  out.rg_matchup_btts_motor_ponderado_score = ponderar('btts_reacao_score');
  out.rg_matchup_trava_1x0_ponderado_score = ponderar('trava_score');
  out.rg_matchup_dominio_seco_ponderado_score = ponderar('dominio_seco_score');
  out.rg_matchup_perde_controle_ponderado_score = ponderar('perde_controle_score');

  // Scores contextuais finais.
  out.rg_contextual_over15_score = perfilRound(
    0.50 * out.rg_matchup_over15_motor_ponderado_score +
    0.30 * out.rg_matchup_caminho_2x0_ponderado_score +
    0.20 * out.rg_matchup_btts_motor_ponderado_score,
    4
  );

  out.rg_contextual_over25_score = perfilRound(
    0.45 * out.rg_matchup_over15_motor_ponderado_score +
    0.30 * out.rg_matchup_btts_motor_ponderado_score +
    0.25 * out.rg_matchup_caminho_2x0_ponderado_score,
    4
  );

  out.rg_contextual_btts_score = out.rg_matchup_btts_motor_ponderado_score;

  out.rg_contextual_2x0_seco_score = perfilRound(
    0.60 * out.rg_matchup_dominio_seco_ponderado_score +
    0.40 * out.rg_matchup_caminho_2x0_ponderado_score,
    4
  );

  out.rg_contextual_2x0_com_reacao_score = perfilRound(
    0.55 * out.rg_matchup_caminho_2x0_ponderado_score +
    0.45 * out.rg_matchup_btts_motor_ponderado_score,
    4
  );

  out.rg_contextual_trava_score = out.rg_matchup_trava_1x0_ponderado_score;
  out.rg_contextual_dependencia_quem_abre_score = perfilMax(
    out.rg_matchup_caminho_2x0_diff_score,
    out.rg_matchup_btts_motor_diff_score,
    out.rg_matchup_over15_motor_diff_score
  );

  // Campos contextuais usados pelo garimpo em 1X2.
  out.rg_context_fora_sai_atras_vs_casa_desmorona_score = perfilRound(
    0.35 * perfilToNum(out.rg_fora_sofre_desmorona_score, 0) +
    0.35 * perfilToNum(out.rg_fora_sofre_toma_mais_score, 0) +
    0.30 * perfilToNum(out.rg_fora_sofre_nao_busca_score, 0),
    4
  );

  out.rg_context_casa_sai_atras_vs_fora_desmorona_score = perfilRound(
    0.35 * perfilToNum(out.rg_casa_sofre_desmorona_score, 0) +
    0.35 * perfilToNum(out.rg_casa_sofre_toma_mais_score, 0) +
    0.30 * perfilToNum(out.rg_casa_sofre_nao_busca_score, 0),
    4
  );

  out.rg_context_fora_vs_casa_abre_forte_risco_sofrer_primeiro_score = perfilRound(
    0.35 * perfilToNum(out.rg_casa_abre_amplia_score, 0) +
    0.25 * perfilToNum(out.rg_casa_abre_mata_jogo_score, 0) +
    0.20 * perfilToNum(out.rg_fora_sofre_toma_mais_score, 0) +
    0.20 * perfilToNum(out.rg_fora_sofre_desmorona_score, 0),
    4
  );

  out.rg_context_casa_vs_fora_abre_forte_risco_sofrer_primeiro_score = perfilRound(
    0.35 * perfilToNum(out.rg_fora_abre_amplia_score, 0) +
    0.25 * perfilToNum(out.rg_fora_abre_mata_jogo_score, 0) +
    0.20 * perfilToNum(out.rg_casa_sofre_toma_mais_score, 0) +
    0.20 * perfilToNum(out.rg_casa_sofre_desmorona_score, 0),
    4
  );

  // Leituras finais.
  if (
    out.rg_matchup_btts_motor_min_score >= 0.52 &&
    out.rg_matchup_over15_motor_avg_score >= 0.52
  ) {
    out.rg_matchup_leitura_final = 'MATCHUP_JOGO_VIVO_POS_1_GOL';
  } else if (
    out.rg_matchup_caminho_2x0_max_score >= 0.52 &&
    out.rg_matchup_btts_motor_avg_score < 0.50
  ) {
    out.rg_matchup_leitura_final = 'MATCHUP_CAMINHO_2X0';
  } else if (
    out.rg_matchup_trava_1x0_max_score >= 0.52 &&
    out.rg_matchup_over15_motor_avg_score < 0.50
  ) {
    out.rg_matchup_leitura_final = 'MATCHUP_TRAVA_1X0';
  } else if (
    out.rg_matchup_dominio_seco_max_score >= 0.52 &&
    out.rg_matchup_btts_motor_avg_score < 0.48
  ) {
    out.rg_matchup_leitura_final = 'MATCHUP_DOMINIO_SECO';
  } else {
    out.rg_matchup_leitura_final = 'MATCHUP_NEUTRO';
  }

  if (
    out.rg_contextual_btts_score >= 0.55 &&
    out.rg_contextual_over25_score >= 0.52
  ) {
    out.rg_contextual_leitura_final = 'CONTEXTUAL_AMBOS_CENARIOS_FAVORECEM_REACAO';
  } else if (
    out.rg_contextual_2x0_seco_score >= 0.52 &&
    out.rg_contextual_btts_score < 0.48
  ) {
    out.rg_contextual_leitura_final = 'CONTEXTUAL_2X0_SECO';
  } else if (out.rg_contextual_over15_score >= 0.52) {
    out.rg_contextual_leitura_final = 'CONTEXTUAL_CAMINHO_OVER15';
  } else if (out.rg_contextual_trava_score >= 0.52) {
    out.rg_contextual_leitura_final = 'CONTEXTUAL_TRAVA';
  } else {
    out.rg_contextual_leitura_final = 'CONTEXTUAL_NEUTRO';
  }

  return out;
}

function perfilCriarResultado(mercado, filtroMercado) {
  return {
    mercado,
    base_passou: !!filtroMercado?.passou,
    base_nivel: filtroMercado?.nivel || null,
    base_decisao: filtroMercado?.decisao || null,
    base_forca: perfilToNum(filtroMercado?.forca, 0),

    status: 'NEUTRO',
    decisao: 'MANTER_BASE',
    transforma: 'MANTER',

    premium_pontos: 0,
    veto_pontos: 0,
    score: 0,

    motivos_premium: [],
    motivos_veto: [],
    motivos_alerta: [],
  };
}

function perfilAddPremium(out, codigo, peso, descricao, dados = {}) {
  out.premium_pontos = perfilRound(out.premium_pontos + peso, 4);
  out.motivos_premium.push({ codigo, peso, descricao, dados });
}

function perfilAddVeto(out, codigo, peso, descricao, dados = {}) {
  out.veto_pontos = perfilRound(out.veto_pontos + peso, 4);
  out.motivos_veto.push({ codigo, peso, descricao, dados });
}

function filtroQuasePassou(filtroMercado) {
  const pilares = Array.isArray(filtroMercado?.pilares)
    ? filtroMercado.pilares
    : [];

  if (!pilares.length) return false;

  const passou = pilares.filter(p => !!p?.passou).length;
  const ratio = passou / pilares.length;

  return ratio >= 0.75;
}

function perfilFinalizarResultado(out, filtroMercado) {
  out.score = perfilRound(out.premium_pontos - out.veto_pontos, 4);

  const vetoForte =
    out.veto_pontos >= 2.0 ||
    (out.veto_pontos >= 1.35 && out.motivos_veto.length >= 2);

  const premiumForte =
    out.premium_pontos >= 1.25;

  if (out.base_passou) {
    if (vetoForte) {
      out.status = 'VETO';
      out.decisao = 'NO_BET_PERFIL';
      out.transforma = 'ENTRADA_PARA_NO_BET';
      return out;
    }

    if (out.veto_pontos >= 0.80 && out.premium_pontos < 1.20) {
      out.status = 'CAUTELOSA';
      out.decisao = 'ENTRADA_CAUTELA';
      out.transforma = 'ENTRADA_MANTIDA_CAUTELA';
      return out;
    }

    if (premiumForte) {
      out.status = 'PREMIUM';
      out.decisao = 'ENTRADA_PREMIUM';
      out.transforma = 'ENTRADA_MANTIDA_PREMIUM';
      return out;
    }

    out.status = 'NORMAL';
    out.decisao = 'ENTRADA_NORMAL';
    out.transforma = 'ENTRADA_MANTIDA';
    return out;
  }

  // NO BET só vira entrada se o filtro operacional quase passou.
  if (!out.base_passou && premiumForte && filtroQuasePassou(filtroMercado) && out.veto_pontos < 0.80) {
    out.status = 'RESGATE_NO_BET';
    out.decisao = 'ENTRADA_RESGATE_PERFIL';
    out.transforma = 'NO_BET_PARA_ENTRADA';
    return out;
  }

  if (out.veto_pontos >= 0.80) {
    out.status = 'NO_BET_CONFIRMADO';
    out.decisao = 'NO_BET_CONFIRMADO_PERFIL';
    out.transforma = 'NO_BET_MANTIDO';
    return out;
  }

  out.status = 'NO_BET';
  out.decisao = 'NO_BET_BASE';
  out.transforma = 'NO_BET_MANTIDO';
  return out;
}

function avaliarPerfilContextualMercado(mercado, ctx, filtroMercado) {
  const out = perfilCriarResultado(mercado, filtroMercado);

  if (!ctx || !perfilIsObj(ctx)) {
    out.status = out.base_passou ? 'NORMAL' : 'NO_BET';
    out.decisao = out.base_passou ? 'ENTRADA_NORMAL_SEM_CTX' : 'NO_BET_SEM_CTX';
    out.transforma = 'SEM_CTX';
    out.motivos_alerta.push({
      codigo: 'SEM_PERFIL_CONTEXTUAL',
      descricao: 'Não encontrei roteiro_gols/contextual no JSON da âncora.',
    });
    return out;
  }

  if (mercado === 'OVER15') {
    const caminho2x0Pond = perfilToNum(ctx.rg_matchup_caminho_2x0_ponderado_score, 0);
    const leituraMatchup = perfilText(ctx.rg_matchup_leitura_final);
    const casaControla = perfilToNum(ctx.rg_casa_abre_controla_score, 0);
    const casaCede = perfilToNum(ctx.rg_casa_abre_cede_reacao_score, 0);
    const geralEmpata = perfilToNum(ctx.rg_geral_abre_pct_empatou, 0);
    const foraAbreTrava = perfilToNum(ctx.rg_match_se_fora_abrir_trava_score, 0);

    if (caminho2x0Pond >= 0.4959) {
      perfilAddPremium(out, 'OVER15_CAMINHO_2X0_PONDERADO', 1.1, 'Caminho 2x0 ponderado forte.', { caminho2x0Pond });
    }

    if (leituraMatchup === 'MATCHUP_CAMINHO_2X0') {
      perfilAddPremium(out, 'OVER15_MATCHUP_CAMINHO_2X0', 1.0, 'Leitura final aponta caminho 2x0.', { leituraMatchup });
    }

    if (casaControla >= 0.583 && casaCede <= 0.2973) {
      perfilAddPremium(out, 'OVER15_CONTROLA_SEM_CEDER', 0.9, 'Controle alto sem ceder reação.', { casaControla, casaCede });
    }

    // Over 1.5 já é forte; aqui começa como cautela, só vira veto se somar com outros sinais.
    if (geralEmpata >= 0.45) {
      perfilAddVeto(out, 'OVER15_ABRE_E_EMPATA_ALTO', 0.65, 'Tendência alta de empate depois de abrir.', { geralEmpata });
    }

    if (foraAbreTrava >= 0.3078) {
      perfilAddVeto(out, 'OVER15_FORA_ABRE_TRAVA', 0.55, 'Cenário de fora abrir trava o jogo.', { foraAbreTrava });
    }
  }

  if (mercado === 'OVER25') {
    const motor = perfilToNum(ctx.rg_matchup_over25_motor_score, 0);
    const caminho2x0Max = perfilToNum(ctx.rg_matchup_caminho_2x0_max_score, 0);
    const contextual = perfilToNum(ctx.rg_contextual_over25_score, 0);
    const casaSofreLeitura = perfilText(ctx.rg_casa_sofre_leitura);
    const geralVirouAj = perfilToNum(ctx.rg_geral_sofre_pct_virou_aj, 0);

    if (motor >= 0.562 || contextual >= 0.56) {
      perfilAddPremium(out, 'OVER25_MOTOR_CONTEXTUAL_FORTE', 1.0, 'Motor contextual de terceiro gol forte.', { motor, contextual });
    }

    if (casaSofreLeitura === 'SOFRE_E_REAGE_MAS_CEDE_ESPACO') {
      perfilAddPremium(out, 'OVER25_REAGE_MAS_CEDE_ESPACO', 0.8, 'Reação com espaço cedido.', { casaSofreLeitura });
    }

    if (geralVirouAj >= 0.314) {
      perfilAddPremium(out, 'OVER25_SOFRER_E_VIRAR_FORTE', 0.8, 'Perfil geral mostra reação/virada.', { geralVirouAj });
    }

    if (motor > 0 && motor <= 0.5188) {
      perfilAddVeto(out, 'OVER25_MOTOR_BAIXO', 1.0, 'Motor contextual baixo para Over 2.5.', { motor });
    }

    if (caminho2x0Max > 0 && caminho2x0Max <= 0.4312) {
      perfilAddVeto(out, 'OVER25_SEM_CAMINHO_2X0', 0.85, 'Baixo caminho 2x0.', { caminho2x0Max });
    }

    if (contextual > 0 && contextual <= 0.4799) {
      perfilAddVeto(out, 'OVER25_CONTEXTUAL_FRACO', 1.0, 'Score contextual Over 2.5 fraco.', { contextual });
    }
  }

  if (mercado === 'BTTS_SIM') {
    const bttsAvg = perfilToNum(ctx.rg_matchup_btts_motor_avg_score, 0);
    const casaBusca = perfilToNum(ctx.rg_casa_sofre_busca_empate_score, 0);
    const geralBusca1x1Aj = perfilToNum(ctx.rg_geral_sofre_pct_busca_1x1_aj, 0);
    const foraPerfil = perfilText(ctx.rg_fora_perfil_pos_1_gol_leitura);
    const casaDesmorona = perfilToNum(ctx.rg_casa_sofre_desmorona_score, 0);
    const casaVirouAj = perfilToNum(ctx.rg_casa_sofre_pct_virou_aj, 0);
    const doisZeroComReacao = perfilToNum(ctx.rg_contextual_2x0_com_reacao_score, 0);
    const casaAbreTrava = perfilToNum(ctx.rg_casa_abre_trava_score, 0);

    if (bttsAvg >= 0.5471) {
      perfilAddPremium(out, 'BTTS_MOTOR_AVG_FORTE', 1.0, 'Motor médio de BTTS forte.', { bttsAvg });
    }

    if (casaBusca >= 0.65) {
      perfilAddPremium(out, 'BTTS_CASA_BUSCA_EMPATE_FORTE', 0.9, 'Casa busca empate forte quando sai atrás.', { casaBusca });
    }

    if (geralBusca1x1Aj >= 0.50) {
      perfilAddPremium(out, 'BTTS_BUSCA_1X1_FORTE', 0.9, 'Busca 1x1 ajustada forte.', { geralBusca1x1Aj });
    }

    if (foraPerfil === 'PERFIL_POS_1_GOL_REACAO_FORTE') {
      perfilAddPremium(out, 'BTTS_FORA_REACAO_FORTE', 0.8, 'Fora tem perfil de reação forte.', { foraPerfil });
    }

    if (casaDesmorona <= 0.18 && geralBusca1x1Aj >= 0.475) {
      perfilAddPremium(out, 'BTTS_REACAO_SEM_DESMORONO', 1.1, 'Boa reação sem desmoronar.', { casaDesmorona, geralBusca1x1Aj });
    }

    if (casaVirouAj > 0 && casaVirouAj <= 0.059) {
      perfilAddVeto(out, 'BTTS_BAIXA_REACAO_VIRADA', 0.75, 'Baixa reação/virada.', { casaVirouAj });
    }

    if (doisZeroComReacao > 0 && doisZeroComReacao <= 0.431) {
      perfilAddVeto(out, 'BTTS_2X0_COM_REACAO_BAIXO', 1.0, 'Baixo 2x0 com reação; risco de jogo seco.', { doisZeroComReacao });
    }

    if (casaAbreTrava >= 0.245) {
      perfilAddVeto(out, 'BTTS_ABRE_E_TRAVA', 0.9, 'Quem abre tende a travar.', { casaAbreTrava });
    }
  }

  if (mercado === 'UNDER35') {
    const contextualOver25 = perfilToNum(ctx.rg_contextual_over25_score, 0);
    const contextualOver15 = perfilToNum(ctx.rg_contextual_over15_score, 0);
    const geralNaoBusca = perfilToNum(ctx.rg_geral_sofre_nao_busca_score, 0);
    const maxDesmorona = perfilToNum(ctx.rg_max_sofre_desmorona_score, 0);
    const travaMax = perfilToNum(ctx.rg_matchup_trava_1x0_max_score, 0);
    const maxCede = perfilToNum(ctx.rg_max_abre_cede_reacao_score, 0);
    const casaAbreLeitura = perfilText(ctx.rg_casa_abre_leitura);
    const diff2x0 = perfilToNum(ctx.rg_matchup_caminho_2x0_diff_score, 0);

    if (contextualOver25 > 0 && contextualOver25 <= 0.4363) {
      perfilAddPremium(out, 'UNDER35_OVER25_CONTEXTUAL_BAIXO', 1.1, 'Motor contextual Over 2.5 baixo.', { contextualOver25 });
    }

    if (geralNaoBusca >= 0.4929) {
      perfilAddPremium(out, 'UNDER35_SOFRIDO_NAO_BUSCA', 0.9, 'Quem sai atrás não busca bem.', { geralNaoBusca });
    }

    if (maxDesmorona >= 0.358 && contextualOver15 > 0 && contextualOver15 <= 0.498) {
      perfilAddPremium(out, 'UNDER35_DESMORONA_SEM_OVER15', 1.2, 'Desmorona sem motor de trocação.', { maxDesmorona, contextualOver15 });
    }

    if (contextualOver15 > 0 && contextualOver15 <= 0.498 && travaMax >= 0.35) {
      perfilAddPremium(out, 'UNDER35_TRAVA_FORTE', 1.1, 'Trava forte com baixo motor Over.', { contextualOver15, travaMax });
    }

    if (maxCede >= 0.601) {
      perfilAddVeto(out, 'UNDER35_ABRE_CEDE_REACAO', 1.0, 'Quem abre cede reação demais.', { maxCede });
    }

    if (casaAbreLeitura === 'ABRE_E_CEDE_REACAO_REAL') {
      perfilAddVeto(out, 'UNDER35_CASA_CEDE_REACAO_REAL', 0.9, 'Casa abre e cede reação real.', { casaAbreLeitura });
    }

    if (diff2x0 >= 0.1844) {
      perfilAddVeto(out, 'UNDER35_DEPENDE_QUEM_ABRE', 0.7, 'Confronto depende muito de quem abre.', { diff2x0 });
    }
  }

  if (mercado === 'UNDER25') {
    const perdeControlePond = perfilToNum(ctx.rg_matchup_perde_controle_ponderado_score, 0);
    const foraSofre1x1 = perfilToNum(ctx.rg_fora_abre_pct_sofreu_1x1, 0);
    const foraCede = perfilToNum(ctx.rg_fora_abre_cede_reacao_score, 0);

    if (
      perdeControlePond > 0 &&
      perdeControlePond <= 0.2991 &&
      foraSofre1x1 > 0 &&
      foraSofre1x1 <= 0.1192 &&
      foraCede > 0 &&
      foraCede <= 0.3769
    ) {
      perfilAddPremium(out, 'UNDER25_ULTRA_PREMIUM', 1.3, 'Under 2.5 ultra seletivo por perfil.', { perdeControlePond, foraSofre1x1, foraCede });
    } else {
      perfilAddVeto(out, 'UNDER25_MANTER_BLOQUEADO', 1.2, 'Under 2.5 segue perigoso sem ultra premium.', { perdeControlePond, foraSofre1x1, foraCede });
    }
  }

  if (mercado === '1X2_CASA') {
    const geralContinua = perfilToNum(ctx.rg_geral_abre_continua_criando_score, 0);
    const geralCompContinua = perfilToNum(ctx.rg_geral_abre_comp_continuou_criando_aj, 0);
    const casaCompContinua = perfilToNum(ctx.rg_casa_abre_comp_continuou_criando_aj, 0);
    const geralAmplia = perfilToNum(ctx.rg_geral_abre_amplia_score, 0);
    const casaAbrir2x0 = perfilToNum(ctx.rg_match_se_casa_abrir_caminho_2x0_score, 0);
    const parouPlacar = perfilToNum(ctx.rg_geral_abre_pct_parou_no_placar, 0);

    if (geralContinua >= 0.79) {
      perfilAddPremium(out, '1X2_CASA_CONTINUA_CRIANDO', 1.1, 'Perfil geral continua criando quando abre.', { geralContinua });
    }

    if (geralCompContinua >= 0.819) {
      perfilAddPremium(out, '1X2_CASA_COMP_CONTINUA_FORTE', 1.0, 'Componente continua criando forte.', { geralCompContinua });
    }

    if (casaCompContinua >= 0.758) {
      perfilAddPremium(out, '1X2_CASA_ABRE_CONTINUA', 0.9, 'Casa quando abre mantém criação.', { casaCompContinua });
    }

    if (geralAmplia > 0 && geralAmplia <= 0.455) {
      perfilAddVeto(out, '1X2_CASA_NAO_AMPLIA', 1.0, 'Baixo score de ampliação.', { geralAmplia });
    }

    if (casaAbrir2x0 > 0 && casaAbrir2x0 <= 0.4193) {
      perfilAddVeto(out, '1X2_CASA_SEM_CAMINHO_2X0', 1.0, 'Casa abrindo sem caminho 2x0.', { casaAbrir2x0 });
    }

    if (parouPlacar >= 0.4964) {
      perfilAddVeto(out, '1X2_CASA_PARA_NO_PLACAR', 0.8, 'Perfil para no placar depois de abrir.', { parouPlacar });
    }
  }

  if (mercado === '1X2_FORA') {
    const riscoSofrerPrimeiro = perfilToNum(ctx.rg_context_fora_vs_casa_abre_forte_risco_sofrer_primeiro_score, 0);
    const bigChancesSofre = perfilToNum(ctx.rg_geral_sofre_big_chances_medio, 0);
    const geralAbrePerdeu = perfilToNum(ctx.rg_geral_abre_pct_perdeu, 0);
    const geralDesmorona = perfilToNum(ctx.rg_geral_sofre_desmorona_score, 0);
    const foraSaiAtrasDesmorona = perfilToNum(ctx.rg_context_fora_sai_atras_vs_casa_desmorona_score, 0);
    const geralBusca1x1 = perfilToNum(ctx.rg_geral_sofre_pct_busca_1x1, 0);

    if (riscoSofrerPrimeiro > 0 && riscoSofrerPrimeiro <= 0.35) {
      perfilAddPremium(out, '1X2_FORA_BAIXO_RISCO_SOFRER_PRIMEIRO', 1.0, 'Fora tem baixo risco de sofrer primeiro contra esse perfil.', { riscoSofrerPrimeiro });
    }

    if (bigChancesSofre > 0 && bigChancesSofre <= 0.8506) {
      perfilAddPremium(out, '1X2_FORA_BAIXA_BIG_CHANCE_CONTRA', 0.7, 'Baixa concessão de grandes chances no cenário.', { bigChancesSofre });
    }

    if (geralAbrePerdeu >= 0.28 && geralDesmorona >= 0.30) {
      perfilAddPremium(out, '1X2_FORA_ADV_COLAPSA', 0.9, 'Cenário favorece colapso do adversário.', { geralAbrePerdeu, geralDesmorona });
    }

    if (foraSaiAtrasDesmorona >= 0.3726) {
      perfilAddVeto(out, '1X2_FORA_DESMORONA_SAI_ATRAS', 1.1, 'Fora saindo atrás tende a desmoronar.', { foraSaiAtrasDesmorona });
    }

    if (geralBusca1x1 >= 0.40) {
      perfilAddVeto(out, '1X2_FORA_ADV_BUSCA_1X1', 0.9, 'Adversário/cenário busca 1x1 com frequência.', { geralBusca1x1 });
    }
  }

  return perfilFinalizarResultado(out, filtroMercado);
}

function aplicarPerfilContextualAoFiltroOperacional({ filtroOperacional, telemetria }) {
  const ctx = montarPerfilContextualFlat(telemetria);
  const f = filtroOperacional?.filtros || {};

  const mercados = {
    over15: avaliarPerfilContextualMercado('OVER15', ctx, f.over15),
    over25: avaliarPerfilContextualMercado('OVER25', ctx, f.over25),
    under25: avaliarPerfilContextualMercado('UNDER25', ctx, f.under25),
    under35: avaliarPerfilContextualMercado('UNDER35', ctx, f.under35),
    btts_sim: avaliarPerfilContextualMercado('BTTS_SIM', ctx, f.btts_sim),
    casa: avaliarPerfilContextualMercado('1X2_CASA', ctx, f.casa),
    fora: avaliarPerfilContextualMercado('1X2_FORA', ctx, f.fora),
  };

  const resumo = {
    premium: Object.entries(mercados)
      .filter(([, v]) => v.status === 'PREMIUM' || v.status === 'RESGATE_NO_BET')
      .map(([k, v]) => ({ mercado: k, status: v.status, score: v.score, motivos: v.motivos_premium.map(m => m.codigo) })),

    cautela: Object.entries(mercados)
      .filter(([, v]) => v.status === 'CAUTELOSA')
      .map(([k, v]) => ({ mercado: k, status: v.status, score: v.score, motivos: v.motivos_veto.map(m => m.codigo) })),

    veto: Object.entries(mercados)
      .filter(([, v]) => v.status === 'VETO')
      .map(([k, v]) => ({ mercado: k, status: v.status, score: v.score, motivos: v.motivos_veto.map(m => m.codigo) })),

    resgate: Object.entries(mercados)
      .filter(([, v]) => v.status === 'RESGATE_NO_BET')
      .map(([k, v]) => ({ mercado: k, status: v.status, score: v.score, motivos: v.motivos_premium.map(m => m.codigo) })),
  };

  return {
    ...(filtroOperacional || {}),
    perfil_contextual: {
      versao: PERFIL_CONTEXTUAL_VERSAO,
      gerado_em: new Date().toISOString(),
      ctx,
      mercados,
      resumo,
    },
  };
}

function normalizeHistoricoLeitura(v) {
  const s = String(v || '').trim().toLowerCase();

  if (!s) return 'neutro';

  if ([
    'a_favor_lambda',
    'a_favor',
    'favor',
    'favoravel',
    'favorável'
  ].includes(s)) {
    return 'a_favor_lambda';
  }

  if ([
    'contra_lambda',
    'contra',
    'desfavoravel',
    'desfavorável'
  ].includes(s)) {
    return 'contra_lambda';
  }

  if ([
    'cobertura_fraca',
    'fraca',
    'sem_cobertura'
  ].includes(s)) {
    return 'cobertura_fraca';
  }

  return 'neutro';
}

function readHistoricoMarket(telemetria, aliases) {
  const containers = [
    telemetria?.historico_contexto,
    telemetria?.historico,
    telemetria?.historico_mercados,
    telemetria?.mercado_historico,
    telemetria?.leitura_historica,
    telemetria
  ].filter(Boolean);

  let src = null;
  let aliasUsado = aliases[0];

  for (const container of containers) {
    for (const alias of aliases) {
      if (container?.[alias] && typeof container[alias] === 'object') {
        src = container[alias];
        aliasUsado = alias;
        break;
      }
    }
    if (src) break;
  }

  const leitura = normalizeHistoricoLeitura(
    pickValue(
      src?.leitura,
      src?.historico_leitura,
      src?.status,
      src?.sinal,
      ...aliases.map(alias => telemetria?.[`${alias}_historico_leitura`]),
      ...aliases.map(alias => telemetria?.[`${alias}_leitura_historico`])
    )
  );

  const homeN = toNum(
    pickValue(
      src?.rt_home_hist_n,
      src?.home_n,
      src?.n_home,
      telemetria?.rt_home_hist_n,
      telemetria?.historico_rt_home_n
    ),
    0
  );

  const awayN = toNum(
    pickValue(
      src?.rt_away_hist_n,
      src?.away_n,
      src?.n_away,
      telemetria?.rt_away_hist_n,
      telemetria?.historico_rt_away_n
    ),
    0
  );

  return {
    leitura,
    homeN,
    awayN,
    coberturaBoa: homeN >= 10 && awayN >= 10,
    aliasUsado
  };
}

function getAnchorAplicacao(telemetria) {
  return telemetria?.anchor_mercados_aplicacao || null;
}

function getAnchorMercadoInfo(telemetria, market) {
  const anchor = getAnchorAplicacao(telemetria);

  const marketKeyMap = {
    over15: 'over15',
    under15: 'over15',

    over25: 'over25',
    under25: 'over25',

    over35: 'over35',
    under35: 'over35',

    btts_sim: 'btts_sim',
    btts_nao: 'btts_sim',
  };

  const key = marketKeyMap[market] || market;

  const mercadoNode =
    anchor?.contextual?.mercados?.[key] ||
    {};

  return {
    anchor,
    key,
    mercadoNode,
    politica: mercadoNode?.politica_anchor || {},
    combinado: mercadoNode?.combinado || {},
  };
}

function anchorBucketNivel(forcaBucket, absDelta) {
  const s = String(forcaBucket || '');

  if (s.includes('04_')) return 4;
  if (s.includes('03_')) return 3;
  if (s.includes('02_')) return 2;
  if (s.includes('01_')) return 1;

  const d = Math.abs(Number(absDelta || 0));

  if (d >= 2.50) return 4;
  if (d >= 1.50) return 3;
  if (d >= 0.75) return 2;
  if (d >= 0.25) return 1;

  return 0;
}
function clampAnchorEntrada(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function classificarZonaLambdaPorMercado(market, scoreBase) {
  const s = Number(scoreBase || 0);

  /*
    A zona é sempre em cima do score do próprio mercado:
    - over25 usa scoreOver25
    - under25 usa scoreUnder25
    - btts_nao usa scoreBttsNao
    etc.

    A âncora NÃO substitui esse score.
    Ela só ajusta conforme a zona.
  */

  if (market === 'over15') {
    if (s < 55) return 'muito_contra';
    if (s < 65) return 'duvida';
    if (s < 75) return 'favoravel';
    return 'muito_favoravel';
  }

  if (market === 'under15') {
    return 'bloqueado';
  }

  if (market === 'under35') {
    if (s < 55) return 'muito_contra';
    if (s < 65) return 'duvida';
    if (s < 75) return 'favoravel';
    return 'muito_favoravel';
  }

  if (market === 'btts_nao') {
    if (s < 50) return 'muito_contra';
    if (s < 55) return 'contra';
    if (s < 60) return 'duvida';
    if (s < 65) return 'favoravel';
    return 'muito_favoravel';
  }

  if (market === 'over35') {
    if (s < 45) return 'muito_contra';
    if (s < 50) return 'contra';
    if (s < 55) return 'duvida';
    if (s < 65) return 'favoravel';
    return 'muito_favoravel';
  }

  if (market === 'btts_sim') {
    if (s < 45) return 'muito_contra';
    if (s < 50) return 'contra';
    if (s < 60) return 'duvida';
    if (s < 65) return 'favoravel';
    return 'muito_favoravel';
  }

  // over25 / under25 e fallback
  if (s < 42) return 'muito_contra';
  if (s < 48) return 'contra';
  if (s < 55) return 'duvida';
  if (s < 65) return 'favoravel';
  return 'muito_favoravel';
}

function deltaPorZonaLambda({
  market,
  zona,
  confianca,
  aFavor,
}) {
  const nivelConf = {
    neutra: 0,
    leve: 1,
    moderada: 2,
    alta: 3,
    muito_alta: 4,
    contra_leve: 1,
    contra_moderada: 2,
    contra_alta: 3,
    contra_muito_alta: 4,
  }[confianca] || 0;

  if (nivelConf <= 0) return 0;

  /*
    Base geral:
    - Se lambda está muito contra, a âncora não transforma sozinha em entrada.
    - Se lambda está em dúvida, a âncora tem mais força.
    - Se lambda já está a favor, a âncora confirma ou corta.
  */

  const tabelaAFavor = {
    muito_contra: [0, 1, 3, 5, 6],
    contra: [0, 2, 5, 8, 10],
    duvida: [0, 3, 6, 9, 12],
    favoravel: [0, 2, 4, 6, 8],
    muito_favoravel: [0, 1, 2, 3, 4],
  };

  const tabelaContra = {
    muito_contra: [0, 0, -1, -2, -3],
    contra: [0, -1, -2, -3, -4],
    duvida: [0, -3, -6, -9, -12],
    favoravel: [0, -4, -8, -11, -14],
    muito_favoravel: [0, -5, -9, -13, -14],
  };

  let delta = aFavor
    ? (tabelaAFavor[zona]?.[nivelConf] || 0)
    : (tabelaContra[zona]?.[nivelConf] || 0);

  /*
    Ajustes por mercado.
  */

  if (market === 'over15') {
    // Over 1.5 é forte por conta própria.
    // A âncora só reforça e quase não corta.
    if (aFavor) {
      delta = Math.min(delta, 5);
    } else {
      delta = Math.max(delta, -2);
    }
  }

  if (market === 'under15') {
    delta = 0;
  }

  if (market === 'over25') {
    // Over 2.5 usa o delta base da tabela.
    // O bônus extra em zona de dúvida/contra piorou no teste.
    // Agora a camada da casa já entra como confirmação adicional.
    delta *= 1.0;
  }

  if (market === 'under25') {
    // Under 2.5 precisa ser um pouco mais seletivo.
    delta *= 0.95;
  }

  if (market === 'over35') {
    // Over 3.5 só seletivo.
    if (aFavor && nivelConf < 3) {
      delta = Math.min(delta, 3);
    }

    if (aFavor) {
      delta *= 0.75;
    } else {
      delta *= 0.85;
    }
  }

  if (market === 'under35') {
    // Under 3.5 é estável, mas sem exagerar.
    delta *= 0.85;
  }

  if (market === 'btts_sim') {
    delta *= 0.85;
  }

  if (market === 'btts_nao') {
    /*
      BTTS Não é perigoso.
      Leve e moderado não devem forçar muito.
      O bloco do mercado btts_nao dentro de calcularDeltaEntradaPorAncora()
      ainda vai aplicar a trava principal.
    */
    if (aFavor && nivelConf <= 1) {
      delta = 0;
    } else {
      delta *= 0.65;
    }
  }

  return Math.round(clampAnchorEntrada(delta, -14, 14));
}

function calcularDeltaEntradaPorAncora(market, scoreAtual, telemetria) {
  const {
    politica,
    combinado,
    key,
  } = getAnchorMercadoInfo(telemetria, market);

  const scoreBaseLambda = Math.round(
    clampAnchorEntrada(Number(scoreAtual || 0), 0, 100)
  );

  const zonaLambda = classificarZonaLambdaPorMercado(market, scoreBaseLambda);

  const decisao = String(politica?.decisao || 'ignorar');
  const direcao = String(politica?.direcao || 'neutro');
  const motivo = String(politica?.motivo || combinado?.politica_motivo || 'sem_motivo');

  const deltaPonderado = Number(
    politica?.delta_ponderado ??
    combinado?.delta_ponderado ??
    0
  );

  const peso = Number(
    politica?.peso ??
    combinado?.politica_peso ??
    0
  );

  const evMedia = Number(politica?.ev_media || 0);
  const resMedia = Number(politica?.res_media || 0);
  const prodMedia = Number(politica?.prod_media || 0);

  const sinaisOver = Number(politica?.sinais_over || 0);
  const sinaisUnder = Number(politica?.sinais_under || 0);

  const nivel = anchorBucketNivel(
    politica?.forca_bucket,
    Math.abs(deltaPonderado)
  );

  const casaOverOk = !!politica?.casa_over_ok;
  const foraOverOk = !!politica?.fora_over_ok;
  const casaOverForte = !!politica?.casa_over_forte;
  const foraOverForte = !!politica?.fora_over_forte;

  const casaUnderOk = !!politica?.casa_under_ok;
  const foraUnderOk = !!politica?.fora_under_ok;
  const casaUnderForte = !!politica?.casa_under_forte;
  const foraUnderForte = !!politica?.fora_under_forte;

  const ambosOver = casaOverOk && foraOverOk;
  const ambosUnder = casaUnderOk && foraUnderOk;
  const umOverForte = casaOverForte || foraOverForte;
  const umUnderForte = casaUnderForte || foraUnderForte;

  const baseRet = {
    market,
    anchor_key: key,

    usar: false,
    delta: 0,

    score_base_lambda: scoreBaseLambda,
    zona_lambda: zonaLambda,

    decisao,
    direcao,
    motivo,

    confianca: 'neutra',
    motivo_confianca: 'sem_confirmacao_suficiente',

    nivel,
    peso: +peso.toFixed(3),
    delta_ponderado: +deltaPonderado.toFixed(3),

    ev_media: +evMedia.toFixed(3),
    res_media: +resMedia.toFixed(3),
    prod_media: +prodMedia.toFixed(3),

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

  /*
    Under 1.5 bloqueado.
    Over 1.5 usa âncora só como contexto.
  */
  if (market === 'under15') {
    return {
      ...baseRet,
      usar: false,
      delta: 0,
      confianca: 'bloqueado',
      motivo_confianca: 'under15_nao_operacional_por_ancora',
      motivo_aplicacao: 'under15_bloqueado_operacionalmente',
    };
  }

  const anchorInvalida =
    !politica ||
    decisao === 'ignorar' ||
    peso <= 0 ||
    nivel <= 0 ||
    Math.abs(deltaPonderado) < 0.10;

  if (anchorInvalida) {
    return {
      ...baseRet,
      motivo_aplicacao: 'anchor_ignorada_na_entrada',
    };
  }

  /*
    =========================================================
    CONFIRMAÇÕES DE FORÇA
    =========================================================
  */

  const overMuitoForte =
    nivel >= 3 &&
    (
      ambosOver ||
      (umOverForte && sinaisOver >= 5)
    ) &&
    evMedia >= 0.18 &&
    resMedia >= 0.18;

  const overForte =
    nivel >= 2 &&
    (
      ambosOver ||
      umOverForte ||
      sinaisOver >= 5
    ) &&
    evMedia >= 0.12 &&
    resMedia >= 0.10;

  const overModerado =
    (
      sinaisOver >= 4 ||
      umOverForte ||
      ambosOver
    ) &&
    evMedia >= 0.06 &&
    resMedia >= 0.05;

  const overLeve =
    sinaisOver >= 3 &&
    evMedia >= 0.00 &&
    resMedia >= -0.02;

  const underMuitoForte =
    nivel >= 3 &&
    (
      ambosUnder ||
      (umUnderForte && sinaisUnder >= 5)
    ) &&
    evMedia <= -0.14 &&
    resMedia <= -0.16;

  const underForte =
    nivel >= 2 &&
    (
      ambosUnder ||
      umUnderForte ||
      sinaisUnder >= 5
    ) &&
    evMedia <= -0.08 &&
    resMedia <= -0.10;

  const underModerado =
    (
      sinaisUnder >= 4 ||
      umUnderForte ||
      ambosUnder
    ) &&
    evMedia <= -0.04 &&
    resMedia <= -0.05;

  const underLeve =
    sinaisUnder >= 3 &&
    evMedia <= 0.00 &&
    resMedia <= 0.02;

  /*
    Travas da auditoria.
  */

  const producaoBloqueiaUnder =
    evMedia > 0.08 ||
    prodMedia > 0.05 ||
    resMedia > 0.12;

  const faltaBaixaBilateralBttsNao =
    evMedia > -0.06 ||
    resMedia > -0.08 ||
    sinaisUnder < 4;

  const over35SemConfirmacao =
    evMedia < 0.15 ||
    resMedia < 0.10 ||
    sinaisOver < 4;

  const under35BloqueadoPorProducao =
    evMedia > 0.08 ||
    resMedia > 0.10;

  function aplicar({
    aFavor,
    confianca,
    motivoConfianca,
    motivoAplicacao,
    forcarDelta = null,
  }) {
    const delta = forcarDelta !== null
      ? Math.round(clampAnchorEntrada(forcarDelta, -14, 14))
      : deltaPorZonaLambda({
        market,
        zona: zonaLambda,
        confianca,
        aFavor,
      });

    return {
      ...baseRet,
      usar: delta !== 0,
      delta,
      confianca,
      motivo_confianca: motivoConfianca,
      motivo_aplicacao: motivoAplicacao,
    };
  }

  /*
    =========================================================
    OVER 1.5
    =========================================================

    Só reforça.
    Não corta forte.
    Não cria Under 1.5.
  */

  if (market === 'over15') {
    if (decisao.includes('favorece_over') || direcao === 'over') {
      if (overMuitoForte || overForte) {
        return aplicar({
          aFavor: true,
          confianca: 'alta',
          motivoConfianca: 'over15_confirmacao_forte_contextual',
          motivoAplicacao: 'anchor_reforca_over15_forte',
        });
      }

      if (overModerado) {
        return aplicar({
          aFavor: true,
          confianca: 'moderada',
          motivoConfianca: 'over15_confirmacao_moderada_contextual',
          motivoAplicacao: 'anchor_reforca_over15_moderado',
        });
      }

      if (overLeve) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'over15_confirmacao_leve_contextual',
          motivoAplicacao: 'anchor_reforca_over15_leve',
        });
      }
    }

    if (decisao.includes('reduz_over') || direcao.includes('under')) {
      // Over 1.5 não deve ser morto pela âncora.
      return aplicar({
        aFavor: false,
        confianca: 'contra_leve',
        motivoConfianca: 'over15_contra_usado_apenas_como_contexto',
        motivoAplicacao: 'anchor_reduz_over15_muito_leve',
        forcarDelta: -1,
      });
    }

    return {
      ...baseRet,
      motivo_aplicacao: 'over15_anchor_sem_confirmacao_util',
    };
  }

  /*
    =========================================================
    OVER 2.5
    =========================================================
  */

  if (market === 'over25') {
    if (decisao.includes('favorece_over') || direcao === 'over' || direcao === 'over_leve') {
      if (overMuitoForte) {
        return aplicar({
          aFavor: true,
          confianca: 'muito_alta',
          motivoConfianca: 'over25_lambda_e_ancora_muito_fortes',
          motivoAplicacao: 'anchor_reforca_over25_muito_forte',
        });
      }

      if (overForte) {
        return aplicar({
          aFavor: true,
          confianca: 'alta',
          motivoConfianca: 'over25_lambda_e_ancora_confirmam',
          motivoAplicacao: 'anchor_reforca_over25_forte',
        });
      }

      if (overModerado) {
        return aplicar({
          aFavor: true,
          confianca: 'moderada',
          motivoConfianca: 'over25_confirmacao_moderada',
          motivoAplicacao: 'anchor_reforca_over25_moderado',
        });
      }

      if (overLeve) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'over25_confirmacao_leve',
          motivoAplicacao: 'anchor_reforca_over25_leve',
        });
      }
    }

    if (decisao.includes('favorece_under') || decisao.includes('leve_under') || direcao.includes('under')) {
      if (producaoBloqueiaUnder) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_leve',
          motivoConfianca: 'pull_under_reduzido_por_producao_nao_baixa',
          motivoAplicacao: 'pull_contra_over25_reduzido_por_producao_alta',
          forcarDelta: -2,
        });
      }

      if (underMuitoForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_muito_alta',
          motivoConfianca: 'under25_confirmacao_muito_forte_contra_over',
          motivoAplicacao: 'anchor_corta_over25_muito_forte',
        });
      }

      if (underForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_alta',
          motivoConfianca: 'under25_confirmacao_forte_contra_over',
          motivoAplicacao: 'anchor_corta_over25_forte',
        });
      }

      if (underModerado) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_moderada',
          motivoConfianca: 'under25_confirmacao_moderada_contra_over',
          motivoAplicacao: 'anchor_corta_over25_moderado',
        });
      }

      if (underLeve) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_leve',
          motivoConfianca: 'under25_confirmacao_leve_contra_over',
          motivoAplicacao: 'anchor_corta_over25_leve',
        });
      }
    }

    return {
      ...baseRet,
      motivo_aplicacao: 'over25_contexto_conflitante_ou_sem_confirmacao',
    };
  }

  /*
    =========================================================
    UNDER 2.5
    =========================================================
  */

  if (market === 'under25') {
    if (decisao.includes('favorece_under') || decisao.includes('leve_under') || direcao.includes('under')) {
      if (producaoBloqueiaUnder) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'under25_reduzido_por_producao_nao_baixa',
          motivoAplicacao: 'under25_reduzido_por_producao_nao_baixa',
          forcarDelta: 1,
        });
      }

      if (underMuitoForte) {
        return aplicar({
          aFavor: true,
          confianca: 'muito_alta',
          motivoConfianca: 'under25_lambda_e_ancora_muito_fortes',
          motivoAplicacao: 'anchor_reforca_under25_muito_forte',
        });
      }

      if (underForte) {
        return aplicar({
          aFavor: true,
          confianca: 'alta',
          motivoConfianca: 'under25_lambda_e_ancora_confirmam',
          motivoAplicacao: 'anchor_reforca_under25_forte',
        });
      }

      if (underModerado) {
        return aplicar({
          aFavor: true,
          confianca: 'moderada',
          motivoConfianca: 'under25_confirmacao_moderada',
          motivoAplicacao: 'anchor_reforca_under25_moderado',
        });
      }

      if (underLeve) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'under25_confirmacao_leve',
          motivoAplicacao: 'anchor_reforca_under25_leve',
        });
      }
    }

    if (decisao.includes('favorece_over') || direcao === 'over' || direcao === 'over_leve') {
      if (overMuitoForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_muito_alta',
          motivoConfianca: 'over25_confirmacao_muito_forte_contra_under',
          motivoAplicacao: 'anchor_corta_under25_muito_forte',
        });
      }

      if (overForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_alta',
          motivoConfianca: 'over25_confirmacao_forte_contra_under',
          motivoAplicacao: 'anchor_corta_under25_forte',
        });
      }

      if (overModerado) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_moderada',
          motivoConfianca: 'over25_confirmacao_moderada_contra_under',
          motivoAplicacao: 'anchor_corta_under25_moderado',
        });
      }

      if (overLeve) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_leve',
          motivoConfianca: 'over25_confirmacao_leve_contra_under',
          motivoAplicacao: 'anchor_corta_under25_leve',
        });
      }
    }

    return {
      ...baseRet,
      motivo_aplicacao: 'under25_contexto_conflitante_ou_sem_confirmacao',
    };
  }

  /*
    =========================================================
    OVER 3.5
    =========================================================
  */

  if (market === 'over35') {
    if (decisao.includes('favorece_over') || direcao === 'over') {
      if (over35SemConfirmacao) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'over35_confirmacao_insuficiente',
          motivoAplicacao: 'over35_reduzido_por_confirmacao_insuficiente',
          forcarDelta: 1,
        });
      }

      if (overMuitoForte || overForte) {
        return aplicar({
          aFavor: true,
          confianca: 'alta',
          motivoConfianca: 'over35_contexto_explosivo_confirmado',
          motivoAplicacao: 'anchor_reforca_over35_forte',
        });
      }

      if (overModerado) {
        return aplicar({
          aFavor: true,
          confianca: 'moderada',
          motivoConfianca: 'over35_confirmacao_moderada',
          motivoAplicacao: 'anchor_reforca_over35_moderado',
        });
      }

      return {
        ...baseRet,
        motivo_aplicacao: 'over35_nao_forca_com_confirmacao_leve',
      };
    }

    if (decisao.includes('favorece_under') || direcao.includes('under')) {
      if (underMuitoForte || underForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_alta',
          motivoConfianca: 'under35_confirmacao_forte_contra_over35',
          motivoAplicacao: 'anchor_corta_over35_forte',
        });
      }

      if (underModerado) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_moderada',
          motivoConfianca: 'under35_confirmacao_moderada_contra_over35',
          motivoAplicacao: 'anchor_corta_over35_moderado',
        });
      }
    }

    return {
      ...baseRet,
      motivo_aplicacao: 'over35_contexto_conflitante_ou_sem_confirmacao',
    };
  }

  /*
    =========================================================
    UNDER 3.5
    =========================================================
  */

  if (market === 'under35') {
    if (decisao.includes('favorece_under') || direcao.includes('under')) {
      if (under35BloqueadoPorProducao) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'under35_reduzido_por_producao_nao_baixa',
          motivoAplicacao: 'under35_reduzido_por_producao_nao_baixa',
          forcarDelta: 1,
        });
      }

      if (underMuitoForte || underForte) {
        return aplicar({
          aFavor: true,
          confianca: 'alta',
          motivoConfianca: 'under35_confirmacao_forte',
          motivoAplicacao: 'anchor_reforca_under35_forte',
        });
      }

      if (underModerado) {
        return aplicar({
          aFavor: true,
          confianca: 'moderada',
          motivoConfianca: 'under35_confirmacao_moderada',
          motivoAplicacao: 'anchor_reforca_under35_moderado',
        });
      }

      if (underLeve) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'under35_confirmacao_leve',
          motivoAplicacao: 'anchor_reforca_under35_leve',
        });
      }
    }

    if (decisao.includes('favorece_over') || direcao === 'over') {
      if (overMuitoForte || overForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_alta',
          motivoConfianca: 'over35_confirmacao_forte_contra_under35',
          motivoAplicacao: 'anchor_corta_under35_forte',
        });
      }

      if (overModerado) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_moderada',
          motivoConfianca: 'over35_confirmacao_moderada_contra_under35',
          motivoAplicacao: 'anchor_corta_under35_moderado',
        });
      }
    }

    return {
      ...baseRet,
      motivo_aplicacao: 'under35_contexto_conflitante_ou_sem_confirmacao',
    };
  }

  /*
    =========================================================
    BTTS SIM
    =========================================================
  */

  if (market === 'btts_sim') {
    if (decisao.includes('btts_sim') || direcao.includes('btts_sim')) {
      if (overMuitoForte || overForte) {
        return aplicar({
          aFavor: true,
          confianca: 'alta',
          motivoConfianca: 'btts_sim_confirmacao_bilateral_forte',
          motivoAplicacao: 'anchor_reforca_btts_sim_forte',
        });
      }

      if (overModerado) {
        return aplicar({
          aFavor: true,
          confianca: 'moderada',
          motivoConfianca: 'btts_sim_confirmacao_moderada',
          motivoAplicacao: 'anchor_reforca_btts_sim_moderado',
        });
      }

      if (overLeve) {
        return aplicar({
          aFavor: true,
          confianca: 'leve',
          motivoConfianca: 'btts_sim_confirmacao_leve',
          motivoAplicacao: 'anchor_reforca_btts_sim_leve',
        });
      }
    }

    if (decisao.includes('btts_nao') || direcao.includes('btts_nao')) {
      if (faltaBaixaBilateralBttsNao) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_leve',
          motivoConfianca: 'btts_nao_sem_baixa_bilateral_forte',
          motivoAplicacao: 'pull_contra_btts_sim_reduzido',
          forcarDelta: -2,
        });
      }

      if (underMuitoForte || underForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_alta',
          motivoConfianca: 'btts_nao_confirmacao_forte_contra_btts_sim',
          motivoAplicacao: 'anchor_corta_btts_sim_forte',
        });
      }

      if (underModerado) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_moderada',
          motivoConfianca: 'btts_nao_confirmacao_moderada_contra_btts_sim',
          motivoAplicacao: 'anchor_corta_btts_sim_moderado',
        });
      }
    }

    return {
      ...baseRet,
      motivo_aplicacao: 'btts_sim_contexto_conflitante_ou_sem_confirmacao',
    };
  }

  /*
    =========================================================
    BTTS NÃO
    =========================================================
  */

  /*
  =========================================================
  BTTS NÃO
  =========================================================

  Mercado perigoso.
  Só pode ganhar peso real quando a âncora mostra baixa bilateral forte.
  Moderado/leves não devem criar entrada.
*/

  if (market === 'btts_nao') {
    if (decisao.includes('btts_nao') || direcao.includes('btts_nao')) {
      /*
        Se não tem baixa bilateral clara, não força BTTS Não.
        Antes isso ainda dava +1/+2 e deixava algumas entradas ruins passarem.
      */
      if (faltaBaixaBilateralBttsNao) {
        return {
          ...baseRet,
          usar: false,
          delta: 0,
          confianca: 'neutra',
          motivo_confianca: 'btts_nao_sem_baixa_bilateral_suficiente',
          motivo_aplicacao: 'btts_nao_bloqueado_por_falta_de_baixa_bilateral',
        };
      }

      /*
        Só estes dois casos dão peso real.
      */
      if (underMuitoForte) {
        return aplicar({
          aFavor: true,
          confianca: 'muito_alta',
          motivoConfianca: 'btts_nao_baixa_bilateral_muito_forte',
          motivoAplicacao: 'anchor_reforca_btts_nao_muito_forte',
        });
      }

      if (underForte) {
        return aplicar({
          aFavor: true,
          confianca: 'alta',
          motivoConfianca: 'btts_nao_baixa_bilateral_forte',
          motivoAplicacao: 'anchor_reforca_btts_nao_forte',
        });
      }

      /*
        Moderado não cria entrada. No máximo, fica registrado como contexto.
      */
      if (underModerado) {
        return {
          ...baseRet,
          usar: false,
          delta: 0,
          confianca: 'moderada_sem_entrada',
          motivo_confianca: 'btts_nao_moderado_nao_e_suficiente',
          motivo_aplicacao: 'btts_nao_moderado_bloqueado',
        };
      }

      return {
        ...baseRet,
        motivo_aplicacao: 'btts_nao_nao_forca_com_confirmacao_leve',
      };
    }

    /*
      Se a âncora confirma BTTS Sim, corta BTTS Não.
    */
    if (decisao.includes('btts_sim') || direcao.includes('btts_sim')) {
      if (overMuitoForte || overForte) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_alta',
          motivoConfianca: 'btts_sim_confirmacao_forte_contra_btts_nao',
          motivoAplicacao: 'anchor_corta_btts_nao_forte',
        });
      }

      if (overModerado) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_moderada',
          motivoConfianca: 'btts_sim_confirmacao_moderada_contra_btts_nao',
          motivoAplicacao: 'anchor_corta_btts_nao_moderado',
        });
      }

      if (overLeve) {
        return aplicar({
          aFavor: false,
          confianca: 'contra_leve',
          motivoConfianca: 'btts_sim_confirmacao_leve_contra_btts_nao',
          motivoAplicacao: 'anchor_corta_btts_nao_leve',
        });
      }
    }

    return {
      ...baseRet,
      motivo_aplicacao: 'btts_nao_contexto_conflitante_ou_sem_confirmacao',
    };
  }

  return {
    ...baseRet,
    motivo_aplicacao: 'mercado_sem_regra_operacional_anchor',
  };
}

function probPercentFromOdd(odd) {
  const o = Number(odd);

  if (!Number.isFinite(o) || o <= 1) {
    return null;
  }

  return +(100 / o).toFixed(2);
}

function normalizarProbPercent(v) {
  if (v === null || v === undefined || v === '') {
    return null;
  }

  const n = Number(v);

  if (!Number.isFinite(n)) {
    return null;
  }

  if (n > 0 && n <= 1) {
    return +(n * 100).toFixed(2);
  }

  if (n > 1 && n <= 100) {
    return +n.toFixed(2);
  }

  return null;
}

function pickFirstProb(obj, keys = []) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  for (const key of keys) {
    const p = normalizarProbPercent(obj[key]);

    if (p !== null) {
      return p;
    }
  }

  return null;
}

function pickFirstOddAsProb(obj, keys = []) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  for (const key of keys) {
    const p = probPercentFromOdd(obj[key]);

    if (p !== null) {
      return p;
    }
  }

  return null;
}

function extrairProbCasaMercado(jogo, market) {
  /*
    Lê a probabilidade da casa/mercado.
    Primeiro tenta p_mercado_*.
    Se não tiver, calcula usando odd_mercado_*.
  */

  const probKeys = {
    casa: ['p_mercado_casa', 'prob_mercado_casa'],
    empate: ['p_mercado_empate', 'prob_mercado_empate'],
    fora: ['p_mercado_fora', 'prob_mercado_fora'],

    over15: ['p_mercado_over15', 'p_mercado_over_1_5', 'prob_mercado_over15'],
    under15: ['p_mercado_under15', 'p_mercado_under_1_5', 'prob_mercado_under15'],

    over25: ['p_mercado_over25', 'p_mercado_over_2_5', 'prob_mercado_over25'],
    under25: ['p_mercado_under25', 'p_mercado_under_2_5', 'prob_mercado_under25'],

    over35: ['p_mercado_over35', 'p_mercado_over_3_5', 'prob_mercado_over35'],
    under35: ['p_mercado_under35', 'p_mercado_under_3_5', 'prob_mercado_under35'],

    btts_sim: ['p_mercado_btts_sim', 'p_mercado_btts_yes', 'p_mercado_btts'],
    btts_nao: ['p_mercado_btts_nao', 'p_mercado_btts_no'],
  };

  const oddKeys = {
    casa: ['odd_mercado_casa', 'odd_casa'],
    empate: ['odd_mercado_empate', 'odd_empate'],
    fora: ['odd_mercado_fora', 'odd_fora'],

    over15: ['odd_mercado_over15', 'odd_over15', 'odd_over_1_5'],
    under15: ['odd_mercado_under15', 'odd_under15', 'odd_under_1_5'],

    over25: ['odd_mercado_over25', 'odd_over25', 'odd_over_2_5'],
    under25: ['odd_mercado_under25', 'odd_under25', 'odd_under_2_5'],

    over35: ['odd_mercado_over35', 'odd_over35', 'odd_over_3_5'],
    under35: ['odd_mercado_under35', 'odd_under35', 'odd_under_3_5'],

    btts_sim: ['odd_mercado_btts_sim', 'odd_btts_sim', 'odd_btts_yes'],
    btts_nao: ['odd_mercado_btts_nao', 'odd_btts_nao', 'odd_btts_no'],
  };

  const direto = pickFirstProb(jogo, probKeys[market] || []);

  if (direto !== null) {
    return direto;
  }

  return pickFirstOddAsProb(jogo, oddKeys[market] || []);
}

function thresholdsCasaPorMercado(market) {
  const map = {
    over15: { weak: 65, medio: 70, forte: 75 },

    under15: { weak: 999, medio: 999, forte: 999 },

    over25: { weak: 55, medio: 60, forte: 65 },
    under25: { weak: 60, medio: 65, forte: 70 },

    over35: { weak: 55, medio: 60, forte: 65 },
    under35: { weak: 65, medio: 70, forte: 75 },

    btts_sim: { weak: 55, medio: 60, forte: 65 },
    btts_nao: { weak: 60, medio: 65, forte: 70 },

    casa: { weak: 55, medio: 60, forte: 65 },
    empate: { weak: 999, medio: 999, forte: 999 },
    fora: { weak: 55, medio: 60, forte: 65 },
  };

  return map[market] || { weak: 55, medio: 60, forte: 65 };
}

function nivelCasaMercado(probCasa, market) {
  const p = normalizarProbPercent(probCasa);

  if (p === null) {
    return {
      prob: null,
      nivel: 'sem_casa',
      favoravel: false,
      contra: false,
      forca: 0,
    };
  }

  const th = thresholdsCasaPorMercado(market);

  if (p >= th.forte) {
    return { prob: p, nivel: 'forte', favoravel: true, contra: false, forca: 3 };
  }

  if (p >= th.medio) {
    return { prob: p, nivel: 'medio', favoravel: true, contra: false, forca: 2 };
  }

  if (p >= th.weak) {
    return { prob: p, nivel: 'leve', favoravel: true, contra: false, forca: 1 };
  }

  const corteContraForte = Math.max(42, th.weak - 10);
  const corteContra = Math.max(45, th.weak - 6);

  if (p <= corteContraForte) {
    return { prob: p, nivel: 'contra_forte', favoravel: false, contra: true, forca: -3 };
  }

  if (p <= corteContra) {
    return { prob: p, nivel: 'contra', favoravel: false, contra: true, forca: -2 };
  }

  return {
    prob: p,
    nivel: 'meio',
    favoravel: false,
    contra: false,
    forca: 0,
  };
}

function anchorFavoravelAoMercado(ajusteAnchor) {
  const d = Number(ajusteAnchor?.delta || 0);
  const conf = String(ajusteAnchor?.confianca || '');

  if (d > 0) return true;
  if (['leve', 'moderada', 'alta', 'muito_alta'].includes(conf)) return true;

  return false;
}

function anchorContraMercado(ajusteAnchor) {
  const d = Number(ajusteAnchor?.delta || 0);
  const conf = String(ajusteAnchor?.confianca || '');

  if (d < 0) return true;
  if (conf.startsWith('contra_')) return true;

  return false;
}

function calcularCamadaCasaMercado({
  market,
  scoreBaseLambda,
  ajusteAnchor,
  probCasa,
}) {
  const scoreBase = Math.round(clampAnchorEntrada(scoreBaseLambda, 0, 100));
  const zona = classificarZonaLambdaPorMercado(market, scoreBase);
  const th = thresholdsCasaPorMercado(market);
  const casa = nivelCasaMercado(probCasa, market);

  const base = {
    prob_casa: casa.prob,
    casa_nivel: casa.nivel,
    zona_lambda: zona,
    delta_casa: 0,
    leitura_casa: 'sem_ajuste_casa',
    motivo_casa: 'sem_confirmacao_externa',
  };

  if (market === 'under15') {
    return {
      ...base,
      delta_casa: 0,
      leitura_casa: 'bloqueado',
      motivo_casa: 'under15_bloqueado_operacionalmente',
      confirmacoes_favor: 0,
      confirmacoes_contra: 0,
      forca_favor_ponderada: 0,
      forca_contra_ponderada: 0,
      saldo_forca_ponderada: 0,
      nivel_confirmacao: 'bloqueado',
      votos_confirmacao: [],
    };
  }

  function configMercadoConfirmacao() {
    /*
      cD é EXTRA de confirmação.
      Não é o peso total da âncora.
      A âncora já entra no aD.
    */

    const cfg = {
      over15: {
        pos3: { leve: 1, media: 2, forte: 3, premium: 3 },
        posLA: { leve: 0, media: 1, forte: 2, premium: 2 },
        posLC: { leve: 0, media: 1, forte: 1, premium: 2 },
        posAC: { leve: 0, media: 0, forte: 1, premium: 1 },

        neg3: { leve: -1, media: -1, forte: -2, premium: -2 },
        negLA: { leve: 0, media: -1, forte: -1, premium: -2 },
        negLC: { leve: 0, media: -1, forte: -1, premium: -1 },
        negAC: { leve: 0, media: 0, forte: -1, premium: -1 },

        casaContraLambdaAncora: -1,
        casaFavorLambdaAncoraContra: 1,
        acContraComLambdaFavor: -1,
        acFavorComLambdaContra: 0,
      },

      over25: {
        /*
          Auditoria:
          3 confirmações é o padrão forte.
          lambda + âncora é ok.
          lambda + casa e âncora + casa sem os três juntos ficaram fracos.
        */
        pos3: { leve: 3, media: 5, forte: 7, premium: 8 },
        posLA: { leve: 1, media: 2, forte: 4, premium: 5 },
        posLC: { leve: 0, media: 0, forte: 1, premium: 2 },
        posAC: { leve: 0, media: 0, forte: 1, premium: 2 },

        neg3: { leve: -3, media: -5, forte: -8, premium: -9 },
        negLA: { leve: -2, media: -4, forte: -6, premium: -7 },
        negLC: { leve: -1, media: -2, forte: -3, premium: -4 },
        negAC: { leve: -1, media: -2, forte: -3, premium: -4 },

        casaContraLambdaAncora: -1,
        casaFavorLambdaAncoraContra: 1,
        acContraComLambdaFavor: -2,
        acFavorComLambdaContra: 0,
      },

      under25: {
        /*
          Auditoria:
          Under 2.5 confia mais em lambda + âncora.
          lambda + casa foi fraco.
          casa contra forte sozinha é ruim, mas NÃO pode derrubar
          quando lambda + âncora confirmam juntos.
        */
        pos3: { leve: 2, media: 3, forte: 5, premium: 6 },
        posLA: { leve: 2, media: 3, forte: 5, premium: 6 },
        posLC: { leve: 0, media: 0, forte: 0, premium: 1 },
        posAC: { leve: 0, media: 1, forte: 2, premium: 2 },

        neg3: { leve: -2, media: -4, forte: -6, premium: -7 },
        negLA: { leve: -2, media: -4, forte: -5, premium: -6 },
        negLC: { leve: -1, media: -2, forte: -3, premium: -3 },
        negAC: { leve: -2, media: -3, forte: -4, premium: -5 },

        casaContraLambdaAncora: -1,
        casaFavorLambdaAncoraContra: 1,
        acContraComLambdaFavor: -4,
        acFavorComLambdaContra: 0,
      },

      over35: {
        pos3: { leve: 2, media: 3, forte: 5, premium: 6 },
        posLA: { leve: 1, media: 2, forte: 3, premium: 4 },
        posLC: { leve: 1, media: 2, forte: 3, premium: 4 },
        posAC: { leve: 0, media: 1, forte: 2, premium: 2 },

        neg3: { leve: -2, media: -4, forte: -6, premium: -7 },
        negLA: { leve: -2, media: -3, forte: -5, premium: -6 },
        negLC: { leve: -1, media: -3, forte: -4, premium: -5 },
        negAC: { leve: -1, media: -2, forte: -3, premium: -4 },

        casaContraLambdaAncora: -1,
        casaFavorLambdaAncoraContra: 1,
        acContraComLambdaFavor: -2,
        acFavorComLambdaContra: 1,
      },

      under35: {
        /*
          Auditoria:
          Under 3.5 gosta de lambda + casa.
          Casa contra forte sozinha foi ruim e corta -3,
          mas se lambda + âncora confirmam juntos, reduz só pouco.
        */
        pos3: { leve: 2, media: 3, forte: 5, premium: 6 },
        posLA: { leve: 1, media: 2, forte: 4, premium: 5 },
        posLC: { leve: 2, media: 3, forte: 5, premium: 6 },
        posAC: { leve: 0, media: 0, forte: 1, premium: 1 },

        neg3: { leve: -2, media: -4, forte: -6, premium: -7 },
        negLA: { leve: -2, media: -3, forte: -5, premium: -6 },
        negLC: { leve: -2, media: -4, forte: -5, premium: -6 },
        negAC: { leve: -1, media: -2, forte: -3, premium: -4 },

        casaContraLambdaAncora: -1,
        casaFavorLambdaAncoraContra: 1,
        acContraComLambdaFavor: -3,
        acFavorComLambdaContra: 0,
      },

      btts_sim: {
        /*
          Auditoria:
          BTTS Sim precisa da casa.
          lambda + âncora sem casa não empurra.
        */
        pos3: { leve: 1, media: 3, forte: 4, premium: 6 },
        posLA: { leve: 0, media: 0, forte: 0, premium: 0 },
        posLC: { leve: 1, media: 3, forte: 4, premium: 5 },
        posAC: { leve: 0, media: 1, forte: 2, premium: 3 },
        neg3: { leve: -2, media: -4, forte: -6, premium: -7 },
        negLA: { leve: -1, media: -2, forte: -3, premium: -4 },
        negLC: { leve: -2, media: -3, forte: -5, premium: -6 },
        negAC: { leve: -2, media: -4, forte: -5, premium: -6 },

        casaContraLambdaAncora: -1,
        casaFavorLambdaAncoraContra: 1,
        acContraComLambdaFavor: -2,
        acFavorComLambdaContra: 0,
      },

      btts_nao: {
        /*
          BTTS Não é instável.
          Casa contra forte sozinha foi muito ruim e corta -3,
          mas não derruba se lambda + âncora confirmam juntos.
        */
        pos3: { leve: 1, media: 2, forte: 4, premium: 5 },
        posLA: { leve: 0, media: 1, forte: 1, premium: 2 },
        posLC: { leve: 1, media: 2, forte: 3, premium: 4 },
        posAC: { leve: 0, media: 0, forte: 1, premium: 1 },

        neg3: { leve: -2, media: -4, forte: -5, premium: -6 },
        negLA: { leve: -1, media: -2, forte: -3, premium: -4 },
        negLC: { leve: -2, media: -3, forte: -4, premium: -5 },
        negAC: { leve: -1, media: -2, forte: -3, premium: -4 },

        casaContraLambdaAncora: -1,
        casaFavorLambdaAncoraContra: 1,
        acContraComLambdaFavor: -2,
        acFavorComLambdaContra: 0,
      },
    };

    return cfg[market] || cfg.over25;
  }

  function classificarLambdaVoto() {
    if (scoreBase >= th.forte) {
      return {
        nome: 'lambda',
        voto: 1,
        forca: 3,
        leitura: 'lambda_confirma_forte',
        valor_base: scoreBase,
        peso_nivel: 1.0,
      };
    }

    if (scoreBase >= th.medio) {
      return {
        nome: 'lambda',
        voto: 1,
        forca: 2,
        leitura: 'lambda_confirma_medio',
        valor_base: scoreBase,
        peso_nivel: 1.0,
      };
    }

    if (scoreBase >= th.weak) {
      return {
        nome: 'lambda',
        voto: 1,
        forca: 1,
        leitura: 'lambda_confirma_leve',
        valor_base: scoreBase,
        peso_nivel: 1.0,
      };
    }

    const corteContraForte = Math.max(42, th.weak - 10);
    const corteContra = Math.max(45, th.weak - 6);

    if (scoreBase <= corteContraForte) {
      return {
        nome: 'lambda',
        voto: -1,
        forca: 3,
        leitura: 'lambda_contra_forte',
        valor_base: scoreBase,
        peso_nivel: 1.0,
      };
    }

    if (scoreBase <= corteContra) {
      return {
        nome: 'lambda',
        voto: -1,
        forca: 2,
        leitura: 'lambda_contra_medio',
        valor_base: scoreBase,
        peso_nivel: 1.0,
      };
    }

    return {
      nome: 'lambda',
      voto: 0,
      forca: 0,
      leitura: 'lambda_neutro',
      valor_base: scoreBase,
      peso_nivel: 1.0,
    };
  }

  function direcaoTextoAncoraRelativaAoMercado() {
    const decisao = String(ajusteAnchor?.decisao || '').toLowerCase();
    const direcao = String(ajusteAnchor?.direcao || '').toLowerCase();
    const motivo = String(ajusteAnchor?.motivo || '').toLowerCase();
    const texto = `${decisao} ${direcao} ${motivo}`;

    if (!texto.trim() || texto.includes('ignorar')) {
      return 0;
    }

    if (market.startsWith('over')) {
      if (texto.includes('favorece_over') || texto.includes('over')) return 1;
      if (texto.includes('favorece_under') || texto.includes('under')) return -1;
    }

    if (market.startsWith('under')) {
      if (texto.includes('favorece_under') || texto.includes('under')) return 1;
      if (texto.includes('favorece_over') || texto.includes('over')) return -1;
    }

    if (market === 'btts_sim') {
      if (texto.includes('btts_sim') || texto.includes('ambos_sim')) return 1;
      if (texto.includes('btts_nao') || texto.includes('ambos_nao')) return -1;
    }

    if (market === 'btts_nao') {
      if (texto.includes('btts_nao') || texto.includes('ambos_nao')) return 1;
      if (texto.includes('btts_sim') || texto.includes('ambos_sim')) return -1;
    }

    return 0;
  }

  function classificarAncoraVoto() {
    const delta = Number(ajusteAnchor?.delta || 0);
    const confianca = String(ajusteAnchor?.confianca || 'neutra').toLowerCase();

    let voto = 0;

    if (delta > 0) {
      voto = 1;
    } else if (delta < 0) {
      voto = -1;
    } else {
      voto = direcaoTextoAncoraRelativaAoMercado();
    }

    if (voto === 0) {
      return {
        nome: 'ancora',
        voto: 0,
        forca: 0,
        leitura: 'ancora_neutra',
        valor_base: delta,
        peso_nivel: 0.85,
      };
    }

    let forca = 1;

    if (
      confianca.includes('muito_alta') ||
      confianca.includes('alta') ||
      Math.abs(delta) >= 8
    ) {
      forca = 3;
    } else if (
      confianca.includes('moderada') ||
      Math.abs(delta) >= 4
    ) {
      forca = 2;
    } else {
      forca = 1;
    }

    /*
      Se a direção veio só por texto e delta = 0,
      não deixa virar confirmação forte.
    */
    if (Math.abs(delta) === 0) {
      forca = Math.min(forca, 1);
    }

    return {
      nome: 'ancora',
      voto,
      forca,
      leitura: voto > 0 ? 'ancora_confirma' : 'ancora_contra',
      valor_base: delta,
      peso_nivel: 0.85,
    };
  }

  function classificarCasaVoto() {
    if (casa.nivel === 'sem_casa') {
      return {
        nome: 'casa',
        voto: 0,
        forca: 0,
        leitura: 'casa_sem_dado',
        valor_base: null,
        peso_nivel: 0.35,
      };
    }

    if (casa.favoravel) {
      return {
        nome: 'casa',
        voto: 1,
        forca: Math.max(1, Number(casa.forca || 1)),
        leitura: 'casa_confirma_valor',
        valor_base: casa.prob,
        peso_nivel: 0.35,
      };
    }

    if (casa.contra) {
      return {
        nome: 'casa',
        voto: -1,
        forca: Math.max(1, Math.abs(Number(casa.forca || 1))),
        leitura: 'casa_contra_valor',
        valor_base: casa.prob,
        peso_nivel: 0.35,
      };
    }

    return {
      nome: 'casa',
      voto: 0,
      forca: 0,
      leitura: 'casa_neutra',
      valor_base: casa.prob,
      peso_nivel: 0.35,
    };
  }

  function forcaPonderada(v) {
    return +(Number(v.forca || 0) * Number(v.peso_nivel || 0)).toFixed(3);
  }

  function nivelCombo(votosCombo) {
    const score = votosCombo.reduce((acc, v) => acc + forcaPonderada(v), 0);
    const fortes = votosCombo.filter(v => Number(v.forca || 0) >= 2).length;

    /*
      Premium real:
      pelo menos 2 sinais fortes e força ponderada alta.
      Assim 3 votos fracos não viram premium.
    */
    if (score >= 5.0 && fortes >= 2) return 'premium';
    if (score >= 3.8 && fortes >= 2) return 'forte';
    if (score >= 2.2 || fortes >= 1) return 'media';

    return 'leve';
  }

  function getDelta(table, nivel) {
    return Number(table?.[nivel] || 0);
  }

  function nomes(votosCombo) {
    return votosCombo
      .map(v => `${v.nome}:${v.leitura}:f${v.forca}:p${v.peso_nivel}`)
      .join('|');
  }

  const cfg = configMercadoConfirmacao();

  const lambda = classificarLambdaVoto();
  const ancora = classificarAncoraVoto();
  const casaVoto = classificarCasaVoto();

  const votos = [lambda, ancora, casaVoto].map(v => ({
    ...v,
    forca_ponderada: forcaPonderada(v),
  }));

  const lF = lambda.voto > 0;
  const lC = lambda.voto < 0;

  const aF = ancora.voto > 0;
  const aC = ancora.voto < 0;

  const cF = casaVoto.voto > 0;
  const cC = casaVoto.voto < 0;

  const votosFavor = votos.filter(v => v.voto > 0);
  const votosContra = votos.filter(v => v.voto < 0);

  const confirmacoesFavor = votosFavor.length;
  const confirmacoesContra = votosContra.length;

  const forcaFavor = votosFavor.reduce(
    (acc, v) => acc + Math.abs(v.forca_ponderada),
    0
  );

  const forcaContra = votosContra.reduce(
    (acc, v) => acc + Math.abs(v.forca_ponderada),
    0
  );

  const saldoForca = +(forcaFavor - forcaContra).toFixed(3);

  /*
    Casa sozinha não manda.
  */
  if (confirmacoesFavor === 1 && cF && !lF && !aF) {
    return {
      ...base,
      delta_casa: 0,
      leitura_casa: 'casa_sozinha_sem_peso',
      motivo_casa: 'casa_confirma_valor_mas_lambda_e_ancora_nao_confirmam',
      confirmacoes_favor: confirmacoesFavor,
      confirmacoes_contra: confirmacoesContra,
      forca_favor_ponderada: +forcaFavor.toFixed(3),
      forca_contra_ponderada: +forcaContra.toFixed(3),
      saldo_forca_ponderada: saldoForca,
      nivel_confirmacao: 'casa_sozinha',
      votos_confirmacao: votos,
    };
  }

  /*
    Casa contra sozinha:
    - se não tem lambda + âncora confirmando juntos, pode bloquear/cortar
      mercados que a auditoria mostrou ruins.
    - se lambda + âncora estão juntos a favor, NÃO bloqueia aqui.
  */
  if (
    confirmacoesContra === 1 &&
    cC &&
    !lC &&
    !aC &&
    !(lF && aF)
  ) {
    if (casaVoto.forca >= 3) {
      if (market === 'btts_nao') {
        return {
          ...base,
          delta_casa: -3,
          leitura_casa: 'casa_contra_forte_bloqueia_btts_nao_fraco',
          motivo_casa: 'btts_nao_com_casa_contra_forte_teve_baixo_hit_rate_na_auditoria',
          confirmacoes_favor: confirmacoesFavor,
          confirmacoes_contra: confirmacoesContra,
          forca_favor_ponderada: +forcaFavor.toFixed(3),
          forca_contra_ponderada: +forcaContra.toFixed(3),
          saldo_forca_ponderada: saldoForca,
          nivel_confirmacao: 'bloqueio_casa_contra_forte',
          votos_confirmacao: votos,
        };
      }

      if (market === 'under25') {
        return {
          ...base,
          delta_casa: -3,
          leitura_casa: 'casa_contra_forte_bloqueia_under25_fraco',
          motivo_casa: 'under25_com_casa_contra_forte_teve_baixo_hit_rate_na_auditoria',
          confirmacoes_favor: confirmacoesFavor,
          confirmacoes_contra: confirmacoesContra,
          forca_favor_ponderada: +forcaFavor.toFixed(3),
          forca_contra_ponderada: +forcaContra.toFixed(3),
          saldo_forca_ponderada: saldoForca,
          nivel_confirmacao: 'bloqueio_casa_contra_forte',
          votos_confirmacao: votos,
        };
      }

      if (market === 'under35') {
        return {
          ...base,
          delta_casa: -3,
          leitura_casa: 'casa_contra_forte_bloqueia_under35_fraco',
          motivo_casa: 'under35_com_casa_contra_forte_teve_baixo_hit_rate_na_auditoria',
          confirmacoes_favor: confirmacoesFavor,
          confirmacoes_contra: confirmacoesContra,
          forca_favor_ponderada: +forcaFavor.toFixed(3),
          forca_contra_ponderada: +forcaContra.toFixed(3),
          saldo_forca_ponderada: saldoForca,
          nivel_confirmacao: 'bloqueio_casa_contra_forte',
          votos_confirmacao: votos,
        };
      }
    }

    return {
      ...base,
      delta_casa: 0,
      leitura_casa: 'casa_contra_sozinha_sem_peso',
      motivo_casa: 'casa_contra_mas_lambda_e_ancora_nao_confirmam_corte',
      confirmacoes_favor: confirmacoesFavor,
      confirmacoes_contra: confirmacoesContra,
      forca_favor_ponderada: +forcaFavor.toFixed(3),
      forca_contra_ponderada: +forcaContra.toFixed(3),
      saldo_forca_ponderada: saldoForca,
      nivel_confirmacao: 'casa_contra_sozinha',
      votos_confirmacao: votos,
    };
  }

  /*
    Casa contra forte contra lambda + âncora:
    NÃO bloqueia.
    Só reduz pouco.

    A auditoria mostrou que quando lambda + âncora confirmam,
    a casa contra forte não pode tomar -3 automaticamente.
  */
  if (
    cC &&
    casaVoto.forca >= 3 &&
    lF &&
    aF
  ) {
    return {
      ...base,
      delta_casa: cfg.casaContraLambdaAncora,
      leitura_casa: 'casa_contra_forte_mas_lambda_ancora_confirmam',
      motivo_casa: 'casa_contra_forte_reduz_pouco_porque_lambda_e_ancora_confirmam',
      confirmacoes_favor: confirmacoesFavor,
      confirmacoes_contra: confirmacoesContra,
      forca_favor_ponderada: +forcaFavor.toFixed(3),
      forca_contra_ponderada: +forcaContra.toFixed(3),
      saldo_forca_ponderada: saldoForca,
      nivel_confirmacao: 'casa_contra_confirmacao_principal',
      votos_confirmacao: votos,
    };
  }

  let delta = 0;
  let leitura = 'sem_confirmacoes';
  let motivo = 'sem_duas_confirmacoes_relevantes';
  let nivel = 'neutro';

  /*
    3 a favor: lambda + âncora + casa.
  */
  if (lF && aF && cF) {
    const combo = [lambda, ancora, casaVoto];
    nivel = nivelCombo(combo);
    delta = getDelta(cfg.pos3, nivel);
    leitura = `${nivel}_favor_${nomes(combo)}`;
    motivo = 'tres_confirmacoes_a_favor_com_forca_validada';
  }

  /*
    Lambda + âncora a favor.
    Se casa contra, não aumenta; só reduz pouco.
  */
  else if (lF && aF && !cF) {
    if (cC) {
      delta = cfg.casaContraLambdaAncora;
      nivel = 'casa_contra_confirmacao_principal';
      leitura = `${nivel}_${nomes([lambda, ancora, casaVoto])}`;
      motivo = 'lambda_e_ancora_confirmam_mas_casa_contra_reduz_pouco';
    } else {
      const combo = [lambda, ancora];
      nivel = nivelCombo(combo);
      delta = getDelta(cfg.posLA, nivel);
      leitura = `${nivel}_favor_${nomes(combo)}`;
      motivo = 'lambda_e_ancora_confirmam_a_favor';
    }
  }

  /*
    Lambda + casa a favor.
    Âncora contra segura.
  */
  else if (lF && cF && !aF) {
    if (aC) {
      delta = 0;
      nivel = 'ancora_contra_lambda_casa';
      leitura = `${nivel}_${nomes([lambda, ancora, casaVoto])}`;
      motivo = 'lambda_e_casa_confirmam_mas_ancora_contra_nao_empurra';
    } else {
      const combo = [lambda, casaVoto];
      nivel = nivelCombo(combo);
      delta = getDelta(cfg.posLC, nivel);
      leitura = `${nivel}_favor_${nomes(combo)}`;
      motivo = 'lambda_e_casa_confirmam_a_favor';
    }
  }

  /*
    Âncora + casa a favor.
    Se lambda contra, bônus controlado.
  */
  else if (aF && cF && !lF) {
    if (lC) {
      delta = cfg.acFavorComLambdaContra;
      nivel = 'lambda_contra_ancora_casa';
      leitura = `${nivel}_${nomes([lambda, ancora, casaVoto])}`;
      motivo = 'ancora_e_casa_confirmam_mas_lambda_contra_bonus_controlado';
    } else {
      const combo = [ancora, casaVoto];
      nivel = nivelCombo(combo);
      delta = getDelta(cfg.posAC, nivel);
      leitura = `${nivel}_favor_${nomes(combo)}`;
      motivo = 'ancora_e_casa_confirmam_a_favor';
    }
  }

  /*
    3 contra.
  */
  else if (lC && aC && cC) {
    const combo = [lambda, ancora, casaVoto];
    nivel = nivelCombo(combo);
    delta = getDelta(cfg.neg3, nivel);
    leitura = `${nivel}_contra_${nomes(combo)}`;
    motivo = 'tres_confirmacoes_contra_com_forca_validada';
  }

  /*
    Lambda + âncora contra.
    Se casa a favor, suaviza pouco; não vira bônus.
  */
  else if (lC && aC && !cC) {
    if (cF) {
      delta = cfg.casaFavorLambdaAncoraContra;
      nivel = 'casa_favor_contra_principal';
      leitura = `${nivel}_${nomes([lambda, ancora, casaVoto])}`;
      motivo = 'lambda_e_ancora_contra_mas_casa_a_favor_suaviza_pouco';
    } else {
      const combo = [lambda, ancora];
      nivel = nivelCombo(combo);
      delta = getDelta(cfg.negLA, nivel);
      leitura = `${nivel}_contra_${nomes(combo)}`;
      motivo = 'lambda_e_ancora_confirmam_contra';
    }
  }

  /*
    Lambda + casa contra.
  */
  else if (lC && cC && !aC) {
    if (aF) {
      delta = 0;
      nivel = 'ancora_favor_lambda_casa_contra';
      leitura = `${nivel}_${nomes([lambda, ancora, casaVoto])}`;
      motivo = 'lambda_e_casa_contra_mas_ancora_favor_conflito_sem_corte_extra';
    } else {
      const combo = [lambda, casaVoto];
      nivel = nivelCombo(combo);
      delta = getDelta(cfg.negLC, nivel);
      leitura = `${nivel}_contra_${nomes(combo)}`;
      motivo = 'lambda_e_casa_confirmam_contra';
    }
  }

  /*
    Âncora + casa contra.
    Se lambda favorece, corta controlado por mercado.
  */
  else if (aC && cC && !lC) {
    if (lF) {
      delta = cfg.acContraComLambdaFavor;
      nivel = 'ancora_casa_contra_lambda_favor';
      leitura = `${nivel}_${nomes([lambda, ancora, casaVoto])}`;
      motivo = 'ancora_e_casa_contra_com_lambda_favor_corte_controlado';
    } else {
      const combo = [ancora, casaVoto];
      nivel = nivelCombo(combo);
      delta = getDelta(cfg.negAC, nivel);
      leitura = `${nivel}_contra_${nomes(combo)}`;
      motivo = 'ancora_e_casa_confirmam_contra';
    }
  }

  /*
    Só um voto de lambda ou âncora:
    não aplica cD, porque lambda já está no score base
    e âncora já está no aD.
  */
  else {
    delta = 0;
    nivel = 'neutro';
    leitura = 'forca_insuficiente_ou_conflito_controlado';
    motivo = 'sem_duas_confirmacoes_relevantes_para_delta_extra';
  }

  return {
    ...base,
    delta_casa: delta,

    leitura_casa: leitura,
    motivo_casa: motivo,

    confirmacoes_favor: confirmacoesFavor,
    confirmacoes_contra: confirmacoesContra,

    forca_favor_ponderada: +forcaFavor.toFixed(3),
    forca_contra_ponderada: +forcaContra.toFixed(3),
    saldo_forca_ponderada: saldoForca,
    nivel_confirmacao: nivel,

    votos_confirmacao: votos,
  };
}

function ajustarDeltasPorPadraoAuditado({
  market,
  scoreAntes,
  ajusteAnchor,
  ajusteCasa,
  deltaAnchor,
  deltaCasa,
}) {
  let aD = Number(deltaAnchor || 0);
  let cD = Number(deltaCasa || 0);

  const aDOriginal = aD;
  const cDOriginal = cD;

  const motivos = [];

  const votos = Array.isArray(ajusteCasa?.votos_confirmacao)
    ? ajusteCasa.votos_confirmacao
    : [];

  function voto(nome) {
    return votos.find(v => v?.nome === nome) || {
      nome,
      voto: 0,
      forca: 0,
      leitura: `${nome}_indefinido`,
      valor_base: null,
      peso_nivel: 0,
      forca_ponderada: 0,
    };
  }

  const lambda = voto('lambda');
  const ancora = voto('ancora');
  const casa = voto('casa');

  const lF = Number(lambda.voto || 0) > 0;
  const lC = Number(lambda.voto || 0) < 0;

  const aF = Number(ancora.voto || 0) > 0;
  const aC = Number(ancora.voto || 0) < 0;

  const cF = Number(casa.voto || 0) > 0;
  const cC = Number(casa.voto || 0) < 0;

  const lForca = Number(lambda.forca || 0);
  const aForca = Number(ancora.forca || 0);
  const cForca = Number(casa.forca || 0);

  const casaNivel = String(ajusteCasa?.casa_nivel || '');
  const anchorDecisao = String(ajusteAnchor?.decisao || '').toLowerCase();
  const anchorDirecao = String(ajusteAnchor?.direcao || '').toLowerCase();
  const anchorMotivo = String(ajusteAnchor?.motivo || '').toLowerCase();
  const anchorTexto = `${anchorDecisao} ${anchorDirecao} ${anchorMotivo}`;

  function limitarPositivo(valor, limite) {
    if (valor > limite) return limite;
    return valor;
  }

  function limitarNegativo(valor, limiteNegativo) {
    if (valor < limiteNegativo) return limiteNegativo;
    return valor;
  }

  function forcarCorteMinimo(valor, corteNegativo) {
    /*
      Exemplo:
      valor = 0, corteNegativo = -2 => retorna -2.
      valor = -4, corteNegativo = -2 => mantém -4.
    */
    return Math.min(valor, corteNegativo);
  }

  /*
    =========================================================
    BTTS SIM
    =========================================================

    Auditoria:
    - lambda leve + âncora forte + casa média:
      9 jogos | 3 GREEN | 6 RED | 33.33%
      Estava tomando aD=8 e cD=4.

    Então:
    - Se lambda é leve e âncora é forte, capar aD.
    - Se lambda não acompanha e só âncora/casa sustentam, capar aD.
    - Se casa não confirma, lambda+âncora não pode empurrar BTTS Sim.
  */
  if (market === 'btts_sim') {
    if (aF && aForca >= 3 && lF && lForca <= 1 && cF && cForca >= 2) {
      aD = limitarPositivo(aD, 4);
      cD = limitarPositivo(cD, 1);
      motivos.push('btts_sim_lambda_leve_ancora_forte_casa_media_cap_aD4_cD1');
    }

    if (aF && cF && !lF) {
      aD = limitarPositivo(aD, 3);
      cD = limitarPositivo(cD, 1);
      motivos.push('btts_sim_ancora_casa_sem_lambda_cap_aD3_cD1');
    }

    if (aF && !cF) {
      aD = limitarPositivo(aD, 2);
      cD = limitarPositivo(cD, 0);
      motivos.push('btts_sim_ancora_sem_casa_cap_aD2_cD0');
    }

    if (lF && aF && !cF) {
      aD = limitarPositivo(aD, 2);
      cD = limitarPositivo(cD, 0);
      motivos.push('btts_sim_lambda_ancora_sem_casa_nao_empurra');
    }
  }

  /*
    =========================================================
    BTTS NÃO
    =========================================================

    Auditoria:
    - BTTS Não com âncora apontando BTTS Sim e sem corte:
      5 jogos | 0 GREEN | 5 RED | 0%

    Então:
    - Se a âncora aponta BTTS Sim contra BTTS Não
      e lambda+casa não confirmam BTTS Não juntos,
      aplica corte mínimo.
  */
  if (market === 'btts_nao') {
    const ancoraApontaBttsSim =
      aC ||
      anchorTexto.includes('btts_sim') ||
      anchorTexto.includes('ambos_sim') ||
      anchorTexto.includes('leve_btts_sim') ||
      anchorTexto.includes('favorece_btts_sim');

    const lambdaCasaConfirmamBttsNao = lF && cF;

    if (ancoraApontaBttsSim && !lambdaCasaConfirmamBttsNao) {
      aD = forcarCorteMinimo(aD, -2);
      cD = limitarPositivo(cD, 0);
      motivos.push('btts_nao_ancora_aponta_btts_sim_corte_minimo_menos2');
    }

    /*
      Se BTTS Não está misto/neutro com casa meio e âncora neutra,
      não empurra. Esse padrão não é bom o bastante para bônus.
    */
    if (!lF && !aF && !cF && casaNivel === 'meio') {
      cD = limitarPositivo(cD, 0);
      motivos.push('btts_nao_misto_meio_sem_bonus');
    }
  }

  /*
    =========================================================
    OVER 2.5
    =========================================================

    Auditoria:
    - lambda leve + casa média/forte sem âncora:
      ruim, cD já ficou 0 na função nova.
    Aqui só garantimos que não volte a empurrar por acidente.
  */
  if (market === 'over25') {
    if (lF && lForca <= 1 && cF && !aF) {
      cD = limitarPositivo(cD, 0);
      motivos.push('over25_lambda_leve_casa_sem_ancora_sem_bonus');
    }

    if (aF && cF && !lF) {
      aD = limitarPositivo(aD, 4);
      cD = limitarPositivo(cD, 1);
      motivos.push('over25_ancora_casa_sem_lambda_bonus_controlado');
    }
  }

  /*
    =========================================================
    UNDER 2.5
    =========================================================

    Auditoria:
    - lambda + casa no Under 2.5 foi fraco.
    - lambda + âncora é melhor.
    - casa contra forte só bloqueia quando lambda+âncora NÃO confirmam.

    Aqui garantimos que casa não empurre Under 2.5 sozinha com lambda.
  */
  if (market === 'under25') {
    if (lF && cF && !aF) {
      cD = limitarPositivo(cD, 0);
      motivos.push('under25_lambda_casa_sem_ancora_sem_bonus');
    }

    if (lF && aF && cC) {
      /*
        A casa contra forte não pode destruir Under 2.5
        quando lambda + âncora confirmam.
      */
      cD = limitarNegativo(cD, -1);
      motivos.push('under25_lambda_ancora_confirmam_casa_contra_max_menos1');
    }
  }

  /*
    =========================================================
    UNDER 3.5
    =========================================================

    Auditoria:
    - Under 3.5 é bom com lambda+casa.
    - Mas 3 votos com âncora fraca e casa média não precisa tomar cD alto.
  */
  if (market === 'under35') {
    if (lF && aF && cF && aForca <= 1 && cForca <= 2) {
      cD = limitarPositivo(cD, 2);
      motivos.push('under35_tres_votos_mas_ancora_fraca_casa_nao_forte_cap_cD2');
    }

    if (aF && cF && !lF) {
      cD = limitarPositivo(cD, 1);
      motivos.push('under35_ancora_casa_sem_lambda_bonus_controlado');
    }

    if (cC && cForca >= 3 && !(lF && aF)) {
      cD = Math.min(cD, -3);
      motivos.push('under35_casa_contra_forte_sem_lambda_ancora_bloqueia');
    }
  }

  /*
    Segurança final:
    cD é extra de confirmação, não pode virar um segundo modelo inteiro.
  */
  cD = clampAnchorEntrada(cD, -8, 8);

  /*
    aD continua sendo a âncora direta, mas com trava auditada.
  */
  aD = clampAnchorEntrada(aD, -10, 10);

  return {
    deltaAnchorOriginal: aDOriginal,
    deltaCasaOriginal: cDOriginal,

    deltaAnchorFinal: Math.round(aD),
    deltaCasaFinal: Math.round(cD),

    ajustou:
      Math.round(aD) !== Math.round(aDOriginal) ||
      Math.round(cD) !== Math.round(cDOriginal),

    motivos,
    votos_auditados: {
      lambda,
      ancora,
      casa,
    },
  };
}
function classificarPadraoPreJogo({ lambdaCasa, lambdaFora, lambdaTotal }) {
  const lCasa = Number(lambdaCasa);
  const lFora = Number(lambdaFora);

  let total = Number(lambdaTotal);

  if (!Number.isFinite(total) && Number.isFinite(lCasa) && Number.isFinite(lFora)) {
    total = lCasa + lFora;
  }

  if (!Number.isFinite(lCasa) || !Number.isFinite(lFora) || !Number.isFinite(total)) {
    return {
      valido: false,
      lambda_casa: null,
      lambda_fora: null,
      lambda_total: null,
      lambda_maior: null,
      lambda_menor: null,
      diff_lambda: null,
      lado_maior_lambda: 'SEM_LAMBDA',
      faixa_total: 'T00_sem_total',
      faixa_lambda_casa: 'HC00_sem_lambda',
      faixa_lambda_fora: 'AW00_sem_lambda',
      faixa_lambda_maior: 'maior_sem_lambda',
      faixa_lambda_menor: 'menor_sem_lambda',
      faixa_diff: 'D00_sem_diff',
      desenho_pre_jogo: 'sem_desenho',
    };
  }

  const lambdaMaior = Math.max(lCasa, lFora);
  const lambdaMenor = Math.min(lCasa, lFora);
  const diff = Math.abs(lCasa - lFora);

  function faixaTotal(v) {
    if (v < 1.80) return 'T01_total_<1.80';
    if (v < 2.00) return 'T02_total_1.80_1.99';
    if (v < 2.20) return 'T03_total_2.00_2.19';
    if (v < 2.40) return 'T04_total_2.20_2.39';
    if (v < 2.60) return 'T05_total_2.40_2.59';
    if (v < 2.80) return 'T06_total_2.60_2.79';
    if (v < 3.00) return 'T07_total_2.80_2.99';
    if (v < 3.20) return 'T08_total_3.00_3.19';
    return 'T09_total_3.20+';
  }

  function faixaHome(v) {
    if (v < 0.60) return 'HC01_<0.60';
    if (v < 0.80) return 'HC02_0.60_0.79';
    if (v < 1.00) return 'HC03_0.80_0.99';
    if (v < 1.20) return 'HC04_1.00_1.19';
    if (v < 1.40) return 'HC05_1.20_1.39';
    if (v < 1.60) return 'HC06_1.40_1.59';
    if (v < 1.80) return 'HC07_1.60_1.79';
    if (v < 2.00) return 'HC08_1.80_1.99';
    return 'HC09_2.00+';
  }

  function faixaAway(v) {
    if (v < 0.60) return 'AW01_<0.60';
    if (v < 0.80) return 'AW02_0.60_0.79';
    if (v < 1.00) return 'AW03_0.80_0.99';
    if (v < 1.20) return 'AW04_1.00_1.19';
    if (v < 1.40) return 'AW05_1.20_1.39';
    if (v < 1.60) return 'AW06_1.40_1.59';
    if (v < 1.80) return 'AW07_1.60_1.79';
    if (v < 2.00) return 'AW08_1.80_1.99';
    return 'AW09_2.00+';
  }

  function faixaMaior(v) {
    if (v < 1.20) return 'maior_<1.20';
    if (v < 1.40) return 'maior_1.20_1.39';
    if (v < 1.60) return 'maior_1.40_1.59';
    if (v < 1.80) return 'maior_1.60_1.79';
    if (v < 2.00) return 'maior_1.80_1.99';
    return 'maior_2.00+';
  }

  function faixaMenor(v) {
    if (v < 0.60) return 'menor_<0.60';
    if (v < 0.80) return 'menor_0.60_0.79';
    if (v < 1.00) return 'menor_0.80_0.99';
    if (v < 1.20) return 'menor_1.00_1.19';
    return 'menor_1.20+';
  }

  function faixaDiff(v) {
    if (v < 0.20) return 'D01_equilibrado_<0.20';
    if (v < 0.40) return 'D02_diff_0.20_0.39';
    if (v < 0.60) return 'D03_diff_0.40_0.59';
    if (v < 0.80) return 'D04_diff_0.60_0.79';
    if (v < 1.00) return 'D05_diff_0.80_0.99';
    return 'D06_um_time_manda_1.00+';
  }

  let desenho = 'misto';

  if (total < 2.00 && lambdaMaior < 1.20) {
    desenho = 'baixo_total_ninguem_carrega';
  } else if (total < 2.20 && lambdaMaior >= 1.20) {
    desenho = 'baixo_total_um_time_carrega';
  } else if (total >= 2.20 && total < 2.60 && lambdaMaior >= 1.40) {
    desenho = 'medio_baixo_um_time_carrega';
  } else if (total >= 2.40 && total < 2.80 && lambdaMaior >= 1.60) {
    desenho = 'medio_um_time_carrega';
  } else if (total >= 2.60 && lambdaMaior >= 1.80) {
    desenho = 'alto_um_time_carrega';
  } else if (total >= 2.80 && lambdaMenor >= 1.20) {
    desenho = 'alto_dois_lados_fortes';
  } else if (total >= 2.60 && lambdaMenor >= 1.00) {
    desenho = 'alto_dois_lados_vivos';
  }

  return {
    valido: true,

    lambda_casa: +lCasa.toFixed(3),
    lambda_fora: +lFora.toFixed(3),
    lambda_total: +total.toFixed(3),
    lambda_maior: +lambdaMaior.toFixed(3),
    lambda_menor: +lambdaMenor.toFixed(3),
    diff_lambda: +diff.toFixed(3),

    lado_maior_lambda: lCasa >= lFora ? 'CASA_MAIOR' : 'FORA_MAIOR',

    faixa_total: faixaTotal(total),
    faixa_lambda_casa: faixaHome(lCasa),
    faixa_lambda_fora: faixaAway(lFora),
    faixa_lambda_maior: faixaMaior(lambdaMaior),
    faixa_lambda_menor: faixaMenor(lambdaMenor),
    faixa_diff: faixaDiff(diff),

    desenho_pre_jogo: desenho,
  };
}
function avaliarPadraoOperacionalPorMercado(market, ajusteEntrada) {
  const scoreFinal = Math.round(Number(ajusteEntrada?.score_final || 0));
  const scoreAntes = Math.round(Number(ajusteEntrada?.score_antes_ancora || 0));

  const casaNivel = String(ajusteEntrada?.casa_nivel || 'sem_casa');
  const casaLeitura = String(ajusteEntrada?.casa_leitura || '');
  const anchorDecisao = String(ajusteEntrada?.anchor_decisao || '').toLowerCase();
  const anchorConfianca = String(ajusteEntrada?.anchor_confianca || '').toLowerCase();

  const desenho = String(ajusteEntrada?.desenho_pre_jogo || 'sem_desenho');
  const faixaTotal = String(ajusteEntrada?.faixa_total || 'T00_sem_total');
  const faixaMenor = String(ajusteEntrada?.faixa_lambda_menor || 'menor_sem_lambda');
  const faixaMaior = String(ajusteEntrada?.faixa_lambda_maior || 'maior_sem_lambda');

  const lambdaMaior = Number(ajusteEntrada?.lambda_maior_pre || 0);
  const lambdaMenor = Number(ajusteEntrada?.lambda_menor_pre || 0);
  const lambdaTotal = Number(ajusteEntrada?.lambda_total_pre || 0);

  const votos = Array.isArray(ajusteEntrada?.votos_confirmacao)
    ? ajusteEntrada.votos_confirmacao
    : [];

  function voto(nome) {
    return votos.find(v => v?.nome === nome) || {
      nome,
      voto: 0,
      forca: 0,
      leitura: `${nome}_indefinido`,
      valor_base: null,
      peso_nivel: 0,
      forca_ponderada: 0,
    };
  }

  const lambda = voto('lambda');
  const ancora = voto('ancora');
  const casa = voto('casa');

  const lF = Number(lambda.voto || 0) > 0;
  const lC = Number(lambda.voto || 0) < 0;

  const aF = Number(ancora.voto || 0) > 0;
  const aC = Number(ancora.voto || 0) < 0;

  const cF = Number(casa.voto || 0) > 0;
  const cC = Number(casa.voto || 0) < 0;

  const lForca = Number(lambda.forca || 0);
  const aForca = Number(ancora.forca || 0);
  const cForca = Number(casa.forca || 0);

  const tresFavor = lF && aF && cF;
  const tresContra = lC && aC && cC;

  const casaContraForte = cC && cForca >= 3;

  const altoDoisFortes = desenho === 'alto_dois_lados_fortes';
  const altoUmCarrega = desenho === 'alto_um_time_carrega';
  const altoDoisVivos = desenho === 'alto_dois_lados_vivos';

  const baixoNinguem = desenho === 'baixo_total_ninguem_carrega';
  const baixoUmCarrega = desenho === 'baixo_total_um_time_carrega';
  const medioBaixoUmCarrega = desenho === 'medio_baixo_um_time_carrega';

  const totalAlto = lambdaTotal >= 2.80;
  const totalMuitoAlto = lambdaTotal >= 3.00;
  const totalBaixo = lambdaTotal < 2.20;
  const totalMedioBaixo = lambdaTotal >= 2.20 && lambdaTotal < 2.60;

  const menorForte = lambdaMenor >= 1.20;
  const menorMorto = lambdaMenor < 0.80;

  const maiorCarregaMuito = lambdaMaior >= 1.80;

  function res({
    permitido,
    veto = false,
    grupo,
    motivo,
    confianca = 'neutra',
  }) {
    return {
      padrao_operacional_permitido: !!permitido,
      veto_operacional: !!veto,
      grupo_padrao_operacional: grupo,
      motivo_padrao_operacional: motivo,
      confianca_padrao_operacional: confianca,
      padrao_operacional_debug: {
        scoreAntes,
        scoreFinal,
        casaNivel,
        casaLeitura,
        anchorDecisao,
        anchorConfianca,

        desenho_pre_jogo: desenho,
        faixa_total: faixaTotal,
        faixa_lambda_maior: faixaMaior,
        faixa_lambda_menor: faixaMenor,
        lambda_maior: lambdaMaior,
        lambda_menor: lambdaMenor,
        lambda_total: lambdaTotal,

        lambda: {
          voto: Number(lambda.voto || 0),
          forca: lForca,
          leitura: lambda.leitura,
        },
        ancora: {
          voto: Number(ancora.voto || 0),
          forca: aForca,
          leitura: ancora.leitura,
        },
        casa: {
          voto: Number(casa.voto || 0),
          forca: cForca,
          leitura: casa.leitura,
        },
      },
    };
  }

  if (market === 'over15') {
    if (tresContra && scoreFinal < 72) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'over15_tres_contra',
        motivo: 'over15_tres_sinais_contra_com_score_nao_premium',
        confianca: 'veto_leve',
      });
    }

    if (totalBaixo && menorMorto && !cF && scoreFinal < 72) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'over15_baixo_total_menor_morto_sem_casa',
        motivo: 'over15_baixo_total_com_lado_morto_e_sem_casa_nao_paga_risco',
        confianca: 'veto_leve',
      });
    }

    return res({
      permitido: true,
      veto: false,
      grupo: 'over15_preservado',
      motivo: 'over15_mercado_estavel_aceita_um_time_carregando',
      confianca: 'permitido',
    });
  }

  if (market === 'over25') {
    if (medioBaixoUmCarrega && lC && cF && aF) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'over25_medio_baixo_um_time_carrega_lambda_contra',
        motivo: 'over25_medio_baixo_um_time_carrega_com_lambda_contra_deu_padrao_fraco_mesmo_com_casa_ancora',
        confianca: 'veto_forte',
      });
    }

    if (totalBaixo || menorMorto) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'over25_total_baixo_ou_menor_morto',
        motivo: 'over25_total_baixo_ou_lambda_menor_morto_nao_sustenta_entrada',
        confianca: 'veto_padrao',
      });
    }

    if (tresFavor && altoDoisFortes && scoreFinal >= 60) {
      return res({
        permitido: true,
        grupo: 'over25_alto_dois_lados_fortes_3_confirmacoes',
        motivo: 'over25_alto_dois_lados_fortes_com_lambda_casa_ancora_confirmando',
        confianca: lForca >= 2 || aForca >= 2 ? 'forte' : 'media',
      });
    }

    if (tresFavor && altoUmCarrega && maiorCarregaMuito && menorForte && scoreFinal >= 60) {
      return res({
        permitido: true,
        grupo: 'over25_alto_um_time_carrega_3_confirmacoes',
        motivo: 'over25_um_time_carrega_mas_o_outro_lado_ainda_esta_vivo',
        confianca: 'forte',
      });
    }

    if (tresFavor && altoDoisVivos && totalAlto && menorForte && scoreFinal >= 64) {
      return res({
        permitido: true,
        grupo: 'over25_alto_dois_lados_vivos_controlado',
        motivo: 'over25_dois_lados_vivos_mas_exige_score_maior',
        confianca: 'media_controlada',
      });
    }

    return res({
      permitido: false,
      veto: true,
      grupo: 'over25_padrao_nao_permitido',
      motivo: 'over25_fora_dos_padroes_macro_auditados_com_maior_hit',
      confianca: 'veto_padrao',
    });
  }

  if (market === 'over35') {
    if ((altoUmCarrega || altoDoisFortes) && totalMuitoAlto && tresFavor && scoreFinal >= 62 && (lForca >= 2 || aForca >= 2)) {
      return res({
        permitido: true,
        grupo: 'over35_explosivo_3_confirmacoes',
        motivo: 'over35_apenas_em_desenho_explosivo_real',
        confianca: 'observacao_forte',
      });
    }

    return res({
      permitido: false,
      veto: true,
      grupo: 'over35_nao_operacional',
      motivo: 'over35_nao_e_mercado_principal_usa_como_alerta_contra_under35',
      confianca: 'veto_padrao',
    });
  }

  if (market === 'under25') {
    if (baixoNinguem && tresFavor && scoreFinal >= 68) {
      return res({
        permitido: true,
        grupo: 'under25_baixo_total_ninguem_carrega_3_confirmacoes',
        motivo: 'under25_so_entra_em_baixo_total_sem_time_carregando_e_3_pilares',
        confianca: 'observacao_forte',
      });
    }

    return res({
      permitido: false,
      veto: true,
      grupo: 'under25_nao_principal',
      motivo: 'under25_instavel_fora_do_recorte_baixo_total_ninguem_carrega',
      confianca: 'veto_padrao',
    });
  }

  if (market === 'under35') {
    if ((altoUmCarrega || altoDoisFortes || altoDoisVivos) && lambdaTotal >= 2.80) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'under35_jogo_alto_bloqueado',
        motivo: 'under35_em_jogo_alto_virou_armadilha_principalmente_com_dois_lados_vivos_ou_um_carregando',
        confianca: 'veto_forte',
      });
    }

    if (casaContraForte && !(lF && aF)) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'under35_casa_contra_forte_sem_confirmacao_principal',
        motivo: 'under35_casa_contra_forte_sem_lambda_ancora_juntos_deu_muito_red',
        confianca: 'veto_forte',
      });
    }

    if ((baixoNinguem || baixoUmCarrega) && lF && cF && scoreFinal >= 70) {
      return res({
        permitido: true,
        grupo: 'under35_baixo_total_lambda_casa',
        motivo: 'under35_baixo_total_com_lambda_e_casa_confirmando_ancora_pode_ser_neutra',
        confianca: cForca >= 2 ? 'forte' : 'media',
      });
    }

    if (totalMedioBaixo && lF && cF && scoreFinal >= 74 && !(aC && aForca >= 2)) {
      return res({
        permitido: true,
        grupo: 'under35_medio_baixo_lambda_casa_controlado',
        motivo: 'under35_medio_baixo_passa_somente_com_lambda_casa_e_sem_ancora_contra_forte',
        confianca: 'media_controlada',
      });
    }

    return res({
      permitido: false,
      veto: true,
      grupo: 'under35_padrao_nao_permitido',
      motivo: 'under35_fora_do_baixo_total_ou_sem_lambda_casa_confirmando',
      confianca: 'veto_padrao',
    });
  }

  if (market === 'btts_sim') {
    if (lC) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'btts_sim_lambda_contra',
        motivo: 'btts_sim_casa_ancora_nao_salvam_quando_lambda_do_mercado_esta_contra',
        confianca: 'veto_forte',
      });
    }

    if (menorMorto) {
      return res({
        permitido: false,
        veto: true,
        grupo: 'btts_sim_menor_morto',
        motivo: 'btts_sim_precisa_dois_lados_vivos_lambda_menor_morto_veta',
        confianca: 'veto_forte',
      });
    }

    if (tresFavor && altoUmCarrega && menorForte && maiorCarregaMuito && scoreFinal >= 61) {
      return res({
        permitido: true,
        grupo: 'btts_sim_alto_um_time_carrega_menor_vivo',
        motivo: 'btts_sim_um_time_carrega_mas_outro_lado_tem_lambda_suficiente',
        confianca: 'forte',
      });
    }

    if (lF && cF && altoDoisFortes && scoreFinal >= 61 && !aC) {
      return res({
        permitido: true,
        grupo: aF
          ? 'btts_sim_alto_dois_lados_fortes_3_confirmacoes'
          : 'btts_sim_alto_dois_lados_fortes_lambda_casa',
        motivo: 'btts_sim_alto_dois_lados_fortes_com_lambda_e_casa_confirmando',
        confianca: aF ? 'forte' : 'media',
      });
    }

    return res({
      permitido: false,
      veto: true,
      grupo: 'btts_sim_padrao_nao_permitido',
      motivo: 'btts_sim_fora_dos_padroes_auditados_com_dois_lados_vivos',
      confianca: 'veto_padrao',
    });
  }

  if (market === 'btts_nao') {
    return res({
      permitido: false,
      veto: true,
      grupo: 'btts_nao_nao_operacional',
      motivo: 'btts_nao_instavel_na_auditoria_usar_como_alerta_nao_como_entrada',
      confianca: 'veto_padrao',
    });
  }

  return res({
    permitido: true,
    veto: false,
    grupo: 'mercado_sem_regra_rigida',
    motivo: 'mercado_sem_padrao_operacional_configurado',
    confianca: 'neutra',
  });
}


function aplicarAncoraNaEntradaScore(
  market,
  scoreAtual,
  telemetria,
  probCasaMercado = null,
  padraoPreJogo = null
) {
  const scoreAntes = Math.round(
    clampAnchorEntrada(Number(scoreAtual || 0), 0, 100)
  );

  const ajusteAnchor = calcularDeltaEntradaPorAncora(
    market,
    scoreAntes,
    telemetria
  );

  const ajusteCasa = calcularCamadaCasaMercado({
    market,
    scoreBaseLambda: scoreAntes,
    ajusteAnchor,
    probCasa: probCasaMercado,
  });

  const deltaAnchorOriginal = Number(ajusteAnchor?.delta || 0);
  const deltaCasaOriginal = Number(ajusteCasa?.delta_casa || 0);

  const ajusteAuditado = ajustarDeltasPorPadraoAuditado({
    market,
    scoreAntes,
    ajusteAnchor,
    ajusteCasa,
    deltaAnchor: deltaAnchorOriginal,
    deltaCasa: deltaCasaOriginal,
  });

  const deltaAnchor = Number(ajusteAuditado?.deltaAnchorFinal || 0);
  const deltaCasa = Number(ajusteAuditado?.deltaCasaFinal || 0);

  const deltaTotal = Math.round(
    clampAnchorEntrada(deltaAnchor + deltaCasa, -18, 18)
  );

  const scoreDepois = Math.round(
    clampAnchorEntrada(scoreAntes + deltaTotal, 0, 100)
  );

  const resultadoBase = {
    market,

    score_antes_ancora: scoreAntes,
    score_final: scoreDepois,
    padrao_pre_jogo: padraoPreJogo || null,

    desenho_pre_jogo: padraoPreJogo?.desenho_pre_jogo || 'sem_desenho',
    faixa_total: padraoPreJogo?.faixa_total || 'T00_sem_total',
    faixa_lambda_casa: padraoPreJogo?.faixa_lambda_casa || 'HC00_sem_lambda',
    faixa_lambda_fora: padraoPreJogo?.faixa_lambda_fora || 'AW00_sem_lambda',
    faixa_lambda_maior: padraoPreJogo?.faixa_lambda_maior || 'maior_sem_lambda',
    faixa_lambda_menor: padraoPreJogo?.faixa_lambda_menor || 'menor_sem_lambda',
    faixa_diff: padraoPreJogo?.faixa_diff || 'D00_sem_diff',

    lambda_casa_pre: padraoPreJogo?.lambda_casa ?? null,
    lambda_fora_pre: padraoPreJogo?.lambda_fora ?? null,
    lambda_total_pre: padraoPreJogo?.lambda_total ?? null,
    lambda_maior_pre: padraoPreJogo?.lambda_maior ?? null,
    lambda_menor_pre: padraoPreJogo?.lambda_menor ?? null,
    diff_lambda_pre: padraoPreJogo?.diff_lambda ?? null,
    anchor_delta_entrada: deltaAnchor,
    casa_delta_entrada: deltaCasa,
    delta_total_entrada: deltaTotal,

    anchor_delta_original: +Number(deltaAnchorOriginal || 0).toFixed(3),
    casa_delta_original: +Number(deltaCasaOriginal || 0).toFixed(3),

    anchor_delta_ajustado_por_auditoria:
      Math.round(deltaAnchor) !== Math.round(deltaAnchorOriginal),

    casa_delta_ajustado_por_auditoria:
      Math.round(deltaCasa) !== Math.round(deltaCasaOriginal),

    delta_auditado_aplicado: !!ajusteAuditado?.ajustou,
    delta_auditado_motivos: ajusteAuditado?.motivos || [],

    anchor_usada: !!ajusteAnchor?.usar || deltaAnchor !== 0,
    casa_usada: deltaCasa !== 0,

    anchor_score_base_lambda: ajusteAnchor?.score_base_lambda ?? scoreAntes,
    anchor_zona_lambda:
      ajusteAnchor?.zona_lambda ??
      classificarZonaLambdaPorMercado(market, scoreAntes),

    casa_prob_mercado: ajusteCasa?.prob_casa ?? null,
    casa_nivel: ajusteCasa?.casa_nivel ?? 'sem_casa',
    casa_leitura: ajusteCasa?.leitura_casa ?? 'sem_camada_casa',
    casa_motivo: ajusteCasa?.motivo_casa ?? 'camada_casa_nao_aplicada',

    confirmacoes_favor: Number(ajusteCasa?.confirmacoes_favor || 0),
    confirmacoes_contra: Number(ajusteCasa?.confirmacoes_contra || 0),

    forca_favor_ponderada:
      Number(ajusteCasa?.forca_favor_ponderada || 0),

    forca_contra_ponderada:
      Number(ajusteCasa?.forca_contra_ponderada || 0),

    saldo_forca_ponderada:
      Number(ajusteCasa?.saldo_forca_ponderada || 0),

    nivel_confirmacao:
      ajusteCasa?.nivel_confirmacao || 'sem_nivel_confirmacao',

    votos_confirmacao: ajusteCasa?.votos_confirmacao || [],

    anchor_confianca: ajusteAnchor?.confianca ?? 'neutra',
    anchor_motivo_confianca: ajusteAnchor?.motivo_confianca ?? 'sem_motivo',

    anchor_decisao: ajusteAnchor?.decisao ?? 'ignorar',
    anchor_direcao: ajusteAnchor?.direcao ?? 'neutro',
    anchor_motivo: ajusteAnchor?.motivo ?? 'sem_motivo',
    anchor_motivo_aplicacao: ajusteAnchor?.motivo_aplicacao ?? 'sem_aplicacao',

    anchor_nivel: ajusteAnchor?.nivel ?? 0,
    anchor_peso: ajusteAnchor?.peso ?? 0,
    anchor_delta_ponderado: ajusteAnchor?.delta_ponderado ?? 0,

    anchor_ev_media: ajusteAnchor?.ev_media ?? 0,
    anchor_res_media: ajusteAnchor?.res_media ?? 0,
    anchor_prod_media: ajusteAnchor?.prod_media ?? 0,

    anchor_sinais_over: ajusteAnchor?.sinais_over ?? 0,
    anchor_sinais_under: ajusteAnchor?.sinais_under ?? 0,

    anchor_casa_over_ok: ajusteAnchor?.casa_over_ok ?? false,
    anchor_fora_over_ok: ajusteAnchor?.fora_over_ok ?? false,
    anchor_casa_over_forte: ajusteAnchor?.casa_over_forte ?? false,
    anchor_fora_over_forte: ajusteAnchor?.fora_over_forte ?? false,

    anchor_casa_under_ok: ajusteAnchor?.casa_under_ok ?? false,
    anchor_fora_under_ok: ajusteAnchor?.fora_under_ok ?? false,
    anchor_casa_under_forte: ajusteAnchor?.casa_under_forte ?? false,
    anchor_fora_under_forte: ajusteAnchor?.fora_under_forte ?? false,
  };

  const padraoOperacional = avaliarPadraoOperacionalPorMercado(
    market,
    resultadoBase
  );

  return {
    ...resultadoBase,

    padrao_operacional_permitido:
      padraoOperacional.padrao_operacional_permitido,

    veto_operacional:
      padraoOperacional.veto_operacional,

    grupo_padrao_operacional:
      padraoOperacional.grupo_padrao_operacional,

    motivo_padrao_operacional:
      padraoOperacional.motivo_padrao_operacional,

    confianca_padrao_operacional:
      padraoOperacional.confianca_padrao_operacional,

    padrao_operacional_debug:
      padraoOperacional.padrao_operacional_debug,
  };
}

function resolverConflitoOposto({
  overScore,
  underScore,
  overMin = 50,
  underMin = 50,
  overEntrada,
  underEntrada,
  anchorOver,
  anchorUnder,
}) {
  const overPassou = Number(overScore || 0) >= overMin;
  const underPassou = Number(underScore || 0) >= underMin;

  if (overPassou && underPassou) {
    if (overScore > underScore) {
      return {
        over: overEntrada,
        under: 'NO BET',
        motivo: 'ambos_passaram_mas_over_score_maior',
      };
    }

    if (underScore > overScore) {
      return {
        over: 'NO BET',
        under: underEntrada,
        motivo: 'ambos_passaram_mas_under_score_maior',
      };
    }

    const overAnchor = Number(anchorOver?.anchor_delta_entrada || 0);
    const underAnchor = Number(anchorUnder?.anchor_delta_entrada || 0);

    if (overAnchor > underAnchor) {
      return {
        over: overEntrada,
        under: 'NO BET',
        motivo: 'empate_score_anchor_over_maior',
      };
    }

    if (underAnchor > overAnchor) {
      return {
        over: 'NO BET',
        under: underEntrada,
        motivo: 'empate_score_anchor_under_maior',
      };
    }

    return {
      over: 'NO BET',
      under: 'NO BET',
      motivo: 'conflito_sem_desempate',
    };
  }

  return {
    over: overPassou ? overEntrada : 'NO BET',
    under: underPassou ? underEntrada : 'NO BET',
    motivo: 'sem_conflito',
  };
}

function buildEntradas(previsao, finalScores, anchorEntrada = {}) {
  const pCasa = toNum(previsao.win_home_prob, 0);
  const pEmpate = toNum(previsao.draw_prob, 0);
  const pFora = toNum(previsao.win_away_prob, 0);

  const opcoes1x2 = [
    { mercado: 'CASA', prob: pCasa },
    { mercado: 'EMPATE', prob: pEmpate },
    { mercado: 'FORA', prob: pFora },
  ].sort((a, b) => b.prob - a.prob);

  const melhor1x2 = opcoes1x2[0];

  const conflito25 = resolverConflitoOposto({
    overScore: finalScores.scoreOver25,
    underScore: finalScores.scoreUnder25,
    overMin: 50,
    underMin: 53,
    overEntrada: 'OVER25',
    underEntrada: 'UNDER25',
    anchorOver: anchorEntrada.over25,
    anchorUnder: anchorEntrada.under25,
  });

  const conflito35 = resolverConflitoOposto({
    overScore: finalScores.scoreOver35,
    underScore: finalScores.scoreUnder35,
    overEntrada: 'OVER35',
    underEntrada: 'UNDER35',
    anchorOver: anchorEntrada.over35,
    anchorUnder: anchorEntrada.under35,
  });

  const conflitoBtts = resolverConflitoOposto({
    overScore: finalScores.scoreBttsSim,
    underScore: finalScores.scoreBttsNao,
    overMin: 50,
    underMin: 55,
    overEntrada: 'BTTS_SIM',
    underEntrada: 'BTTS_NAO',
    anchorOver: anchorEntrada.btts_sim,
    anchorUnder: anchorEntrada.btts_nao,
  });

  return {
    entrada_1x2: finalScores.score1x2 >= 50 ? melhor1x2.mercado : 'NO BET',

    entrada_over15: finalScores.scoreOver15 >= 50 ? 'OVER15' : 'NO BET',
    entrada_under15: 'NO BET',

    entrada_over25: conflito25.over,
    entrada_under25: conflito25.under,

    entrada_over35: conflito35.over,
    entrada_under35: conflito35.under,

    entrada_btts: conflitoBtts.over,
    entrada_btts_nao: conflitoBtts.under,

    conflitos_resolvidos: {
      over_under_25: conflito25.motivo,
      over_under_35: conflito35.motivo,
      btts: conflitoBtts.motivo,
    },
  };
}


function localClampRunAnalysis(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function localToNumRunAnalysis(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readHistoricoMarket(telemetria, keys = []) {
  /*
    Busca uma leitura histórica de mercado dentro da telemetria.

    Essa função é defensiva:
    - se não existir histórico, retorna null;
    - não quebra o fluxo;
    - permite vários nomes possíveis de estrutura.
  */

  if (!telemetria || typeof telemetria !== 'object') {
    return null;
  }

  const containers = [
    telemetria.historico_mercados,
    telemetria.historicoMercados,
    telemetria.historico,
    telemetria.confianca_historica,
    telemetria.confiancaHistorica,
    telemetria.historical_confidence,
    telemetria.market_history,
    telemetria.mercados_historico,
    telemetria.mercadosHistorico,
  ].filter(Boolean);

  for (const container of containers) {
    if (!container || typeof container !== 'object') {
      continue;
    }

    for (const key of keys || []) {
      if (container[key]) {
        return container[key];
      }
    }

    // fallback: procura ignorando diferenças simples de nome
    const normalizedKeys = Object.keys(container);

    for (const key of keys || []) {
      const foundKey = normalizedKeys.find(k => {
        const a = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
        const b = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
        return a === b;
      });

      if (foundKey && container[foundKey]) {
        return container[foundKey];
      }
    }
  }

  return null;
}

function extrairNumeroHistorico(hist, nomes = []) {
  if (!hist || typeof hist !== 'object') {
    return null;
  }

  for (const nome of nomes) {
    const v = hist[nome];

    if (v === undefined || v === null || v === '') {
      continue;
    }

    const n = Number(v);

    if (Number.isFinite(n)) {
      return n;
    }
  }

  return null;
}

function inferirSampleHistorico(hist) {
  if (!hist || typeof hist !== 'object') {
    return 0;
  }

  const direto = extrairNumeroHistorico(hist, [
    'n',
    'sample',
    'amostra',
    'jogos',
    'total',
    'qtd',
    'count',
  ]);

  if (direto !== null) {
    return Math.max(0, Math.round(direto));
  }

  const green = extrairNumeroHistorico(hist, [
    'green',
    'greens',
    'hits',
    'acertos',
  ]);

  const red = extrairNumeroHistorico(hist, [
    'red',
    'reds',
    'misses',
    'erros',
  ]);

  if (green !== null || red !== null) {
    return Math.max(0, Math.round(Number(green || 0) + Number(red || 0)));
  }

  return 0;
}

function inferirHitRateHistorico(hist) {
  if (!hist || typeof hist !== 'object') {
    return null;
  }

  let hitRate = extrairNumeroHistorico(hist, [
    'hit_rate',
    'hitRate',
    'acerto',
    'taxa_acerto',
    'taxaAcerto',
    'green_rate',
    'greenRate',
    'rate',
  ]);

  if (hitRate !== null) {
    // Se vier 0.61, transforma em 61%.
    if (hitRate >= 0 && hitRate <= 1) {
      hitRate *= 100;
    }

    return localClampRunAnalysis(hitRate, 0, 100);
  }

  const green = extrairNumeroHistorico(hist, [
    'green',
    'greens',
    'hits',
    'acertos',
  ]);

  const red = extrairNumeroHistorico(hist, [
    'red',
    'reds',
    'misses',
    'erros',
  ]);

  const total = Number(green || 0) + Number(red || 0);

  if (total > 0) {
    return localClampRunAnalysis((Number(green || 0) / total) * 100, 0, 100);
  }

  return null;
}

function applyHistoricalConfidence(market, scoreBase, hist) {
  /*
    Ajuste leve por histórico.

    Importante:
    - Não é a âncora principal.
    - Se não tiver histórico, não muda nada.
    - Retorna sempre:
        finalScore
        delta
        leitura
      porque a main usa isso no log.
  */

  const base = Math.round(
    localClampRunAnalysis(localToNumRunAnalysis(scoreBase, 0), 0, 100)
  );

  if (!hist || typeof hist !== 'object') {
    return {
      market,
      scoreBase: base,
      finalScore: base,
      delta: 0,
      leitura: 'sem_historico',
      sample: 0,
      hit_rate: null,
    };
  }

  const sample = inferirSampleHistorico(hist);
  const hitRate = inferirHitRateHistorico(hist);

  if (hitRate === null || sample <= 0) {
    return {
      market,
      scoreBase: base,
      finalScore: base,
      delta: 0,
      leitura: 'historico_sem_hit_rate',
      sample,
      hit_rate: hitRate,
    };
  }

  if (sample < 8) {
    return {
      market,
      scoreBase: base,
      finalScore: base,
      delta: 0,
      leitura: 'historico_amostra_baixa',
      sample,
      hit_rate: +hitRate.toFixed(2),
    };
  }

  /*
    Delta conservador:
    - histórico bom reforça um pouco;
    - histórico ruim reduz um pouco;
    - a âncora operacional continua sendo a camada forte.
  */

  let rawDelta = 0;
  let leitura = 'historico_neutro';

  if (hitRate >= 68) {
    rawDelta = 5;
    leitura = 'historico_muito_forte';
  } else if (hitRate >= 62) {
    rawDelta = 3;
    leitura = 'historico_favoravel';
  } else if (hitRate >= 56) {
    rawDelta = 1;
    leitura = 'historico_levemente_favoravel';
  } else if (hitRate <= 38) {
    rawDelta = -5;
    leitura = 'historico_muito_ruim';
  } else if (hitRate <= 44) {
    rawDelta = -3;
    leitura = 'historico_ruim';
  } else if (hitRate <= 48) {
    rawDelta = -1;
    leitura = 'historico_levemente_ruim';
  }

  /*
    Quanto menor a amostra, menor o peso.
    Com 8 jogos quase não mexe.
    Com 38+ jogos aplica inteiro.
  */
  const sampleWeight = localClampRunAnalysis((sample - 8) / 30, 0.25, 1);
  let delta = Math.round(rawDelta * sampleWeight);

  /*
    Travas por mercado:
    - Over 1.5 já é bom/permissivo, não reduzir demais.
    - Under 1.5 não deve ser criado por histórico.
    - BTTS Não é fraco, deixa histórico negativo cortar mais que reforçar.
  */
  if (market === 'over15') {
    delta = localClampRunAnalysis(delta, -2, 4);
  } else if (market === 'under15') {
    delta = Math.min(delta, 0);
  } else if (market === 'btts_nao') {
    delta = localClampRunAnalysis(delta, -5, 3);
  } else {
    delta = localClampRunAnalysis(delta, -5, 5);
  }

  const finalScore = Math.round(
    localClampRunAnalysis(base + delta, 0, 100)
  );

  return {
    market,
    scoreBase: base,
    finalScore,
    delta,
    leitura,
    sample,
    hit_rate: +hitRate.toFixed(2),
  };
}
function mergePreferindoValor(objPrincipal, objFallback) {
  const out = { ...(objFallback || {}) };

  for (const [k, v] of Object.entries(objPrincipal || {})) {
    if (v !== null && v !== undefined && v !== '') {
      out[k] = v;
    }
  }

  return out;
}

async function carregarMercadoAnalisesJogos(flashscoreIds = []) {
  const ids = [...new Set(
    (flashscoreIds || [])
      .filter(Boolean)
      .map(String)
  )];

  if (!ids.length) {
    return new Map();
  }

  const sql = `
    SELECT DISTINCT ON (flashscore_id_jogo)
      flashscore_id_jogo,

      odd_mercado_casa,
      p_mercado_casa,
      odd_mercado_empate,
      p_mercado_empate,
      odd_mercado_fora,
      p_mercado_fora,

      odd_mercado_over15,
      p_mercado_over15,
      odd_mercado_under15,
      p_mercado_under15,

      odd_mercado_over25,
      p_mercado_over25,
      odd_mercado_under25,
      p_mercado_under25,

      odd_mercado_over35,
      p_mercado_over35,
      odd_mercado_under35,
      p_mercado_under35,

      odd_mercado_btts_sim,
      p_mercado_btts_sim,
      odd_mercado_btts_nao,
      p_mercado_btts_nao,

      odd_coletada,
      criado_em
    FROM analises_jogos
    WHERE flashscore_id_jogo = ANY($1::text[])
    ORDER BY flashscore_id_jogo, criado_em DESC NULLS LAST, id DESC
  `;

  const { rows } = await pool.query(sql, [ids]);

  const map = new Map();

  for (const row of rows || []) {
    map.set(String(row.flashscore_id_jogo), row);
  }

  return map;
}
async function main() {
  const argDate = process.argv.find(a => a.startsWith('--date='))?.split('=')[1];
  const data = argDate || process.env.DATA_ALVO || '2026-04-20';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    throw new Error(`DATA inválida: ${data}`);
  }

  console.log(`\n🚀 [MAESTRO] Iniciando Fluxo para: ${data}`);

  try {
    console.log('3. Buscando jogos do dia...');
    const jogos = await pegaJogosDoDia(data);
    console.log(`   Encontrados ${jogos.length} jogos.`);

    if (!jogos.length) {
      console.log('ℹ️ Nenhum jogo para analisar nessa data.');
      return;
    }

    const mercadoAnalisesMap = await carregarMercadoAnalisesJogos(
      jogos.map(j => j.flashscore_id)
    );

    console.log(
      `🏦 Odds/probabilidades carregadas de analises_jogos: ${mercadoAnalisesMap.size}/${jogos.length}`
    );

    const queryInsert = `
      INSERT INTO analises_jogos (
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
        l_home,
        l_away,
        total_esperado,

        p_casa,
        o_casa,
        p_empate,
        o_empate,
        p_fora,
        o_fora,
        entrada_1x2,

        p_over15,
        o_over15,
        p_under15,
        o_under15,
        entrada_over15,
        entrada_under15,

        p_over25,
        o_over25,
        p_under25,
        o_under25,
        entrada_over25,
        entrada_under25,

        p_over35,
        o_over35,
        p_under35,
        o_under35,
        entrada_over35,
        entrada_under35,

        p_btts_sim,
        o_btts_sim,
        p_btts_nao,
        o_btts_nao,
        entrada_btts,
        entrada_btts_nao,

        anchor_tipo,
        anchor_delta_over15,
        anchor_delta_over25,
        anchor_delta_over35,
        anchor_delta_btts,
        anchor_hist_casa_qtd,
        anchor_hist_fora_qtd,
        anchor_over25_motivo,
        anchor_btts_motivo,
               anchor_under35_motivo,
        telemetria_anchor,

        versao_filtro_operacional,
        filtro_operacional,

        passou_filtro_over15,
        nivel_filtro_over15,
        decisao_filtro_over15,

        passou_filtro_over25,
        nivel_filtro_over25,
        decisao_filtro_over25,

        passou_filtro_under25,
        nivel_filtro_under25,
        decisao_filtro_under25,

        passou_filtro_under35,
        nivel_filtro_under35,
        decisao_filtro_under35,

        passou_filtro_btts_sim,
        nivel_filtro_btts_sim,
        decisao_filtro_btts_sim,

        passou_filtro_1x2_casa,
        nivel_filtro_1x2_casa,
        decisao_filtro_1x2_casa,

        passou_filtro_1x2_fora,
        nivel_filtro_1x2_fora,
        decisao_filtro_1x2_fora,

        mercado_filtro_principal,
        nivel_filtro_principal,
        decisao_filtro_principal
      ) VALUES (
         $1,  $2,  $3,  $4,  $5,  $6,  $7,  $8,  $9,  $10, $11,
         $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21,
         $22, $23, $24, $25, $26, $27,
         $28, $29, $30, $31, $32, $33,
         $34, $35, $36, $37, $38, $39,
         $40, $41, $42, $43, $44, $45,
         $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56::jsonb,

         $57,
         $58::jsonb,

         $59, $60, $61,
         $62, $63, $64,
         $65, $66, $67,
         $68, $69, $70,
         $71, $72, $73,
         $74, $75, $76,
         $77, $78, $79,

         $80, $81, $82      )
      ON CONFLICT (flashscore_id_jogo) DO UPDATE SET
        data_jogo = EXCLUDED.data_jogo,
        hora_jogo = EXCLUDED.hora_jogo,
        flashscore_slug_liga = EXCLUDED.flashscore_slug_liga,
        time_casa = EXCLUDED.time_casa,
        time_fora = EXCLUDED.time_fora,
        url = EXCLUDED.url,
        id_time_casa = EXCLUDED.id_time_casa,
        id_time_fora = EXCLUDED.id_time_fora,
        flashscore_id_casa = EXCLUDED.flashscore_id_casa,
        flashscore_id_fora = EXCLUDED.flashscore_id_fora,

        l_home = EXCLUDED.l_home,
        l_away = EXCLUDED.l_away,
        total_esperado = EXCLUDED.total_esperado,

        p_casa = EXCLUDED.p_casa,
        o_casa = EXCLUDED.o_casa,
        p_empate = EXCLUDED.p_empate,
        o_empate = EXCLUDED.o_empate,
        p_fora = EXCLUDED.p_fora,
        o_fora = EXCLUDED.o_fora,
        entrada_1x2 = EXCLUDED.entrada_1x2,

        p_over15 = EXCLUDED.p_over15,
        o_over15 = EXCLUDED.o_over15,
        p_under15 = EXCLUDED.p_under15,
        o_under15 = EXCLUDED.o_under15,
        entrada_over15 = EXCLUDED.entrada_over15,
        entrada_under15 = EXCLUDED.entrada_under15,

        p_over25 = EXCLUDED.p_over25,
        o_over25 = EXCLUDED.o_over25,
        p_under25 = EXCLUDED.p_under25,
        o_under25 = EXCLUDED.o_under25,
        entrada_over25 = EXCLUDED.entrada_over25,
        entrada_under25 = EXCLUDED.entrada_under25,

        p_over35 = EXCLUDED.p_over35,
        o_over35 = EXCLUDED.o_over35,
        p_under35 = EXCLUDED.p_under35,
        o_under35 = EXCLUDED.o_under35,
        entrada_over35 = EXCLUDED.entrada_over35,
        entrada_under35 = EXCLUDED.entrada_under35,

        p_btts_sim = EXCLUDED.p_btts_sim,
        o_btts_sim = EXCLUDED.o_btts_sim,
        p_btts_nao = EXCLUDED.p_btts_nao,
        o_btts_nao = EXCLUDED.o_btts_nao,
        entrada_btts = EXCLUDED.entrada_btts,
        entrada_btts_nao = EXCLUDED.entrada_btts_nao,

        anchor_tipo = EXCLUDED.anchor_tipo,
        anchor_delta_over15 = EXCLUDED.anchor_delta_over15,
        anchor_delta_over25 = EXCLUDED.anchor_delta_over25,
        anchor_delta_over35 = EXCLUDED.anchor_delta_over35,
        anchor_delta_btts = EXCLUDED.anchor_delta_btts,
        anchor_hist_casa_qtd = EXCLUDED.anchor_hist_casa_qtd,
        anchor_hist_fora_qtd = EXCLUDED.anchor_hist_fora_qtd,
        anchor_over25_motivo = EXCLUDED.anchor_over25_motivo,
        anchor_btts_motivo = EXCLUDED.anchor_btts_motivo,
        anchor_under35_motivo = EXCLUDED.anchor_under35_motivo,
        telemetria_anchor = EXCLUDED.telemetria_anchor,

        versao_filtro_operacional = EXCLUDED.versao_filtro_operacional,
        filtro_operacional = EXCLUDED.filtro_operacional,

        passou_filtro_over15 = EXCLUDED.passou_filtro_over15,
        nivel_filtro_over15 = EXCLUDED.nivel_filtro_over15,
        decisao_filtro_over15 = EXCLUDED.decisao_filtro_over15,

        passou_filtro_over25 = EXCLUDED.passou_filtro_over25,
        nivel_filtro_over25 = EXCLUDED.nivel_filtro_over25,
        decisao_filtro_over25 = EXCLUDED.decisao_filtro_over25,

        passou_filtro_under25 = EXCLUDED.passou_filtro_under25,
        nivel_filtro_under25 = EXCLUDED.nivel_filtro_under25,
        decisao_filtro_under25 = EXCLUDED.decisao_filtro_under25,

        passou_filtro_under35 = EXCLUDED.passou_filtro_under35,
        nivel_filtro_under35 = EXCLUDED.nivel_filtro_under35,
        decisao_filtro_under35 = EXCLUDED.decisao_filtro_under35,

        passou_filtro_btts_sim = EXCLUDED.passou_filtro_btts_sim,
        nivel_filtro_btts_sim = EXCLUDED.nivel_filtro_btts_sim,
        decisao_filtro_btts_sim = EXCLUDED.decisao_filtro_btts_sim,

        passou_filtro_1x2_casa = EXCLUDED.passou_filtro_1x2_casa,
        nivel_filtro_1x2_casa = EXCLUDED.nivel_filtro_1x2_casa,
        decisao_filtro_1x2_casa = EXCLUDED.decisao_filtro_1x2_casa,

        passou_filtro_1x2_fora = EXCLUDED.passou_filtro_1x2_fora,
        nivel_filtro_1x2_fora = EXCLUDED.nivel_filtro_1x2_fora,
        decisao_filtro_1x2_fora = EXCLUDED.decisao_filtro_1x2_fora,

        mercado_filtro_principal = EXCLUDED.mercado_filtro_principal,
        nivel_filtro_principal = EXCLUDED.nivel_filtro_principal,
        decisao_filtro_principal = EXCLUDED.decisao_filtro_principal
            `;

    for (const jogo of jogos) {
      console.log(`🔍 Analisando: ${jogo.nome_time_casa} x ${jogo.nome_time_fora}`);

      const res = await analyzeTeamGolsFromFiltered(jogo);

      if (res.status !== 'success') {
        console.log(`   ⚠️ Pulado: ${res.motivo || res.error}`);
        continue;
      }

      const { previsao, telemetria } = res;

      const mercadoDb = mercadoAnalisesMap.get(String(jogo.flashscore_id)) || null;
      const jogoComMercado = mergePreferindoValor(jogo, mercadoDb || {});

      const over15Prob = toNum(previsao.over_1_5_prob || 0);
      const over25Prob = toNum(previsao.over_2_5_prob || 0);
      const over35Prob = toNum(previsao.over_3_5_prob || 0);
      const bttsSimProb = toNum(previsao.btts_prob || 0);

      const under15Prob = Number.isFinite(Number(previsao.under_1_5_prob))
        ? toNum(previsao.under_1_5_prob)
        : +(100 - over15Prob).toFixed(2);

      const under25Prob = Number.isFinite(Number(previsao.under_2_5_prob))
        ? toNum(previsao.under_2_5_prob)
        : +(100 - over25Prob).toFixed(2);

      const under35Prob = Number.isFinite(Number(previsao.under_3_5_prob))
        ? toNum(previsao.under_3_5_prob)
        : +(100 - over35Prob).toFixed(2);

      const bttsNaoProb = Number.isFinite(Number(previsao.btts_nao_prob))
        ? toNum(previsao.btts_nao_prob)
        : +(100 - bttsSimProb).toFixed(2);

      previsao.under_1_5_prob = under15Prob;
      previsao.under_2_5_prob = under25Prob;
      previsao.under_3_5_prob = under35Prob;
      previsao.btts_nao_prob = bttsNaoProb;

      const lHome = toNum(telemetria?.lHome || 0);
      const lAway = toNum(telemetria?.lAway || 0);
      const totalEsperado = +(lHome + lAway).toFixed(3);

      const perfilEdge = {
        edge_over25: 0,
        edge_btts: 0,
        sugestao_over25: 'NEUTRO',
        sugestao_btts: 'NEUTRO',
      };

      // =========================================================
      // SCORES BASE
      // =========================================================

      const score1x2Base = Math.round(Math.max(
        toNum(previsao.win_home_prob || 0),
        toNum(previsao.draw_prob || 0),
        toNum(previsao.win_away_prob || 0)
      ));

      const scoreOver15Base = Math.round(over15Prob);

      const scoreOver25Base = applyEdgeToScore(
        previsao.over_2_5_prob,
        perfilEdge.edge_over25,
        perfilEdge.sugestao_over25
      );

      const scoreOver35Base = Math.round(over35Prob);

      const scoreBttsSimBase = applyEdgeToScore(
        previsao.btts_prob,
        perfilEdge.edge_btts,
        perfilEdge.sugestao_btts
      );

      const scoreUnder25Base = Math.round(under25Prob);
      const scoreUnder35Base = Math.round(under35Prob);
      const scoreBttsNaoBase = Math.round(bttsNaoProb);

      // =========================================================
      // HISTÓRICO DE CONFIANÇA
      // =========================================================

      const hist1x2 = readHistoricoMarket(telemetria, ['1x2', 'mercado_1x2', 'one_x_two']);
      const histOver15 = readHistoricoMarket(telemetria, ['over15', 'over_1_5']);
      const histOver25 = readHistoricoMarket(telemetria, ['over25', 'over_2_5']);
      const histOver35 = readHistoricoMarket(telemetria, ['over35', 'over_3_5']);
      const histBttsSim = readHistoricoMarket(telemetria, ['btts_sim', 'btts', 'btts_yes']);
      const histUnder25 = readHistoricoMarket(telemetria, ['under25', 'under_2_5']);
      const histUnder35 = readHistoricoMarket(telemetria, ['under35', 'under_3_5']);
      const histBttsNao = readHistoricoMarket(telemetria, ['btts_nao', 'btts_no']);

      const score1x2Final = applyHistoricalConfidence('1x2', score1x2Base, hist1x2);
      const scoreOver15Hist = applyHistoricalConfidence('over15', scoreOver15Base, histOver15);
      const scoreOver25Hist = applyHistoricalConfidence('over25', scoreOver25Base, histOver25);
      const scoreOver35Hist = applyHistoricalConfidence('over35', scoreOver35Base, histOver35);
      const scoreBttsSimHist = applyHistoricalConfidence('btts_sim', scoreBttsSimBase, histBttsSim);
      const scoreUnder25Hist = applyHistoricalConfidence('under25', scoreUnder25Base, histUnder25);
      const scoreUnder35Hist = applyHistoricalConfidence('under35', scoreUnder35Base, histUnder35);
      const scoreBttsNaoHist = applyHistoricalConfidence('btts_nao', scoreBttsNaoBase, histBttsNao);

      // =========================================================
      // CASA / MERCADO COMO CAMADA EXTERNA
      // =========================================================

      const casaMercado = {
        over15: extrairProbCasaMercado(jogoComMercado, 'over15'),
        under15: extrairProbCasaMercado(jogoComMercado, 'under15'),

        over25: extrairProbCasaMercado(jogoComMercado, 'over25'),
        under25: extrairProbCasaMercado(jogoComMercado, 'under25'),

        over35: extrairProbCasaMercado(jogoComMercado, 'over35'),
        under35: extrairProbCasaMercado(jogoComMercado, 'under35'),

        btts_sim: extrairProbCasaMercado(jogoComMercado, 'btts_sim'),
        btts_nao: extrairProbCasaMercado(jogoComMercado, 'btts_nao'),

        casa: extrairProbCasaMercado(jogoComMercado, 'casa'),
        empate: extrairProbCasaMercado(jogoComMercado, 'empate'),
        fora: extrairProbCasaMercado(jogoComMercado, 'fora'),
      };

      const temCasaMercado = Object.values(casaMercado)
        .some(v => v !== null && v !== undefined);

      if (!temCasaMercado) {
        console.log(
          `   ⚠️ [CASA MERCADO] Sem odds/probabilidades em analises_jogos para ${jogo.flashscore_id}`
        );
      } else {
        console.log(
          `   🏦 Casa mercado: ` +
          `O1.5=${casaMercado.over15 ?? 'null'} ` +
          `O2.5=${casaMercado.over25 ?? 'null'} ` +
          `U2.5=${casaMercado.under25 ?? 'null'} ` +
          `U3.5=${casaMercado.under35 ?? 'null'} ` +
          `BTTS=${casaMercado.btts_sim ?? 'null'} ` +
          `BTTS_NAO=${casaMercado.btts_nao ?? 'null'}`
        );
      }

      // =========================================================
      // TESTE: ENTRADA PURA DO TEAM_GOALS
      // =========================================================
      // Objetivo:
      // - NÃO aplicar a segunda camada do run_analysis
      // - NÃO aplicar casa mercado
      // - NÃO aplicar aplicarAncoraNaEntradaScore
      // - NÃO aplicar veto operacional
      // - Usar somente os scores que já vieram do team_goals
      //
      // Importante:
      // O team_goals já calculou a nova âncora rating_batalhas_anchor
      // e já ajustou as probabilidades da previsão.
      // Aqui estamos só auditando o que aconteceria SEM a camada operacional extra.
      // =========================================================

      const padraoPreJogo = classificarPadraoPreJogo({
        lambdaCasa: lHome,
        lambdaFora: lAway,
        lambdaTotal: totalEsperado,
      });

      console.log(
        `   🧪 TESTE TEAM_GOALS PURO | ` +
        `${padraoPreJogo.desenho_pre_jogo} | ` +
        `${padraoPreJogo.faixa_total} | ` +
        `casa=${padraoPreJogo.lambda_casa} fora=${padraoPreJogo.lambda_fora} ` +
        `maior=${padraoPreJogo.lambda_maior} menor=${padraoPreJogo.lambda_menor}`
      );

      function criarAnchorEntradaNeutra(market, scoreFinal) {
        return {
          market,
          anchor_key: market,

          usar: false,
          delta: 0,

          score_base_lambda: Math.round(Number(scoreFinal || 0)),
          zona_lambda: 'teste_team_goals_puro',

          decisao: 'ignorar',
          direcao: 'neutro',
          motivo: 'segunda_camada_run_analysis_desligada_para_teste',

          confianca: 'neutra',
          motivo_confianca: 'teste_sem_anchor_entrada',

          nivel: 0,
          peso: 0,
          delta_ponderado: 0,

          ev_media: 0,
          res_media: 0,
          prod_media: 0,

          sinais_over: 0,
          sinais_under: 0,

          casa_over_ok: false,
          fora_over_ok: false,
          casa_over_forte: false,
          fora_over_forte: false,

          casa_under_ok: false,
          fora_under_ok: false,
          casa_under_forte: false,
          fora_under_forte: false,

          anchor_delta_entrada: 0,
          casa_delta_entrada: 0,
          delta_total_entrada: 0,

          score_antes_anchor: Math.round(Number(scoreFinal || 0)),
          score_final: Math.round(Number(scoreFinal || 0)),

          casa_usada: false,
          casa_nivel: 'desligada',
          casa_leitura: 'casa_mercado_desligada_no_teste',
          casa_motivo: 'teste_team_goals_puro',

          anchor_usada: false,
          anchor_nivel: 0,
          anchor_motivo: 'segunda_camada_run_analysis_desligada',
          anchor_decisao: 'ignorar',
          anchor_direcao: 'neutro',
          anchor_ev_media: 0,

          faixa_total: padraoPreJogo.faixa_total,
          faixa_diff: null,
          lambda_casa_pre: padraoPreJogo.lambda_casa,
          lambda_fora_pre: padraoPreJogo.lambda_fora,
          diff_lambda_pre: Math.abs(Number(padraoPreJogo.lambda_casa || 0) - Number(padraoPreJogo.lambda_fora || 0)),

          padrao_operacional_permitido: true,
          veto_operacional: false,
          grupo_padrao_operacional: 'teste_sem_veto',
          motivo_padrao_operacional: 'veto_operacional_desligado_para_teste_team_goals_puro',
          confianca_padrao_operacional: 'teste',
          padrao_operacional_debug: {
            teste_team_goals_puro: true,
            observacao: 'run_analysis_nao_aplicou_segunda_camada_nem_veto',
          },
        };
      }

      /*
        Scores finais do teste:
        Usamos os scores base, porque eles já vieram da previsão do team_goals.
        Assim isolamos o efeito da nova âncora dentro do team_goals.
      */
      const finalScores = {
        score1x2: score1x2Base,

        scoreOver15: scoreOver15Base,
        scoreOver25: scoreOver25Base,
        scoreOver35: scoreOver35Base,

        scoreBttsSim: scoreBttsSimBase,

        scoreUnder25: scoreUnder25Base,
        scoreUnder35: scoreUnder35Base,
        scoreBttsNao: scoreBttsNaoBase,
      };

      const anchorEntrada = {
        over15: criarAnchorEntradaNeutra('over15', finalScores.scoreOver15),
        under15: criarAnchorEntradaNeutra('under15', 100 - finalScores.scoreOver15),

        over25: criarAnchorEntradaNeutra('over25', finalScores.scoreOver25),
        under25: criarAnchorEntradaNeutra('under25', finalScores.scoreUnder25),

        over35: criarAnchorEntradaNeutra('over35', finalScores.scoreOver35),
        under35: criarAnchorEntradaNeutra('under35', finalScores.scoreUnder35),

        btts_sim: criarAnchorEntradaNeutra('btts_sim', finalScores.scoreBttsSim),
        btts_nao: criarAnchorEntradaNeutra('btts_nao', finalScores.scoreBttsNao),
      };

      /*
        BuildEntradas ainda é usado para aplicar os cortes básicos:
        - Over 1.5 >= 50
        - Over 2.5 >= 50
        - Under 2.5 >= 53
        - BTTS etc.
        Mas sem desempate por âncora, porque anchor_delta_entrada = 0.
      */
      const entradas = buildEntradas(
        previsao,
        finalScores,
        anchorEntrada
      );

      const entradasAntesFiltro = { ...entradas };

      const filtroOperacionalBase = aplicarFiltrosOperacionaisValidados({
        previsao,
        telemetria,
        finalScores,
        lHome,
        lAway,
      });

      const filtroOperacional = aplicarPerfilContextualAoFiltroOperacional({
        filtroOperacional: filtroOperacionalBase,
        telemetria,
      });

      const entradasFiltradas = montarEntradasPeloFiltroOperacional(filtroOperacional);

      Object.assign(entradas, entradasFiltradas);

      console.log('\n🧠 PERFIL CONTEXTUAL');
      console.log(
        `   Premium: ${filtroOperacional.perfil_contextual?.resumo?.premium?.length || 0} | ` +
        `Cautela: ${filtroOperacional.perfil_contextual?.resumo?.cautela?.length || 0} | ` +
        `Veto: ${filtroOperacional.perfil_contextual?.resumo?.veto?.length || 0} | ` +
        `Resgate: ${filtroOperacional.perfil_contextual?.resumo?.resgate?.length || 0}`
      );

      for (const [k, v] of Object.entries(filtroOperacional.perfil_contextual?.mercados || {})) {
        console.log(
          `   ${k}: ${v.status} | ${v.decisao} | score=${v.score} | ` +
          `premium=${v.premium_pontos} veto=${v.veto_pontos}`
        );
      }

      console.log(`   Over 1.5: ${filtroOperacional.filtros.over15.nivel} | ${filtroOperacional.filtros.over15.decisao}`);
      console.log(`   Over 2.5: ${filtroOperacional.filtros.over25.nivel} | ${filtroOperacional.filtros.over25.decisao}`);
      console.log(`   Under 2.5: ${filtroOperacional.filtros.under25.nivel} | ${filtroOperacional.filtros.under25.decisao}`);
      console.log(`   Under 3.5: ${filtroOperacional.filtros.under35.nivel} | ${filtroOperacional.filtros.under35.decisao}`);
      console.log(`   BTTS Sim: ${filtroOperacional.filtros.btts_sim.nivel} | ${filtroOperacional.filtros.btts_sim.decisao}`);
      console.log(`   1X2 Casa: ${filtroOperacional.filtros.casa.nivel} | ${filtroOperacional.filtros.casa.decisao}`);
      console.log(`   1X2 Fora: ${filtroOperacional.filtros.fora.nivel} | ${filtroOperacional.filtros.fora.decisao}`);

      if (
        telemetria &&
        telemetria.anchor_mercados_aplicacao &&
        typeof telemetria.anchor_mercados_aplicacao === 'object'
      ) {
        telemetria.anchor_mercados_aplicacao.entrada_operacional = {
          enabled: true,
          observacao: 'TESTE_TEAM_GOALS_PURO_sem_segunda_camada_run_analysis_sem_casa_sem_veto', casa_mercado_origem: mercadoDb
            ? 'analises_jogos'
            : (temCasaMercado ? 'jogo' : 'nao_encontrado'),
          casa_mercado: casaMercado,

          scores_base: {
            score1x2Base,
            scoreOver15Base,
            scoreOver25Base,
            scoreOver35Base,
            scoreBttsSimBase,
            scoreUnder25Base,
            scoreUnder35Base,
            scoreBttsNaoBase,
          },

          scores_pos_historico: {
            score1x2: score1x2Final.finalScore,
            scoreOver15: scoreOver15Hist.finalScore,
            scoreOver25: scoreOver25Hist.finalScore,
            scoreOver35: scoreOver35Hist.finalScore,
            scoreBttsSim: scoreBttsSimHist.finalScore,
            scoreUnder25: scoreUnder25Hist.finalScore,
            scoreUnder35: scoreUnder35Hist.finalScore,
            scoreBttsNao: scoreBttsNaoHist.finalScore,
          },

          scores_finais: finalScores,

          anchor_entrada: anchorEntrada,

          entradas_antes_filtro: entradasAntesFiltro,
          entradas_depois_filtro: entradas,
          filtro_operacional: filtroOperacional,

          historico_confidence: {
            score1x2Final,
            scoreOver15Hist,
            scoreOver25Hist,
            scoreOver35Hist,
            scoreBttsSimHist,
            scoreUnder25Hist,
            scoreUnder35Hist,
            scoreBttsNaoHist,
          },
        };
      }

      const anchorDb = extrairCamposAnchorContextual(res);

      // =========================================================
      // ODDS JUSTAS
      // =========================================================

      const oddCasa =
        toNum(previsao.odd_justa_home || 0) ||
        oddFromPercent(previsao.win_home_prob);

      const oddEmpate =
        toNum(previsao.odd_justa_draw || 0) ||
        oddFromPercent(previsao.draw_prob);

      const oddFora =
        toNum(previsao.odd_justa_away || 0) ||
        oddFromPercent(previsao.win_away_prob);

      const oddOver15 =
        toNum(previsao.odd_justa_over_1_5 || 0) ||
        oddFromPercent(over15Prob);

      const oddUnder15 =
        toNum(previsao.odd_justa_under_1_5 || 0) ||
        oddFromPercent(under15Prob);

      const oddOver25 =
        toNum(previsao.odd_justa_over_2_5 || 0) ||
        oddFromPercent(over25Prob);

      const oddUnder25 =
        toNum(previsao.odd_justa_under_2_5 || 0) ||
        oddFromPercent(under25Prob);

      const oddOver35 =
        toNum(previsao.odd_justa_over_3_5 || 0) ||
        oddFromPercent(over35Prob);

      const oddUnder35 =
        toNum(previsao.odd_justa_under_3_5 || 0) ||
        oddFromPercent(under35Prob);

      const oddBTTS =
        toNum(previsao.odd_justa_btts || 0) ||
        oddFromPercent(bttsSimProb);

      const oddBTTSNao =
        toNum(previsao.odd_justa_btts_nao || 0) ||
        oddFromPercent(bttsNaoProb);

      // =========================================================
      // INSERT / UPDATE
      // =========================================================

      await pool.query(queryInsert, [
        jogo.flashscore_id,                   // 1
        jogo.data_jogo,                       // 2
        jogo.hora_jogo || null,               // 3
        jogo.flashscore_slug_liga || null,    // 4
        jogo.nome_time_casa,                  // 5
        jogo.nome_time_fora,                  // 6
        jogo.url || null,                     // 7
        jogo.id_time_casa || null,            // 8
        jogo.id_time_fora || null,            // 9
        jogo.flashscore_id_time_casa || null, // 10
        jogo.flashscore_id_time_fora || null, // 11

        lHome,                                // 12
        lAway,                                // 13
        totalEsperado,                        // 14

        toNum(previsao.win_home_prob || 0),   // 15
        oddCasa,                              // 16
        toNum(previsao.draw_prob || 0),       // 17
        oddEmpate,                            // 18
        toNum(previsao.win_away_prob || 0),   // 19
        oddFora,                              // 20
        entradas.entrada_1x2,                 // 21

        over15Prob,                           // 22
        oddOver15,                            // 23
        under15Prob,                          // 24
        oddUnder15,                           // 25
        entradas.entrada_over15,              // 26
        entradas.entrada_under15,             // 27

        over25Prob,                           // 28
        oddOver25,                            // 29
        under25Prob,                          // 30
        oddUnder25,                           // 31
        entradas.entrada_over25,              // 32
        entradas.entrada_under25,             // 33

        over35Prob,                           // 34
        oddOver35,                            // 35
        under35Prob,                          // 36
        oddUnder35,                           // 37
        entradas.entrada_over35,              // 38
        entradas.entrada_under35,             // 39

        bttsSimProb,                          // 40
        oddBTTS,                              // 41
        bttsNaoProb,                          // 42
        oddBTTSNao,                           // 43
        entradas.entrada_btts,                // 44
        entradas.entrada_btts_nao,            // 45

        anchorDb.anchor_tipo,                 // 46
        anchorDb.anchor_delta_over15,         // 47
        anchorDb.anchor_delta_over25,         // 48
        anchorDb.anchor_delta_over35,         // 49
        anchorDb.anchor_delta_btts,           // 50
        anchorDb.anchor_hist_casa_qtd,        // 51
        anchorDb.anchor_hist_fora_qtd,        // 52
        anchorDb.anchor_over25_motivo,        // 53
        anchorDb.anchor_btts_motivo,          // 54
        anchorDb.anchor_under35_motivo,       // 55
        anchorDb.telemetria_anchor,           // 56

        ...colunasFiltroOperacionalParaInsert(filtroOperacional),
      ]);

      const algumFiltroPassou = Object.values(filtroOperacional?.filtros || {})
        .some(f => f?.passou);

      if (algumFiltroPassou) {
        console.log('✅ Pelo menos um mercado passou no filtro operacional.');
      } else {
        console.log('🚫 Nenhum mercado passou no filtro operacional.');
      }
      console.log(
        `   ✅ Gravado` +

        ` | 1X2: ${entradas.entrada_1x2} (${score1x2Base}→${finalScores.score1x2}, hist=${score1x2Final.leitura}, d=${score1x2Final.delta})` +

        ` | O1.5: ${entradas.entrada_over15} (${scoreOver15Base}→${scoreOver15Hist.finalScore}→${finalScores.scoreOver15}, hist=${scoreOver15Hist.leitura}, hD=${scoreOver15Hist.delta}, aD=${anchorEntrada.over15.anchor_delta_entrada}, cD=${anchorEntrada.over15.casa_delta_entrada}, c=${anchorEntrada.over15.casa_nivel}, a=${anchorEntrada.over15.anchor_decisao}, p=${anchorEntrada.over15.grupo_padrao_operacional})` +

        ` | O2.5: ${entradas.entrada_over25} (${scoreOver25Base}→${scoreOver25Hist.finalScore}→${finalScores.scoreOver25}, hist=${scoreOver25Hist.leitura}, hD=${scoreOver25Hist.delta}, aD=${anchorEntrada.over25.anchor_delta_entrada}, cD=${anchorEntrada.over25.casa_delta_entrada}, c=${anchorEntrada.over25.casa_nivel}, a=${anchorEntrada.over25.anchor_decisao}, p=${anchorEntrada.over25.grupo_padrao_operacional})` +

        ` | O3.5: ${entradas.entrada_over35} (${scoreOver35Base}→${scoreOver35Hist.finalScore}→${finalScores.scoreOver35}, hist=${scoreOver35Hist.leitura}, hD=${scoreOver35Hist.delta}, aD=${anchorEntrada.over35.anchor_delta_entrada}, cD=${anchorEntrada.over35.casa_delta_entrada}, c=${anchorEntrada.over35.casa_nivel}, a=${anchorEntrada.over35.anchor_decisao}, p=${anchorEntrada.over35.grupo_padrao_operacional})` +

        ` | BTTS: ${entradas.entrada_btts} (${scoreBttsSimBase}→${scoreBttsSimHist.finalScore}→${finalScores.scoreBttsSim}, hist=${scoreBttsSimHist.leitura}, hD=${scoreBttsSimHist.delta}, aD=${anchorEntrada.btts_sim.anchor_delta_entrada}, cD=${anchorEntrada.btts_sim.casa_delta_entrada}, c=${anchorEntrada.btts_sim.casa_nivel}, a=${anchorEntrada.btts_sim.anchor_decisao}, p=${anchorEntrada.btts_sim.grupo_padrao_operacional})` +

        ` | U2.5: ${entradas.entrada_under25} (${scoreUnder25Base}→${scoreUnder25Hist.finalScore}→${finalScores.scoreUnder25}, hist=${scoreUnder25Hist.leitura}, hD=${scoreUnder25Hist.delta}, aD=${anchorEntrada.under25.anchor_delta_entrada}, cD=${anchorEntrada.under25.casa_delta_entrada}, c=${anchorEntrada.under25.casa_nivel}, a=${anchorEntrada.under25.anchor_decisao}, p=${anchorEntrada.under25.grupo_padrao_operacional})` +

        ` | U3.5: ${entradas.entrada_under35} (${scoreUnder35Base}→${scoreUnder35Hist.finalScore}→${finalScores.scoreUnder35}, hist=${scoreUnder35Hist.leitura}, hD=${scoreUnder35Hist.delta}, aD=${anchorEntrada.under35.anchor_delta_entrada}, cD=${anchorEntrada.under35.casa_delta_entrada}, c=${anchorEntrada.under35.casa_nivel}, a=${anchorEntrada.under35.anchor_decisao}, p=${anchorEntrada.under35.grupo_padrao_operacional})` +

        ` | BTTS_NAO: ${entradas.entrada_btts_nao} (${scoreBttsNaoBase}→${scoreBttsNaoHist.finalScore}→${finalScores.scoreBttsNao}, hist=${scoreBttsNaoHist.leitura}, hD=${scoreBttsNaoHist.delta}, aD=${anchorEntrada.btts_nao.anchor_delta_entrada}, cD=${anchorEntrada.btts_nao.casa_delta_entrada}, c=${anchorEntrada.btts_nao.casa_nivel}, a=${anchorEntrada.btts_nao.anchor_decisao}, p=${anchorEntrada.btts_nao.grupo_padrao_operacional})`

      );
    }
  } catch (err) {
    console.error('❌ ERRO NO PROCESSO:', err.message);
    throw err;
  } finally {
    console.log('7. Fechando conexão...');

    try {
      await pool.end();
    } catch (e) {
      console.error('⚠️ Erro ao fechar pool principal:', e.message);
    }

    try {
      await closeDbGols();
    } catch (e) {
      console.error('⚠️ Erro ao fechar db_gols/team_goals:', e.message);
    }
  }
}

main();