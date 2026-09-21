'use strict';

/**
 * BACKTEST V2 — gols
 *
 * Roda, para cada jogo do período, três variações do modelo de gols e grava em
 * COLUNAS NOVAS de `jogos`:
 *   A   = modelo atual (log-ratio) + fator de nível
 *   B   = perda nova (erro relativo, zeros incluídos), SEM fator
 *   A+B = perda nova + fator de nível
 */

const mleGolsA = require('./mle_gols_a');
const mleGolsAB = require('./mle_gols_ab');

// Validação defensiva na inicialização do script
if (typeof mleGolsA.otimizarModeloConjuntoA !== 'function' || typeof mleGolsA.projetarExpectativaGolsA !== 'function') {
  console.error('ERRO CRÍTICO: Módulo "./mle_gols_a" não exportou as funções esperadas.');
  console.error('Verifique se o arquivo possui "module.exports = { otimizarModeloConjuntoA, projetarExpectativaGolsA }".');
  process.exit(1);
}

if (typeof mleGolsAB.otimizarModeloConjuntoAB !== 'function' || typeof mleGolsAB.projetarExpectativaGolsAB !== 'function') {
  console.error('ERRO CRÍTICO: Módulo "./mle_gols_ab" não exportou as funções esperadas.');
  console.error('Verifique se o arquivo possui "module.exports = { otimizarModeloConjuntoAB, projetarExpectativaGolsAB }".');
  process.exit(1);
}

const { otimizarModeloConjuntoA, projetarExpectativaGolsA } = mleGolsA;
const { otimizarModeloConjuntoAB, projetarExpectativaGolsAB } = mleGolsAB;

const JANELA_HISTORICO = '1 year';
const MIN_JOGOS_TREINO = 20;
const METRICAS_OBRIGATORIAS = ['xg', 'xgot', 'gols_marcados'];
const ITERACOES = 1500;
const TAXA_APRENDIZADO = 0.003;
const OPCOES_MODELO = {
  pesoXG: 0.30,
  pesoXGOT: 0.50,
  pesoGols: 0.20,
  regularizacao: 0.015,
  gradienteMax: 5
};

async function carregarReferenciaLiga(client, idCompeticao, cache) {
  if (cache.has(idCompeticao)) return cache.get(idCompeticao);

  const { rows } = await client.query(
    `SELECT metrica, casa_mediana, fora_mediana
       FROM grid_metricas_competicoes
      WHERE id_competicao = $1
        AND metrica = ANY($2)`,
    [idCompeticao, METRICAS_OBRIGATORIAS]
  );

  const referenciaLiga = {};
  for (const row of rows) {
    referenciaLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };
  }

  const faltantes = METRICAS_OBRIGATORIAS.filter(
    (m) => !referenciaLiga[m] || !Number.isFinite(referenciaLiga[m].casa) || !Number.isFinite(referenciaLiga[m].fora)
  );

  const resultado = { referenciaLiga, faltantes };
  cache.set(idCompeticao, resultado);
  return resultado;
}

