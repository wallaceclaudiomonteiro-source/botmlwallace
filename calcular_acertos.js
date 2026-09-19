const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

const LIMIAR_PROBABILIDADE = 50.0;

const mercados = [
    { prob: 'p_home', res: 'res_home', check: (golsC, golsF) => golsC > golsF },
    { prob: 'p_draw', res: 'res_draw', check: (golsC, golsF) => golsC === golsF },
    { prob: 'p_away', res: 'res_away', check: (golsC, golsF) => golsC < golsF },
    { prob: 'p_over15', res: 'res_over15', check: (gols) => gols > 1.5 },
    { prob: 'p_under15', res: 'res_under15', check: (gols) => gols < 1.5 },
    { prob: 'p_over25', res: 'res_over25', check: (gols) => gols > 2.5 },
    { prob: 'p_under25', res: 'res_under25', check: (gols) => gols < 2.5 },
    { prob: 'p_over35', res: 'res_over35', check: (gols) => gols > 3.5 },
    { prob: 'p_under35', res: 'res_under35', check: (gols) => gols < 3.5 },
    { prob: 'p_btts_yes', res: 'res_btts_yes', check: (golsC, golsF) => golsC > 0 && golsF > 0 },
    { prob: 'p_btts_no', res: 'res_btts_no', check: (golsC, golsF) => golsC === 0 || golsF === 0 },

    { prob: 'p_casa_over05', res: 'res_casa_over05', check: (golsC) => golsC > 0.5 },
    { prob: 'p_casa_over15', res: 'res_casa_over15', check: (golsC) => golsC > 1.5 },
    { prob: 'p_fora_over05', res: 'res_fora_over05', check: (golsF) => golsF > 0.5 },
    { prob: 'p_fora_over15', res: 'res_fora_over15', check: (golsF) => golsF > 1.5 },

    { prob: 'p_cantos_over75', res: 'res_cantos_over75', check: (cantos) => cantos > 7.5 },
    { prob: 'p_cantos_under75', res: 'res_cantos_under75', check: (cantos) => cantos < 7.5 },
    { prob: 'p_cantos_over85', res: 'res_cantos_over85', check: (cantos) => cantos > 8.5 },
    { prob: 'p_cantos_under85', res: 'res_cantos_under85', check: (cantos) => cantos < 8.5 },
    { prob: 'p_cantos_over95', res: 'res_cantos_over95', check: (cantos) => cantos > 9.5 },
    { prob: 'p_cantos_under95', res: 'res_cantos_under95', check: (cantos) => cantos < 9.5 },

    { prob: 'p_casa_cantos_over35', res: 'res_casa_cantos_over35', check: (cantosC) => cantosC > 3.5 },
    { prob: 'p_casa_cantos_over45', res: 'res_casa_cantos_over45', check: (cantosC) => cantosC > 4.5 },
    { prob: 'p_fora_cantos_over25', res: 'res_fora_cantos_over25', check: (cantosF) => cantosF > 2.5 },
    { prob: 'p_fora_cantos_over35', res: 'res_fora_cantos_over35', check: (cantosF) => cantosF > 3.5 },
    { prob: 'p_fora_cantos_over45', res: 'res_fora_cantos_over45', check: (cantosF) => cantosF > 4.5 },

    { prob: 'p_cartoes_over25', res: 'res_cartoes_over25', check: (cartoes) => cartoes > 2.5 },
    { prob: 'p_cartoes_under25', res: 'res_cartoes_under25', check: (cartoes) => cartoes < 2.5 },
    { prob: 'p_cartoes_over35', res: 'res_cartoes_over35', check: (cartoes) => cartoes > 3.5 },
    { prob: 'p_cartoes_under35', res: 'res_cartoes_under35', check: (cartoes) => cartoes < 3.5 },
    { prob: 'p_cartoes_over45', res: 'res_cartoes_over45', check: (cartoes) => cartoes > 4.5 },
    { prob: 'p_cartoes_under45', res: 'res_cartoes_under45', check: (cartoes) => cartoes < 4.5 },

    { prob: 'p_casa_cartoes_over05', res: 'res_casa_cartoes_over05', check: (cartoesC) => cartoesC > 0.5 },
    { prob: 'p_casa_cartoes_over15', res: 'res_casa_cartoes_over15', check: (cartoesC) => cartoesC > 1.5 },
    { prob: 'p_casa_cartoes_over25', res: 'res_casa_cartoes_over25', check: (cartoesC) => cartoesC > 2.5 },
    { prob: 'p_fora_cartoes_over05', res: 'res_fora_cartoes_over05', check: (cartoesF) => cartoesF > 0.5 },
    { prob: 'p_fora_cartoes_over15', res: 'res_fora_cartoes_over15', check: (cartoesF) => cartoesF > 1.5 },
    { prob: 'p_fora_cartoes_over25', res: 'res_fora_cartoes_over25', check: (cartoesF) => cartoesF > 2.5 }
];

