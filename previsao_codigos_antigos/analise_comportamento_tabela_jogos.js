const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

function round3(num) {
    return Math.round(num * 1000) / 1000;
}
function calcularForcaPitagorica(ataque, defesa) {
    if (ataque === null || ataque === undefined || defesa === null || defesa === undefined) return 0;
    
    const atkExp = Math.pow(Math.max(0, ataque), 1.7);
    const defExp = Math.pow(Math.max(0, defesa), 1.7);
    const denominador = atkExp + defExp;
    
    return denominador === 0 ? 0 : atkExp / denominador;
}
function pesoCanonico(idx) {
    const alpha = 0.15;
    return Math.pow(1 - alpha, idx);
}

function calcularMedianaPonderada(itens) {
    if (!itens || itens.length === 0) return 0;
    const validos = itens.filter(i => Number.isFinite(i.valor) && i.peso > 0)
        .sort((a, b) => a.valor - b.valor);
    if (validos.length === 0) return 0;
    const pesoTotal = validos.reduce((acc, item) => acc + item.peso, 0);
    let pesoAcumulado = 0;
    for (const item of validos) {
        pesoAcumulado += item.peso;
        if (pesoAcumulado >= pesoTotal / 2) {
            return round3(item.valor);
        }
    }
    return round3(validos[validos.length - 1].valor);
}

function calcularMediaPonderadaEstatistica(itens) {
    if (!itens || itens.length === 0) return 0;
    let somaPesada = 0;
    let somaPesos = 0;
    for (const item of itens) {
        if (Number.isFinite(item.valor) && item.peso > 0) {
            somaPesada += item.valor * item.peso;
            somaPesos += item.peso;
        }
    }
    return somaPesos > 0 ? round3(somaPesada / somaPesos) : 0;
}

