'use strict';

/**
 * VERSÃO A+B — perda nova + fator de nível.
 *
 * MUDANÇAS em relação ao otimizarModeloConjunto atual:
 *
 * 1) PERDA: erro relativo  (observado / esperado - 1), limitado a [-1, 3],
 *    no lugar de log(observado / esperado).
 *    O ponto de equilíbrio passa a ser a média ARITMÉTICA (a que a Poisson
 *    usa), e não a média geométrica. Um jogo com 0 no canal vale -1.
 *
 * 2) ZEROS ENTRAM:
 *    - gols: usa o PLACAR real do jogo (gols_casa / gols_fora), sempre presente,
 *      inclusive 0. Só cai para gols_marcados se o placar não estiver disponível.
 *    - xGOT: 0 conta como observação válida quando o mesmo time tem xG > 0 no
 *      jogo (xGOT 0 = nenhum chute no alvo). Sem xG no jogo, xGOT 0 é ignorado.
 *    - xG: continua exigindo > 0 (um xG exatamente 0 num jogo real é tratado
 *      como dado ausente).
 *
 * 3) NULOS: ausente (null / undefined / '' / não numérico) NUNCA vira 0.
 *    A checagem é explícita antes de qualquer conversão com Number().
 *
 * 4) FATOR DE NÍVEL (igual ao da versão A): gols reais / lambda ajustado nos
 *    jogos de treino, por mando, limitado a [0.6, 1.6].
 *
 * NÃO MUDA: pesos dos canais, bases da grid, regularização (default 0.015),
 * limites de gradiente/parâmetros e centralização do ataque.
 *
 * projetarExpectativaGolsAB(..., usarFator = false) devolve o lambda da versão
 * "B sozinha" (perda nova, sem fator), para medir o efeito da perda isoladamente.
 */

const NIVEL_MIN = 0.6;
const NIVEL_MAX = 1.6;
const ERRO_REL_MIN = -1;
const ERRO_REL_MAX = 3;

// presente = tem valor numérico >= 0; null/undefined/'' nunca são tratados como 0
const valorPresente = (v) =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0;

