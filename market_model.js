const math = require('mathjs');

function poisson(lambda, k) {
  const l = Number(lambda) || 0;
  const kk = Math.max(0, Number(k) || 0);
  if (!Number.isFinite(l) || l < 0 || !Number.isFinite(kk)) return 0;

  let factorial = 1;
  for (let i = 1; i <= kk; i++) factorial *= i;
  return (Math.exp(-l) * Math.pow(l, kk)) / factorial;
}

function fatorial(n) {
  const valor = Math.max(0, Number(n) || 0);
  if (valor <= 1) return 1;

  let resultado = 1;
  for (let i = 2; i <= valor; i++) resultado *= i;
  return resultado;
}

function bivariatePoisson(homeGoals, awayGoals, lambdaHome, lambdaAway, lambdaShared) {
  const h = Math.max(0, Number(homeGoals) || 0);
  const a = Math.max(0, Number(awayGoals) || 0);
  const lh = Number(lambdaHome) || 0;
  const la = Number(lambdaAway) || 0;
  const ls = Number(lambdaShared) || 0;

  if (!Number.isFinite(h) || !Number.isFinite(a) || !Number.isFinite(lh) || !Number.isFinite(la) || !Number.isFinite(ls)) {
    return 0;
  }

  let soma = 0;
  const maxK = Math.min(h, a);
  for (let k = 0; k <= maxK; k++) {
    const termo = (
      Math.exp(-(lh + la + ls)) *
      Math.pow(lh, h - k) / fatorial(h - k) *
      Math.pow(la, a - k) / fatorial(a - k) *
      Math.pow(ls, k) / fatorial(k)
    );
    soma += termo;
  }
  return soma;
}