function ehGol(evento) {
    const tipo = (evento.tipo_evento || '').toString().toLowerCase().trim();
    const desc = (evento.descricao_evento || '').toString().toLowerCase().trim();
    if (
        desc.includes('anulado') ||
        desc.includes('cancelado') ||
        desc.includes('pênalti perdido') ||
        desc.includes('penalti perdido') ||
        desc.includes('pênalti defendido') ||
        desc.includes('penalti defendido') ||
        desc.includes('na trave')
    ) {
        return false;
    }
    if (tipo === 'gol') return true;
    if (tipo === 'desconhecido' && (desc.includes('pênalti') || desc.includes('penalti') || desc.includes('gol contra'))) {
        return true;
    }
    return false;
}
function compilarLinhasNetRating(historicoEstats, timeInfo, forcaAdv, dataJogo, idCompeticao) {
    if (!historicoEstats || historicoEstats.length === 0) return [];

    const linhas = [];
    const periodos = [
        { nome: 'GE', chave: null },
        { nome: '1T', chave: '1_tempo' },
        { nome: '2T', chave: '2_tempo' }
    ];

    const tiposAnalise = [
        { tipo: 'ATAQUE_DEFESA_TIME', chaveDado: 'time' },
        { tipo: 'ATAQUE_DEFESA_CONTRA', chaveDado: 'contra' }
    ];

    const jogosUsados = historicoEstats.map(h => h.flashscore_id_jogo).filter(Boolean);

    for (const periodoConfig of periodos) {
        for (const itemTipo of tiposAnalise) {
            const linha = {
                id_time: timeInfo.id,
                flashscore_id_time: timeInfo.flashscore_id,
                nome_time: timeInfo.nome,
                casa_fora: timeInfo.casa_fora,
                data_jogo: dataJogo,
                id_competicao: idCompeticao,
                tipo_analise: itemTipo.tipo,
                grid_forca_adv: forcaAdv,
                periodo: periodoConfig.nome,
                jogos_analisados: historicoEstats.length,
                jogos_usados: jogosUsados,
                gol_marc_0_15: 0, gol_marc_16_30: 0, gol_marc_31_45: 0,
                gol_marc_46_60: 0, gol_marc_61_75: 0, gol_marc_76_90: 0,
                sem_gol: 0, vitorias: 0, empates: 0, derrotas: 0,
                gols_marcados: 0, gols_sofridos: 0,
                sequencia_gols: null, rating_ataque: null, rating_defesa: null,
                gol_sofr_0_15: 0, gol_sofr_16_30: 0, gol_sofr_31_45: 0,
                gol_sofr_46_60: 0, gol_sofr_61_75: 0, gol_sofr_76_90: 0
            };

            const estatisticasParaEwma = {};
            metricasAlvo.forEach(metrica => { estatisticasParaEwma[metrica] = []; });

            historicoEstats.forEach((histItem, idx) => {
                const peso = pesoCanonico(idx);
                let dadosLinha;

                if (periodoConfig.nome === 'GE') {
                    dadosLinha = histItem[itemTipo.chaveDado];
                } else {
                    const grupoPeriodo = itemTipo.chaveDado === 'time' ? histItem.periodos_time : histItem.periodos_contra;
                    if (grupoPeriodo) dadosLinha = grupoPeriodo[periodoConfig.chave];
                }

                if (dadosLinha) {
                    metricasAlvo.forEach(metrica => {
                        const valor = dadosLinha[metrica];
                        if (valor !== null && valor !== undefined && Number.isFinite(Number(valor))) {
                            estatisticasParaEwma[metrica].push({ valor: Number(valor), peso: peso });
                        }
                    });
                }

                let golsMarcadosPeriodo = [];
                let golsSofridosPeriodo = [];

                if (periodoConfig.nome === 'GE') {
                    if (itemTipo.chaveDado === 'time') {
                        golsMarcadosPeriodo = Array.isArray(histItem.gols_time) ? histItem.gols_time : [];
                        golsSofridosPeriodo = Array.isArray(histItem.gols_contra) ? histItem.gols_contra : [];
                    } else {
                        golsMarcadosPeriodo = Array.isArray(histItem.gols_contra) ? histItem.gols_contra : [];
                        golsSofridosPeriodo = Array.isArray(histItem.gols_time) ? histItem.gols_time : [];
                    }
                } else if (periodoConfig.nome === '1T') {
                    if (itemTipo.chaveDado === 'time') {
                        golsMarcadosPeriodo = Array.isArray(histItem.gols_time_1T) ? histItem.gols_time_1T : [];
                        golsSofridosPeriodo = Array.isArray(histItem.gols_contra_1T) ? histItem.gols_contra_1T : [];
                    } else {
                        golsMarcadosPeriodo = Array.isArray(histItem.gols_contra_1T) ? histItem.gols_contra_1T : [];
                        golsSofridosPeriodo = Array.isArray(histItem.gols_time_1T) ? histItem.gols_time_1T : [];
                    }
                } else if (periodoConfig.nome === '2T') {
                    if (itemTipo.chaveDado === 'time') {
                        golsMarcadosPeriodo = Array.isArray(histItem.gols_time_2T) ? histItem.gols_time_2T : [];
                        golsSofridosPeriodo = Array.isArray(histItem.gols_contra_2T) ? histItem.gols_contra_2T : [];
                    } else {
                        golsMarcadosPeriodo = Array.isArray(histItem.gols_contra_2T) ? histItem.gols_contra_2T : [];
                        golsSofridosPeriodo = Array.isArray(histItem.gols_time_2T) ? histItem.gols_time_2T : [];
                    }
                }

                linha.gols_marcados += golsMarcadosPeriodo.length;
                linha.gols_sofridos += golsSofridosPeriodo.length;

                if (golsMarcadosPeriodo.length === 0) linha.sem_gol += 1;

                if (golsMarcadosPeriodo.length > golsSofridosPeriodo.length) {
                    linha.vitorias += 1;
                } else if (golsMarcadosPeriodo.length === golsSofridosPeriodo.length) {
                    linha.empates += 1;
                } else {
                    linha.derrotas += 1;
                }

                golsMarcadosPeriodo.forEach(gol => {
                    const colunaMinuto = classificarMinutoGol(gol.minuto);
                    if (linha[colunaMinuto] !== undefined) linha[colunaMinuto] += 1;
                });

                golsSofridosPeriodo.forEach(gol => {
                    const minuto = Number(gol.minuto);
                    if (!Number.isFinite(minuto)) return;

                    let colunaMinuto;
                    if (minuto <= 15) colunaMinuto = 'gol_sofr_0_15';
                    else if (minuto <= 30) colunaMinuto = 'gol_sofr_16_30';
                    else if (minuto <= 45) colunaMinuto = 'gol_sofr_31_45';
                    else if (minuto <= 60) colunaMinuto = 'gol_sofr_46_60';
                    else if (minuto <= 75) colunaMinuto = 'gol_sofr_61_75';
                    else colunaMinuto = 'gol_sofr_76_90';

                    linha[colunaMinuto] += 1;
                });
            });

            metricasAlvo.forEach(metrica => {
                const itens = estatisticasParaEwma[metrica];
                if (itens.length >= 5) {
                    linha[`${metrica}_media_wma`] = calcularMediaPonderadaEstatistica(itens);
                    linha[`${metrica}_mediana_wma`] = calcularMedianaPonderada(itens);
                } else {
                    linha[`${metrica}_media_wma`] = 0;
                    linha[`${metrica}_mediana_wma`] = 0;
                }
            });

            linhas.push(linha);
        }
    }

    return linhas;
}

