const { Client } = require('pg');
const {
    otimizarModeloEscanteios,
    projetarExpectativaEscanteios
} = require('./market_model');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

/*
 * ================================================================
 * MERCADOS DE PERÍODO (1º TEMPO E 2º TEMPO)
 * ================================================================
 *
 * Mesma matemática do backtest de escanteios original
 * (otimizarModeloEscanteios / projetarExpectativaEscanteios,
 * pesos 60% escanteios / 25% finalizações / 15% cruzamentos).
 * O que muda por período:
 *
 *   - histórico vem de estatisticas_por_periodo, filtrando
 *     ep.periodo
 *   - referência de liga vem de grid_metricas_competicoes_periodo
 *     (pré-calculada por gerar_grid_metricas_periodos.js), igual
 *     ao script original fazia com grid_metricas_competicoes
 *   - o resultado grava em colunas com sufixo _1t / _2t
 *
 * A referência de liga não depende da data do jogo-alvo (é o
 * grid pré-calculado da competição), então volta a ser cacheada
 * só por competição+período, igual ao script original fazia.
 */

const MERCADOS = [
    { periodo: '1_tempo', sufixo: '1t' },
    { periodo: '2_tempo', sufixo: '2t' }
];

const METRICAS_OBRIGATORIAS = ['escanteios', 'finalizacoes_de_dentro_area', 'cruzamentos_total'];
const ligasCache = new Map();

async function calcularReferenciaLiga(id_competicao, periodo) {

    const chaveCache = `${id_competicao}_${periodo}`;

    if (ligasCache.has(chaveCache)) {
        return ligasCache.get(chaveCache);
    }

    const { rows } = await client.query(`
        SELECT
            metrica,
            casa_mediana,
            fora_mediana
        FROM grid_metricas_competicoes_periodo
        WHERE id_competicao = $1
          AND periodo = $2
          AND metrica IN (
              'escanteios',
              'finalizacoes_de_dentro_area',
              'cruzamentos_total',
              'toques_area_adversaria',
              'finalizacoes_bloqueadas',
              'rebatidas',
              'defesas_goleiro',
              'gols_evitados'
          )
    `, [id_competicao, periodo]);

    const referenciaLiga = {};

    for (const row of rows) {
        referenciaLiga[row.metrica] = {
            casa: Number(row.casa_mediana),
            fora: Number(row.fora_mediana)
        };
    }

    ligasCache.set(chaveCache, referenciaLiga);

    return referenciaLiga;
}


