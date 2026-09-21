'use strict';

const NIVEL_MIN = 0.6;
const NIVEL_MAX = 1.6;

async function otimizarModeloConjuntoA(
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

  const aplicarGradiente = (valor) => limitar(valor, -gradienteMax, gradienteMax);
  const pesoTemporal = (jogo) => (Number.isFinite(Number(jogo.peso_tempo)) ? Number(jogo.peso_tempo) : 1);

  const canais = [
    { peso: pesoXG, mediaCasa: mediaXGCasa, mediaFora: mediaXGFora, campoCasa: 'xg_casa', campoFora: 'xg_fora' },
    { peso: pesoXGOT, mediaCasa: mediaXGOTCasa, mediaFora: mediaXGOTFora, campoCasa: 'xgot_casa', campoFora: 'xgot_fora' },
    { peso: pesoGols, mediaCasa: mediaGolsCasa, mediaFora: mediaGolsFora, campoCasa: 'gols_marcados_casa', campoFora: 'gols_marcados_fora' }
  ];

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

      for (const c of canais) {
        const obsCasa = Number(jogo[c.campoCasa]);
        if (numeroValido(obsCasa) && obsCasa > 0) {
          const erro = logRatio(obsCasa, c.mediaCasa * Math.exp(etaCasa));
          if (erro !== null) {
            const g = pesoJogo * c.peso * erro;
            gradCasa += g;
            gradDefesa[fora] += g;
            observacoes++;
          }
        }

        const obsFora = Number(jogo[c.campoFora]);
        if (numeroValido(obsFora) && obsFora > 0) {
          const erro = logRatio(obsFora, c.mediaFora * Math.exp(etaFora));
          if (erro !== null) {
            const g = pesoJogo * c.peso * erro;
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

function projetarExpectativaGolsA(parametros, timeA_id, timeB_id, jogaEmCasa = true, usarFator = true) {
  const idA = String(timeA_id);
  const idB = String(timeB_id);

  const ataqueA = Number(parametros.ataque?.[idA]) || 0;
  const defesaB = Number(parametros.defesa?.[idB]) || 0;
  const referenciaLiga = parametros.referenciaLiga || {};

  const base = jogaEmCasa
    ? Number(referenciaLiga.gols_marcados?.casa)
    : Number(referenciaLiga.gols_marcados?.fora);

  if (!Number.isFinite(base) || base <= 0) {
    throw new Error(`Base de gols inválida para projeção: ${jogaEmCasa ? 'CASA' : 'FORA'}`);
  }

  const eta = ataqueA + defesaB;
  const etaLimitado = Math.max(-5, Math.min(5, eta));

  const fatorBruto = jogaEmCasa ? parametros.fatorNivelCasa : parametros.fatorNivelFora;
  const fator = usarFator && Number.isFinite(fatorBruto) && fatorBruto > 0 ? fatorBruto : 1;

  const lambda = base * Math.exp(etaLimitado) * fator;

  if (!Number.isFinite(lambda) || lambda <= 0) {
    throw new Error(`Lambda inválido: base=${base}, eta=${eta}, fator=${fator}`);
  }

  return Math.max(0.05, Math.min(8, lambda));
}

module.exports = {
  otimizarModeloConjuntoA,
  projetarExpectativaGolsA
};