const { Client } = require('pg');

const {
    otimizarModeloCartoes,
    projetarExpectativaCartoes,
    pontosCartao
} = require('./market_model');

const client = new Client({
    connectionString:
        process.env.DATABASE_URL ||
        'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

/*
 * ================================================================
 * MERCADOS DE PERÍODO (1º TEMPO E 2º TEMPO)
 * ================================================================
 *
 * Mesma matemática do backtest de cartões original
 * (otimizarModeloCartoes / projetarExpectativaCartoes / pontosCartao,
 * pesos 55% cartões / 30% faltas / 15% intensidade, dos dois lados).
 * O que muda por período:
 *
 *   - histórico vem de estatisticas_por_periodo, filtrando
 *     ep.periodo
 *   - referência de liga vem de grid_metricas_competicoes_periodo
 *     (pré-calculada por gerar_grid_metricas_periodos.js) — já
 *     direto no grid, sem passar pela fase on-the-fly
 *   - resultado grava em colunas com sufixo _1t / _2t
 *
 * O pré-carregamento em RAM por competição do script original é
 * mantido, só que agora existem DOIS mapas de histórico por
 * competição (um por período), montados uma vez e reaproveitados
 * para todos os jogos-alvo daquela competição.
 */

const MERCADOS = [
    { periodo: '1_tempo', sufixo: '1t' },
    { periodo: '2_tempo', sufixo: '2t' }
];


async function buscarReferenciaLiga(id_competicao, periodo) {

    const { rows } = await client.query(`
        SELECT metrica, casa_mediana, fora_mediana
        FROM grid_metricas_competicoes_periodo
        WHERE id_competicao = $1
          AND periodo = $2
          AND metrica IN ('cartoes_amarelos', 'cartao_vermelho', 'faltas', 'desarmes_total', 'duelos_ganhos')
    `, [id_competicao, periodo]);

    const brutoLiga = {};
    for (const row of rows) {
        brutoLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };
    }

    if (!brutoLiga['cartoes_amarelos'] || !brutoLiga['cartao_vermelho']) {
        return null;
    }

    return {
        cartoes: {
            casa: pontosCartao(brutoLiga.cartoes_amarelos.casa, brutoLiga.cartao_vermelho.casa),
            fora: pontosCartao(brutoLiga.cartoes_amarelos.fora, brutoLiga.cartao_vermelho.fora)
        },
        faltas: brutoLiga.faltas,
        intensidade: {
            casa: (brutoLiga.desarmes_total?.casa ?? 0) + (brutoLiga.duelos_ganhos?.casa ?? 0),
            fora: (brutoLiga.desarmes_total?.fora ?? 0) + (brutoLiga.duelos_ganhos?.fora ?? 0)
        }
    };
}


async function buscarHistoricoProcessado(id_competicao, primeiraDataAlvo, dataFim, periodo) {

    const { rows: historicoBruto } = await client.query(`
        SELECT j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
               ep.id_time, ep.eh_casa, ep.cartoes_amarelos, ep.cartao_vermelho, ep.faltas, ep.desarmes_total, ep.duelos_ganhos
        FROM jogos j
        INNER JOIN estatisticas_por_periodo ep ON ep.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND ep.periodo = $4
          AND j.data_jogo::date >= $2::date - INTERVAL '1 year'
          AND j.data_jogo::date <= $3::date
          AND j.placar_casa IS NOT NULL AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [id_competicao, primeiraDataAlvo, dataFim, periodo]);

    const mapaHistoricoGeral = new Map();

    for (const linha of historicoBruto) {
        const chave = String(linha.flashscore_id);
        if (!mapaHistoricoGeral.has(chave)) {
            mapaHistoricoGeral.set(chave, {
                data_jogo: new Date(linha.data_jogo),
                casa_id: String(linha.flashscore_id_time_casa),
                fora_id: String(linha.flashscore_id_time_fora),
                cartoes_casa: null, cartoes_fora: null,
                faltas_casa: null, faltas_fora: null,
                intensidade_casa: null, intensidade_fora: null
            });
        }
        const jogoObj = mapaHistoricoGeral.get(chave);

        const amarelos = linha.cartoes_amarelos !== null ? Number(linha.cartoes_amarelos) : 0;
        const vermelhos = linha.cartao_vermelho !== null ? Number(linha.cartao_vermelho) : 0;
        const cartoes = pontosCartao(amarelos, vermelhos);
        const faltas = linha.faltas !== null ? Number(linha.faltas) : null;
        const intensidade = (linha.desarmes_total !== null && linha.duelos_ganhos !== null)
                            ? Number(linha.desarmes_total) + Number(linha.duelos_ganhos)
                            : null;

        if (Number(linha.eh_casa) === 1) {
            jogoObj.cartoes_casa = cartoes; jogoObj.faltas_casa = faltas; jogoObj.intensidade_casa = intensidade;
        } else {
            jogoObj.cartoes_fora = cartoes; jogoObj.faltas_fora = faltas; jogoObj.intensidade_fora = intensidade;
        }
    }

    return Array.from(mapaHistoricoGeral.values());
}


/*
 * Processa um período (1T ou 2T) para um jogo-alvo, usando o
 * histórico já pré-carregado em RAM para aquele período.
 * Retorna null se faltar referência de liga ou histórico
 * suficiente.
 */
function filtrarJanela(historicoGeralProcessado, dataAlvoDate) {

    const umAnoAtrasDate = new Date(dataAlvoDate);
    umAnoAtrasDate.setFullYear(umAnoAtrasDate.getFullYear() - 1);

    const jogosValidos = [];

    for (const h of historicoGeralProcessado) {
        if (h.data_jogo >= umAnoAtrasDate && h.data_jogo < dataAlvoDate) {
            if (h.casa_id && h.fora_id && Number.isFinite(h.cartoes_casa) && Number.isFinite(h.cartoes_fora)) {

                const diasDiferenca = (dataAlvoDate - h.data_jogo) / (1000 * 60 * 60 * 24);
                const pesoTempo = Math.exp(-0.005 * diasDiferenca);

                jogosValidos.push({ ...h, peso_tempo: pesoTempo });
            }
        }
    }

    return jogosValidos;
}


async function processarMercadoCartoes(alvo, referenciaLiga, historicoGeralProcessado) {

    if (!referenciaLiga) return null;

    const dataAlvoDate = new Date(alvo.data_jogo);
    const jogosValidos = filtrarJanela(historicoGeralProcessado, dataAlvoDate);

    if (jogosValidos.length < 20) return null;

    const parametros = await otimizarModeloCartoes(jogosValidos, 1500, 0.003, {
        referenciaLiga,
        pesoCartoes: 0.55, pesoFaltasCometidas: 0.30, pesoIntensidade: 0.15,
        pesoCartoesProvocados: 0.55, pesoFaltasProvocadas: 0.30, pesoIntensidadeProvocada: 0.15,
        regularizacao: 0.02, gradienteMax: 5
    });

    const casaId = String(alvo.flashscore_id_time_casa);
    const foraId = String(alvo.flashscore_id_time_fora);

    const home = projetarExpectativaCartoes(parametros, casaId, foraId, true);
    const away = projetarExpectativaCartoes(parametros, foraId, casaId, false);

    return {
        indisciplinaCasa: parametros.indisciplina?.[casaId] ?? 0,
        provocacaoCasa: parametros.provocacao?.[casaId] ?? 0,
        indisciplinaFora: parametros.indisciplina?.[foraId] ?? 0,
        provocacaoFora: parametros.provocacao?.[foraId] ?? 0,
        home,
        away,
        total: home + away
    };
}


async function rodarBacktest(dataInicio, dataFim) {
    try {
        await client.connect();
        console.log(`Iniciando simulação [1T + 2T - cartões] de ${dataInicio} até ${dataFim}...`);

        // 1. BUSCA TODOS OS JOGOS ALVO (falta pelo menos um dos dois períodos)
        const { rows: jogosAlvo } = await client.query(`
            SELECT id, data_jogo, id_competicao, flashscore_id, flashscore_id_time_casa, flashscore_id_time_fora, placar_casa, placar_fora
            FROM jogos
            WHERE data_jogo::date BETWEEN $1::date AND $2::date
            AND placar_casa IS NOT NULL AND placar_fora IS NOT NULL AND id_competicao IS NOT NULL
            AND (mle_cartoes_total_1t IS NULL OR mle_cartoes_total_2t IS NULL)
            ORDER BY data_jogo::date ASC, id ASC
        `, [dataInicio, dataFim]);

        console.log(`\nEncontrados ${jogosAlvo.length} jogos. Agrupando por competição...`);

        // 2. AGRUPAR POR COMPETIÇÃO PARA EVITAR RECONSULTAS AO BANCO
        const jogosPorCompeticao = new Map();
        for (const jogo of jogosAlvo) {
            const compId = Number(jogo.id_competicao);
            if (!jogosPorCompeticao.has(compId)) {
                jogosPorCompeticao.set(compId, []);
            }
            jogosPorCompeticao.get(compId).push(jogo);
        }

        // 3. PROCESSAR CADA COMPETIÇÃO DE UMA VEZ
        for (const [id_competicao, jogosDestaCompeticao] of jogosPorCompeticao.entries()) {
            console.log(`\n============================================================`);
            console.log(`Pré-carregando dados da Competição: ${id_competicao} (${jogosDestaCompeticao.length} jogos alvo)`);

            const primeiraDataAlvo = jogosDestaCompeticao[0].data_jogo;

            // 3A/3B. PARA CADA PERÍODO: REFERÊNCIA DE LIGA + HISTÓRICO EM RAM
            const dadosPorPeriodo = {};

            for (const { periodo, sufixo } of MERCADOS) {

                const referenciaLiga = await buscarReferenciaLiga(id_competicao, periodo);

                if (!referenciaLiga) {
                    console.log(`[AVISO] Competição ${id_competicao} sem métricas de cartões completas [${periodo}] no grid. Período pulado para esta competição.`);
                    dadosPorPeriodo[sufixo] = { periodo, referenciaLiga: null, historico: [] };
                    continue;
                }

                const historico = await buscarHistoricoProcessado(id_competicao, primeiraDataAlvo, dataFim, periodo);

                dadosPorPeriodo[sufixo] = { periodo, referenciaLiga, historico };
            }

            if (!dadosPorPeriodo['1t'].referenciaLiga && !dadosPorPeriodo['2t'].referenciaLiga) {
                console.log(`[PULAR] Competição ${id_competicao} sem grid de cartões em nenhum dos dois períodos.`);
                continue;
            }

            // 4. PROCESSAR CADA JOGO ALVO DA COMPETIÇÃO SÓ FILTRANDO O QUE ESTÁ NA RAM
            for (const alvo of jogosDestaCompeticao) {

                const resultado1t = await processarMercadoCartoes(alvo, dadosPorPeriodo['1t'].referenciaLiga, dadosPorPeriodo['1t'].historico);
                const resultado2t = await processarMercadoCartoes(alvo, dadosPorPeriodo['2t'].referenciaLiga, dadosPorPeriodo['2t'].historico);

                if (!resultado1t && !resultado2t) {
                    console.log(`[${alvo.data_jogo}] Jogo ${alvo.id} ignorado (histórico insuficiente em ambos os períodos).`);
                    continue;
                }

                await client.query(`
                    UPDATE jogos
                    SET mle_cartoes_casa_indisciplina_1t = $1, mle_cartoes_casa_provocacao_1t = $2,
                        mle_cartoes_fora_indisciplina_1t = $3, mle_cartoes_fora_provocacao_1t = $4,
                        mle_cartoes_home_1t = $5, mle_cartoes_away_1t = $6, mle_cartoes_total_1t = $7,

                        mle_cartoes_casa_indisciplina_2t = $8, mle_cartoes_casa_provocacao_2t = $9,
                        mle_cartoes_fora_indisciplina_2t = $10, mle_cartoes_fora_provocacao_2t = $11,
                        mle_cartoes_home_2t = $12, mle_cartoes_away_2t = $13, mle_cartoes_total_2t = $14
                    WHERE id = $15
                `, [
                    resultado1t?.indisciplinaCasa ?? null, resultado1t?.provocacaoCasa ?? null,
                    resultado1t?.indisciplinaFora ?? null, resultado1t?.provocacaoFora ?? null,
                    resultado1t?.home ?? null, resultado1t?.away ?? null, resultado1t?.total ?? null,

                    resultado2t?.indisciplinaCasa ?? null, resultado2t?.provocacaoCasa ?? null,
                    resultado2t?.indisciplinaFora ?? null, resultado2t?.provocacaoFora ?? null,
                    resultado2t?.home ?? null, resultado2t?.away ?? null, resultado2t?.total ?? null,

                    alvo.id
                ]);

                console.log(
                    `[OK] Jogo ${alvo.id} processado! MLE Cartões 1T: ` +
                    `${resultado1t ? resultado1t.home.toFixed(2) + ' x ' + resultado1t.away.toFixed(2) : 'N/A'} | 2T: ` +
                    `${resultado2t ? resultado2t.home.toFixed(2) + ' x ' + resultado2t.away.toFixed(2) : 'N/A'}`
                );
            }
        }

        console.log('\nSimulação [1T + 2T - cartões] concluída com sucesso!');
    } catch (error) {
        console.error('Erro durante o backtest [1T + 2T - cartões]:', error);
    } finally {
        await client.end();
    }
}


/*
 * ================================================================
 * EXECUTAR
 * ================================================================
 */

rodarBacktest(
    '2023-01-01',
    '2026-09-07'
);