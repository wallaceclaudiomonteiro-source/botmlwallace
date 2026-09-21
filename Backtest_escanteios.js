const { criarClient } = require('./db');
const {
    otimizarModeloEscanteios,
    projetarExpectativaEscanteios
} = require('./market_model');

const client = criarClient('modelo');

async function atualizarLote(client, lote) {
    if (lote.length === 0) return;

    // Prepara os arrays para o update em lote
    const ids = lote.map(i => i.id);
    const casaOfs = lote.map(i => i.casaOfensiva);
    const casaCons = lote.map(i => i.casaConcessao);
    const foraOfs = lote.map(i => i.foraOfensiva);
    const foraCons = lote.map(i => i.foraConcessao);
    const homes = lote.map(i => i.mle_escanteios_home);
    const aways = lote.map(i => i.mle_escanteios_away);
    const totals = lote.map(i => i.mle_escanteios_total);

    const query = `
        UPDATE jogos AS j
        SET
            mle_escanteios_casa_ofensiva = data.casaOf,
            mle_escanteios_casa_concessao = data.casaCon,
            mle_escanteios_fora_ofensiva = data.foraOf,
            mle_escanteios_fora_concessao = data.foraCon,
            mle_escanteios_home = data.home,
            mle_escanteios_away = data.away,
            mle_escanteios_total = data.total
        FROM (
            SELECT * FROM unnest(
                $1::int[], $2::numeric[], $3::numeric[], $4::numeric[],
                $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[]
            ) AS t(id, casaOf, casaCon, foraOf, foraCon, home, away, total)
        ) AS data
        WHERE j.id = data.id
    `;

    await client.query(query, [ids, casaOfs, casaCons, foraOfs, foraCons, homes, aways, totals]);
}