async function validarResultados() {
    await client.connect();
    console.log('[SISTEMA] Iniciando validador de Greens e Reds...');

    let jogosProcessados = 0;
    let jogosSemEstatistica = 0;
    const relatorioMercados = {};

    for (const m of mercados) {
        relatorioMercados[m.res] = { green: 0, red: 0 };
    }

    try {
        // MUDANÇA: Agora busca jogos NULL (novos) E jogos marcados como '0_EST'
        const queryAnalises = `
    SELECT * FROM analises_jogo;
`;
        const analisesResult = await client.query(queryAnalises);
        const analises = analisesResult.rows;

        if (analises.length === 0) {
            console.log('[SISTEMA] Nenhuma análise pendente ou sem estatística para recalcular.');
            return;
        }

        console.log(`[SISTEMA] ${analises.length} jogos encontrados na fila. Buscando estatísticas...`);

        for (const analise of analises) {
            const idJogo = analise.flashscore_id_jogo;

            const queryStatsCasa = `
                SELECT gols_marcados, gols_sofridos, escanteios, cartoes_amarelos, cartao_vermelho 
                FROM estatisticas_geral 
                WHERE flashscore_id_jogo = $1 AND id_time = $2 AND eh_casa = 1 
                LIMIT 1;
            `;
            const queryStatsFora = `
                SELECT gols_marcados, gols_sofridos, escanteios, cartoes_amarelos, cartao_vermelho 
                FROM estatisticas_geral 
                WHERE flashscore_id_jogo = $1 AND id_time = $2 AND eh_casa = 0 
                LIMIT 1;
            `;

            const statsCasaRes = await client.query(queryStatsCasa, [idJogo, analise.id_time_casa]);
            const statsForaRes = await client.query(queryStatsFora, [idJogo, analise.id_time_fora]);

            // Se ainda não tiver os dados, marca/mantém como sem estatística
            if (statsCasaRes.rows.length === 0 || statsForaRes.rows.length === 0) {
                console.log(`[AVISO] Dados ausentes para ${analise.nome_time_casa} x ${analise.nome_time_fora} - Marcando como 0_EST.`);
                await marcarComoSemEstatistica(idJogo, analise);
                jogosSemEstatistica++;
                continue;
            }

            jogosProcessados++;

            const statsCasa = statsCasaRes.rows[0];
            const statsFora = statsForaRes.rows[0];

            const golsCasa = Number(statsCasa.gols_marcados) || 0;
            const golsFora = Number(statsFora.gols_marcados) || 0;
            const totalGols = golsCasa + golsFora;

            const cantosCasa = Number(statsCasa.escanteios) || 0;
            const cantosFora = Number(statsFora.escanteios) || 0;
            const totalCantos = cantosCasa + cantosFora;

            const cartoesCasa = (Number(statsCasa.cartoes_amarelos) || 0) + ((Number(statsCasa.cartao_vermelho) || 0) * 2);
            const cartoesFora = (Number(statsFora.cartoes_amarelos) || 0) + ((Number(statsFora.cartao_vermelho) || 0) * 2);
            const totalCartoes = cartoesCasa + cartoesFora;

            let updates = {};

            if (golsCasa > golsFora) updates.res_match_odds = "'CASA'";
            else if (golsCasa === golsFora) updates.res_match_odds = "'EMPATE'";
            else updates.res_match_odds = "'FORA'";

            for (const mercado of mercados) {
                const probabilidade = parseFloat(analise[mercado.prob]);

                if (probabilidade > LIMIAR_PROBABILIDADE) {
                    let bateu = false;

                    if (mercado.prob.includes('btts') || ['p_home', 'p_draw', 'p_away'].includes(mercado.prob)) {
                        bateu = mercado.check(golsCasa, golsFora);
                    } else if (mercado.prob.includes('casa_over') && !mercado.prob.includes('cantos') && !mercado.prob.includes('cartoes')) {
                        bateu = mercado.check(golsCasa);
                    } else if (mercado.prob.includes('fora_over') && !mercado.prob.includes('cantos') && !mercado.prob.includes('cartoes')) {
                        bateu = mercado.check(golsFora);
                    } else if (mercado.prob.includes('casa_cantos')) {
                        bateu = mercado.check(cantosCasa);
                    } else if (mercado.prob.includes('fora_cantos')) {
                        bateu = mercado.check(cantosFora);
                    } else if (mercado.prob.includes('cantos')) {
                        bateu = mercado.check(totalCantos);
                    } else if (mercado.prob.includes('casa_cartoes')) {
                        bateu = mercado.check(cartoesCasa);
                    } else if (mercado.prob.includes('fora_cartoes')) {
                        bateu = mercado.check(cartoesFora);
                    } else if (mercado.prob.includes('cartoes')) {
                        bateu = mercado.check(totalCartoes);
                    } else {
                        bateu = mercado.check(totalGols);
                    }

                    if (bateu) {
                        updates[mercado.res] = "'GREEN'";
                        relatorioMercados[mercado.res].green++;
                    } else {
                        updates[mercado.res] = "'RED'";
                        relatorioMercados[mercado.res].red++;
                    }
                } else {
                    // MUDANÇA: Se o mercado não passou no limiar, mas tinha um '0_EST' velho gravado, volta a ser nulo.
                    updates[mercado.res] = "NULL";
                }
            }

            const colunasUpdate = Object.keys(updates).map(k => `${k} = ${updates[k]}`).join(', ');

            if (colunasUpdate.length > 0) {
                const updateQuery = `UPDATE analises_jogo SET ${colunasUpdate} WHERE flashscore_id_jogo = $1;`;
                await client.query(updateQuery, [idJogo]);
            }
        }

        console.log(`\n======================================================`);
        console.log(`📊 RELATÓRIO DE VALIDAÇÃO CONCLUÍDO`);
        console.log(`======================================================`);
        console.log(`Total de jogos validados com sucesso : ${jogosProcessados}`);
        console.log(`Total de jogos (re)marcados sem stats: ${jogosSemEstatistica}`);
        console.log(`======================================================`);
        console.log(`\n🏆 DESEMPENHO POR MERCADO (Probabilidade > ${LIMIAR_PROBABILIDADE}%)`);
        console.log(`------------------------------------------------------`);

        for (const key in relatorioMercados) {
            const greens = relatorioMercados[key].green;
            const reds = relatorioMercados[key].red;
            const totalSugerido = greens + reds;

            if (totalSugerido > 0) {
                const winRate = ((greens / totalSugerido) * 100).toFixed(1);
                const nomeMercado = key.replace('res_', '').padEnd(20);

                console.log(`Mercado: ${nomeMercado} | Sugestões: ${totalSugerido.toString().padEnd(3)} | 🟢 GREENS: ${greens.toString().padEnd(3)} | 🔴 REDS: ${reds.toString().padEnd(3)} | 🎯 Taxa de Acerto: ${winRate}%`);
            }
        }
        console.log(`======================================================\n`);

    } catch (err) {
        console.error('[ERRO FATAL] Falha no validador:', err);
    } finally {
        await client.end();
    }
}

// Otimizei esta função para aproveitar os dados do loop e fazer menos consultas no banco
async function marcarComoSemEstatistica(idJogo, analise) {
    let colunasParaAnular = [];

    colunasParaAnular.push(`res_match_odds = '0_EST'`);

    for (const mercado of mercados) {
        if (parseFloat(analise[mercado.prob]) > LIMIAR_PROBABILIDADE) {
            colunasParaAnular.push(`${mercado.res} = '0_EST'`);
        }
    }

    if (colunasParaAnular.length > 0) {
        const updateQuery = `UPDATE analises_jogo SET ${colunasParaAnular.join(', ')} WHERE flashscore_id_jogo = $1;`;
        await client.query(updateQuery, [idJogo]);
    }
}

validarResultados();