async function otimizarModeloConjuntoAB(
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

  const mediaXGCasa = Number(referenciaLiga.xg?.casa) > 0 ? Number(referenciaLiga.xg.casa) : 1.30;
  const mediaXGFora = Number(referenciaLiga.xg?.fora) > 0 ? Number(referenciaLiga.xg.fora) : 0.95;
  const mediaXGOTCasa = Number(referenciaLiga.xgot?.casa) > 0 ? Number(referenciaLiga.xgot.casa) : 1.17;
  const mediaXGOTFora = Number(referenciaLiga.xgot?.fora) > 0 ? Number(referenciaLiga.xgot.fora) : 0.86;
  const mediaGolsCasa = Number(referenciaLiga.gols_marcados?.casa) > 0 ? Number(referenciaLiga.gols_marcados.casa) : 1.45;
  const mediaGolsFora = Number(referenciaLiga.gols_marcados?.fora) > 0 ? Number(referenciaLiga.gols_marcados.fora) : 1.15;

  if (!Array.isArray(jogosValidos) || jogosValidos.length === 0) {
    return {
      ataque: {}, defesa: {}, referenciaLiga,
      mediaGolsCasa, mediaGolsFora,
      fatorNivelCasa: 1, fatorNivelFora: 1,
      convergiu: false, iteracoes: 0
    };
  }

  const limitar = (valor, minimo, maximo) => Math.max(minimo, Math.min(maximo, valor));

  const erroRelativo = (observado, esperado) => {
    if (!Number.isFinite(observado) || observado < 0) return null;
    if (!Number.isFinite(esperado) || esperado <= 0) return null;
    return limitar(observado / esperado - 1, ERRO_REL_MIN, ERRO_REL_MAX);
  };

  const aplicarGradiente = (valor) => limitar(valor, -gradienteMax, gradienteMax);

  const canais = [
    { chave: 'xg',   peso: pesoXG,   mediaCasa: mediaXGCasa,   mediaFora: mediaXGFora },
    { chave: 'xgot', peso: pesoXGOT, mediaCasa: mediaXGOTCasa, mediaFora: mediaXGOTFora },
    { chave: 'gols', peso: pesoGols, mediaCasa: mediaGolsCasa, mediaFora: mediaGolsFora }
  ];

  // Observações válidas de um lado do jogo, com as regras de nulo/zero descritas acima.
  const observacoesDoLado = (jogo, lado) => {
    const xgBruto = valorPresente(jogo[`xg_${lado}`]) ? Number(jogo[`xg_${lado}`]) : null;
    const xg = xgBruto !== null && xgBruto > 0 ? xgBruto : null;

    const xgotBruto = valorPresente(jogo[`xgot_${lado}`]) ? Number(jogo[`xgot_${lado}`]) : null;
    const xgot = xgotBruto !== null && (xgotBruto > 0 || xg !== null) ? xgotBruto : null;

    let gols = null;
    if (valorPresente(jogo[`gols_${lado}`])) gols = Number(jogo[`gols_${lado}`]);
    else if (valorPresente(jogo[`gols_marcados_${lado}`])) gols = Number(jogo[`gols_marcados_${lado}`]);

    return { xg, xgot, gols };
  };

  const times = new Set();
  const jogos = [];

  for (const jogo of jogosValidos) {
    if (jogo.casa_id === undefined || jogo.casa_id === null) continue;
    if (jogo.fora_id === undefined || jogo.fora_id === null) continue;

    const casa = String(jogo.casa_id);
    const fora = String(jogo.fora_id);
    times.add(casa);
    times.add(fora);

    jogos.push({
      casa,
      fora,
      peso: Number.isFinite(Number(jogo.peso_tempo)) ? Number(jogo.peso_tempo) : 1,
      obsCasa: observacoesDoLado(jogo, 'casa'),
      obsFora: observacoesDoLado(jogo, 'fora'),
      golsCasaReal: valorPresente(jogo.gols_casa) ? Number(jogo.gols_casa) : null,
      golsForaReal: valorPresente(jogo.gols_fora) ? Number(jogo.gols_fora) : null
    });
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

    for (const jogo of jogos) {
      const expCasa = Math.exp(limitar(ataque[jogo.casa] + defesa[jogo.fora], -5, 5));
      const expFora = Math.exp(limitar(ataque[jogo.fora] + defesa[jogo.casa], -5, 5));

      let gradCasa = 0;
      let gradFora = 0;

      for (const c of canais) {
        const obsC = jogo.obsCasa[c.chave];
        if (obsC !== null) {
          const erro = erroRelativo(obsC, c.mediaCasa * expCasa);
          if (erro !== null) {
            const g = jogo.peso * c.peso * erro;
            gradCasa += g;
            gradDefesa[jogo.fora] += g;
            observacoes++;
          }
        }

        const obsF = jogo.obsFora[c.chave];
        if (obsF !== null) {
          const erro = erroRelativo(obsF, c.mediaFora * expFora);
          if (erro !== null) {
            const g = jogo.peso * c.peso * erro;
            gradFora += g;
            gradDefesa[jogo.casa] += g;
            observacoes++;
          }
        }
      }

      gradAtaque[jogo.casa] += aplicarGradiente(gradCasa);
      gradAtaque[jogo.fora] += aplicarGradiente(gradFora);
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

  // ------------------------------------------------------------------
  // FATOR DE NÍVEL (gols reais / lambda ajustado, por mando)
  // ------------------------------------------------------------------
  let obsCasaTotal = 0, espCasaTotal = 0, obsForaTotal = 0, espForaTotal = 0;

  for (const jogo of jogos) {
    if (jogo.golsCasaReal === null || jogo.golsForaReal === null) continue;

    espCasaTotal += jogo.peso * mediaGolsCasa * Math.exp(limitar(ataque[jogo.casa] + defesa[jogo.fora], -5, 5));
    espForaTotal += jogo.peso * mediaGolsFora * Math.exp(limitar(ataque[jogo.fora] + defesa[jogo.casa], -5, 5));
    obsCasaTotal += jogo.peso * jogo.golsCasaReal;
    obsForaTotal += jogo.peso * jogo.golsForaReal;
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

/**
 * usarFator = true  -> versão A+B (perda nova + fator de nível)
 * usarFator = false -> versão B sozinha (perda nova, sem fator)
 */
function projetarExpectativaGolsAB(parametros, timeA_id, timeB_id, jogaEmCasa = true, usarFator = true) {
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

  const fatorBruto = jogaEmCasa ? parametros.fatorNivelCasa : parametros.fatorNivelFora;
  const fator = usarFator && Number.isFinite(fatorBruto) && fatorBruto > 0 ? fatorBruto : 1;

  const lambda = base * Math.exp(etaLimitado) * fator;

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda inválido: base=${base}, ataque=${ataqueA}, defesa=${defesaB}, eta=${eta}, fator=${fator}`);
  }

  return Math.max(0.05, Math.min(8, lambda));
}

module.exports = {
  otimizarModeloConjuntoAB,
  projetarExpectativaGolsAB
};