function dixonColesCorrection(homeGoals, awayGoals, lambdaHome, lambdaAway, rho = -0.1) {
  const h = Number(homeGoals) || 0;
  const a = Number(awayGoals) || 0;
  const lh = Number(lambdaHome) || 0;
  const la = Number(lambdaAway) || 0;

  if (h === 0 && a === 0) return 1 - (lh * la * rho);
  if (h === 0 && a === 1) return 1 + (lh * rho);
  if (h === 1 && a === 0) return 1 + (la * rho);
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

function negativeBinomial(k, r, p) {
  const kk = Math.max(0, Number(k) || 0);
  const rr = Math.max(0.0001, Number(r) || 4.2);
  const pp = Math.max(0, Math.min(1, Number(p) || 0));

  const coef = math.gamma(rr + kk) / (math.factorial(kk) * math.gamma(rr));
  return coef * Math.pow(pp, rr) * Math.pow(1 - pp, kk);
}

function probOverNegativeBinomial(mean, line, r = 4.2) {
  const meanSeguro = Math.max(0.0001, Number(mean) || 0.0001);
  const rSeguro = Math.max(0.25, Number(r) || 4.2);
  const p = rSeguro / (rSeguro + meanSeguro);

  let probUnder = 0;
  for (let k = 0; k <= Math.floor(line); k++) {
    probUnder += negativeBinomial(k, rSeguro, p);
  }
  return 1 - probUnder;
}

function zeroInflatedPoisson(lambda, k, pi) {
  const l = Number(lambda) || 0;
  const kk = Number(k) || 0;
  const pp = Number(pi) || 0;

  if (kk === 0) {
    return pp + ((1 - pp) * Math.exp(-l));
  }
  return (1 - pp) * poisson(l, kk);
}

function probOverZeroInflated(mean, line) {
  const probZeroInflado = 0.05;
  const lambda = mean / (1 - probZeroInflado);
  let probUnder = 0;
  for (let k = 0; k <= Math.floor(line); k++) {
    probUnder += zeroInflatedPoisson(lambda, k, probZeroInflado);
  }
  return 1 - probUnder;
}

function probOverPoisson(lambda, line) {
  let probUnder = 0;
  for (let k = 0; k <= Math.floor(line); k++) {
    probUnder += poisson(lambda, k);
  }
  return 1 - probUnder;
}

// Nota: Esta função pode se tornar obsoleta com o novo modelo,
// mas mantida para retrocompatibilidade em outras partes do app.
function cruzarForcas(producao, concessao) {
  if (producao === 0 || concessao === 0) {
    return (producao + concessao) / 2;
  }
  return Math.sqrt(producao * concessao);
}

function fatorCalibracaoLiga(valorTime, mediaLiga, suavizacao = 0.25) {
  if (!mediaLiga || mediaLiga <= 0 || !valorTime || valorTime <= 0) {
    return 1.0;
  }
  const alvo = mediaLiga + suavizacao * (valorTime - mediaLiga);
  const alvoLimitado = Math.max(valorTime * 0.65, Math.min(valorTime * 1.35, alvo));
  return alvoLimitado / valorTime;
}

const percentual = (val) => val !== null && val !== undefined && val !== '' ? (parseFloat(val) * 100).toFixed(2) : 0;

// ============================================================================
// MODELO CONJUNTO DE GOLS (DIXON-COLES MLE) — COM CORREÇÕES
//
// CORREÇÃO 1: peso_tempo (decaimento temporal calculado no SQL do backtest)
//             agora é lido de cada jogo e multiplicado em TODAS as
//             contribuições de gradiente daquele jogo.
//
// CORREÇÃO 2: pesos por NÍVEL de disponibilidade de dado, decidido por LADO
//             (casa e fora podem cair em níveis diferentes no mesmo jogo):
//               nível 1 (xG e xGOT presentes)      -> xG 0.30 / xGOT 0.50 / gols 0.20
//               nível 2 (falta só xGOT)             -> xG 0.80 / gols 0.20
//               nível 3a (faltam xG e xGOT, tem
//                         finalizações no gol)      -> finalizações 0.80 / gols 0.20
//               nível 3b (faltam xG, xGOT e
//                         finalizações)             -> gols 1.0
//             validado empiricamente: corr(gols, finalizações no gol) nos
//             jogos sem xG/xGOT = 0.5681 (r² 0.3227), praticamente igual à
//             corr geral (0.5745 / r² 0.3301) — canal vale a pena. O
//             orçamento total de peso do ataque continua somando 1.0 em
//             todos os cenários, em vez de apenas descartar o canal ausente.
// ============================================================================

// Constantes para o Fator de Nível (Calibração final)
const NIVEL_MIN = 0.6;
const NIVEL_MAX = 1.6;

async function otimizarModeloConjunto(
  jogosValidos,
  iteracoes = 1500,
  taxaAprendizado = 0.003,
  opcoes = {}
) {
  const {
    referenciaLiga = {},
    pesoXG = 0.30,
    pesoXGOT = 0.50,
    pesoGols = 0.20,
    pesoXGSemXGOT = 0.80,
    pesoGolsSemXGOT = 0.20,
    pesoFinalizacoesSemXGXGOT = 0.80,
    pesoGolsSemXGXGOT = 0.20,
    regularizacao = 0.015,
    gradienteMax = 5
  } = opcoes;

  const numeroValido = (valor) => {
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0;
  };

  const mediaXGCasa = numeroValido(referenciaLiga.xg?.casa) ? Number(referenciaLiga.xg.casa) : 1.30;
  const mediaXGFora = numeroValido(referenciaLiga.xg?.fora) ? Number(referenciaLiga.xg.fora) : 0.95;
  const mediaXGOTCasa = numeroValido(referenciaLiga.xgot?.casa) ? Number(referenciaLiga.xgot.casa) : 1.17;
  const mediaXGOTFora = numeroValido(referenciaLiga.xgot?.fora) ? Number(referenciaLiga.xgot.fora) : 0.86;
  const mediaGolsCasa = numeroValido(referenciaLiga.gols_marcados?.casa) ? Number(referenciaLiga.gols_marcados.casa) : 1.45;
  const mediaGolsFora = numeroValido(referenciaLiga.gols_marcados?.fora) ? Number(referenciaLiga.gols_marcados.fora) : 1.15;
  const mediaFinalizacoesCasa = numeroValido(referenciaLiga.finalizacoes_no_gol?.casa) ? Number(referenciaLiga.finalizacoes_no_gol.casa) : 4.60;
  const mediaFinalizacoesFora = numeroValido(referenciaLiga.finalizacoes_no_gol?.fora) ? Number(referenciaLiga.finalizacoes_no_gol.fora) : 3.75;

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return {
      ataque: {}, defesa: {}, referenciaLiga,
      mediaGolsCasa, mediaGolsFora,
      fatorNivelCasa: 1, fatorNivelFora: 1,
      convergiu: false, iteracoes: 0
    };
  }

  const limitar = (valor, minimo, maximo) => Math.max(minimo, Math.min(maximo, valor));

  const logRatio = (observado, esperado) => {
    if (!numeroValido(observado)) return null; 
    if (!Number.isFinite(esperado) || esperado <= 0) return null;
    return Math.log(Math.max(0.05, observado) / Math.max(0.05, esperado));
  };

  const aplicarGradiente = (valor) => limitar(valor, -gradienteMax, gradienteMax);
  const pesoTemporal = (jogo) => (Number.isFinite(Number(jogo.peso_tempo)) ? Number(jogo.peso_tempo) : 1);

  const canaisBase = {
    xg: { mediaCasa: mediaXGCasa, mediaFora: mediaXGFora, campoCasa: 'xg_casa', campoFora: 'xg_fora' },
    xgot: { mediaCasa: mediaXGOTCasa, mediaFora: mediaXGOTFora, campoCasa: 'xgot_casa', campoFora: 'xgot_fora' },
    finalizacoes: { mediaCasa: mediaFinalizacoesCasa, mediaFora: mediaFinalizacoesFora, campoCasa: 'finalizacoes_no_gol_casa', campoFora: 'finalizacoes_no_gol_fora' },
    gols: { mediaCasa: mediaGolsCasa, mediaFora: mediaGolsFora, campoCasa: 'gols_marcados_casa', campoFora: 'gols_marcados_fora' }
  };

  const PESOS_NIVEL_1 = { xg: pesoXG, xgot: pesoXGOT, gols: pesoGols };
  const PESOS_NIVEL_2 = { xg: pesoXGSemXGOT, gols: pesoGolsSemXGOT };
  const PESOS_NIVEL_3A = { finalizacoes: pesoFinalizacoesSemXGXGOT, gols: pesoGolsSemXGXGOT };
  const PESOS_NIVEL_3B = { gols: 1.0 };

  const resolverPesosLado = (jogo, sufixo) => {
    const temXG = numeroValido(jogo[`xg_${sufixo}`]);
    const temXGOT = numeroValido(jogo[`xgot_${sufixo}`]);
    const temFinalizacoes = numeroValido(jogo[`finalizacoes_no_gol_${sufixo}`]);

    if (temXG && temXGOT) return PESOS_NIVEL_1;
    if (temXG) return PESOS_NIVEL_2;
    if (temFinalizacoes) return PESOS_NIVEL_3A;
    return PESOS_NIVEL_3B;
  };

  const times = new Set();
  for (const jogo of jogosValidos) {
    if (jogo.casa_id !== undefined && jogo.casa_id !== null) times.add(String(jogo.casa_id));
    if (jogo.fora_id !== undefined && jogo.fora_id !== null) times.add(String(jogo.fora_id));
  }

  const ataque = {};
  const defesa = {};
  for (const id of times) { ataque[id] = 0; defesa[id] = 0; }

  let convergiu = false;
  let iteracaoFinal = 0;

  for (let iteracao = 0; iteracao < iteracoes; iteracao++) {
    const gradAtaque = {};
    const gradDefesa = {};
    for (const id of times) { gradAtaque[id] = 0; gradDefesa[id] = 0; }

    let maiorMudanca = 0;
    let observacoes = 0;

    for (const jogo of jogosValidos) {
      const casa = String(jogo.casa_id);
      const fora = String(jogo.fora_id);
      if (!times.has(casa) || !times.has(fora)) continue;

      const pesoJogo = pesoTemporal(jogo);
      const etaCasa = limitar(ataque[casa] + defesa[fora], -5, 5);
      const etaFora = limitar(ataque[fora] + defesa[casa], -5, 5);

      let gradCasa = 0;
      let gradFora = 0;

      const pesosCasa = resolverPesosLado(jogo, 'casa');
      for (const chave of Object.keys(pesosCasa)) {
        const c = canaisBase[chave];
        const peso = pesosCasa[chave];
        const obsCasa = Number(jogo[c.campoCasa]);
        if (numeroValido(obsCasa)) {
          const erro = logRatio(obsCasa, c.mediaCasa * Math.exp(etaCasa));
          if (erro !== null) {
            const g = pesoJogo * peso * erro;
            gradCasa += g;
            gradDefesa[fora] += g;
            observacoes++;
          }
        }
      }

      const pesosFora = resolverPesosLado(jogo, 'fora');
      for (const chave of Object.keys(pesosFora)) {
        const c = canaisBase[chave];
        const peso = pesosFora[chave];
        const obsFora = Number(jogo[c.campoFora]);
        if (numeroValido(obsFora)) {
          const erro = logRatio(obsFora, c.mediaFora * Math.exp(etaFora));
          if (erro !== null) {
            const g = pesoJogo * peso * erro;
            gradFora += g;
            gradDefesa[casa] += g;
            observacoes++;
          }
        }
      }

      gradAtaque[casa] += aplicarGradiente(gradCasa);
      gradAtaque[fora] += aplicarGradiente(gradFora);
    }

    for (const id of times) {
      const ga = aplicarGradiente(gradAtaque[id]);
      const gd = aplicarGradiente(gradDefesa[id]);

      const novoAtaque = ataque[id] + taxaAprendizado * (ga - regularizacao * ataque[id]);
      const novaDefesa = defesa[id] + taxaAprendizado * (gd - regularizacao * defesa[id]);

      maiorMudanca = Math.max(
        maiorMudanca,
        Math.abs(novoAtaque - ataque[id]),
        Math.abs(novaDefesa - defesa[id])
      );

      ataque[id] = limitar(novoAtaque, -3, 3);
      defesa[id] = limitar(novaDefesa, -3, 3);
    }

    if (times.size > 1) {
      let mediaAtaque = 0;
      for (const id of times) mediaAtaque += ataque[id];
      mediaAtaque /= times.size;

      for (const id of times) {
        ataque[id] -= mediaAtaque;
        defesa[id] += mediaAtaque;
      }
    }

    iteracaoFinal = iteracao + 1;

    if (maiorMudanca < 0.00001 && observacoes > 0) {
      convergiu = true;
      break;
    }
  }

  // CÁLCULO DO FATOR DE NÍVEL (Corrige a subestimativa)
  let obsCasaTotal = 0, espCasaTotal = 0, obsForaTotal = 0, espForaTotal = 0;

  for (const jogo of jogosValidos) {
    const casa = String(jogo.casa_id);
    const fora = String(jogo.fora_id);
    if (!times.has(casa) || !times.has(fora)) continue;

    const golsCasaReal = Number(jogo.gols_casa);
    const golsForaReal = Number(jogo.gols_fora);
    if (!Number.isFinite(golsCasaReal) || !Number.isFinite(golsForaReal)) continue;

    const pesoJogo = pesoTemporal(jogo);

    espCasaTotal += pesoJogo * mediaGolsCasa * Math.exp(limitar(ataque[casa] + defesa[fora], -5, 5));
    espForaTotal += pesoJogo * mediaGolsFora * Math.exp(limitar(ataque[fora] + defesa[casa], -5, 5));
    obsCasaTotal += pesoJogo * golsCasaReal;
    obsForaTotal += pesoJogo * golsForaReal;
  }

  const fatorNivelCasa = espCasaTotal > 0 ? limitar(obsCasaTotal / espCasaTotal, NIVEL_MIN, NIVEL_MAX) : 1;
  const fatorNivelFora = espForaTotal > 0 ? limitar(obsForaTotal / espForaTotal, NIVEL_MIN, NIVEL_MAX) : 1;

  return {
    ataque,
    defesa,
    referenciaLiga,
    mediaGolsCasa,
    mediaGolsFora,
    fatorNivelCasa,
    fatorNivelFora,
    convergiu,
    iteracoes: iteracaoFinal
  };
}