function classificarForcaUnificada(valorForca, limiteFraco, limiteForte) {
    const valor = Number(valorForca);
    const fraco = Number(limiteFraco);
    const forte = Number(limiteForte);
    if (isNaN(valor) || isNaN(fraco) || isNaN(forte)) return 'INDEFINIDO';
    if (valor <= fraco) return 'FRACO';
    if (valor <= forte) return 'MEDIO';
    return 'FORTE';
}

async function buscarJogosPorData(dataJogo) {
    try {
        const query = `SELECT * FROM jogos WHERE data_jogo = $1`;
        const res = await client.query(query, [dataJogo]);
        return res.rows;
    } catch (err) {
        console.error('[ERRO DB] Falha ao buscar jogos no banco:', err);
        return [];
    }
}

function inicializarEstruturaJogo(jogo) {
    return {
        info_jogo: {
            id: jogo.id,
            flashscore_id: jogo.flashscore_id,
            data: jogo.data_jogo,
            hora: jogo.hora_jogo,
            campeonato: jogo.nome_competicao,
            id_competicao: jogo.id_competicao
        },
        timeCasa: {
            id: jogo.id_time_casa,
            flashscore_id: jogo.flashscore_id_time_casa,
            nome: jogo.nome_time_casa,
            dados: [],
            stats_ewma: {},
            forca: {},
            historico_jogos_semelhantes: [],
            historico_estatisticas: []
        },
        timeFora: {
            id: jogo.id_time_fora,
            flashscore_id: jogo.flashscore_id_time_fora,
            nome: jogo.nome_time_fora,
            dados: [],
            stats_ewma: {},
            forca: {},
            historico_jogos_semelhantes: [],
            historico_estatisticas: []
        }
    };
}