async function carregarJogosTreino(client, idCompeticao, dataIso) {
  const { rows: historicoBruto } = await client.query(
    `SELECT
         j.id, j.data_jogo, j.flashscore_id,
         j.flashscore_id_time_casa, j.flashscore_id_time_fora,
         j.placar_casa, j.placar_fora,
         sg.id_time, sg.eh_casa,
         sg.xg, sg.xgot, sg.gols_marcados,
         EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
       FROM jogos j
       INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
      WHERE j.id_competicao = $1
        AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
        AND j.data_jogo::date <  $2::date
        AND j.placar_casa IS NOT NULL
        AND j.placar_fora IS NOT NULL
      ORDER BY j.data_jogo::date ASC`,
    [idCompeticao, dataIso]
  );

  const mapaJogos = new Map();

  for (const linha of historicoBruto) {
    const chave = String(linha.flashscore_id);

    if (!mapaJogos.has(chave)) {
      mapaJogos.set(chave, {
        casa_id: String(linha.flashscore_id_time_casa),
        fora_id: String(linha.flashscore_id_time_fora),
        gols_casa: Number(linha.placar_casa),
        gols_fora: Number(linha.placar_fora),
        xg_casa: null, xg_fora: null,
        xgot_casa: null, xgot_fora: null,
        gols_marcados_casa: null, gols_marcados_fora: null,
        peso_tempo: Number(linha.peso_tempo) || 1
      });
    }

    const jogo = mapaJogos.get(chave);

    const xg = linha.xg !== null ? Number(linha.xg) : null;
    const xgot = linha.xgot !== null ? Number(linha.xgot) : null;
    const golsMarcados = linha.gols_marcados !== null ? Number(linha.gols_marcados) : null;

    if (Number(linha.eh_casa) === 1) {
      jogo.xg_casa = xg;
      jogo.xgot_casa = xgot;
      jogo.gols_marcados_casa = golsMarcados;
    }

    if (Number(linha.eh_casa) === 0) {
      jogo.xg_fora = xg;
      jogo.xgot_fora = xgot;
      jogo.gols_marcados_fora = golsMarcados;
    }
  }

  return Array.from(mapaJogos.values()).filter(
    (j) => j.casa_id && j.fora_id && Number.isFinite(j.gols_casa) && Number.isFinite(j.gols_fora)
  );
}