function projetarExpectativaGols(parametros, timeA_id, timeB_id, jogaEmCasa = true) {
  const idA = String(timeA_id);
  const idB = String(timeB_id);

  const ataqueA = Number(parametros.ataque?.[idA]) || 0;
  const defesaB = Number(parametros.defesa?.[idB]) || 0;
  const referenciaLiga = parametros.referenciaLiga || {};

  const base = jogaEmCasa
    ? Number(referenciaLiga.gols_marcados?.casa) || parametros.mediaGolsCasa
    : Number(referenciaLiga.gols_marcados?.fora) || parametros.mediaGolsFora;

  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`Base de gols inválida para projeção: ${jogaEmCasa ? 'CASA' : 'FORA'}`);
  }

  const eta = ataqueA + defesaB;
  const etaLimitado = Math.max(-5, Math.min(5, eta));

  // Aplicação do Fator de Nível resolvendo a subestimativa geométrica
  const fatorBruto = jogaEmCasa ? parametros.fatorNivelCasa : parametros.fatorNivelFora;
  const fator = Number.isFinite(fatorBruto) && fatorBruto > 0 ? fatorBruto : 1;

  const lambda = base * Math.exp(etaLimitado) * fator;

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda inválido: base=${base}, eta=${eta}, fator=${fator}`);
  }

  return Math.max(0.05, Math.min(8, lambda));
}

// ============================================================================
// MODELO CONJUNTO DE CARTÕES — MLE (ATAQUE = INDISCIPLINA / DEFESA = PROVOCAÇÃO)
//
// A PROVOCAÇÃO usa diretamente as métricas do adversário no MESMO jogo
// (jogo.cartoes_fora, jogo.faltas_fora, jogo.intensidade_fora como
// evidência de provocação da casa, e vice-versa) — esses valores já
// existem no objeto do jogo porque o histórico junta as duas linhas
// (casa e fora) da estatisticas_geral.
//
// LIMITAÇÃO CONHECIDA: não há dado de árbitro disponível.
// ============================================================================

function pontosCartao(amarelos, vermelhos, pesoVermelho = 2) {
  const a = Math.max(0, Number(amarelos) || 0);
  const v = Math.max(0, Number(vermelhos) || 0);
  return a + v * pesoVermelho;
}

async function otimizarModeloCartoes(
  jogosValidos,
  iteracoes = 1500,
  taxaAprendizado = 0.003,
  opcoes = {}
) {
  const {
    referenciaLiga = {},
    pesoCartoes = 0.55,
    pesoFaltasCometidas = 0.30,
    pesoIntensidade = 0.15,
    pesoCartoesProvocados = 0.55,
    pesoFaltasProvocadas = 0.30,
    pesoIntensidadeProvocada = 0.15,
    regularizacao = 0.02,
    gradienteMax = 5
  } = opcoes;

  const numeroValido = (valor) => Number.isFinite(Number(valor)) && Number(valor) >= 0;

  const mediaCartoesCasa = numeroValido(referenciaLiga.cartoes?.casa) ? Number(referenciaLiga.cartoes.casa) : 1.90;
  const mediaCartoesFora = numeroValido(referenciaLiga.cartoes?.fora) ? Number(referenciaLiga.cartoes.fora) : 2.30;
  const mediaFaltasCasa = numeroValido(referenciaLiga.faltas?.casa) ? Number(referenciaLiga.faltas.casa) : 11.0;
  const mediaFaltasFora = numeroValido(referenciaLiga.faltas?.fora) ? Number(referenciaLiga.faltas.fora) : 12.5;
  const mediaIntensidadeCasa = numeroValido(referenciaLiga.intensidade?.casa) ? Number(referenciaLiga.intensidade.casa) : 16.0;
  const mediaIntensidadeFora = numeroValido(referenciaLiga.intensidade?.fora) ? Number(referenciaLiga.intensidade.fora) : 16.0;

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return {
      indisciplina: {}, provocacao: {}, referenciaLiga,
      mediaCartoesCasa, mediaCartoesFora,
      fatorNivelCasa: 1, fatorNivelFora: 1,
      convergiu: false, iteracoes: 0
    };
  }

  const limitar = (valor, minimo, maximo) => Math.max(minimo, Math.min(maximo, valor));
  const aplicarGradiente = (valor) => Number.isFinite(valor) ? limitar(valor, -gradienteMax, gradienteMax) : 0;
  const pesoTemporal = (jogo) => (Number.isFinite(Number(jogo.peso_tempo)) ? Number(jogo.peso_tempo) : 1);
  const logRatio = (obs, esp) => {
    if (!numeroValido(obs) || !Number.isFinite(esp) || esp <= 0) return null;
    return Math.log(Math.max(0.05, obs) / Math.max(0.05, esp));
  };

  const canaisIndisciplinaCasa = [
    { campo: 'cartoes_casa', media: mediaCartoesCasa, pesoBase: pesoCartoes },
    { campo: 'faltas_casa', media: mediaFaltasCasa, pesoBase: pesoFaltasCometidas },
    { campo: 'intensidade_casa', media: mediaIntensidadeCasa, pesoBase: pesoIntensidade }
  ];

  const canaisIndisciplinaFora = [
    { campo: 'cartoes_fora', media: mediaCartoesFora, pesoBase: pesoCartoes },
    { campo: 'faltas_fora', media: mediaFaltasFora, pesoBase: pesoFaltasCometidas },
    { campo: 'intensidade_fora', media: mediaIntensidadeFora, pesoBase: pesoIntensidade }
  ];

  const canaisProvocacaoCasa = [ 
    { campo: 'cartoes_fora', media: mediaCartoesFora, pesoBase: pesoCartoesProvocados },
    { campo: 'faltas_fora', media: mediaFaltasFora, pesoBase: pesoFaltasProvocadas },
    { campo: 'intensidade_fora', media: mediaIntensidadeFora, pesoBase: pesoIntensidadeProvocada }
  ];

  const canaisProvocacaoFora = [ 
    { campo: 'cartoes_casa', media: mediaCartoesCasa, pesoBase: pesoCartoesProvocados },
    { campo: 'faltas_casa', media: mediaFaltasCasa, pesoBase: pesoFaltasProvocadas },
    { campo: 'intensidade_casa', media: mediaIntensidadeCasa, pesoBase: pesoIntensidadeProvocada }
  ];

  const indisciplina = {};
  const provocacao = {};
  const times = new Set();

  for (const jogo of jogosValidos) {
    if (jogo.casa_id != null) times.add(String(jogo.casa_id));
    if (jogo.fora_id != null) times.add(String(jogo.fora_id));
  }
  for (const id of times) { indisciplina[id] = 0; provocacao[id] = 0; }

  let convergiu = false;
  let iteracaoFinal = 0;

  for (let iteracao = 0; iteracao < iteracoes; iteracao++) {
    const gradIndisciplina = {};
    const gradProvocacao = {};
    for (const id of times) { gradIndisciplina[id] = 0; gradProvocacao[id] = 0; }
    let observacoes = 0;

    for (const jogo of jogosValidos) {
      const casa = String(jogo.casa_id);
      const fora = String(jogo.fora_id);
      if (!times.has(casa) || !times.has(fora)) continue;

      const pJogo = pesoTemporal(jogo);
      const etaCasa = limitar(indisciplina[casa] + provocacao[fora], -5, 5);
      const etaFora = limitar(indisciplina[fora] + provocacao[casa], -5, 5);
      const exp = (media, eta) => media * Math.exp(eta);

      const processarCanais = (listaCanais, etaTime, timeAlvo, isIndisciplina) => {
        let somaPesosValidos = 0;
        const validos = [];

        for (const canal of listaCanais) {
          const obs = Number(jogo[canal.campo]);
          if (numeroValido(obs)) {
            somaPesosValidos += canal.pesoBase;
            validos.push({ obs, media: canal.media, pesoOriginal: canal.pesoBase });
          }
        }

        let somaGradiente = 0;
        for (const v of validos) {
          const erro = logRatio(v.obs, exp(v.media, etaTime));
          if (erro !== null) {
            const pesoReajustado = somaPesosValidos > 0 ? v.pesoOriginal / somaPesosValidos : 0;
            somaGradiente += pJogo * pesoReajustado * erro;
            observacoes++;
          }
        }

        if (isIndisciplina) {
          gradIndisciplina[timeAlvo] += aplicarGradiente(somaGradiente);
        } else {
          gradProvocacao[timeAlvo] += aplicarGradiente(somaGradiente);
        }
      };

      processarCanais(canaisIndisciplinaCasa, etaCasa, casa, true);
      processarCanais(canaisIndisciplinaFora, etaFora, fora, true);
      processarCanais(canaisProvocacaoCasa, etaFora, casa, false);
      processarCanais(canaisProvocacaoFora, etaCasa, fora, false);
    }

    let maiorMudanca = 0;
    for (const id of times) {
      const gi = aplicarGradiente(gradIndisciplina[id]);
      const gp = aplicarGradiente(gradProvocacao[id]);

      const novaIndisciplina = indisciplina[id] + taxaAprendizado * (gi - regularizacao * indisciplina[id]);
      const novaProvocacao = provocacao[id] + taxaAprendizado * (gp - regularizacao * provocacao[id]);

      maiorMudanca = Math.max(maiorMudanca, Math.abs(novaIndisciplina - indisciplina[id]), Math.abs(novaProvocacao - provocacao[id]));

      indisciplina[id] = limitar(novaIndisciplina, -3, 3);
      provocacao[id] = limitar(novaProvocacao, -3, 3);
    }

    if (times.size > 1) {
      let mediaIndisciplina = 0;
      for (const id of times) mediaIndisciplina += indisciplina[id];
      mediaIndisciplina /= times.size;
      for (const id of times) {
        indisciplina[id] -= mediaIndisciplina;
        provocacao[id] += mediaIndisciplina;
      }
    }

    iteracaoFinal = iteracao + 1;
    if (maiorMudanca < 0.00001 && observacoes > 0) {
      convergiu = true;
      break;
    }
  }

  let obsCasaTotal = 0, espCasaTotal = 0, obsForaTotal = 0, espForaTotal = 0;

  for (const jogo of jogosValidos) {
    const casa = String(jogo.casa_id);
    const fora = String(jogo.fora_id);
    if (!times.has(casa) || !times.has(fora)) continue;

    const cartoesCasaReal = Number(jogo.cartoes_casa);
    const cartoesForaReal = Number(jogo.cartoes_fora);

    if (!Number.isFinite(cartoesCasaReal) || !Number.isFinite(cartoesForaReal)) continue;

    const pJogo = pesoTemporal(jogo);

    espCasaTotal += pJogo * mediaCartoesCasa * Math.exp(limitar(indisciplina[casa] + provocacao[fora], -5, 5));
    espForaTotal += pJogo * mediaCartoesFora * Math.exp(limitar(indisciplina[fora] + provocacao[casa], -5, 5));
    obsCasaTotal += pJogo * cartoesCasaReal;
    obsForaTotal += pJogo * cartoesForaReal;
  }

  const fatorNivelCasa = espCasaTotal > 0 ? limitar(obsCasaTotal / espCasaTotal, NIVEL_MIN, NIVEL_MAX) : 1;
  const fatorNivelFora = espForaTotal > 0 ? limitar(obsForaTotal / espForaTotal, NIVEL_MIN, NIVEL_MAX) : 1;

  return {
    indisciplina,
    provocacao,
    referenciaLiga,
    mediaCartoesCasa,
    mediaCartoesFora,
    mediaFaltasCasa,
    mediaFaltasFora,
    mediaIntensidadeCasa,
    mediaIntensidadeFora,
    fatorNivelCasa,
    fatorNivelFora,
    convergiu,
    iteracoes: iteracaoFinal
  };
}

function projetarExpectativaCartoes(parametros, timeA_id, timeB_id, jogaEmCasa = true) {
  const idA = String(timeA_id);
  const idB = String(timeB_id);

  const indisciplinaA = Number(parametros.indisciplina?.[idA]) || 0;
  const provocacaoB = Number(parametros.provocacao?.[idB]) || 0;
  const referenciaLiga = parametros.referenciaLiga || {};

  const base = jogaEmCasa
    ? Number(referenciaLiga.cartoes?.casa) || parametros.mediaCartoesCasa || 1.90
    : Number(referenciaLiga.cartoes?.fora) || parametros.mediaCartoesFora || 2.30;

  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`Base de cartões inválida para projeção: ${jogaEmCasa ? 'CASA' : 'FORA'} | base=${base}`);
  }

  const eta = indisciplinaA + provocacaoB;
  const etaLimitado = Math.max(-5, Math.min(5, eta));

  // Aplicação do Fator de Nível para corrigir a subestimativa
  const fatorBruto = jogaEmCasa ? parametros.fatorNivelCasa : parametros.fatorNivelFora;
  const fator = Number.isFinite(fatorBruto) && fatorBruto > 0 ? fatorBruto : 1;

  const lambda = base * Math.exp(etaLimitado) * fator;

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda de cartões inválido: base=${base}, indisciplina=${indisciplinaA}, provocacao=${provocacaoB}, eta=${eta}, fator=${fator}`);
  }

  return Math.max(0.05, Math.min(10, lambda));
}