async function definirForcaTimes(baseDeDadosEmMemoria) {
    console.log(`\n[DEBUG SISTEMA] Iniciando definição de força para ${baseDeDadosEmMemoria.length} jogo(s)...`);

    for (const jogo of baseDeDadosEmMemoria) {
        const idComp = jogo.info_jogo.id_competicao;
        const flashCasa = jogo.timeCasa.flashscore_id;
        const flashFora = jogo.timeFora.flashscore_id;
        const dataJogo = jogo.info_jogo.data;
        const idJogo = jogo.info_jogo.flashscore_id;

        console.log(`\n====================================================================`);
        console.log(`[DEBUG FORÇA] Jogo: ${jogo.timeCasa.nome} x ${jogo.timeFora.nome}`);
        console.log(`ID Jogo: ${idJogo} | Data Jogo: ${dataJogo} | ID Competição: ${idComp}`);
        console.log(`Flashscore ID Casa: ${flashCasa} | Flashscore ID Fora: ${flashFora}`);
        console.log(`--------------------------------------------------------------------`);

        try {
            // 1. Buscando limites da competição
            const queryComp = `
                SELECT casa_forca_limite_fraco, casa_forca_limite_forte,
                       fora_forca_limite_fraco, fora_forca_limite_forte
                FROM competicoes
                WHERE id = $1
            `;
            const resComp = await client.query(queryComp, [idComp]);
            const limites = resComp.rows[0];

            if (!limites) {
                console.log(`❌ ERRO: Limites NÃO ENCONTRADOS na tabela 'competicoes' para ID = ${idComp}`);
            } else {
                console.log(`✅ LIMITES COMP: Casa (Fraco: ${limites.casa_forca_limite_fraco}, Forte: ${limites.casa_forca_limite_forte})`);
                console.log(`✅ LIMITES COMP: Fora (Fraco: ${limites.fora_forca_limite_fraco}, Forte: ${limites.fora_forca_limite_forte})`);
            }

            // 2. Buscando Rating do Time da CASA
            const queryRatingCasa = `
                SELECT casa_rating_ataque, casa_rating_defesa, data_referencia
                FROM rating_times_historico
                WHERE flashscore_id_time = $1
                  AND data_referencia <= $2
                ORDER BY data_referencia DESC
                LIMIT 1
            `;
            const resCasa = await client.query(queryRatingCasa, [flashCasa, dataJogo]);
            const ratingCasa = resCasa.rows[0];

            if (!ratingCasa) {
                console.log(`❌ ERRO: RATING CASA NÃO ENCONTRADO! Nenhuma linha p/ ID = ${flashCasa} anterior a ${dataJogo}`);
            } else {
                const dataRefFormatada = String(ratingCasa.data_referencia).substring(0, 10);
                console.log(`✅ RATING CASA ENCONTRADO (Data Ref: ${dataRefFormatada}): Ataque = ${ratingCasa.casa_rating_ataque} | Defesa = ${ratingCasa.casa_rating_defesa}`);
            }

            // 3. Buscando Rating do Time de FORA
            const queryRatingFora = `
                SELECT fora_rating_ataque, fora_rating_defesa, data_referencia
                FROM rating_times_historico
                WHERE flashscore_id_time = $1
                  AND data_referencia < $2
                ORDER BY data_referencia DESC
                LIMIT 1
            `;
            const resFora = await client.query(queryRatingFora, [flashFora, dataJogo]);
            const ratingFora = resFora.rows[0];

            if (!ratingFora) {
                console.log(`❌ ERRO: RATING FORA NÃO ENCONTRADO! Nenhuma linha p/ ID = ${flashFora} anterior a ${dataJogo}`);
            } else {
                const dataRefFormatada = String(ratingFora.data_referencia).substring(0, 10);
                console.log(`✅ RATING FORA ENCONTRADO (Data Ref: ${dataRefFormatada}): Ataque = ${ratingFora.fora_rating_ataque} | Defesa = ${ratingFora.fora_rating_defesa}`);
            }

            console.log(`--------------------------------------------------------------------`);

            // 4. Processamento Matemático: CASA
            if (
                ratingCasa &&
                limites &&
                ratingCasa.casa_rating_ataque !== null &&
                ratingCasa.casa_rating_defesa !== null
            ) {
                const forcaCasa = calcularForcaPitagorica(ratingCasa.casa_rating_ataque, ratingCasa.casa_rating_defesa);
                const classeCasa = classificarForcaUnificada(
                    forcaCasa,
                    limites.casa_forca_limite_fraco,
                    limites.casa_forca_limite_forte
                );

                console.log(`🧮 CÁLCULO CASA: Força Pitagórica = ${forcaCasa.toFixed(4)} => Classificado como [${classeCasa}]`);

                jogo.timeCasa.forca = {
                    forca: classeCasa,
                    net_rating: forcaCasa, // A chave foi mantida como 'net_rating' para não quebrar seu front/banco, mas armazena a Força Pitagórica (0 a 1)
                    rating_ataque_bruto: Number(ratingCasa.casa_rating_ataque),
                    rating_defesa_bruto: Number(ratingCasa.casa_rating_defesa),
                    ataque: classeCasa,
                    defesa: classeCasa
                };
            } else {
                console.log(`⚠️ AVISO: Não foi possível calcular a força da CASA devido aos erros acima.`);
                jogo.timeCasa.forca = { erro: 'Limites ou Ratings da Casa não encontrados' };
            }

            // 5. Processamento Matemático: FORA
            if (
                ratingFora &&
                limites &&
                ratingFora.fora_rating_ataque !== null &&
                ratingFora.fora_rating_defesa !== null
            ) {
                const forcaFora = calcularForcaPitagorica(ratingFora.fora_rating_ataque, ratingFora.fora_rating_defesa);
                const classeFora = classificarForcaUnificada(
                    forcaFora,
                    limites.fora_forca_limite_fraco,
                    limites.fora_forca_limite_forte
                );

                console.log(`🧮 CÁLCULO FORA: Força Pitagórica = ${forcaFora.toFixed(4)} => Classificado como [${classeFora}]`);

                jogo.timeFora.forca = {
                    forca: classeFora,
                    net_rating: forcaFora, // A chave foi mantida como 'net_rating' para compatibilidade
                    rating_ataque_bruto: Number(ratingFora.fora_rating_ataque),
                    rating_defesa_bruto: Number(ratingFora.fora_rating_defesa),
                    ataque: classeFora,
                    defesa: classeFora
                };
            } else {
                console.log(`⚠️ AVISO: Não foi possível calcular a força de FORA devido aos erros acima.`);
                jogo.timeFora.forca = { erro: 'Limites ou Ratings de Fora não encontrados' };
            }

            console.log(`====================================================================\n`);

        } catch (error) {
            console.error(`[ERRO FATAL DB] Falha ao definir força para o jogo ${idJogo}:`, error.message);
        }
    }

    console.log('[DEBUG] Definição de forças concluída!');
    return baseDeDadosEmMemoria;
}