async function rodarBacktestV2(client, dataInicio, dataFim) {
  console.log(`Backtest v2 (A, B, A+B) de ${dataInicio} até ${dataFim}...`);

  const { rows: jogosAlvo } = await client.query(
    `SELECT id, id_competicao, data_jogo::date::text AS data_iso,
            flashscore_id_time_casa, flashscore_id_time_fora
       FROM jogos
      WHERE data_jogo::date BETWEEN $1::date AND $2::date
        AND placar_casa IS NOT NULL
        AND placar_fora IS NOT NULL
        AND id_competicao IS NOT NULL
      ORDER BY data_jogo::date ASC, id ASC`,
    [dataInicio, dataFim]
  );

  console.log(`Encontrados ${jogosAlvo.length} jogos.`);

  const grupos = new Map();
  for (const alvo of jogosAlvo) {
    const chave = `${alvo.id_competicao}|${alvo.data_iso}`;
    if (!grupos.has(chave)) {
      grupos.set(chave, { idCompeticao: Number(alvo.id_competicao), dataIso: alvo.data_iso, alvos: [] });
    }
    grupos.get(chave).alvos.push(alvo);
  }

  console.log(`Agrupados em ${grupos.size} grupos (competição, data).\n`);

  const cacheGrid = new Map();
  const resumo = { gruposOk: 0, gruposPulados: 0, jogosAtualizados: 0, erros: 0 };

  for (const grupo of grupos.values()) {
    const { idCompeticao, dataIso, alvos } = grupo;

    try {
      const { referenciaLiga, faltantes } = await carregarReferenciaLiga(client, idCompeticao, cacheGrid);

      if (faltantes.length > 0) {
        console.log(`[${dataIso}] comp ${idCompeticao}: pulando ${alvos.length} jogo(s) — grid sem [${faltantes.join(', ')}]`);
        resumo.gruposPulados++;
        continue;
      }

      const jogosTreino = await carregarJogosTreino(client, idCompeticao, dataIso);

      if (jogosTreino.length < MIN_JOGOS_TREINO) {
        console.log(`[${dataIso}] comp ${idCompeticao}: pulando ${alvos.length} jogo(s) — histórico insuficiente (${jogosTreino.length})`);
        resumo.gruposPulados++;
        continue;
      }

      const opcoes = { referenciaLiga, ...OPCOES_MODELO };

      const parametrosA = await otimizarModeloConjuntoA(jogosTreino, ITERACOES, TAXA_APRENDIZADO, opcoes);
      const parametrosAB = await otimizarModeloConjuntoAB(jogosTreino, ITERACOES, TAXA_APRENDIZADO, opcoes);

      const comXG = jogosTreino.filter((j) => j.xg_casa !== null && j.xg_fora !== null).length;

      for (const alvo of alvos) {
        const casaId = String(alvo.flashscore_id_time_casa);
        const foraId = String(alvo.flashscore_id_time_fora);

        try {
          const aCasa = projetarExpectativaGolsA(parametrosA, casaId, foraId, true, true);
          const aFora = projetarExpectativaGolsA(parametrosA, foraId, casaId, false, true);

          const bCasa = projetarExpectativaGolsAB(parametrosAB, casaId, foraId, true, false);
          const bFora = projetarExpectativaGolsAB(parametrosAB, foraId, casaId, false, false);

          const abCasa = projetarExpectativaGolsAB(parametrosAB, casaId, foraId, true, true);
          const abFora = projetarExpectativaGolsAB(parametrosAB, foraId, casaId, false, true);

          await client.query(
            `UPDATE jogos SET
                 mle_a_l_home = $1,  mle_a_l_away = $2,
                 mle_a_fator_casa = $3, mle_a_fator_fora = $4,
                 mle_b_l_home = $5,  mle_b_l_away = $6,
                 mle_ab_l_home = $7, mle_ab_l_away = $8,
                 mle_ab_fator_casa = $9, mle_ab_fator_fora = $10
               WHERE id = $11`,
            [
              aCasa, aFora,
              parametrosA.fatorNivelCasa, parametrosA.fatorNivelFora,
              bCasa, bFora,
              abCasa, abFora,
              parametrosAB.fatorNivelCasa, parametrosAB.fatorNivelFora,
              alvo.id
            ]
          );

          resumo.jogosAtualizados++;
        } catch (err) {
          resumo.erros++;
          console.log(`[${dataIso}] jogo ${alvo.id}: erro ao projetar/gravar — ${err.message}`);
        }
      }

      resumo.gruposOk++;

      console.log(
        `[${dataIso}] comp ${idCompeticao}: treino=${jogosTreino.length} (xG em ${comXG}) | ${alvos.length} jogo(s) | ` +
        `fator A c=${parametrosA.fatorNivelCasa.toFixed(3)} f=${parametrosA.fatorNivelFora.toFixed(3)} | ` +
        `fator A+B c=${parametrosAB.fatorNivelCasa.toFixed(3)} f=${parametrosAB.fatorNivelFora.toFixed(3)}`
      );
    } catch (err) {
      resumo.erros++;
      console.log(`[${dataIso}] comp ${idCompeticao}: erro — ${err.message}`);
    }
  }

  console.log(
    `\nConcluído. Grupos ok: ${resumo.gruposOk} | pulados: ${resumo.gruposPulados} | ` +
    `jogos atualizados: ${resumo.jogosAtualizados} | erros: ${resumo.erros}`
  );

  return resumo;
}

module.exports = { rodarBacktestV2 };

if (require.main === module) {
  const [dataInicio, dataFim] = process.argv.slice(2);
  const formatoData = /^\d{4}-\d{2}-\d{2}$/;

  if (!dataInicio || !dataFim || !formatoData.test(dataInicio) || !formatoData.test(dataFim)) {
    console.error('Uso: node backtest_gols_v2.js 2025-06-01 2026-09-18');
    process.exit(1);
  }
  const { criarClient } = require('../db');
  const client = criarClient('modelo');

  (async () => {
    try {
      await client.connect();
      await rodarBacktestV2(client, dataInicio, dataFim);
    } catch (err) {
      console.error('Erro durante o backtest:', err);
      process.exitCode = 1;
    } finally {
      await client.end();
    }
  })();
}