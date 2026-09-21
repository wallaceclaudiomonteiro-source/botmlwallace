const { criarClient } = require('./db');

const {
    otimizarModeloCartoes,
    projetarExpectativaCartoes,
    pontosCartao
} = require('./market_model');

const client = criarClient('modelo');


async function rodarBacktest(dataInicio, dataFim) {
    try {
        await client.connect();
        console.log(`Iniciando simulação de ${dataInicio} até ${dataFim}...`);

        // 1. BUSCA TODOS OS JOGOS ALVO
        const { rows: jogosAlvo } = await client.query(`
            SELECT id, data_jogo, id_competicao, flashscore_id, flashscore_id_time_casa, flashscore_id_time_fora, placar_casa, placar_fora
            FROM jogos
            WHERE data_jogo::date BETWEEN $1::date AND $2::date
            AND placar_casa IS NOT NULL AND placar_fora IS NOT NULL AND id_competicao IS NOT NULL 
            AND mle_cartoes_total IS NULL -- <== TRAVA ADICIONADA AQUI
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

            // 3A. BUSCA MÉTRICAS DA LIGA UMA ÚNICA VEZ
            const { rows: metricasLigaCartoes } = await client.query(`
                SELECT metrica, casa_mediana, fora_mediana 
                FROM grid_metricas_competicoes 
                WHERE id_competicao = $1 AND metrica IN ('cartoes_amarelos', 'cartao_vermelho', 'faltas', 'desarmes_total', 'duelos_ganhos')
            `, [id_competicao]);

            const brutoLiga = {};
            for (const row of metricasLigaCartoes) {
                brutoLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };
            }

            // Validação de segurança das métricas (mantida como o seu código original)
            if (!brutoLiga['cartoes_amarelos'] || !brutoLiga['cartao_vermelho']) {
                console.log(`[PULAR] Competição ${id_competicao} sem métricas completas. Pulando seus jogos.`);
                continue; 
            }

            const referenciaLiga = {
                cartoes: {
                    casa: pontosCartao(brutoLiga.cartoes_amarelos.casa, brutoLiga.cartao_vermelho.casa),
                    fora: pontosCartao(brutoLiga.cartoes_amarelos.fora, brutoLiga.cartao_vermelho.fora)
                },
                faltas: brutoLiga.faltas,
                intensidade: {
                    casa: brutoLiga.desarmes_total.casa + brutoLiga.duelos_ganhos.casa,
                    fora: brutoLiga.desarmes_total.fora + brutoLiga.duelos_ganhos.fora
                }
            };

            // 3B. BUSCA TODO O HISTÓRICO DA COMPETIÇÃO NA RAM (De 1 ano antes do primeiro jogo até o fim)
            const primeiraDataAlvo = jogosDestaCompeticao[0].data_jogo;
            
            const { rows: historicoBruto } = await client.query(`
                SELECT j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
                       sg.id_time, sg.eh_casa, sg.cartoes_amarelos, sg.cartao_vermelho, sg.faltas, sg.desarmes_total, sg.duelos_ganhos
                FROM jogos j
                INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
                WHERE j.id_competicao = $1
                  AND j.data_jogo::date >= $2::date - INTERVAL '1 year'
                  AND j.data_jogo::date <= $3::date
                  AND j.placar_casa IS NOT NULL AND j.placar_fora IS NOT NULL
                ORDER BY j.data_jogo::date ASC
            `, [id_competicao, primeiraDataAlvo, dataFim]);

            // Monta o array gigante de todos os jogos históricos convertidos UMA VEZ
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
            const historicoGeralProcessado = Array.from(mapaHistoricoGeral.values());

            // 4. PROCESSAR CADA JOGO ALVO DA COMPETIÇÃO SÓ FILTRANDO O QUE ESTÁ NA RAM
            for (const alvo of jogosDestaCompeticao) {
                const dataAlvoDate = new Date(alvo.data_jogo);
                const umAnoAtrasDate = new Date(dataAlvoDate);
                umAnoAtrasDate.setFullYear(umAnoAtrasDate.getFullYear() - 1);

                // FILTRO EM RAM: Pega só os jogos válidos da janela de 1 ano antes DESTE jogo
                const jogosValidos = [];
                for (const h of historicoGeralProcessado) {
                    if (h.data_jogo >= umAnoAtrasDate && h.data_jogo < dataAlvoDate) {
                        if (h.casa_id && h.fora_id && Number.isFinite(h.cartoes_casa) && Number.isFinite(h.cartoes_fora)) {
                            
                            // Calcula o peso temporal em JS (idêntico ao SQL)
                            const diasDiferenca = (dataAlvoDate - h.data_jogo) / (1000 * 60 * 60 * 24);
                            const pesoTempoStr = Math.exp(-0.005 * diasDiferenca);

                            jogosValidos.push({
                                ...h,
                                peso_tempo: pesoTempoStr
                            });
                        }
                    }
                }

                if (jogosValidos.length < 20) {
                    console.log(`[${alvo.data_jogo}] Jogo ${alvo.id} ignorado (apenas ${jogosValidos.length} jogos no histórico).`);
                    continue;
                }

                // Otimização Matemática com os dados filtrados em RAM
                const parametros = await otimizarModeloCartoes(jogosValidos, 1500, 0.003, { 
                    referenciaLiga, pesoCartoes: 0.55, pesoFaltasCometidas: 0.30, pesoIntensidade: 0.15, 
                    pesoCartoesProvocados: 0.55, pesoFaltasProvocadas: 0.30, pesoIntensidadeProvocada: 0.15, 
                    regularizacao: 0.02, gradienteMax: 5 
                });

                const casaId = String(alvo.flashscore_id_time_casa);
                const foraId = String(alvo.flashscore_id_time_fora);

                const mle_cartoes_home = projetarExpectativaCartoes(parametros, casaId, foraId, true);
                const mle_cartoes_away = projetarExpectativaCartoes(parametros, foraId, casaId, false);

                // Salva no Banco apenas o resultado
                await client.query(`
                    UPDATE jogos 
                    SET mle_cartoes_casa_indisciplina = $1, mle_cartoes_casa_provocacao = $2,
                        mle_cartoes_fora_indisciplina = $3, mle_cartoes_fora_provocacao = $4,
                        mle_cartoes_home = $5, mle_cartoes_away = $6, mle_cartoes_total = $7
                    WHERE id = $8
                `, [
                    parametros.indisciplina?.[casaId] ?? 0, parametros.provocacao?.[casaId] ?? 0,
                    parametros.indisciplina?.[foraId] ?? 0, parametros.provocacao?.[foraId] ?? 0,
                    mle_cartoes_home, mle_cartoes_away, mle_cartoes_home + mle_cartoes_away, alvo.id
                ]);

                console.log(`[OK] Jogo ${alvo.id} processado! MLE Cartões: ${mle_cartoes_home.toFixed(2)} x ${mle_cartoes_away.toFixed(2)}`);
            }
        }

        console.log('\nSimulação concluída com sucesso!');
    } catch (error) {
        console.error('Erro durante o backtest:', error);
    } finally {
        await client.end();
    }
}


/*
 * ================================================================
 * EXECUTAR
 * ================================================================
 *
 * A DATA/PERÍODO CONTINUA SENDO DEFINIDA AQUI POR VOCÊ.
 *
 * Não existe competição fixa.
 */

rodarBacktest(
    '2025-01-01',
    '2026-09-20'
);