async function buscarJogosReferencia(baseDeDadosEmMemoria) {
    console.log(`\n[DEBUG SISTEMA] Buscando histórico de referência por TAG de força para ${baseDeDadosEmMemoria.length} jogo(s)...`);

    const MIN_JOGOS = 6;
    const MAX_JOGOS = 10;

    for (const jogo of baseDeDadosEmMemoria) {
        const idJogoAtual = jogo.info_jogo.flashscore_id;
        const dataJogoAtual = jogo.info_jogo.data;
        const idCompeticaoAtual = jogo.info_jogo.id_competicao;
        const idCasa = jogo.timeCasa.flashscore_id;
        const idFora = jogo.timeFora.flashscore_id;

        if (jogo.timeCasa.forca.erro || jogo.timeFora.forca.erro) continue;

        const tagCasaAtual = String(jogo.timeCasa.forca.forca || '').trim().toUpperCase();
        const tagForaAtual = String(jogo.timeFora.forca.forca || '').trim().toUpperCase();

        if (!['FRACO', 'MEDIO', 'FORTE'].includes(tagCasaAtual) || !['FRACO', 'MEDIO', 'FORTE'].includes(tagForaAtual)) {
            jogo.historico_insuficiente = true;
            continue;
        }

        try {
            let idCompeticaoReferenciaCasa = idCompeticaoAtual;
            let idCompeticaoReferenciaFora = idCompeticaoAtual;

            const queryCheck = `SELECT 1 FROM classificacao_geral_2026 WHERE id_competicao = $1 LIMIT 1`;
            const resCheck = await client.query(queryCheck, [idCompeticaoAtual]);
            const isCopa = resCheck.rows.length === 0;

            if (isCopa) {
                const queryTimes = `SELECT flashscore_id, pais, competicao_disputada FROM times WHERE flashscore_id IN ($1, $2)`;
                const resTimes = await client.query(queryTimes, [idCasa, idFora]);

                let dadosCasa = null, dadosFora = null;
                for (const row of resTimes.rows) {
                    if (row.flashscore_id === idCasa) dadosCasa = row;
                    if (row.flashscore_id === idFora) dadosFora = row;
                }

                function extrairCompeticoes(valor) {
                    let competicoes = valor;
                    if (typeof competicoes === 'string') {
                        try { competicoes = JSON.parse(competicoes); } catch { competicoes = []; }
                    }
                    if (!Array.isArray(competicoes)) return [];
                    return [...new Set(competicoes.map(Number).filter(id => Number.isInteger(id) && id > 0))];
                }

                const competicoesCasa = dadosCasa ? extrairCompeticoes(dadosCasa.competicao_disputada) : [];
                const competicoesFora = dadosFora ? extrairCompeticoes(dadosFora.competicao_disputada) : [];

                const paisCasa = dadosCasa?.pais;
                const paisFora = dadosFora?.pais;
                const mesmosPaises = paisCasa && paisFora && String(paisCasa).trim().toLowerCase() === String(paisFora).trim().toLowerCase();

                if (mesmosPaises) {
                    const idsCompeticoesDisputadas = [...new Set([...competicoesCasa, ...competicoesFora])];
                    if (idsCompeticoesDisputadas.length > 0) {
                        const menorId = Math.min(...idsCompeticoesDisputadas);
                        idCompeticaoReferenciaCasa = menorId;
                        idCompeticaoReferenciaFora = menorId;
                    }
                } else {
                    if (competicoesCasa.length > 0) idCompeticaoReferenciaCasa = Math.min(...competicoesCasa);
                    if (competicoesFora.length > 0) idCompeticaoReferenciaFora = Math.min(...competicoesFora);
                }
            }

            /*
             * ============================================================
             * QUERY CASA
             * ============================================================
             * Botafogo (Casa) contra times que possuem a mesma tag de Força do adversário atual (Fora).
             * Utilizamos a coluna nativa `fora_classe_forca`.
             */
            const queryHistoricoCasa = `
                SELECT
                    j.flashscore_id,
                    j.flashscore_id_time_casa,
                    j.flashscore_id_time_fora,
                    j.data_jogo,
                    j.hora_jogo,
                    j.id_competicao
                FROM jogos j
                WHERE j.flashscore_id_time_casa = $1
                  AND j.id_competicao = $5
                  AND j.data_jogo < $3
                  AND j.flashscore_id != $4
                  AND j.fora_classe_forca = $2
                ORDER BY j.data_jogo DESC, j.hora_jogo DESC
                LIMIT ${MAX_JOGOS}
            `;

            const resCasa = await client.query(
                queryHistoricoCasa,
                [idCasa, tagForaAtual, dataJogoAtual, idJogoAtual, idCompeticaoReferenciaCasa]
            );

            /*
             * ============================================================
             * QUERY FORA
             * ============================================================
             * Palmeiras (Fora) contra times que possuem a mesma tag de Força do adversário atual (Casa).
             * Utilizamos a coluna nativa `casa_classe_forca`.
             */
            const queryHistoricoFora = `
                SELECT
                    j.flashscore_id,
                    j.flashscore_id_time_casa,
                    j.flashscore_id_time_fora,
                    j.data_jogo,
                    j.hora_jogo,
                    j.id_competicao
                FROM jogos j
                WHERE j.flashscore_id_time_fora = $1
                  AND j.id_competicao = $5
                  AND j.data_jogo < $3
                  AND j.flashscore_id != $4
                  AND j.casa_classe_forca = $2
                ORDER BY j.data_jogo DESC, j.hora_jogo DESC
                LIMIT ${MAX_JOGOS}
            `;

            const resFora = await client.query(
                queryHistoricoFora,
                [idFora, tagCasaAtual, dataJogoAtual, idJogoAtual, idCompeticaoReferenciaFora]
            );

            const historicoCasa = resCasa.rows.length >= MIN_JOGOS ? resCasa.rows : [];
            const historicoFora = resFora.rows.length >= MIN_JOGOS ? resFora.rows : [];

            jogo.timeCasa.historico_jogos_semelhantes = historicoCasa;
            jogo.timeFora.historico_jogos_semelhantes = historicoFora;

            console.log(
                `[DEBUG TAG] ${jogo.timeCasa.nome} x ${jogo.timeFora.nome} | ` +
                `Casa atual=${tagCasaAtual} → histórico do ${jogo.timeFora.nome} contra ${tagCasaAtual}: ${historicoFora.length} | ` +
                `Fora atual=${tagForaAtual} → histórico do ${jogo.timeCasa.nome} contra ${tagForaAtual}: ${historicoCasa.length}`
            );

            if (historicoCasa.length < MIN_JOGOS || historicoFora.length < MIN_JOGOS) {
                jogo.historico_insuficiente = true;
                continue;
            }

            jogo.historico_insuficiente = false;

            async function auditarIdsHistorico(historico, nomeTime, ehCasaAnalisado) {
                console.log(`📂 Analisando ${historico.length} jogos encontrados para o time: ${nomeTime}`);

                const historicoEstatisticas = [];
                const ehCasa = ehCasaAnalisado ? 1 : 0;
                const ehCasaContra = ehCasa === 1 ? 0 : 1;

                for (const h of historico) {
                    const idJogoHist = h.flashscore_id;

                    const resultGeral = await client.query(
                        `SELECT * FROM estatisticas_geral WHERE flashscore_id_jogo = $1`,
                        [idJogoHist]
                    );

                    if (resultGeral.rows.length < 2) continue;

                    const linhaTime = resultGeral.rows.find(row => Number(row.eh_casa) === ehCasa);
                    const linhaAdversario = resultGeral.rows.find(row => Number(row.eh_casa) === ehCasaContra);

                    if (!linhaTime || !linhaAdversario) continue;

                    const resultPeriodos = await client.query(
                        `SELECT * FROM estatisticas_por_periodo WHERE flashscore_id_jogo = $1 AND periodo IN ('1_tempo', '2_tempo')`,
                        [idJogoHist]
                    );

                    const periodosTime = { '1_tempo': null, '2_tempo': null };
                    const periodosContra = { '1_tempo': null, '2_tempo': null };

                    for (const periodo of ['1_tempo', '2_tempo']) {
                        const linhasPeriodo = resultPeriodos.rows.filter(row => row.periodo === periodo);
                        const linhaTimePeriodo = linhasPeriodo.find(row => Number(row.eh_casa) === ehCasa);
                        const linhaAdversarioPeriodo = linhasPeriodo.find(row => Number(row.eh_casa) === ehCasaContra);

                        if (linhaTimePeriodo) periodosTime[periodo] = linhaTimePeriodo;
                        if (linhaAdversarioPeriodo) periodosContra[periodo] = linhaAdversarioPeriodo;
                    }

                    historicoEstatisticas.push({
                        flashscore_id_jogo: idJogoHist,
                        time: linhaTime,
                        contra: linhaAdversario,
                        periodos_time: periodosTime,
                        periodos_contra: periodosContra
                    });
                }
                return historicoEstatisticas;
            }

            jogo.timeCasa.historico_estatisticas = await auditarIdsHistorico(jogo.timeCasa.historico_jogos_semelhantes, jogo.timeCasa.nome, true);
            jogo.timeFora.historico_estatisticas = await auditarIdsHistorico(jogo.timeFora.historico_jogos_semelhantes, jogo.timeFora.nome, false);

            if (jogo.timeCasa.historico_estatisticas.length < MIN_JOGOS || jogo.timeFora.historico_estatisticas.length < MIN_JOGOS) {
                jogo.historico_insuficiente = true;
            } else {
                jogo.historico_insuficiente = false;
            }

        } catch (error) {
            console.error(`[ERRO FATAL DB] Falha ao buscar histórico para o jogo ${idJogoAtual}:`, error.message);
        }
    }

    return baseDeDadosEmMemoria;
}