function probOverCartoes(mean, line, r = 2.8) {
  return probOverNegativeBinomial(mean, line, r);
}

// ============================================================================
// MODELO CONJUNTO DE ESCANTEIOS — MLE (OFENSIVA / CONCESSÃO)
//
// Segue o mesmo padrão do modelo de cartões acima: a CONCESSÃO de cada
// time é aprendida a partir das métricas que o ADVERSÁRIO produziu NESSE
// MESMO JOGO (escanteios_fora, finalizacoes_fora, cruzamentos_fora como
// evidência de concessão da casa, e vice-versa) — esses valores já
// existem no objeto do jogo porque o histórico junta as duas linhas
// (casa e fora) da estatisticas_geral, exatamente como em cartões.
//
// OFENSIVA e CONCESSÃO têm pesos totalmente independentes
// (pesoEscanteios vs. pesoEscanteiosConcedidos etc.) — o quanto um canal
// ensina "produção própria" não precisa ser igual ao quanto ensina
// "concessão ao adversário".
// ============================================================================

async function otimizarModeloEscanteios(
  jogosValidos,
  iteracoes = 1500,
  taxaAprendizado = 0.003,
  opcoes = {}
) {
  const {
    referenciaLiga = {},
    pesoEscanteios = 0.6000,
    pesoCruzamentos = 0.1599,
    pesoToquesArea = 0.0979,
    pesoFinDentroArea = 0.0790,
    pesoFinBloqueadas = 0.0632,
    pesoEscanteiosConcedidos = 0.6000,
    pesoCruzamentosConcedidos = 0.1260,
    pesoToquesAreaConcedidos = 0.0771,
    pesoFinDentroAreaConcedidas = 0.0623,
    pesoRebatidas = 0.0547,
    pesoFinBloqueadasConcedidas = 0.0498,
    pesoDefesasGoleiro = 0.0205,
    pesoGolsEvitados = 0.0096,
    regularizacao = 0.02,
    gradienteMax = 5
  } = opcoes;

  const numeroValido = (v) => Number.isFinite(Number(v)) && Number(v) >= 0;

  const getMedia = (chave, local, padrao) =>
    numeroValido(referenciaLiga[chave]?.[local]) ? Number(referenciaLiga[chave][local]) : padrao;

  const mediasAtaque = {
    escanteiosCasa: getMedia('escanteios', 'casa', 5.2),
    escanteiosFora: getMedia('escanteios', 'fora', 4.4),
    cruzamentosCasa: getMedia('cruzamentos_total', 'casa', 18.0),
    cruzamentosFora: getMedia('cruzamentos_total', 'fora', 15.0),
    toquesAreaCasa: getMedia('toques_area_adversaria', 'casa', 16.0),
    toquesAreaFora: getMedia('toques_area_adversaria', 'fora', 12.0),
    finDentroAreaCasa: getMedia('finalizacoes_de_dentro_area', 'casa', 7.5),
    finDentroAreaFora: getMedia('finalizacoes_de_dentro_area', 'fora', 6.0),
    finBloqueadasCasa: getMedia('finalizacoes_bloqueadas', 'casa', 3.0),
    finBloqueadasFora: getMedia('finalizacoes_bloqueadas', 'fora', 2.5),
  };

  const mediasDefesa = {
    rebatidasCasa: getMedia('rebatidas', 'casa', 18.0),
    rebatidasFora: getMedia('rebatidas', 'fora', 20.0),
    defesasGoleiroCasa: getMedia('defesas_goleiro', 'casa', 3.0),
    defesasGoleiroFora: getMedia('defesas_goleiro', 'fora', 3.5),
    golsEvitadosCasa: getMedia('gols_evitados', 'casa', 0.5),
    golsEvitadosFora: getMedia('gols_evitados', 'fora', 0.5)
  };

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return {
      ofensiva: {}, concessao: {}, referenciaLiga, mediasAtaque, mediasDefesa,
      fatorNivelCasa: 1, fatorNivelFora: 1,
      convergiu: false, iteracoes: 0
    };
  }

  const limitar = (v, min, max) => Math.max(min, Math.min(max, v));
  const aplicarGradiente = (v) => Number.isFinite(v) ? limitar(v, -gradienteMax, gradienteMax) : 0;
  const logRatio = (obs, esp) => {
    if (!numeroValido(obs) || !Number.isFinite(esp) || esp <= 0) return null;
    return Math.log(Math.max(0.05, obs) / Math.max(0.05, esp));
  };
  const pesoTemporal = (jogo) => (Number.isFinite(Number(jogo.peso_tempo)) ? Number(jogo.peso_tempo) : 1);

  const canaisOfensivaCasa = [
    { campo: 'escanteios_casa', media: mediasAtaque.escanteiosCasa, pesoBase: pesoEscanteios },
    { campo: 'cruzamentos_total_casa', media: mediasAtaque.cruzamentosCasa, pesoBase: pesoCruzamentos },
    { campo: 'toques_area_adversaria_casa', media: mediasAtaque.toquesAreaCasa, pesoBase: pesoToquesArea },
    { campo: 'finalizacoes_de_dentro_area_casa', media: mediasAtaque.finDentroAreaCasa, pesoBase: pesoFinDentroArea },
    { campo: 'finalizacoes_bloqueadas_casa', media: mediasAtaque.finBloqueadasCasa, pesoBase: pesoFinBloqueadas }
  ];

  const canaisOfensivaFora = [
    { campo: 'escanteios_fora', media: mediasAtaque.escanteiosFora, pesoBase: pesoEscanteios },
    { campo: 'cruzamentos_total_fora', media: mediasAtaque.cruzamentosFora, pesoBase: pesoCruzamentos },
    { campo: 'toques_area_adversaria_fora', media: mediasAtaque.toquesAreaFora, pesoBase: pesoToquesArea },
    { campo: 'finalizacoes_de_dentro_area_fora', media: mediasAtaque.finDentroAreaFora, pesoBase: pesoFinDentroArea },
    { campo: 'finalizacoes_bloqueadas_fora', media: mediasAtaque.finBloqueadasFora, pesoBase: pesoFinBloqueadas }
  ];

  const canaisConcessaoCasa = [ 
    { campo: 'escanteios_fora', media: mediasAtaque.escanteiosFora, pesoBase: pesoEscanteiosConcedidos },
    { campo: 'cruzamentos_total_fora', media: mediasAtaque.cruzamentosFora, pesoBase: pesoCruzamentosConcedidos },
    { campo: 'toques_area_adversaria_fora', media: mediasAtaque.toquesAreaFora, pesoBase: pesoToquesAreaConcedidos },
    { campo: 'finalizacoes_de_dentro_area_fora', media: mediasAtaque.finDentroAreaFora, pesoBase: pesoFinDentroAreaConcedidas },
    { campo: 'finalizacoes_bloqueadas_fora', media: mediasAtaque.finBloqueadasFora, pesoBase: pesoFinBloqueadasConcedidas },
    { campo: 'rebatidas_casa', media: mediasDefesa.rebatidasCasa, pesoBase: pesoRebatidas },
    { campo: 'defesas_goleiro_casa', media: mediasDefesa.defesasGoleiroCasa, pesoBase: pesoDefesasGoleiro },
    { campo: 'gols_evitados_casa', media: mediasDefesa.golsEvitadosCasa, pesoBase: pesoGolsEvitados }
  ];

  const canaisConcessaoFora = [ 
    { campo: 'escanteios_casa', media: mediasAtaque.escanteiosCasa, pesoBase: pesoEscanteiosConcedidos },
    { campo: 'cruzamentos_total_casa', media: mediasAtaque.cruzamentosCasa, pesoBase: pesoCruzamentosConcedidos },
    { campo: 'toques_area_adversaria_casa', media: mediasAtaque.toquesAreaCasa, pesoBase: pesoToquesAreaConcedidos },
    { campo: 'finalizacoes_de_dentro_area_casa', media: mediasAtaque.finDentroAreaCasa, pesoBase: pesoFinDentroAreaConcedidas },
    { campo: 'finalizacoes_bloqueadas_casa', media: mediasAtaque.finBloqueadasCasa, pesoBase: pesoFinBloqueadasConcedidas },
    { campo: 'rebatidas_fora', media: mediasDefesa.rebatidasFora, pesoBase: pesoRebatidas },
    { campo: 'defesas_goleiro_fora', media: mediasDefesa.defesasGoleiroFora, pesoBase: pesoDefesasGoleiro },
    { campo: 'gols_evitados_fora', media: mediasDefesa.golsEvitadosFora, pesoBase: pesoGolsEvitados }
  ];

  const ofensiva = {};
  const concessao = {};
  const times = new Set();

  for (const jogo of jogosValidos) {
    if (jogo.casa_id != null) times.add(String(jogo.casa_id));
    if (jogo.fora_id != null) times.add(String(jogo.fora_id));
  }
  for (const id of times) { ofensiva[id] = 0; concessao[id] = 0; }

  let convergiu = false;
  let iteracaoFinal = 0;

  for (let iteracao = 0; iteracao < iteracoes; iteracao++) {
    const gradOfensiva = {};
    const gradConcessao = {};
    for (const id of times) { gradOfensiva[id] = 0; gradConcessao[id] = 0; }
    let observacoes = 0;

    for (const jogo of jogosValidos) {
      const casa = String(jogo.casa_id);
      const fora = String(jogo.fora_id);
      if (!times.has(casa) || !times.has(fora)) continue;

      const pJogo = pesoTemporal(jogo);
      const etaCasa = limitar(ofensiva[casa] + concessao[fora], -5, 5);
      const etaFora = limitar(ofensiva[fora] + concessao[casa], -5, 5);

      const exp = (media, eta) => media * Math.exp(eta);

      const processarCanais = (listaCanais, etaTime, timeAlvo, isOfensiva) => {
        let somaPesosValidos = 0;
        const validos = [];

        for (const canal of listaCanais) {
          const obs = Number(jogo[canal.campo]);
          if (numeroValido(obs)) {
            somaPesosValidos += canal.pesoBase;
            validos.push({ obs, media: canal.media, pesoOriginal: canal.pesoBase });
          }
        }

        let somaGradiente = 0;
        for (const v of validos) {
          const erro = logRatio(v.obs, exp(v.media, etaTime));
          if (erro !== null) {
            const pesoReajustado = somaPesosValidos > 0 ? v.pesoOriginal / somaPesosValidos : 0;
            somaGradiente += pJogo * pesoReajustado * erro;
            observacoes++;
          }
        }

        if (isOfensiva) {
          gradOfensiva[timeAlvo] += aplicarGradiente(somaGradiente);
        } else {
          gradConcessao[timeAlvo] += aplicarGradiente(somaGradiente);
        }
      };

      processarCanais(canaisOfensivaCasa, etaCasa, casa, true);
      processarCanais(canaisOfensivaFora, etaFora, fora, true);
      processarCanais(canaisConcessaoCasa, etaFora, casa, false);
      processarCanais(canaisConcessaoFora, etaCasa, fora, false);
    }

    let maiorMudanca = 0;
    for (const id of times) {
      const go = aplicarGradiente(gradOfensiva[id]);
      const gc = aplicarGradiente(gradConcessao[id]);

      const novaOfensiva = ofensiva[id] + taxaAprendizado * (go - regularizacao * ofensiva[id]);
      const novaConcessao = concessao[id] + taxaAprendizado * (gc - regularizacao * concessao[id]);

      maiorMudanca = Math.max(maiorMudanca, Math.abs(novaOfensiva - ofensiva[id]), Math.abs(novaConcessao - concessao[id]));

      ofensiva[id] = limitar(novaOfensiva, -3, 3);
      concessao[id] = limitar(novaConcessao, -3, 3);
    }

    if (times.size > 1) {
      let mediaOfensiva = 0;
      for (const id of times) mediaOfensiva += ofensiva[id];
      mediaOfensiva /= times.size;
      for (const id of times) {
        ofensiva[id] -= mediaOfensiva;
        concessao[id] += mediaOfensiva;
      }
    }

    iteracaoFinal = iteracao + 1;
    if (maiorMudanca < 0.00001 && observacoes > 0) {
      convergiu = true;
      break;
    }
  }

  let obsCasaTotal = 0, espCasaTotal = 0, obsForaTotal = 0, espForaTotal = 0;

  for (const jogo of jogosValidos) {
    const casa = String(jogo.casa_id);
    const fora = String(jogo.fora_id);
    if (!times.has(casa) || !times.has(fora)) continue;

    const cantosCasaReal = Number(jogo.escanteios_casa);
    const cantosForaReal = Number(jogo.escanteios_fora);

    if (!Number.isFinite(cantosCasaReal) || !Number.isFinite(cantosForaReal)) continue;

    const pJogo = pesoTemporal(jogo);

    espCasaTotal += pJogo * mediasAtaque.escanteiosCasa * Math.exp(limitar(ofensiva[casa] + concessao[fora], -5, 5));
    espForaTotal += pJogo * mediasAtaque.escanteiosFora * Math.exp(limitar(ofensiva[fora] + concessao[casa], -5, 5));
    obsCasaTotal += pJogo * cantosCasaReal;
    obsForaTotal += pJogo * cantosForaReal;
  }

  const fatorNivelCasa = espCasaTotal > 0 ? limitar(obsCasaTotal / espCasaTotal, NIVEL_MIN, NIVEL_MAX) : 1;
  const fatorNivelFora = espForaTotal > 0 ? limitar(obsForaTotal / espForaTotal, NIVEL_MIN, NIVEL_MAX) : 1;

  return {
    ofensiva,
    concessao,
    referenciaLiga,
    mediasAtaque,
    mediasDefesa,
    fatorNivelCasa,
    fatorNivelFora,
    convergiu,
    iteracoes: iteracaoFinal
  };
}