async function buscarHistorico(id_competicao, dataLimite, periodo) {

    const { rows } = await client.query(`
        SELECT
            j.flashscore_id_time_casa AS casa_id,
            j.flashscore_id_time_fora AS fora_id,

            EXP(
                -0.005 *
                ($2::date - j.data_jogo::date)
            ) AS peso_tempo,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.escanteios
            END) AS escanteios_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.escanteios
            END) AS escanteios_fora,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.cruzamentos_total
            END) AS cruzamentos_total_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.cruzamentos_total
            END) AS cruzamentos_total_fora,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.toques_area_adversaria
            END) AS toques_area_adversaria_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.toques_area_adversaria
            END) AS toques_area_adversaria_fora,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.finalizacoes_de_dentro_area
            END) AS finalizacoes_de_dentro_area_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.finalizacoes_de_dentro_area
            END) AS finalizacoes_de_dentro_area_fora,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.finalizacoes_bloqueadas
            END) AS finalizacoes_bloqueadas_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.finalizacoes_bloqueadas
            END) AS finalizacoes_bloqueadas_fora,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.rebatidas
            END) AS rebatidas_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.rebatidas
            END) AS rebatidas_fora,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.defesas_goleiro
            END) AS defesas_goleiro_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.defesas_goleiro
            END) AS defesas_goleiro_fora,

            MAX(CASE
                WHEN ep.eh_casa = 1
                THEN ep.gols_evitados
            END) AS gols_evitados_casa,

            MAX(CASE
                WHEN ep.eh_casa = 0
                THEN ep.gols_evitados
            END) AS gols_evitados_fora

        FROM jogos j
        INNER JOIN estatisticas_por_periodo ep
            ON ep.flashscore_id_jogo = j.flashscore_id

        WHERE j.id_competicao = $1
          AND ep.periodo = $3
          AND j.data_jogo::date >= $2::date - INTERVAL '1 year'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL

        GROUP BY
            j.id,
            j.data_jogo,
            j.flashscore_id,
            j.flashscore_id_time_casa,
            j.flashscore_id_time_fora

        ORDER BY j.data_jogo::date ASC
    `, [id_competicao, dataLimite, periodo]);

    return rows
        .filter(j =>
            j.casa_id &&
            j.fora_id &&
            Number.isFinite(Number(j.escanteios_casa)) &&
            Number.isFinite(Number(j.escanteios_fora))
        )
        .map(j => ({
            casa_id: String(j.casa_id),
            fora_id: String(j.fora_id),

            escanteios_casa: Number(j.escanteios_casa),
            escanteios_fora: Number(j.escanteios_fora),

            cruzamentos_total_casa:
                j.cruzamentos_total_casa !== null
                    ? Number(j.cruzamentos_total_casa)
                    : null,

            cruzamentos_total_fora:
                j.cruzamentos_total_fora !== null
                    ? Number(j.cruzamentos_total_fora)
                    : null,

            toques_area_adversaria_casa:
                j.toques_area_adversaria_casa !== null
                    ? Number(j.toques_area_adversaria_casa)
                    : null,

            toques_area_adversaria_fora:
                j.toques_area_adversaria_fora !== null
                    ? Number(j.toques_area_adversaria_fora)
                    : null,

            finalizacoes_de_dentro_area_casa:
                j.finalizacoes_de_dentro_area_casa !== null
                    ? Number(j.finalizacoes_de_dentro_area_casa)
                    : null,

            finalizacoes_de_dentro_area_fora:
                j.finalizacoes_de_dentro_area_fora !== null
                    ? Number(j.finalizacoes_de_dentro_area_fora)
                    : null,

            finalizacoes_bloqueadas_casa:
                j.finalizacoes_bloqueadas_casa !== null
                    ? Number(j.finalizacoes_bloqueadas_casa)
                    : null,

            finalizacoes_bloqueadas_fora:
                j.finalizacoes_bloqueadas_fora !== null
                    ? Number(j.finalizacoes_bloqueadas_fora)
                    : null,

            rebatidas_casa:
                j.rebatidas_casa !== null
                    ? Number(j.rebatidas_casa)
                    : null,

            rebatidas_fora:
                j.rebatidas_fora !== null
                    ? Number(j.rebatidas_fora)
                    : null,

            defesas_goleiro_casa:
                j.defesas_goleiro_casa !== null
                    ? Number(j.defesas_goleiro_casa)
                    : null,

            defesas_goleiro_fora:
                j.defesas_goleiro_fora !== null
                    ? Number(j.defesas_goleiro_fora)
                    : null,

            gols_evitados_casa:
                j.gols_evitados_casa !== null
                    ? Number(j.gols_evitados_casa)
                    : null,

            gols_evitados_fora:
                j.gols_evitados_fora !== null
                    ? Number(j.gols_evitados_fora)
                    : null,

            peso_tempo: Number(j.peso_tempo) || 1
        }));
}


/*
 * Processa um período (1T ou 2T) para um jogo-alvo.
 * Retorna null se faltar referência de liga ou histórico
 * suficiente (equivalente ao "continue" do script original).
 */