async function buscarEventosGolsHistorico(timeCasa, timeFora) {
    const idsJogos = new Set();

    if (Array.isArray(timeCasa?.historico_estatisticas)) {
        for (const hist of timeCasa.historico_estatisticas) {
            if (hist.flashscore_id_jogo) idsJogos.add(hist.flashscore_id_jogo);
        }
    }

    if (Array.isArray(timeFora?.historico_estatisticas)) {
        for (const hist of timeFora.historico_estatisticas) {
            if (hist.flashscore_id_jogo) idsJogos.add(hist.flashscore_id_jogo);
        }
    }

    if (idsJogos.size === 0) return new Map();

    const ids = Array.from(idsJogos);

    const result = await client.query(`
        SELECT e.flashscore_id_jogo, e.time, e.minuto, e.tipo_evento, e.descricao_evento
        FROM eventos_jogo e
        WHERE e.flashscore_id_jogo = ANY($1)
          AND (LOWER(e.tipo_evento) LIKE '%gol%' OR LOWER(e.tipo_evento) = 'goal' OR LOWER(e.tipo_evento) = 'desconhecido')
        ORDER BY e.flashscore_id_jogo, e.minuto
    `, [ids]);

    const golsPorJogo = new Map();

    for (const row of result.rows) {
        const evento = {
            flashscore_id_jogo: row.flashscore_id_jogo,
            id_time: row.time,
            minuto: row.minuto,
            tipo_evento: row.tipo_evento,
            descricao_evento: row.descricao_evento
        };

        if (!ehGol(evento)) continue;

        if (!golsPorJogo.has(row.flashscore_id_jogo)) {
            golsPorJogo.set(row.flashscore_id_jogo, []);
        }

        golsPorJogo.get(row.flashscore_id_jogo).push({
            time: String(row.time).trim().toLowerCase(),
            minuto: Number(row.minuto)
        });
    }

    return golsPorJogo;
}