function projetarExpectativaEscanteios(parametros, timeA_id, timeB_id, jogaEmCasa = true) {
  const idA = String(timeA_id);
  const idB = String(timeB_id);

  const ofensivaA = Number(parametros.ofensiva?.[idA]) || 0;
  const concessaoB = Number(parametros.concessao?.[idB]) || 0;
  const referenciaLiga = parametros.referenciaLiga || {};

  const base = jogaEmCasa
    ? Number(referenciaLiga.escanteios?.casa) || parametros.mediasAtaque?.escanteiosCasa || 5.2
    : Number(referenciaLiga.escanteios?.fora) || parametros.mediasAtaque?.escanteiosFora || 4.4;

  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`Base de escanteios inválida para projeção: ${jogaEmCasa ? 'CASA' : 'FORA'} | base=${base}`);
  }

  const eta = ofensivaA + concessaoB;
  const etaLimitado = Math.max(-5, Math.min(5, eta));

  // Aplicação do Fator de Nível para corrigir a subestimativa
  const fatorBruto = jogaEmCasa ? parametros.fatorNivelCasa : parametros.fatorNivelFora;
  const fator = Number.isFinite(fatorBruto) && fatorBruto > 0 ? fatorBruto : 1;

  const lambda = base * Math.exp(etaLimitado) * fator;

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda de escanteios inválido: base=${base}, ofensiva=${ofensivaA}, concessao=${concessaoB}, eta=${eta}, fator=${fator}`);
  }

  return Math.max(0.5, Math.min(15, lambda));
}

function probOverEscanteios(mean, line, r = 3.5) {
  return probOverNegativeBinomial(mean, line, r);
}

// ============================================================================
// MOTOR GENÉRICO DE ESTILO — OFENSIVA/CONCESSÃO PARA QUALQUER MÉTRICA
//
// Generaliza a arquitetura de otimizarModeloCartoes/otimizarModeloEscanteios
// pra qualquer conjunto de métricas de estatisticas_geral, sem duplicar a
// função pra cada eixo tático (construção, verticalização, intensidade...).
//
// Cada "canal" é uma métrica (ex: passes_terco_final_porcentagem) com peso
// próprio no lado OFENSIVA (produção própria do time) e no lado CONCESSÃO
// (o que o time permite, lido da linha do ADVERSÁRIO no mesmo jogo — igual
// cartões/escanteios: um jogo tem duas linhas em estatisticas_geral,
// eh_casa=1 e eh_casa=0, e a concessão de um lado é a produção do outro).
//
// A base da liga (mediana casa/fora) vem de referenciaLiga, no mesmo
// formato usado em gols/cartões/escanteios (grid_metricas_competicoes) —
// exatamente o "medianas da liga como base" que você pediu.
//
// Um eixo tático pode combinar 1-3 métricas num único par ofensiva/
// concessão (ex: eixo "verticalização" = passes_longos_porcentagem +
// cruzamentos_total), do mesmo jeito que escanteios combina escanteios +
// finalizações + cruzamentos num único par ofensiva/concessão.
// ============================================================================

/**
 * @param {Array} jogosValidos [{ casa_id, fora_id, peso_tempo, <chave>_casa, <chave>_fora, ... }]
 *   — um objeto por jogo, com um par <chave>_casa/<chave>_fora pra cada
 *   canal do eixo que está sendo ajustado.
 * @param {Array} canais [{ chave, pesoOfensivo, pesoConcessao }]
 *   — as métricas desse eixo e o peso de cada uma nos dois lados.
 * @param {Object} opcoes { referenciaLiga: { <chave>: {casa, fora} }, regularizacao, gradienteMax }
 */
async function otimizarModeloEstilo(
  jogosValidos,
  canais,
  iteracoes = 1500,
  taxaAprendizado = 0.003,
  opcoes = {}
) {
  const {
    referenciaLiga = {},
    regularizacao = 0.02,
    gradienteMax = 5
  } = opcoes;

  const numeroValido = (valor) => { const n = Number(valor); return Number.isFinite(n) && n >= 0; };

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0 || !Array.isArray(canais) || canais.length === 0) {
    return {
      ofensivaCasa: {}, ofensivaFora: {}, concessaoCasa: {}, concessaoFora: {},
      referenciaLiga, canais: [], convergiu: false, iteracoes: 0
    };
  }

  const limitar = (valor, minimo, maximo) => Math.max(minimo, Math.min(maximo, valor));
  const logRatio = (observado, esperado) => {
    if (!numeroValido(observado)) return null;
    if (!Number.isFinite(esperado) || esperado <= 0) return null;
    return Math.log(Math.max(0.05, observado) / Math.max(0.05, esperado));
  };
  const aplicarGradiente = (valor) => Number.isFinite(valor) ? limitar(valor, -gradienteMax, gradienteMax) : 0;
  const pesoTemporalDoJogo = (jogo) => {
    const p = Number(jogo.peso_tempo);
    return Number.isFinite(p) && p > 0 ? p : 1;
  };

  const mediasCanais = {};
  for (const canal of canais) {
    const ref = referenciaLiga[canal.chave];
    mediasCanais[canal.chave] = {
      casa: numeroValido(ref?.casa) ? Number(ref.casa) : 1,
      fora: numeroValido(ref?.fora) ? Number(ref.fora) : 1
    };
  }

  const somaOfensiva = canais.reduce((s, c) => s + (c.pesoOfensivo ?? 0), 0);
  const somaConcessao = canais.reduce((s, c) => s + (c.pesoConcessao ?? 0), 0);
  const pesosNormalizados = canais.map(c => ({
    chave: c.chave,
    pOfensivo: somaOfensiva > 0 ? (c.pesoOfensivo ?? 0) / somaOfensiva : 1 / canais.length,
    pConcessao: somaConcessao > 0 ? (c.pesoConcessao ?? 0) / somaConcessao : 1 / canais.length
  }));

  const ofensivaCasa = {}, ofensivaFora = {}, concessaoCasa = {}, concessaoFora = {};
  const times = new Set();

  for (const jogo of jogosValidos) {
    if (jogo.casa_id !== undefined && jogo.casa_id !== null) times.add(String(jogo.casa_id));
    if (jogo.fora_id !== undefined && jogo.fora_id !== null) times.add(String(jogo.fora_id));
  }
  for (const id of times) { ofensivaCasa[id] = 0; ofensivaFora[id] = 0; concessaoCasa[id] = 0; concessaoFora[id] = 0; }

  let convergiu = false;
  let iteracaoFinal = 0;

  for (let iteracao = 0; iteracao < iteracoes; iteracao++) {
    const gradOfensivaCasa = {}, gradOfensivaFora = {}, gradConcessaoCasa = {}, gradConcessaoFora = {};
    for (const id of times) { gradOfensivaCasa[id] = 0; gradOfensivaFora[id] = 0; gradConcessaoCasa[id] = 0; gradConcessaoFora[id] = 0; }

    let observacoes = 0;

    for (const jogo of jogosValidos) {
      const casa = String(jogo.casa_id);
      const fora = String(jogo.fora_id);
      if (!times.has(casa) || !times.has(fora)) continue;

      const pesoJogo = pesoTemporalDoJogo(jogo);
      const etaCasa = ofensivaCasa[casa] + concessaoFora[fora];
      const etaFora = ofensivaFora[fora] + concessaoCasa[casa];

      let gradOfensivaCasaAcc = 0, gradConcessaoForaAcc = 0;
      let gradOfensivaForaAcc = 0, gradConcessaoCasaAcc = 0;

      for (const { chave, pOfensivo, pConcessao } of pesosNormalizados) {
        const media = mediasCanais[chave];
        const esperadoCasa = media.casa * Math.exp(limitar(etaCasa, -5, 5));
        const esperadoFora = media.fora * Math.exp(limitar(etaFora, -5, 5));

        const valorCasa = Number(jogo[`${chave}_casa`]);
        const valorFora = Number(jogo[`${chave}_fora`]);

        if (numeroValido(valorCasa)) {
          const erro = logRatio(valorCasa, esperadoCasa);
          if (erro !== null) {
            gradOfensivaCasaAcc += pesoJogo * pOfensivo * erro;
            gradConcessaoForaAcc += pesoJogo * pConcessao * erro;
            observacoes++;
          }
        }

        if (numeroValido(valorFora)) {
          const erro = logRatio(valorFora, esperadoFora);
          if (erro !== null) {
            gradOfensivaForaAcc += pesoJogo * pOfensivo * erro;
            gradConcessaoCasaAcc += pesoJogo * pConcessao * erro;
            observacoes++;
          }
        }
      }

      gradOfensivaCasa[casa] += aplicarGradiente(gradOfensivaCasaAcc);
      gradConcessaoFora[fora] += aplicarGradiente(gradConcessaoForaAcc);
      gradOfensivaFora[fora] += aplicarGradiente(gradOfensivaForaAcc);
      gradConcessaoCasa[casa] += aplicarGradiente(gradConcessaoCasaAcc);
    }

    let maiorMudanca = 0;
    for (const id of times) {
      const atualizar = (dict, grad) => {
        const g = aplicarGradiente(grad[id]);
        const gReg = g - regularizacao * dict[id];
        const novo = dict[id] + taxaAprendizado * gReg;
        maiorMudanca = Math.max(maiorMudanca, Math.abs(novo - dict[id]));
        dict[id] = limitar(novo, -3, 3);
      };
      atualizar(ofensivaCasa, gradOfensivaCasa);
      atualizar(ofensivaFora, gradOfensivaFora);
      atualizar(concessaoCasa, gradConcessaoCasa);
      atualizar(concessaoFora, gradConcessaoFora);
    }

    if (times.size > 1) {
      let mediaCasa = 0;
      for (const id of times) mediaCasa += ofensivaCasa[id];
      mediaCasa /= times.size;
      for (const id of times) { ofensivaCasa[id] -= mediaCasa; concessaoFora[id] += mediaCasa; }

      let mediaFora = 0;
      for (const id of times) mediaFora += ofensivaFora[id];
      mediaFora /= times.size;
      for (const id of times) { ofensivaFora[id] -= mediaFora; concessaoCasa[id] += mediaFora; }
    }

    iteracaoFinal = iteracao + 1;
    if (maiorMudanca < 0.00001 && observacoes > 0) { convergiu = true; break; }
  }

  return {
    ofensivaCasa, ofensivaFora, concessaoCasa, concessaoFora,
    referenciaLiga, canais: canais.map(c => c.chave), convergiu, iteracoes: iteracaoFinal
  };
}

/**
 * Leitura de perfil de um time num eixo, separada por mando — > 0 = acima
 * da mediana da liga nesse eixo/mando, < 0 = abaixo, já descontado o
 * adversário enfrentado em cada mando especificamente.
 */
function indiceEstilo(parametros, timeId) {
  const id = String(timeId);
  return {
    casa: {
      ofensiva: Number(parametros.ofensivaCasa?.[id]) || 0,
      concessao: Number(parametros.concessaoCasa?.[id]) || 0
    },
    fora: {
      ofensiva: Number(parametros.ofensivaFora?.[id]) || 0,
      concessao: Number(parametros.concessaoFora?.[id]) || 0
    }
  };
}

// ============================================================================
// MODELO DE DOMINÂNCIA DE POSSE — BRADLEY-TERRY (EIXO 0 DO PERFIL DE ESTILO)
//
// Posse de bola não é uma contagem livre como gol/cartão/escanteio — posse
// da casa + posse do visitante soma ~100% no mesmo jogo, é uma quantidade
// COMPARTILHADA entre os dois times, não duas produções independentes.
// Por isso não usa o motor de ofensiva/concessão com exp(eta) sobre uma
// média — usa um modelo de razão logarítmica direto:
//
//   log(posse_casa / posse_fora) = vantagem_mando + dominanciaCasa[casa] - dominanciaFora[fora]
//
// dominanciaCasa[time] e dominanciaFora[time] são dois números separados
// por time — quanto ele controla jogando em casa, e quanto controla
// jogando fora, cada um centralizado em ~0 pela otimização. Um time pode
// ser CONTROLADOR em casa e VERTICAL fora, e isso agora aparece nos dois
// números em vez de se misturar numa média só.
// ============================================================================

/**
 * @param {Array} jogosValidos [{ casa_id, fora_id, peso_tempo, posse_casa, posse_fora }]
 */
async function otimizarModeloPosse(
  jogosValidos,
  iteracoes = 1500,
  taxaAprendizado = 0.01,
  opcoes = {}
) {
  const {
    regularizacao = 0.02,
    gradienteMax = 3
  } = opcoes;

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return { dominanciaCasa: {}, dominanciaFora: {}, vantagemMando: 0, convergiu: false, iteracoes: 0 };
  }

  const numeroValido = (valor) => { const n = Number(valor); return Number.isFinite(n) && n >= 0; };
  const limitar = (valor, minimo, maximo) => Math.max(minimo, Math.min(maximo, valor));
  const aplicarGradiente = (valor) => Number.isFinite(valor) ? limitar(valor, -gradienteMax, gradienteMax) : 0;
  const pesoTemporalDoJogo = (jogo) => {
    const p = Number(jogo.peso_tempo);
    return Number.isFinite(p) && p > 0 ? p : 1;
  };

  // dominanciaCasa[time] = controle desse time especificamente quando joga
  // em casa; dominanciaFora[time] = controle desse time especificamente
  // quando joga fora. Um time pode ser CONTROLADOR em casa e VERTICAL fora
  // — os dois números capturam isso em vez de se misturar numa média só.
  const dominanciaCasa = {};
  const dominanciaFora = {};
  const times = new Set();

  for (const jogo of jogosValidos) {
    if (jogo.casa_id !== undefined && jogo.casa_id !== null) times.add(String(jogo.casa_id));
    if (jogo.fora_id !== undefined && jogo.fora_id !== null) times.add(String(jogo.fora_id));
  }
  for (const id of times) { dominanciaCasa[id] = 0; dominanciaFora[id] = 0; }

  let vantagemMando = 0;
  let convergiu = false;
  let iteracaoFinal = 0;

  for (let iteracao = 0; iteracao < iteracoes; iteracao++) {
    const gradDominanciaCasa = {};
    const gradDominanciaFora = {};
    for (const id of times) { gradDominanciaCasa[id] = 0; gradDominanciaFora[id] = 0; }
    let gradVantagemMando = 0;

    let observacoes = 0;

    for (const jogo of jogosValidos) {
      const casa = String(jogo.casa_id);
      const fora = String(jogo.fora_id);
      if (!times.has(casa) || !times.has(fora)) continue;

      const posseCasa = Number(jogo.posse_casa);
      const posseFora = Number(jogo.posse_fora);
      if (!numeroValido(posseCasa) || posseCasa <= 0 || !numeroValido(posseFora) || posseFora <= 0) continue;

      const pesoJogo = pesoTemporalDoJogo(jogo);

      const etaCasa = limitar(vantagemMando + dominanciaCasa[casa] - dominanciaFora[fora], -5, 5);
      const observado = Math.log(posseCasa / posseFora);
      const erro = observado - etaCasa; // já em escala log, sem exp

      gradDominanciaCasa[casa] += pesoJogo * erro;
      gradDominanciaFora[fora] += pesoJogo * (-erro);
      gradVantagemMando += pesoJogo * erro;

      observacoes++;
    }

    let maiorMudanca = 0;

    // vantagemMando não leva regularização — é um único parâmetro global.
    const gradMandoAplicado = aplicarGradiente(gradVantagemMando);
    const novaVantagemMando = vantagemMando + taxaAprendizado * gradMandoAplicado;
    maiorMudanca = Math.max(maiorMudanca, Math.abs(novaVantagemMando - vantagemMando));
    vantagemMando = novaVantagemMando;

    for (const id of times) {
      const gc = aplicarGradiente(gradDominanciaCasa[id]);
      const gcReg = gc - regularizacao * dominanciaCasa[id];
      const novaCasa = dominanciaCasa[id] + taxaAprendizado * gcReg;
      maiorMudanca = Math.max(maiorMudanca, Math.abs(novaCasa - dominanciaCasa[id]));
      dominanciaCasa[id] = limitar(novaCasa, -3, 3);

      const gf = aplicarGradiente(gradDominanciaFora[id]);
      const gfReg = gf - regularizacao * dominanciaFora[id];
      const novaFora = dominanciaFora[id] + taxaAprendizado * gfReg;
      maiorMudanca = Math.max(maiorMudanca, Math.abs(novaFora - dominanciaFora[id]));
      dominanciaFora[id] = limitar(novaFora, -3, 3);
    }

    // Centraliza dominanciaCasa e dominanciaFora separadamente, cada uma
    // transferindo sua média pra vantagemMando com o sinal certo pra não
    // mudar nenhuma previsão — só ganhar identificabilidade (mediana da
    // liga estável em ~0 em cada mando).
    if (times.size > 1) {
      let mediaCasa = 0;
      for (const id of times) mediaCasa += dominanciaCasa[id];
      mediaCasa /= times.size;
      for (const id of times) dominanciaCasa[id] -= mediaCasa;
      vantagemMando += mediaCasa;

      let mediaFora = 0;
      for (const id of times) mediaFora += dominanciaFora[id];
      mediaFora /= times.size;
      for (const id of times) dominanciaFora[id] -= mediaFora;
      vantagemMando -= mediaFora;
    }

    iteracaoFinal = iteracao + 1;
    if (maiorMudanca < 0.00001 && observacoes > 0) { convergiu = true; break; }
  }

  return { dominanciaCasa, dominanciaFora, vantagemMando, convergiu, iteracoes: iteracaoFinal };
}

/**
 * Projeta a posse esperada de cada time num confronto específico — usado
 * pra saber, jogo a jogo, o que seria "dentro do esperado" antes de olhar
 * a posse real que aconteceu.
 */
function projetarPosseEsperada(parametros, timeCasa_id, timeFora_id) {
  const idCasa = String(timeCasa_id);
  const idFora = String(timeFora_id);

  const domCasa = Number(parametros.dominanciaCasa?.[idCasa]) || 0;
  const domFora = Number(parametros.dominanciaFora?.[idFora]) || 0;
  const vantagemMando = Number(parametros.vantagemMando) || 0;

  const eta = Math.max(-5, Math.min(5, vantagemMando + domCasa - domFora));
  const oddsCasa = Math.exp(eta);
  const posseCasaEsperada = (100 * oddsCasa) / (1 + oddsCasa);
  const posseForaEsperada = 100 - posseCasaEsperada;

  return { posseCasaEsperada, posseForaEsperada };
}

/**
 * Classifica o estilo do time em CADA mando, comparando a dominância
 * dele contra a MEDIANA da liga inteira NAQUELE mando — a mediana de
 * dominanciaCasa entre todos os times pode não ser igual à de
 * dominanciaFora, então cada mando é comparado contra sua própria liga.
 */
function classificarEstiloPosse(parametros, timeId) {
  const id = String(timeId);

  const calcularMediana = (dict) => {
    const valores = Object.values(dict || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (valores.length === 0) return 0;
    const meio = Math.floor(valores.length / 2);
    return valores.length % 2 === 0 ? (valores[meio - 1] + valores[meio]) / 2 : valores[meio];
  };

  const dominanciaCasa = Number(parametros.dominanciaCasa?.[id]) || 0;
  const dominanciaFora = Number(parametros.dominanciaFora?.[id]) || 0;
  const medianaLigaCasa = calcularMediana(parametros.dominanciaCasa);
  const medianaLigaFora = calcularMediana(parametros.dominanciaFora);

  const classificar = (valor, mediana) => {
    if (valor > mediana) return 'CONTROLADOR';
    if (valor < mediana) return 'VERTICAL';
    return 'NEUTRO';
  };

  return {
    casa: { dominancia: dominanciaCasa, medianaLiga: medianaLigaCasa, estilo: classificar(dominanciaCasa, medianaLigaCasa) },
    fora: { dominancia: dominanciaFora, medianaLiga: medianaLigaFora, estilo: classificar(dominanciaFora, medianaLigaFora) }
  };
}

module.exports = {
  poisson,
  fatorial,
  bivariatePoisson,
  dixonColesCorrection,
  negativeBinomial,
  probOverNegativeBinomial,
  zeroInflatedPoisson,
  probOverZeroInflated,
  probOverPoisson,
  cruzarForcas,
  fatorCalibracaoLiga,
  percentual,

  otimizarModeloConjunto,
  projetarExpectativaGols,

  pontosCartao,
  otimizarModeloCartoes,
  projetarExpectativaCartoes,
  probOverCartoes,

  otimizarModeloEscanteios,
  projetarExpectativaEscanteios,
  probOverEscanteios,

  otimizarModeloEstilo,
  indiceEstilo,

  otimizarModeloPosse,
  projetarPosseEsperada,
  classificarEstiloPosse
};