async function calcularMercadoPeriodo(alvo, id_competicao, periodo) {

    const referenciaLiga = await calcularReferenciaLiga(id_competicao, periodo);

    const faltantes = METRICAS_OBRIGATORIAS.filter(
        m => !referenciaLiga[m] || !Number.isFinite(referenciaLiga[m].casa) || !Number.isFinite(referenciaLiga[m].fora)
    );

    if (faltantes.length > 0) return null;

    const jogosValidos = await buscarHistorico(id_competicao, alvo.data_jogo, periodo);

    if (jogosValidos.length < 20) return null;

    const parametros = await otimizarModeloEscanteios(
    jogosValidos,
    1500,
    0.003,
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

    const home = projetarExpectativaEscanteios(parametros, casaId, foraId, true);
    const away = projetarExpectativaEscanteios(parametros, foraId, casaId, false);

    return {
        casaOfensiva, casaConcessao,
        foraOfensiva, foraConcessao,
        home, away,
        total: home + away
    };
}


/*
 * ================================================================
 * UPDATE EM LOTE (1T + 2T NA MESMA QUERY, VIA UNNEST)
 * ================================================================
 */
async function atualizarLote(client, lote) {
    if (lote.length === 0) return;

    const ids = lote.map(i => i.id);

    const arr1t = (campo) => lote.map(i => i.m1t ? i.m1t[campo] : null);
    const arr2t = (campo) => lote.map(i => i.m2t ? i.m2t[campo] : null);

    const query = `
        UPDATE jogos AS j
        SET
            mle_escanteios_casa_ofensiva_1t  = data.casaOf1t,
            mle_escanteios_casa_concessao_1t = data.casaCon1t,
            mle_escanteios_fora_ofensiva_1t  = data.foraOf1t,
            mle_escanteios_fora_concessao_1t = data.foraCon1t,
            mle_escanteios_home_1t  = data.home1t,
            mle_escanteios_away_1t  = data.away1t,
            mle_escanteios_total_1t = data.total1t,

            mle_escanteios_casa_ofensiva_2t  = data.casaOf2t,
            mle_escanteios_casa_concessao_2t = data.casaCon2t,
            mle_escanteios_fora_ofensiva_2t  = data.foraOf2t,
            mle_escanteios_fora_concessao_2t = data.foraCon2t,
            mle_escanteios_home_2t  = data.home2t,
            mle_escanteios_away_2t  = data.away2t,
            mle_escanteios_total_2t = data.total2t
        FROM (
            SELECT * FROM unnest(
                $1::int[],
                $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[],
                $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[], $14::numeric[], $15::numeric[]
            ) AS t(
                id,
                casaOf1t, casaCon1t, foraOf1t, foraCon1t, home1t, away1t, total1t,
                casaOf2t, casaCon2t, foraOf2t, foraCon2t, home2t, away2t, total2t
            )
        ) AS data
        WHERE j.id = data.id
    `;

    await client.query(query, [
        ids,
        arr1t('casaOfensiva'), arr1t('casaConcessao'), arr1t('foraOfensiva'), arr1t('foraConcessao'),
        arr1t('home'), arr1t('away'), arr1t('total'),
        arr2t('casaOfensiva'), arr2t('casaConcessao'), arr2t('foraOfensiva'), arr2t('foraConcessao'),
        arr2t('home'), arr2t('away'), arr2t('total')
    ]);
}


async function rodarBacktest(dataInicio, dataFim) {
    try {
        await client.connect();
        console.log(`Iniciando simulação [1T + 2T - escanteios] de ${dataInicio} até ${dataFim}...`);

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
              AND (mle_escanteios_total_1t IS NULL OR mle_escanteios_total_2t IS NULL)
            ORDER BY data_jogo::date ASC, id ASC
        `, [dataInicio, dataFim]);

        console.log(`Encontrados ${jogosAlvo.length} jogos para processar.\n`);

        const loteUpdates = [];
        const TAMANHO_LOTE = 500;
        let iteracoesFeitas = 0;

        for (const alvo of jogosAlvo) {
            try {
                const id_competicao = Number(alvo.id_competicao);

                const m1t = await calcularMercadoPeriodo(alvo, id_competicao, '1_tempo');
                const m2t = await calcularMercadoPeriodo(alvo, id_competicao, '2_tempo');

                // Se nenhum dos dois períodos pôde ser calculado, pula o jogo inteiro
                if (!m1t && !m2t) continue;

                loteUpdates.push({ id: alvo.id, m1t, m2t });

                iteracoesFeitas++;

                if (iteracoesFeitas % 50 === 0) {
                    console.log(
                        `[Status] Processados ${iteracoesFeitas} de ${jogosAlvo.length} jogos... ` +
                        `Último: 1T=${m1t ? m1t.total.toFixed(3) : 'N/A'} | 2T=${m2t ? m2t.total.toFixed(3) : 'N/A'}`
                    );
                }

                if (loteUpdates.length >= TAMANHO_LOTE) {
                    console.log(`\nSalvando lote de ${TAMANHO_LOTE} jogos no banco...`);
                    await atualizarLote(client, loteUpdates);
                    loteUpdates.length = 0;
                }

            } catch (err) {
                console.error(`Erro ao processar jogo ${alvo.id}:`, err.message);
                continue;
            }

            await new Promise(resolve => setImmediate(resolve));
        }

        if (loteUpdates.length > 0) {
            console.log(`\nSalvando lote final de ${loteUpdates.length} jogos no banco...`);
            await atualizarLote(client, loteUpdates);
        }

        console.log('\nSimulação [1T + 2T - escanteios] concluída com sucesso!');

    } catch (error) {
        console.error('Erro geral no backtest [1T + 2T - escanteios]:', error);
    } finally {
        await client.end();
    }
}

rodarBacktest('2023-01-01', '2026-09-07');