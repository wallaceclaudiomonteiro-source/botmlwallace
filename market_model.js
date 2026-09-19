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
// CORREÇÃO 2: quando falta xGOT, o fallback só usa a fatia de peso que
//             sobrou do xGOT ausente (pXGOT), redistribuída 80/20 entre
//             xG e gols — o orçamento total de peso do ataque continua
//             somando 1.0 nos dois cenários (com ou sem xGOT).
// ============================================================================

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
    regularizacao = 0.015,
    gradienteMax = 5
  } = opcoes;

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return {
      ataque: {},
      defesa: {},
      mediaGolsCasa: Number(referenciaLiga.mediaGolsCasa) || 1.45,
      mediaGolsFora: Number(referenciaLiga.mediaGolsFora) || 1.15,
      convergiu: false,
      iteracoes: 0
    };
  }

  const mediaXGCasa = Number(referenciaLiga.xg?.casa) > 0 ? Number(referenciaLiga.xg.casa) : 1.30;
  const mediaXGFora = Number(referenciaLiga.xg?.fora) > 0 ? Number(referenciaLiga.xg.fora) : 0.95;
  const mediaXGOTCasa = Number(referenciaLiga.xgot?.casa) > 0 ? Number(referenciaLiga.xgot.casa) : 1.17;
  const mediaXGOTFora = Number(referenciaLiga.xgot?.fora) > 0 ? Number(referenciaLiga.xgot.fora) : 0.86;
  const mediaGolsCasa = Number(referenciaLiga.gols_marcados?.casa) > 0 ? Number(referenciaLiga.gols_marcados.casa) : 1.45;
  const mediaGolsFora = Number(referenciaLiga.gols_marcados?.fora) > 0 ? Number(referenciaLiga.gols_marcados.fora) : 1.15;

  const numeroValido = (valor) => {
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0;
  };

  const limitar = (valor, minimo, maximo) => {
    return Math.max(minimo, Math.min(maximo, valor));
  };

  const logRatio = (observado, esperado) => {
    if (!numeroValido(observado) || observado <= 0) return null;
    if (!Number.isFinite(esperado) || esperado <= 0) return null;
    return Math.log(Math.max(0.05, observado) / Math.max(0.05, esperado));
  };

  const aplicarGradiente = (valor) => {
    return limitar(valor, -gradienteMax, gradienteMax);
  };

  const times = new Set();

  for (const jogo of jogosValidos) {
    if (jogo.casa_id !== undefined && jogo.casa_id !== null) times.add(String(jogo.casa_id));
    if (jogo.fora_id !== undefined && jogo.fora_id !== null) times.add(String(jogo.fora_id));
  }

  const ataque = {};
  const defesa = {};

  for (const id of times) {
    ataque[id] = 0;
    defesa[id] = 0;
  }

  let convergiu = false;
  let iteracaoFinal = 0;

  for (let iteracao = 0; iteracao < iteracoes; iteracao++) {

    const gradAtaque = {};
    const gradDefesa = {};

    for (const id of times) {
      gradAtaque[id] = 0;
      gradDefesa[id] = 0;
    }

    let maiorMudanca = 0;
    let observacoes = 0;
    let erroTotal = 0;

    for (const jogo of jogosValidos) {

      const casa = String(jogo.casa_id);
      const fora = String(jogo.fora_id);

      if (!times.has(casa) || !times.has(fora)) {
        continue;
      }

      const pesoJogo = Number.isFinite(Number(jogo.peso_tempo)) ? Number(jogo.peso_tempo) : 1;

      const etaCasa = limitar(ataque[casa] + defesa[fora], -5, 5);
      const etaFora = limitar(ataque[fora] + defesa[casa], -5, 5);

      let gradCasa = 0;

      const xGCasa = Number(jogo.xg_casa);
      const temXGCasa = numeroValido(xGCasa) && xGCasa > 0;

      if (temXGCasa) {
        const esperadoXGCasa = mediaXGCasa * Math.exp(etaCasa);
        const erroXG = logRatio(xGCasa, esperadoXGCasa);
        if (erroXG !== null) {
          gradCasa += pesoJogo * pesoXG * erroXG;
          gradDefesa[fora] += pesoJogo * pesoXG * erroXG;
          erroTotal += Math.abs(erroXG) * pesoXG;
          observacoes++;
        }
      }

      const xGOTCasa = Number(jogo.xgot_casa);

      if (numeroValido(xGOTCasa) && xGOTCasa > 0) {
        const esperadoXGOTCasa = mediaXGOTCasa * Math.exp(etaCasa);
        const erroXGOT = logRatio(xGOTCasa, esperadoXGOTCasa);
        if (erroXGOT !== null) {
          gradCasa += pesoJogo * pesoXGOT * erroXGOT;
          gradDefesa[fora] += pesoJogo * pesoXGOT * erroXGOT;
          erroTotal += Math.abs(erroXGOT) * pesoXGOT;
          observacoes++;
        }
      } else {
        //const pesoFallbackXG = 0.24;   // Fixo no valor antigo
        //const pesoFallbackGols = 0.06; // Fixo no valor antigo

        //if (temXGCasa) {
          //const esperadoXGCasa = mediaXGCasa * Math.exp(etaCasa);
          //const erroFallbackXG = logRatio(xGCasa, esperadoXGCasa);
          //if (erroFallbackXG !== null) {
            //gradCasa += pesoJogo * pesoFallbackXG * erroFallbackXG;
            //gradDefesa[fora] += pesoJogo * pesoFallbackXG * erroFallbackXG;
            //erroTotal += Math.abs(erroFallbackXG) * pesoFallbackXG;
            //observacoes++;
          //}
        //}

        //const golsCasaFallback = Number(jogo.gols_marcados_casa);

        /*if (numeroValido(golsCasaFallback) && golsCasaFallback > 0) {
          const esperadoGolsCasa = mediaGolsCasa * Math.exp(etaCasa);
          const erroFallbackGols = logRatio(golsCasaFallback, esperadoGolsCasa);
          if (erroFallbackGols !== null) {
            gradCasa += pesoJogo * pesoFallbackGols * erroFallbackGols;
            gradDefesa[fora] += pesoJogo * pesoFallbackGols * erroFallbackGols;
            erroTotal += Math.abs(erroFallbackGols) * pesoFallbackGols;
            observacoes++;
          }
        }*/
      }

      const golsCasa = Number(jogo.gols_marcados_casa);

      if (numeroValido(golsCasa) && golsCasa > 0) {
        const esperadoGolsCasa = mediaGolsCasa * Math.exp(etaCasa);
        const erroGolsCasa = logRatio(golsCasa, esperadoGolsCasa);
        if (erroGolsCasa !== null) {
          gradCasa += pesoJogo * pesoGols * erroGolsCasa;
          gradDefesa[fora] += pesoJogo * pesoGols * erroGolsCasa;
          erroTotal += Math.abs(erroGolsCasa) * pesoGols;
          observacoes++;
        }
      }

      gradAtaque[casa] += aplicarGradiente(gradCasa);

      let gradFora = 0;

      const xGFora = Number(jogo.xg_fora);
      const temXGFora = numeroValido(xGFora) && xGFora > 0;

      if (temXGFora) {
        const esperadoXGFora = mediaXGFora * Math.exp(etaFora);
        const erroXG = logRatio(xGFora, esperadoXGFora);
        if (erroXG !== null) {
          gradFora += pesoJogo * pesoXG * erroXG;
          gradDefesa[casa] += pesoJogo * pesoXG * erroXG;
          erroTotal += Math.abs(erroXG) * pesoXG;
          observacoes++;
        }
      }

      const xGOTFora = Number(jogo.xgot_fora);

      if (numeroValido(xGOTFora) && xGOTFora > 0) {
        const esperadoXGOTFora = mediaXGOTFora * Math.exp(etaFora);
        const erroXGOT = logRatio(xGOTFora, esperadoXGOTFora);
        if (erroXGOT !== null) {
          gradFora += pesoJogo * pesoXGOT * erroXGOT;
          gradDefesa[casa] += pesoJogo * pesoXGOT * erroXGOT;
          erroTotal += Math.abs(erroXGOT) * pesoXGOT;
          observacoes++;
        }
      } else {
        /*const pesoFallbackXG = 0.24;   // Fixo no valor antigo
        const pesoFallbackGols = 0.06; // Fixo no valor antigo

        if (temXGFora) {
          const esperadoXGFora = mediaXGFora * Math.exp(etaFora);
          const erroFallbackXG = logRatio(xGFora, esperadoXGFora);
          if (erroFallbackXG !== null) {
            gradFora += pesoJogo * pesoFallbackXG * erroFallbackXG;
            gradDefesa[casa] += pesoJogo * pesoFallbackXG * erroFallbackXG;
            erroTotal += Math.abs(erroFallbackXG) * pesoFallbackXG;
            observacoes++;
          }
        }-*/

       // const golsForaFallback = Number(jogo.gols_marcados_fora);

        /*if (numeroValido(golsForaFallback) && golsForaFallback > 0) {
          const esperadoGolsFora = mediaGolsFora * Math.exp(etaFora);
          const erroFallbackGols = logRatio(golsForaFallback, esperadoGolsFora);
          if (erroFallbackGols !== null) {
            gradFora += pesoJogo * pesoFallbackGols * erroFallbackGols;
            gradDefesa[casa] += pesoJogo * pesoFallbackGols * erroFallbackGols;
            erroTotal += Math.abs(erroFallbackGols) * pesoFallbackGols;
            observacoes++;
          }
        }*/
      }

      const golsFora = Number(jogo.gols_marcados_fora);

      if (numeroValido(golsFora) && golsFora > 0) {
        const esperadoGolsFora = mediaGolsFora * Math.exp(etaFora);
        const erroGolsFora = logRatio(golsFora, esperadoGolsFora);
        if (erroGolsFora !== null) {
          gradFora += pesoJogo * pesoGols * erroGolsFora;
          gradDefesa[casa] += pesoJogo * pesoGols * erroGolsFora;
          erroTotal += Math.abs(erroGolsFora) * pesoGols;
          observacoes++;
        }
      }

      gradAtaque[fora] += aplicarGradiente(gradFora);
    }

    for (const id of times) {
      const ga = aplicarGradiente(gradAtaque[id]);
      const gd = aplicarGradiente(gradDefesa[id]);

      const gradAtaqueRegularizado = ga - regularizacao * ataque[id];
      const gradDefesaRegularizado = gd - regularizacao * defesa[id];

      const novoAtaque = ataque[id] + taxaAprendizado * gradAtaqueRegularizado;
      const novaDefesa = defesa[id] + taxaAprendizado * gradDefesaRegularizado;

      maiorMudanca = Math.max(maiorMudanca, Math.abs(novoAtaque - ataque[id]), Math.abs(novaDefesa - defesa[id]));

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

  return {
    ataque,
    defesa,
    referenciaLiga,
    mediaGolsCasa,
    mediaGolsFora,
    mediaXGCasa,
    mediaXGFora,
    mediaXGOTCasa,
    mediaXGOTFora,
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
    ? Number(referenciaLiga.gols_marcados?.casa)
    : Number(referenciaLiga.gols_marcados?.fora);

  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(
      `Base de gols inválida para projeção: ${jogaEmCasa ? 'CASA' : 'FORA'} | base=${base} | referenciaLiga=${JSON.stringify(referenciaLiga.gols_marcados)}`
    );
  }

  const eta = ataqueA + defesaB;
  const etaLimitado = Math.max(-5, Math.min(5, eta));
  const lambda = base * Math.exp(etaLimitado);

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda inválido: base=${base}, ataque=${ataqueA}, defesa=${defesaB}, eta=${eta}`);
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

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return {
      indisciplina: {},
      provocacao: {},
      mediaCartoesCasa: Number(referenciaLiga.cartoes?.casa) || 1.90,
      mediaCartoesFora: Number(referenciaLiga.cartoes?.fora) || 2.30,
      convergiu: false,
      iteracoes: 0
    };
  }

  const mediaCartoesCasa = Number(referenciaLiga.cartoes?.casa) > 0 ? Number(referenciaLiga.cartoes.casa) : 1.90;
  const mediaCartoesFora = Number(referenciaLiga.cartoes?.fora) > 0 ? Number(referenciaLiga.cartoes.fora) : 2.30;
  const mediaFaltasCasa = Number(referenciaLiga.faltas?.casa) > 0 ? Number(referenciaLiga.faltas.casa) : 11.0;
  const mediaFaltasFora = Number(referenciaLiga.faltas?.fora) > 0 ? Number(referenciaLiga.faltas.fora) : 12.5;
  const mediaIntensidadeCasa = Number(referenciaLiga.intensidade?.casa) > 0 ? Number(referenciaLiga.intensidade.casa) : 16.0;
  const mediaIntensidadeFora = Number(referenciaLiga.intensidade?.fora) > 0 ? Number(referenciaLiga.intensidade.fora) : 16.0;

  const numeroValido = (valor) => {
    const n = Number(valor);
    return Number.isFinite(n) && n >= 0;
  };

  const limitar = (valor, minimo, maximo) => Math.max(minimo, Math.min(maximo, valor));

  const logRatio = (observado, esperado) => {
    if (!numeroValido(observado) || observado <= 0) return null;
    if (!Number.isFinite(esperado) || esperado <= 0) return null;
    return Math.log(Math.max(0.05, observado) / Math.max(0.05, esperado));
  };

  const aplicarGradiente = (valor) => {
    if (!Number.isFinite(valor)) return 0;
    return limitar(valor, -gradienteMax, gradienteMax);
  };

  const pesoTemporalDoJogo = (jogo) => {
    const p = Number(jogo.peso_tempo);
    return Number.isFinite(p) && p > 0 ? p : 1;
  };

  const indisciplina = {};
  const provocacao = {};
  const times = new Set();

  for (const jogo of jogosValidos) {
    if (jogo.casa_id !== undefined && jogo.casa_id !== null) times.add(String(jogo.casa_id));
    if (jogo.fora_id !== undefined && jogo.fora_id !== null) times.add(String(jogo.fora_id));
  }

  for (const id of times) {
    indisciplina[id] = 0;
    provocacao[id] = 0;
  }

  const somaIndisciplina = pesoCartoes + pesoFaltasCometidas + pesoIntensidade;
  const somaProvocacao = pesoCartoesProvocados + pesoFaltasProvocadas + pesoIntensidadeProvocada;

  const pCartoes = somaIndisciplina > 0 ? pesoCartoes / somaIndisciplina : 0.55;
  const pFaltasCometidas = somaIndisciplina > 0 ? pesoFaltasCometidas / somaIndisciplina : 0.30;
  const pIntensidade = somaIndisciplina > 0 ? pesoIntensidade / somaIndisciplina : 0.15;

  const pCartoesProvocados = somaProvocacao > 0 ? pesoCartoesProvocados / somaProvocacao : 0.55;
  const pFaltasProvocadas = somaProvocacao > 0 ? pesoFaltasProvocadas / somaProvocacao : 0.30;
  const pIntensidadeProvocada = somaProvocacao > 0 ? pesoIntensidadeProvocada / somaProvocacao : 0.15;

  let convergiu = false;
  let iteracaoFinal = 0;

  for (let iteracao = 0; iteracao < iteracoes; iteracao++) {
    const gradIndisciplina = {};
    const gradProvocacao = {};

    for (const id of times) {
      gradIndisciplina[id] = 0;
      gradProvocacao[id] = 0;
    }

    let observacoes = 0;

    for (const jogo of jogosValidos) {
      const casa = String(jogo.casa_id);
      const fora = String(jogo.fora_id);
      if (!times.has(casa) || !times.has(fora)) continue;

      const pesoJogo = pesoTemporalDoJogo(jogo);

      const etaCasa = indisciplina[casa] + provocacao[fora];
      const etaFora = indisciplina[fora] + provocacao[casa];

      const esperadoCartoesCasa = mediaCartoesCasa * Math.exp(limitar(etaCasa, -5, 5));
      const esperadoCartoesFora = mediaCartoesFora * Math.exp(limitar(etaFora, -5, 5));

      const esperadoFaltasCasa = mediaFaltasCasa * Math.exp(limitar(etaCasa, -5, 5));
      const esperadoFaltasFora = mediaFaltasFora * Math.exp(limitar(etaFora, -5, 5));

      const esperadoIntensidadeCasa = mediaIntensidadeCasa * Math.exp(limitar(etaCasa, -5, 5));
      const esperadoIntensidadeFora = mediaIntensidadeFora * Math.exp(limitar(etaFora, -5, 5));

      const cartoesCasa = Number(jogo.cartoes_casa);
      const cartoesFora = Number(jogo.cartoes_fora);
      const faltasCasa = Number(jogo.faltas_casa);
      const faltasFora = Number(jogo.faltas_fora);
      const intensidadeCasa = Number(jogo.intensidade_casa);
      const intensidadeFora = Number(jogo.intensidade_fora);

      let gradIndisciplinaCasa = 0;

      if (numeroValido(cartoesCasa) && cartoesCasa > 0) {
        const erro = logRatio(cartoesCasa, esperadoCartoesCasa);
        if (erro !== null) { gradIndisciplinaCasa += pesoJogo * pCartoes * erro; observacoes++; }
      }

      if (numeroValido(faltasCasa) && faltasCasa > 0) {
        const erro = logRatio(faltasCasa, esperadoFaltasCasa);
        if (erro !== null) { gradIndisciplinaCasa += pesoJogo * pFaltasCometidas * erro; observacoes++; }
      }

      if (numeroValido(intensidadeCasa) && intensidadeCasa > 0) {
        const erro = logRatio(intensidadeCasa, esperadoIntensidadeCasa);
        if (erro !== null) { gradIndisciplinaCasa += pesoJogo * pIntensidade * erro; observacoes++; }
      }

      gradIndisciplina[casa] += aplicarGradiente(gradIndisciplinaCasa);

      let gradIndisciplinaFora = 0;

      if (numeroValido(cartoesFora) && cartoesFora > 0) {
        const erro = logRatio(cartoesFora, esperadoCartoesFora);
        if (erro !== null) { gradIndisciplinaFora += pesoJogo * pCartoes * erro; observacoes++; }
      }

      if (numeroValido(faltasFora) && faltasFora > 0) {
        const erro = logRatio(faltasFora, esperadoFaltasFora);
        if (erro !== null) { gradIndisciplinaFora += pesoJogo * pFaltasCometidas * erro; observacoes++; }
      }

      if (numeroValido(intensidadeFora) && intensidadeFora > 0) {
        const erro = logRatio(intensidadeFora, esperadoIntensidadeFora);
        if (erro !== null) { gradIndisciplinaFora += pesoJogo * pIntensidade * erro; observacoes++; }
      }

      gradIndisciplina[fora] += aplicarGradiente(gradIndisciplinaFora);

      let gradProvocacaoCasa = 0;

      if (numeroValido(cartoesFora) && cartoesFora > 0) {
        const erro = logRatio(cartoesFora, esperadoCartoesFora);
        if (erro !== null) { gradProvocacaoCasa += pesoJogo * pCartoesProvocados * erro; observacoes++; }
      }

      if (numeroValido(faltasFora) && faltasFora > 0) {
        const erro = logRatio(faltasFora, esperadoFaltasFora);
        if (erro !== null) { gradProvocacaoCasa += pesoJogo * pFaltasProvocadas * erro; observacoes++; }
      }

      if (numeroValido(intensidadeFora) && intensidadeFora > 0) {
        const erro = logRatio(intensidadeFora, esperadoIntensidadeFora);
        if (erro !== null) { gradProvocacaoCasa += pesoJogo * pIntensidadeProvocada * erro; observacoes++; }
      }

      gradProvocacao[casa] += aplicarGradiente(gradProvocacaoCasa);

      let gradProvocacaoFora = 0;

      if (numeroValido(cartoesCasa) && cartoesCasa > 0) {
        const erro = logRatio(cartoesCasa, esperadoCartoesCasa);
        if (erro !== null) { gradProvocacaoFora += pesoJogo * pCartoesProvocados * erro; observacoes++; }
      }

      if (numeroValido(faltasCasa) && faltasCasa > 0) {
        const erro = logRatio(faltasCasa, esperadoFaltasCasa);
        if (erro !== null) { gradProvocacaoFora += pesoJogo * pFaltasProvocadas * erro; observacoes++; }
      }

      if (numeroValido(intensidadeCasa) && intensidadeCasa > 0) {
        const erro = logRatio(intensidadeCasa, esperadoIntensidadeCasa);
        if (erro !== null) { gradProvocacaoFora += pesoJogo * pIntensidadeProvocada * erro; observacoes++; }
      }

      gradProvocacao[fora] += aplicarGradiente(gradProvocacaoFora);
    }

    let maiorMudanca = 0;

    for (const id of times) {
      const gi = aplicarGradiente(gradIndisciplina[id]);
      const gp = aplicarGradiente(gradProvocacao[id]);

      const gradIndisciplinaReg = gi - regularizacao * indisciplina[id];
      const gradProvocacaoReg = gp - regularizacao * provocacao[id];

      const novaIndisciplina = indisciplina[id] + taxaAprendizado * gradIndisciplinaReg;
      const novaProvocacao = provocacao[id] + taxaAprendizado * gradProvocacaoReg;

      maiorMudanca = Math.max(
        maiorMudanca,
        Math.abs(novaIndisciplina - indisciplina[id]),
        Math.abs(novaProvocacao - provocacao[id])
      );

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
    ? Number(referenciaLiga.cartoes?.casa) || parametros.mediaCartoesCasa
    : Number(referenciaLiga.cartoes?.fora) || parametros.mediaCartoesFora;

  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`Base de cartões inválida para projeção: ${jogaEmCasa ? 'CASA' : 'FORA'} | base=${base}`);
  }

  const eta = indisciplinaA + provocacaoB;
  const etaLimitado = Math.max(-5, Math.min(5, eta));
  const lambda = base * Math.exp(etaLimitado);

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda de cartões inválido: base=${base}, indisciplina=${indisciplinaA}, provocacao=${provocacaoB}, eta=${eta}`);
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
    // Ofensiva
    pesoEscanteios = 0.6000,
    pesoCruzamentos = 0.1599,
    pesoToquesArea = 0.0979,
    pesoFinDentroArea = 0.0790,
    pesoFinBloqueadas = 0.0632,
    // Concessão
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

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return { ofensiva: {}, concessao: {}, convergiu: false, iteracoes: 0 };
  }

  // Função auxiliar para buscar médias no Grid de Competições
  const getMedia = (chave, local, padrao) =>
    Number(referenciaLiga[chave]?.[local]) > 0 ? Number(referenciaLiga[chave][local]) : padrao;

  // 1. CRUZAMENTO NO GRID DE COMPETIÇÕES (MÉDIAS DA LIGA)
  // Agrupados para clareza: O que é ação de ataque e o que é ação de defesa
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
    // Estas médias representam as ações defensivas do PRÓPRIO time no local indicado
    rebatidasCasa: getMedia('rebatidas', 'casa', 18.0),
    rebatidasFora: getMedia('rebatidas', 'fora', 20.0),
    defesasGoleiroCasa: getMedia('defesas_goleiro', 'casa', 3.0),
    defesasGoleiroFora: getMedia('defesas_goleiro', 'fora', 3.5),
    golsEvitadosCasa: getMedia('gols_evitados', 'casa', 0.5),
    golsEvitadosFora: getMedia('gols_evitados', 'fora', 0.5)
  };

  const numeroValido = (v) => Number.isFinite(Number(v)) && Number(v) >= 0;
  const limitar = (v, min, max) => Math.max(min, Math.min(max, v));
  const aplicarGradiente = (v) => Number.isFinite(v) ? limitar(v, -gradienteMax, gradienteMax) : 0;

  const logRatio = (obs, esp) => {
    if (!numeroValido(obs) || obs <= 0 || !Number.isFinite(esp) || esp <= 0) return null;
    return Math.log(Math.max(0.05, obs) / Math.max(0.05, esp));
  };

  const ofensiva = {};
  const concessao = {};
  const times = new Set();

  for (const jogo of jogosValidos) {
    if (jogo.casa_id != null) times.add(String(jogo.casa_id));
    if (jogo.fora_id != null) times.add(String(jogo.fora_id));
  }
  for (const id of times) { ofensiva[id] = 0; concessao[id] = 0; }

  // Pesos normalizados
  const somaOf = pesoEscanteios + pesoCruzamentos + pesoToquesArea + pesoFinDentroArea + pesoFinBloqueadas;
  const pOf = {
    esc: somaOf > 0 ? pesoEscanteios / somaOf : 0.60,
    cru: somaOf > 0 ? pesoCruzamentos / somaOf : 0.1599,
    toq: somaOf > 0 ? pesoToquesArea / somaOf : 0.0979,
    fin: somaOf > 0 ? pesoFinDentroArea / somaOf : 0.0790,
    blo: somaOf > 0 ? pesoFinBloqueadas / somaOf : 0.0632
  };

  const somaCo = pesoEscanteiosConcedidos + pesoCruzamentosConcedidos + pesoToquesAreaConcedidos + pesoFinDentroAreaConcedidas + pesoRebatidas + pesoFinBloqueadasConcedidas + pesoDefesasGoleiro + pesoGolsEvitados;
  const pCo = {
    esc: somaCo > 0 ? pesoEscanteiosConcedidos / somaCo : 0.60,
    cru: somaCo > 0 ? pesoCruzamentosConcedidos / somaCo : 0.1260,
    toq: somaCo > 0 ? pesoToquesAreaConcedidos / somaCo : 0.0771,
    fin: somaCo > 0 ? pesoFinDentroAreaConcedidas / somaCo : 0.0623,
    reb: somaCo > 0 ? pesoRebatidas / somaCo : 0.0547,
    blo: somaCo > 0 ? pesoFinBloqueadasConcedidas / somaCo : 0.0498,
    def: somaCo > 0 ? pesoDefesasGoleiro / somaCo : 0.0205,
    gol: somaCo > 0 ? pesoGolsEvitados / somaCo : 0.0096
  };

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

      const pesoJogo = (Number.isFinite(Number(jogo.peso_tempo)) && Number(jogo.peso_tempo) > 0) ? Number(jogo.peso_tempo) : 1;

      // etaCasa = Força de Ataque da Casa + Fraqueza de Defesa de Fora
      const etaCasa = ofensiva[casa] + concessao[fora];
      // etaFora = Força de Ataque de Fora + Fraqueza de Defesa da Casa
      const etaFora = ofensiva[fora] + concessao[casa];

      const exp = (media, eta) => media * Math.exp(limitar(eta, -5, 5));

      let gOfCasa = 0, gOfFora = 0, gCoCasa = 0, gCoFora = 0;
      const addGrad = (observado, mediaLg, etaObj, peso, tipo) => {
        const obsNum = Number(observado);
        if (numeroValido(obsNum) && obsNum > 0) {
          const erro = logRatio(obsNum, exp(mediaLg, etaObj));
          if (erro !== null) {
            const variacao = pesoJogo * peso * erro;
            if (tipo === 'OfCasa') gOfCasa += variacao;
            if (tipo === 'OfFora') gOfFora += variacao;
            if (tipo === 'CoCasa') gCoCasa += variacao;
            if (tipo === 'CoFora') gCoFora += variacao;
            observacoes++;
          }
        }
      };

      // --- OFENSIVA CASA (Ações de Ataque da Casa) ---
      addGrad(jogo.escanteios_casa, mediasAtaque.escanteiosCasa, etaCasa, pOf.esc, 'OfCasa');
      addGrad(jogo.cruzamentos_total_casa, mediasAtaque.cruzamentosCasa, etaCasa, pOf.cru, 'OfCasa');
      addGrad(jogo.toques_area_adversaria_casa, mediasAtaque.toquesAreaCasa, etaCasa, pOf.toq, 'OfCasa');
      addGrad(jogo.finalizacoes_de_dentro_area_casa, mediasAtaque.finDentroAreaCasa, etaCasa, pOf.fin, 'OfCasa');
      addGrad(jogo.finalizacoes_bloqueadas_casa, mediasAtaque.finBloqueadasCasa, etaCasa, pOf.blo, 'OfCasa');

      // --- OFENSIVA FORA (Ações de Ataque de Fora) ---
      addGrad(jogo.escanteios_fora, mediasAtaque.escanteiosFora, etaFora, pOf.esc, 'OfFora');
      addGrad(jogo.cruzamentos_total_fora, mediasAtaque.cruzamentosFora, etaFora, pOf.cru, 'OfFora');
      addGrad(jogo.toques_area_adversaria_fora, mediasAtaque.toquesAreaFora, etaFora, pOf.toq, 'OfFora');
      addGrad(jogo.finalizacoes_de_dentro_area_fora, mediasAtaque.finDentroAreaFora, etaFora, pOf.fin, 'OfFora');
      addGrad(jogo.finalizacoes_bloqueadas_fora, mediasAtaque.finBloqueadasFora, etaFora, pOf.blo, 'OfFora');

      // ====================================================================
      // 2. CRUZAMENTO DA CONCESSÃO (MISTURANDO ADVERSÁRIO COM O PRÓPRIO TIME)
      // ====================================================================

      // --- CONCESSÃO CASA (Avaliando a fraqueza da defesa da CASA) ---
      // A) O que o adversário conseguiu fazer contra a casa (Puxa da linha de FORA contra média de FORA)
      addGrad(jogo.escanteios_fora, mediasAtaque.escanteiosFora, etaFora, pCo.esc, 'CoCasa');
      addGrad(jogo.cruzamentos_total_fora, mediasAtaque.cruzamentosFora, etaFora, pCo.cru, 'CoCasa');
      addGrad(jogo.toques_area_adversaria_fora, mediasAtaque.toquesAreaFora, etaFora, pCo.toq, 'CoCasa');
      addGrad(jogo.finalizacoes_de_dentro_area_fora, mediasAtaque.finDentroAreaFora, etaFora, pCo.fin, 'CoCasa');
      addGrad(jogo.finalizacoes_bloqueadas_fora, mediasAtaque.finBloqueadasFora, etaFora, pCo.blo, 'CoCasa');
      // B) O que o PRÓPRIO time teve que fazer para se defender (Puxa da linha da CASA contra média da CASA)
      addGrad(jogo.rebatidas_casa, mediasDefesa.rebatidasCasa, etaFora, pCo.reb, 'CoCasa');
      addGrad(jogo.defesas_goleiro_casa, mediasDefesa.defesasGoleiroCasa, etaFora, pCo.def, 'CoCasa');
      addGrad(jogo.gols_evitados_casa, mediasDefesa.golsEvitadosCasa, etaFora, pCo.gol, 'CoCasa');

      // --- CONCESSÃO FORA (Avaliando a fraqueza da defesa de FORA) ---
      // A) O que o adversário conseguiu fazer contra fora (Puxa da linha de CASA contra média de CASA)
      addGrad(jogo.escanteios_casa, mediasAtaque.escanteiosCasa, etaCasa, pCo.esc, 'CoFora');
      addGrad(jogo.cruzamentos_total_casa, mediasAtaque.cruzamentosCasa, etaCasa, pCo.cru, 'CoFora');
      addGrad(jogo.toques_area_adversaria_casa, mediasAtaque.toquesAreaCasa, etaCasa, pCo.toq, 'CoFora');
      addGrad(jogo.finalizacoes_de_dentro_area_casa, mediasAtaque.finDentroAreaCasa, etaCasa, pCo.fin, 'CoFora');
      addGrad(jogo.finalizacoes_bloqueadas_casa, mediasAtaque.finBloqueadasCasa, etaCasa, pCo.blo, 'CoFora');
      // B) O que o PRÓPRIO time teve que fazer para se defender (Puxa da linha de FORA contra média de FORA)
      addGrad(jogo.rebatidas_fora, mediasDefesa.rebatidasFora, etaCasa, pCo.reb, 'CoFora');
      addGrad(jogo.defesas_goleiro_fora, mediasDefesa.defesasGoleiroFora, etaCasa, pCo.def, 'CoFora');
      addGrad(jogo.gols_evitados_fora, mediasDefesa.golsEvitadosFora, etaCasa, pCo.gol, 'CoFora');

      gradOfensiva[casa] += aplicarGradiente(gOfCasa);
      gradOfensiva[fora] += aplicarGradiente(gOfFora);
      gradConcessao[casa] += aplicarGradiente(gCoCasa);
      gradConcessao[fora] += aplicarGradiente(gCoFora);
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

  return {
    ofensiva,
    concessao,
    referenciaLiga,
    mediasAtaque,
    mediasDefesa,
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
    ? Number(referenciaLiga.escanteios?.casa) || parametros.mediaEscanteiosCasa
    : Number(referenciaLiga.escanteios?.fora) || parametros.mediaEscanteiosFora;

  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`Base de escanteios inválida para projeção: ${jogaEmCasa ? 'CASA' : 'FORA'} | base=${base}`);
  }

  const eta = ofensivaA + concessaoB;
  const etaLimitado = Math.max(-5, Math.min(5, eta));
  const lambda = base * Math.exp(etaLimitado);

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda de escanteios inválido: base=${base}, ofensiva=${ofensivaA}, concessao=${concessaoB}, eta=${eta}`);
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

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0 || !Array.isArray(canais) || canais.length === 0) {
    return {
      ofensivaCasa: {}, ofensivaFora: {}, concessaoCasa: {}, concessaoFora: {},
      referenciaLiga, canais: [], convergiu: false, iteracoes: 0
    };
  }

  const numeroValido = (valor) => { const n = Number(valor); return Number.isFinite(n) && n >= 0; };
  const limitar = (valor, minimo, maximo) => Math.max(minimo, Math.min(maximo, valor));
  const logRatio = (observado, esperado) => {
    if (!numeroValido(observado) || observado <= 0) return null;
    if (!Number.isFinite(esperado) || esperado <= 0) return null;
    return Math.log(Math.max(0.05, observado) / Math.max(0.05, esperado));
  };
  const aplicarGradiente = (valor) => Number.isFinite(valor) ? limitar(valor, -gradienteMax, gradienteMax) : 0;
  const pesoTemporalDoJogo = (jogo) => {
    const p = Number(jogo.peso_tempo);
    return Number.isFinite(p) && p > 0 ? p : 1;
  };

  // Médias de liga por canal — default neutro (1) se faltar referência, o
  // que deixa o canal praticamente inerte em vez de quebrar o cálculo.
  const mediasCanais = {};
  for (const canal of canais) {
    const ref = referenciaLiga[canal.chave];
    mediasCanais[canal.chave] = {
      casa: Number(ref?.casa) > 0 ? Number(ref.casa) : 1,
      fora: Number(ref?.fora) > 0 ? Number(ref.fora) : 1
    };
  }

  const somaOfensiva = canais.reduce((s, c) => s + (c.pesoOfensivo ?? 0), 0);
  const somaConcessao = canais.reduce((s, c) => s + (c.pesoConcessao ?? 0), 0);
  const pesosNormalizados = canais.map(c => ({
    chave: c.chave,
    pOfensivo: somaOfensiva > 0 ? (c.pesoOfensivo ?? 0) / somaOfensiva : 1 / canais.length,
    pConcessao: somaConcessao > 0 ? (c.pesoConcessao ?? 0) / somaConcessao : 1 / canais.length
  }));

  // ============================================================
  // 4 PARÂMETROS POR TIME EM VEZ DE 2 — cada time agora tem uma
  // versão de ofensiva/concessão pra quando joga EM CASA e outra
  // pra quando joga FORA, em vez de um valor único que misturava
  // os dois mandos.
  //
  //   etaCasa (produção do lado de casa nesse jogo) =
  //     ofensivaCasa[time_da_casa] + concessaoFora[time_de_fora]
  //   etaFora (produção do lado de fora nesse jogo) =
  //     ofensivaFora[time_de_fora] + concessaoCasa[time_da_casa]
  //
  // Ou seja: a concessão que entra no cálculo é sempre a versão do
  // adversário no MANDO que ele está jogando naquele jogo — não uma
  // concessão genérica dele.
  // ============================================================

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

        // Produção da casa nesse canal informa ofensivaCasa[casa] (como
        // ela ataca jogando em casa) E concessaoFora[fora] (o quanto o
        // adversário, jogando fora, permitiu contra ela).
        if (numeroValido(valorCasa) && valorCasa > 0) {
          const erro = logRatio(valorCasa, esperadoCasa);
          if (erro !== null) {
            gradOfensivaCasaAcc += pesoJogo * pOfensivo * erro;
            gradConcessaoForaAcc += pesoJogo * pConcessao * erro;
            observacoes++;
          }
        }

        // Espelhado: produção do visitante informa ofensivaFora[fora] e
        // concessaoCasa[casa].
        if (numeroValido(valorFora) && valorFora > 0) {
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

    // Centraliza ofensivaCasa e ofensivaFora separadamente, transferindo
    // cada média pro concessao do MANDO OPOSTO que usa ela na mesma
    // equação — preserva o eta de cada jogo, só ganha identificabilidade.
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