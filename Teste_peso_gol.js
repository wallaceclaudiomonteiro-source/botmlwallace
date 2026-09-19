// teste_pesos_gols.js
//
// Isola UM jogo (por flashscore_id) e roda o modelo MLE de gols duas vezes,
// usando exatamente a função otimizarModeloConjunto do market_model.js:
//   1) pesoXG=0.30 / pesoXGOT=0.50  (config atual)
//   2) pesoXG=0.50 / pesoXGOT=0.30  (config invertida)
// e compara o lambda_casa / lambda_fora resultante.
//
// Rode com: node teste_pesos_gols.js
// (ajuste o FLASHSCORE_ID_ALVO abaixo se quiser testar outro jogo)

const { Client } = require('pg');
const { otimizarModeloConjunto, projetarExpectativaGols } = require('./market_model');

const client = new Client({ connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol' });

const FLASHSCORE_ID_ALVO = '6g6tG3Vr';
const JANELA_HISTORICO = '1 year';
const METRICAS_OBRIGATORIAS = ['xg', 'xgot', 'gols_marcados'];

async function buscarReferenciaLiga(idCompeticao) {
  const { rows } = await client.query(
    `SELECT metrica, casa_mediana, fora_mediana FROM grid_metricas_competicoes WHERE id_competicao = $1 AND metrica = ANY($2)`,
    [idCompeticao, METRICAS_OBRIGATORIAS]
  );
  const referenciaLiga = {};
  for (const row of rows) referenciaLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };
  return referenciaLiga;
}

async function buscarHistorico(idCompeticao, dataAlvo) {
  const { rows } = await client.query(`
    SELECT
      j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
      j.placar_casa, j.placar_fora,
      sg.eh_casa, sg.xg, sg.xgot, sg.gols_marcados,
      EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
    FROM jogos j
    INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
    WHERE j.id_competicao = $1
      AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
      AND j.data_jogo::date < $2::date
      AND j.placar_casa IS NOT NULL
      AND j.placar_fora IS NOT NULL
    ORDER BY j.data_jogo::date ASC
  `, [idCompeticao, dataAlvo]);

  const mapaJogos = new Map();
  for (const linha of rows) {
    const chave = String(linha.flashscore_id);
    if (!mapaJogos.has(chave)) {
      mapaJogos.set(chave, {
        casa_id: String(linha.flashscore_id_time_casa),
        fora_id: String(linha.flashscore_id_time_fora),
        gols_casa: Number(linha.placar_casa),
        gols_fora: Number(linha.placar_fora),
        xg_casa: null, xg_fora: null, xgot_casa: null, xgot_fora: null,
        gols_marcados_casa: null, gols_marcados_fora: null,
        peso_tempo: Number(linha.peso_tempo) || 1
      });
    }
    const jogo = mapaJogos.get(chave);
    const xg = linha.xg !== null ? Number(linha.xg) : null;
    const xgot = linha.xgot !== null ? Number(linha.xgot) : null;
    const gm = linha.gols_marcados !== null ? Number(linha.gols_marcados) : null;
    if (Number(linha.eh_casa) === 1) { jogo.xg_casa = xg; jogo.xgot_casa = xgot; jogo.gols_marcados_casa = gm; }
    if (Number(linha.eh_casa) === 0) { jogo.xg_fora = xg; jogo.xgot_fora = xgot; jogo.gols_marcados_fora = gm; }
  }

  return Array.from(mapaJogos.values()).filter(
    j => j.casa_id && j.fora_id && Number.isFinite(j.gols_casa) && Number.isFinite(j.gols_fora)
  );
}

async function main() {
  await client.connect();

  const { rows: jogoRows } = await client.query(
    `SELECT flashscore_id, flashscore_id_casa, flashscore_id_fora, id_competicao, data_jogo, nome_time_casa, nome_time_fora, nome_competicao
     FROM calendario WHERE flashscore_id = $1`,
    [FLASHSCORE_ID_ALVO]
  );

  if (jogoRows.length === 0) {
    console.log(`Jogo ${FLASHSCORE_ID_ALVO} não encontrado na tabela "calendario".`);
    await client.end();
    return;
  }

  const jogoAlvo = jogoRows[0];
  const dataAlvo = jogoAlvo.data_jogo;
  const idCompeticao = jogoAlvo.id_competicao;
  const casaId = String(jogoAlvo.flashscore_id_casa);
  const foraId = String(jogoAlvo.flashscore_id_fora);

  console.log(`Jogo: ${jogoAlvo.flashscore_id} | ${jogoAlvo.nome_time_casa} x ${jogoAlvo.nome_time_fora} | Competição: ${jogoAlvo.nome_competicao} (${idCompeticao}) | Data: ${dataAlvo}`);
  console.log(`Time casa (id): ${casaId} | Time fora (id): ${foraId}`);

  const referenciaLiga = await buscarReferenciaLiga(idCompeticao);
  const jogosValidos = await buscarHistorico(idCompeticao, dataAlvo);
  console.log(`Jogos de histórico usados no treino: ${jogosValidos.length}\n`);

  if (jogosValidos.length === 0) {
    console.log('Sem histórico suficiente pra treinar o modelo pra essa competição/data.');
    await client.end();
    return;
  }

  // Config 1: xGOT com mais peso (config atual do seu script)
  const paramsXGOTAlto = await otimizarModeloConjunto(jogosValidos, 1500, 0.003, {
    referenciaLiga, pesoXG: 0.30, pesoXGOT: 0.50, pesoGols: 0.20, regularizacao: 0.015, gradienteMax: 5
  });

  // Config 2: invertido — xG com mais peso
  const paramsXGAlto = await otimizarModeloConjunto(jogosValidos, 1500, 0.003, {
    referenciaLiga, pesoXG: 0.50, pesoXGOT: 0.30, pesoGols: 0.20, regularizacao: 0.015, gradienteMax: 5
  });

  const lambdaCasa_xgotAlto = projetarExpectativaGols(paramsXGOTAlto, casaId, foraId, true);
  const lambdaFora_xgotAlto = projetarExpectativaGols(paramsXGOTAlto, foraId, casaId, false);

  const lambdaCasa_xgAlto = projetarExpectativaGols(paramsXGAlto, casaId, foraId, true);
  const lambdaFora_xgAlto = projetarExpectativaGols(paramsXGAlto, foraId, casaId, false);

  console.log('--- COMPARAÇÃO ---');
  console.log(`pesoXG=0.30 / pesoXGOT=0.50 (atual)     -> λ_casa=${lambdaCasa_xgotAlto.toFixed(4)} | λ_fora=${lambdaFora_xgotAlto.toFixed(4)} | convergiu=${paramsXGOTAlto.convergiu} | iterações=${paramsXGOTAlto.iteracoes}`);
  console.log(`pesoXG=0.50 / pesoXGOT=0.30 (invertido) -> λ_casa=${lambdaCasa_xgAlto.toFixed(4)} | λ_fora=${lambdaFora_xgAlto.toFixed(4)} | convergiu=${paramsXGAlto.convergiu} | iterações=${paramsXGAlto.iteracoes}`);
  console.log(`\nDiferença λ_casa: ${(lambdaCasa_xgotAlto - lambdaCasa_xgAlto).toFixed(6)}`);
  console.log(`Diferença λ_fora: ${(lambdaFora_xgotAlto - lambdaFora_xgAlto).toFixed(6)}`);

  await client.end();
}

main().catch(err => { console.error(err); process.exit(1); });