function distribuirGolsTime(timeObj, golsPorJogo) {
    if (!timeObj || !Array.isArray(timeObj.historico_estatisticas)) return;

    const ladoTime = timeObj.casa_fora === 'C' ? 'casa' : 'fora';

    for (const hist of timeObj.historico_estatisticas) {
        const idJogo = hist.flashscore_id_jogo;

        hist.gols_time = [];
        hist.gols_contra = [];
        hist.gols_time_1T = [];
        hist.gols_time_2T = [];
        hist.gols_contra_1T = [];
        hist.gols_contra_2T = [];

        const golsJogo = golsPorJogo.get(idJogo);
        if (!golsJogo) continue;

        for (const evento of golsJogo) {
            const minuto = Number(evento.minuto);
            if (!Number.isFinite(minuto)) continue;

            const golDoTime = evento.time === ladoTime;

            const gol = {
                minuto: minuto,
                tipo: golDoTime ? 'TIME' : 'CONTRA'
            };

            if (golDoTime) {
                hist.gols_time.push(gol);

                if (minuto <= 45) {
                    hist.gols_time_1T.push(gol);
                } else {
                    hist.gols_time_2T.push(gol);
                }
            } else {
                hist.gols_contra.push(gol);

                if (minuto <= 45) {
                    hist.gols_contra_1T.push(gol);
                } else {
                    hist.gols_contra_2T.push(gol);
                }
            }
        }
    }
}

const metricasAlvo = [
    'gols_marcados', 'gols_sofridos', 'posse_bola', 'xg', 'xga', 'xgot', 'xa', 'chances_clara', 'bolas_na_trave', 'xg_contra',
    'finalizacoes', 'finalizacoes_no_gol', 'finalizacoes_para_fora',
    'finalizacoes_bloqueadas', 'finalizacoes_de_dentro_area', 'finalizacoes_de_fora_area',
    'toques_area_adversaria', 'passes_porcentagem', 'passes_certos', 'passes_total',
    'passes_profundidade_certos', 'passes_longos_porcentagem', 'passes_longos_certos', 'passes_longos_total',
    'passes_terco_final_porcentagem', 'passes_terco_final_certos', 'passes_terco_final_total', 'cruzamentos_porcentagem',
    'cruzamentos_certos', 'cruzamentos_total',
    'interceptacoes', 'rebatidas', 'desarmes_porcentagem', 'desarmes_certos',
    'desarmes_total', 'duelos_ganhos', 'defesas_goleiro', 'gols_evitados',
    'erros_resultaram_finalizacao', 'erros_resultaram_gol',
    'faltas', 'escanteios', 'impedimentos', 'cartoes_amarelos',
    'cartao_vermelho', 'indice_intensidade'
];


function classificarMinutoGol(minuto) {
    const m = Number(minuto);
    if (m <= 15) return 'gol_marc_0_15';
    if (m <= 30) return 'gol_marc_16_30';
    if (m <= 45) return 'gol_marc_31_45';
    if (m <= 60) return 'gol_marc_46_60';
    if (m <= 75) return 'gol_marc_61_75';
    return 'gol_marc_76_90';
}

function formatarPeriodo(p) {
    if (p === 'GE') return null;
    if (p === '1T') return '1_tempo';
    if (p === '2T') return '2_tempo';
    return p;
}