async function rodarBacktest(dataInicio, dataFim) {
    try {
        await client.connect();
        console.log(`Iniciando simulação de ${dataInicio} até ${dataFim}...`);

        const { rows: jogosAlvo } = await client.query(`
            SELECT
                id, data_jogo, id_competicao, flashscore_id,
                flashscore_id_time_casa, flashscore_id_time_fora,
                placar_casa, placar_fora
            FROM jogos
            WHERE data_jogo::date BETWEEN $1::date AND $2::date
              AND placar_casa IS NOT NULL
              AND placar_fora IS NOT NULL
              AND id_competicao IS NOT NULL
              AND mle_escanteios_total IS NULL
            ORDER BY data_jogo::date ASC, id ASC
        `, [dataInicio, dataFim]);

        console.log(`Encontrados ${jogosAlvo.length} jogos para processar.\n`);

        const ligasCache = new Map();
        const loteUpdates = [];
        const TAMANHO_LOTE = 500;
        let iteracoesFeitas = 0;

        for (const alvo of jogosAlvo) {
            try {
                const id_competicao = Number(alvo.id_competicao);

                // ========================================================
                // 1. CACHE DE LIGAS (Consulta no banco apenas 1x por liga)
                // ========================================================
                if (!ligasCache.has(id_competicao)) {
                    const { rows: metricas } = await client.query(`
                        SELECT metrica, casa_mediana, fora_mediana
                        FROM grid_metricas_competicoes
                        WHERE id_competicao = $1
                          AND metrica IN (
                            'escanteios', 'finalizacoes_de_dentro_area', 'cruzamentos_total', 
                            'toques_area_adversaria', 'finalizacoes_bloqueadas', 
                            'rebatidas', 'defesas_goleiro', 'gols_evitados'
                          )
                    `, [id_competicao]);

                    const bruto = {};
                    for (const row of metricas) {
                        bruto[row.metrica] = {
                            casa: Number(row.casa_mediana),
                            fora: Number(row.fora_mediana)
                        };
                    }
                    ligasCache.set(id_competicao, bruto);
                }

                const brutoLiga = ligasCache.get(id_competicao);
                const metricasObrigatorias = ['escanteios', 'finalizacoes_de_dentro_area', 'cruzamentos_total'];

                const faltantes = metricasObrigatorias.filter(
                    m => !brutoLiga[m] || !Number.isFinite(brutoLiga[m].casa) || !Number.isFinite(brutoLiga[m].fora)
                );

                if (faltantes.length > 0) continue;

                const referenciaLiga = {
                    escanteios: brutoLiga.escanteios,
                    finalizacoes_de_dentro_area: brutoLiga.finalizacoes_de_dentro_area,
                    cruzamentos_total: brutoLiga.cruzamentos_total,
                    toques_area_adversaria: brutoLiga.toques_area_adversaria,
                    finalizacoes_bloqueadas: brutoLiga.finalizacoes_bloqueadas,
                    rebatidas: brutoLiga.rebatidas,
                    defesas_goleiro: brutoLiga.defesas_goleiro,
                    gols_evitados: brutoLiga.gols_evitados
                };

                // ========================================================
                // 2. QUERY HISTÓRICO OTIMIZADA (O SQL faz o agrupamento)
                // ========================================================
                const { rows: historicoOtimizado } = await client.query(`
                    SELECT
                        j.flashscore_id_time_casa AS casa_id,
                        j.flashscore_id_time_fora AS fora_id,
                        EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.escanteios END) AS escanteios_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.escanteios END) AS escanteios_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.finalizacoes END) AS finalizacoes_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.finalizacoes END) AS finalizacoes_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.cruzamentos_total END) AS cruzamentos_total_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.cruzamentos_total END) AS cruzamentos_total_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.toques_area_adversaria END) AS toques_area_adversaria_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.toques_area_adversaria END) AS toques_area_adversaria_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.finalizacoes_de_dentro_area END) AS finalizacoes_de_dentro_area_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.finalizacoes_de_dentro_area END) AS finalizacoes_de_dentro_area_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.finalizacoes_bloqueadas END) AS finalizacoes_bloqueadas_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.finalizacoes_bloqueadas END) AS finalizacoes_bloqueadas_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.rebatidas END) AS rebatidas_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.rebatidas END) AS rebatidas_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.defesas_goleiro END) AS defesas_goleiro_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.defesas_goleiro END) AS defesas_goleiro_fora,
                        MAX(CASE WHEN sg.eh_casa = 1 THEN sg.gols_evitados END) AS gols_evitados_casa,
                        MAX(CASE WHEN sg.eh_casa = 0 THEN sg.gols_evitados END) AS gols_evitados_fora
                    FROM jogos j
                    INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
                    WHERE j.id_competicao = $1
                      AND j.data_jogo::date >= $2::date - INTERVAL '1 year'
                      AND j.data_jogo::date < $2::date
                      AND j.placar_casa IS NOT NULL
                      AND j.placar_fora IS NOT NULL
                    GROUP BY j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora
                    ORDER BY j.data_jogo::date ASC
                `, [id_competicao, alvo.data_jogo]);

                const jogosValidos = historicoOtimizado.filter(j =>
                    j.casa_id && j.fora_id &&
                    Number.isFinite(Number(j.escanteios_casa)) &&
                    Number.isFinite(Number(j.escanteios_fora))
                ).map(j => ({
                    casa_id: String(j.casa_id),
                    fora_id: String(j.fora_id),
                    escanteios_casa: Number(j.escanteios_casa),
                    escanteios_fora: Number(j.escanteios_fora),
                    finalizacoes_casa: j.finalizacoes_casa !== null ? Number(j.finalizacoes_casa) : null,
                    finalizacoes_fora: j.finalizacoes_fora !== null ? Number(j.finalizacoes_fora) : null,
                    cruzamentos_total_casa: j.cruzamentos_total_casa !== null ? Number(j.cruzamentos_total_casa) : null,
                    cruzamentos_total_fora: j.cruzamentos_total_fora !== null ? Number(j.cruzamentos_total_fora) : null,
                    toques_area_adversaria_casa: j.toques_area_adversaria_casa !== null ? Number(j.toques_area_adversaria_casa) : null,
                    toques_area_adversaria_fora: j.toques_area_adversaria_fora !== null ? Number(j.toques_area_adversaria_fora) : null,
                    finalizacoes_de_dentro_area_casa: j.finalizacoes_de_dentro_area_casa !== null ? Number(j.finalizacoes_de_dentro_area_casa) : null,
                    finalizacoes_de_dentro_area_fora: j.finalizacoes_de_dentro_area_fora !== null ? Number(j.finalizacoes_de_dentro_area_fora) : null,
                    finalizacoes_bloqueadas_casa: j.finalizacoes_bloqueadas_casa !== null ? Number(j.finalizacoes_bloqueadas_casa) : null,
                    finalizacoes_bloqueadas_fora: j.finalizacoes_bloqueadas_fora !== null ? Number(j.finalizacoes_bloqueadas_fora) : null,
                    rebatidas_casa: j.rebatidas_casa !== null ? Number(j.rebatidas_casa) : null,
                    rebatidas_fora: j.rebatidas_fora !== null ? Number(j.rebatidas_fora) : null,
                    defesas_goleiro_casa: j.defesas_goleiro_casa !== null ? Number(j.defesas_goleiro_casa) : null,
                    defesas_goleiro_fora: j.defesas_goleiro_fora !== null ? Number(j.defesas_goleiro_fora) : null,
                    gols_evitados_casa: j.gols_evitados_casa !== null ? Number(j.gols_evitados_casa) : null,
                    gols_evitados_fora: j.gols_evitados_fora !== null ? Number(j.gols_evitados_fora) : null,
                    peso_tempo: Number(j.peso_tempo) || 1
                }));

                if (jogosValidos.length < 20) continue;

                // ========================================================
                // 3. OTIMIZAÇÃO MLE
                // ========================================================
                const parametros = await otimizarModeloEscanteios(
                    jogosValidos, 1500, 0.003,
                   {
    referenciaLiga,
    pesoEscanteios: 0.6000,
    pesoCruzamentos: 0.1599,
    pesoToquesArea: 0.0979,
    pesoFinDentroArea: 0.0790,
    pesoFinBloqueadas: 0.0632,
    pesoEscanteiosConcedidos: 0.6000,
    pesoCruzamentosConcedidos: 0.1260,
    pesoToquesAreaConcedidos: 0.0771,
    pesoFinDentroAreaConcedidas: 0.0623,
    pesoRebatidas: 0.0547,
    pesoFinBloqueadasConcedidas: 0.0498,
    pesoDefesasGoleiro: 0.0205,
    pesoGolsEvitados: 0.0096,
    regularizacao: 0.02,
    gradienteMax: 5
}
                );

                const casaId = String(alvo.flashscore_id_time_casa);
                const foraId = String(alvo.flashscore_id_time_fora);

                const casaOfensiva = parametros.ofensiva?.[casaId] ?? 0;
                const casaConcessao = parametros.concessao?.[casaId] ?? 0;
                const foraOfensiva = parametros.ofensiva?.[foraId] ?? 0;
                const foraConcessao = parametros.concessao?.[foraId] ?? 0;

                const mle_escanteios_home = projetarExpectativaEscanteios(parametros, casaId, foraId, true);
                const mle_escanteios_away = projetarExpectativaEscanteios(parametros, foraId, casaId, false);
                const mle_escanteios_total = mle_escanteios_home + mle_escanteios_away;

                // ========================================================
                // 4. ADICIONA AO LOTE DE ATUALIZAÇÃO
                // ========================================================
                loteUpdates.push({
                    id: alvo.id,
                    casaOfensiva, casaConcessao,
                    foraOfensiva, foraConcessao,
                    mle_escanteios_home, mle_escanteios_away, mle_escanteios_total
                });

                iteracoesFeitas++;

                // Imprime apenas a cada 50 jogos para não travar a tela do VS Code
                if (iteracoesFeitas % 50 === 0) {
                    console.log(`[Status] Processados ${iteracoesFeitas} de ${jogosAlvo.length} jogos... Último MLE: ${mle_escanteios_total.toFixed(3)}`);
                }

                // Envia o lote para o banco quando atingir o limite
                if (loteUpdates.length >= TAMANHO_LOTE) {
                    console.log(`\nSalvando lote de ${TAMANHO_LOTE} jogos no banco...`);
                    await atualizarLote(client, loteUpdates);
                    loteUpdates.length = 0; // Limpa o lote
                }

            } catch (err) {
                console.error(`Erro ao processar jogo ${alvo.id}:`, err.message);
                continue;
            }

            // Força a liberação de memória e evita travamento do processo principal
            await new Promise(resolve => setImmediate(resolve));
        }

        // Salva qualquer jogo restante no fim do loop
        if (loteUpdates.length > 0) {
            console.log(`\nSalvando lote final de ${loteUpdates.length} jogos no banco...`);
            await atualizarLote(client, loteUpdates);
        }

        console.log('\nSimulação concluída com sucesso!');

    } catch (error) {
        console.error('Erro geral no backtest:', error);
    } finally {
        await client.end();
    }
}

rodarBacktest('2025-01-01', '2026-09-20');