async function salvarAnaliseNoBanco(linhasAnalise, idTime, dataJogo) {
    if (!linhasAnalise || linhasAnalise.length === 0) return;
    await client.query('BEGIN');
    try {
        const deleteQuery = `
            DELETE FROM analise_comportamento_times
            WHERE flashscore_id_time = $1
              AND data_jogo = $2
        `;
        await client.query(deleteQuery, [idTime, dataJogo]);

        const colunas = Object.keys(linhasAnalise[0]);
        const colunasSql = colunas.join(', ');

        let valoresParametros = [];
        let valoresPlanos = [];
        let contadorParam = 1;

        for (const linha of linhasAnalise) {
            let placeholders = [];
            for (const coluna of colunas) {
                placeholders.push(`$${contadorParam}`);
                valoresPlanos.push(linha[coluna]);
                contadorParam++;
            }
            valoresParametros.push(`(${placeholders.join(', ')})`);
        }

        const insertQuery = `
            INSERT INTO analise_comportamento_times
            (${colunasSql}) 
            VALUES ${valoresParametros.join(', ')}
        `;
        await client.query(insertQuery, valoresPlanos);
        await client.query('COMMIT');
        console.log(`[DB] Salvo com sucesso! Inseridas ${linhasAnalise.length} linhas para o time ${linhasAnalise[0].nome_time}.`);
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[ERRO DB] Falha ao salvar no banco para o time ${idTime}. Alterações revertidas. Erro:`, err.message);
    }
}

async function main(dataAlvo) {
    console.log(`\n--- INICIANDO PROCESSAMENTO: ${dataAlvo} ---`);
    let baseDeDadosEmMemoria = [];
    try {
        await client.connect();
        const jogos = await buscarJogosPorData(dataAlvo);
        if (jogos.length > 0) {
            for (const jogo of jogos) {
                let estrutura = inicializarEstruturaJogo(jogo);
                estrutura.timeCasa.casa_fora = 'C';
                estrutura.timeFora.casa_fora = 'F';
                baseDeDadosEmMemoria.push(estrutura);
            }
            baseDeDadosEmMemoria = await definirForcaTimes(baseDeDadosEmMemoria);
            baseDeDadosEmMemoria = await buscarJogosReferencia(baseDeDadosEmMemoria);
            function temMinimoXgValido(historico) {
                if (!Array.isArray(historico)) return false;
                let count = 0;
                for (const hist of historico) {
                    const dadosTime = hist?.time;
                    if (dadosTime && dadosTime.xg !== null && dadosTime.xg !== undefined && Number.isFinite(Number(dadosTime.xg))) {
                        count++;
                    }
                }
                return count >= 5;
            }
            console.log(`\n[SISTEMA] Iniciando compilação matemática (EWMA) e inserção no banco...`);
            for (const jogo of baseDeDadosEmMemoria) {
                if (jogo.timeCasa.forca.erro || jogo.timeFora.forca.erro || jogo.historico_insuficiente) {
                    continue;
                }
                const golsPorJogo = await buscarEventosGolsHistorico(jogo.timeCasa, jogo.timeFora);
                distribuirGolsTime(jogo.timeCasa, golsPorJogo);
                distribuirGolsTime(jogo.timeFora, golsPorJogo);
                const casaXgOk = temMinimoXgValido(jogo.timeCasa.historico_estatisticas);
                const foraXgOk = temMinimoXgValido(jogo.timeFora.historico_estatisticas);
                if (!casaXgOk || !foraXgOk) {
                    console.log(`⚠️ XG insuficiente para ${jogo.info_jogo.flashscore_id}. Pulando.`);
                    continue;
                }
                const linhasCasa = compilarLinhasNetRating(jogo.timeCasa.historico_estatisticas, jogo.timeCasa, jogo.timeFora.forca.forca, dataAlvo, jogo.info_jogo.id_competicao);
                const todasLinhasCasa = [...linhasCasa];
                const linhasFora = compilarLinhasNetRating(jogo.timeFora.historico_estatisticas, jogo.timeFora, jogo.timeCasa.forca.forca, dataAlvo, jogo.info_jogo.id_competicao);
                const todasLinhasFora = [...linhasFora];
                if (todasLinhasCasa.length > 0) {
                    await salvarAnaliseNoBanco(todasLinhasCasa, jogo.timeCasa.flashscore_id, dataAlvo);
                }
                if (todasLinhasFora.length > 0) {
                    await salvarAnaliseNoBanco(todasLinhasFora, jogo.timeFora.flashscore_id, dataAlvo);
                }
            }
            console.log(`\n🎉 PROCESSO CONCLUÍDO COM SUCESSO PARA A DATA: ${dataAlvo}`);
        } else {
            console.log(`[AVISO] Nenhum jogo encontrado para a data ${dataAlvo}.`);
        }
    } catch (err) {
        console.error('[ERRO FATAL]', err);
    } finally {
        await client.end();
    }
}

const dataEscolhida = process.argv[2];

if (!dataEscolhida) {
    console.error('Data não informada. Exemplo: node analise_comportamento_tabela_jogos.js 2026-09-02');
    process.exit(1);
}

main(dataEscolhida);