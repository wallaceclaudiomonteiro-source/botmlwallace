const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

const LIMIAR_PROBABILIDADE = 50.0;

const mercados = [
    { prob: 'p_home', res: 'res_home', check: (golsC, golsF) => golsC > golsF },
    { prob: 'p_draw', res: 'res_draw', check: (golsC, golsF) => golsC === golsF },
    { prob: 'p_away', res: 'res_away', check: (golsC, golsF) => golsC < golsF },

    { prob: 'p_over05', res: 'res_over05', check: (gols) => gols > 0.5 },
    { prob: 'p_under05', res: 'res_under05', check: (gols) => gols < 0.5 },

    { prob: 'p_over15', res: 'res_over15', check: (gols) => gols > 1.5 },
    { prob: 'p_under15', res: 'res_under15', check: (gols) => gols < 1.5 },

    { prob: 'p_over25', res: 'res_over25', check: (gols) => gols > 2.5 },
    { prob: 'p_under25', res: 'res_under25', check: (gols) => gols < 2.5 },

    { prob: 'p_btts_yes', res: 'res_btts_yes', check: (golsC, golsF) => golsC > 0 && golsF > 0 },
    { prob: 'p_btts_no', res: 'res_btts_no', check: (golsC, golsF) => golsC === 0 || golsF === 0 },

    { prob: 'p_casa_over05', res: 'res_casa_over05', check: (golsC) => golsC > 0.5 },
    { prob: 'p_casa_over15', res: 'res_casa_over15', check: (golsC) => golsC > 1.5 },

    { prob: 'p_fora_over05', res: 'res_fora_over05', check: (golsF) => golsF > 0.5 },
    { prob: 'p_fora_over15', res: 'res_fora_over15', check: (golsF) => golsF > 1.5 },

    { prob: 'p_cantos_over15', res: 'res_cantos_over15', check: (cantos) => cantos > 1.5 },
    { prob: 'p_cantos_under15', res: 'res_cantos_under15', check: (cantos) => cantos < 1.5 },

    { prob: 'p_cantos_over25', res: 'res_cantos_over25', check: (cantos) => cantos > 2.5 },
    { prob: 'p_cantos_under25', res: 'res_cantos_under25', check: (cantos) => cantos < 2.5 },

    { prob: 'p_cantos_over35', res: 'res_cantos_over35', check: (cantos) => cantos > 3.5 },
    { prob: 'p_cantos_under35', res: 'res_cantos_under35', check: (cantos) => cantos < 3.5 },

    { prob: 'p_cantos_over45', res: 'res_cantos_over45', check: (cantos) => cantos > 4.5 },
    { prob: 'p_cantos_under45', res: 'res_cantos_under45', check: (cantos) => cantos < 4.5 },

    { prob: 'p_cantos_over55', res: 'res_cantos_over55', check: (cantos) => cantos > 5.5 },
    { prob: 'p_cantos_under55', res: 'res_cantos_under55', check: (cantos) => cantos < 5.5 },

    { prob: 'p_cantos_over65', res: 'res_cantos_over65', check: (cantos) => cantos > 6.5 },
    { prob: 'p_cantos_under65', res: 'res_cantos_under65', check: (cantos) => cantos < 6.5 },

    { prob: 'p_casa_cantos_over05', res: 'res_casa_cantos_over05', check: (cantosC) => cantosC > 0.5 },
    { prob: 'p_casa_cantos_over15', res: 'res_casa_cantos_over15', check: (cantosC) => cantosC > 1.5 },
    { prob: 'p_casa_cantos_over25', res: 'res_casa_cantos_over25', check: (cantosC) => cantosC > 2.5 },
    { prob: 'p_casa_cantos_over35', res: 'res_casa_cantos_over35', check: (cantosC) => cantosC > 3.5 },

    { prob: 'p_fora_cantos_over05', res: 'res_fora_cantos_over05', check: (cantosF) => cantosF > 0.5 },
    { prob: 'p_fora_cantos_over15', res: 'res_fora_cantos_over15', check: (cantosF) => cantosF > 1.5 },
    { prob: 'p_fora_cantos_over25', res: 'res_fora_cantos_over25', check: (cantosF) => cantosF > 2.5 },
    { prob: 'p_fora_cantos_over35', res: 'res_fora_cantos_over35', check: (cantosF) => cantosF > 3.5 },

    { prob: 'p_cartoes_over05', res: 'res_cartoes_over05', check: (cartoes) => cartoes > 0.5 },
    { prob: 'p_cartoes_under05', res: 'res_cartoes_under05', check: (cartoes) => cartoes < 0.5 },

    { prob: 'p_cartoes_over15', res: 'res_cartoes_over15', check: (cartoes) => cartoes > 1.5 },
    { prob: 'p_cartoes_under15', res: 'res_cartoes_under15', check: (cartoes) => cartoes < 1.5 },

    { prob: 'p_cartoes_over25', res: 'res_cartoes_over25', check: (cartoes) => cartoes > 2.5 },
    { prob: 'p_cartoes_under25', res: 'res_cartoes_under25', check: (cartoes) => cartoes < 2.5 },

    { prob: 'p_cartoes_over35', res: 'res_cartoes_over35', check: (cartoes) => cartoes > 3.5 },
    { prob: 'p_cartoes_under35', res: 'res_cartoes_under35', check: (cartoes) => cartoes < 3.5 },

    { prob: 'p_casa_cartoes_over05', res: 'res_casa_cartoes_over05', check: (cartoesC) => cartoesC > 0.5 },
    { prob: 'p_casa_cartoes_over15', res: 'res_casa_cartoes_over15', check: (cartoesC) => cartoesC > 1.5 },
    { prob: 'p_casa_cartoes_over25', res: 'res_casa_cartoes_over25', check: (cartoesC) => cartoesC > 2.5 },
    { prob: 'p_casa_cartoes_under25', res: 'res_casa_cartoes_under25', check: (cartoesC) => cartoesC < 2.5 },

    { prob: 'p_fora_cartoes_over05', res: 'res_fora_cartoes_over05', check: (cartoesF) => cartoesF > 0.5 },
    { prob: 'p_fora_cartoes_over15', res: 'res_fora_cartoes_over15', check: (cartoesF) => cartoesF > 1.5 },
    { prob: 'p_fora_cartoes_over25', res: 'res_fora_cartoes_over25', check: (cartoesF) => cartoesF > 2.5 },
    { prob: 'p_fora_cartoes_under25', res: 'res_fora_cartoes_under25', check: (cartoesF) => cartoesF < 2.5 }
];

function obterPeriodoBanco(periodo) {
    if (periodo === '1T') return '1_tempo';
    if (periodo === '2T') return '2_tempo';
    return null;
}

async function buscarGolsSumario(idJogo, periodo) {
    const query = `
        SELECT
            gol_1tempo_casa,
            gol_1tempo_fora,
            gol_2tempo_casa,
            gol_2tempo_fora
        FROM sumario
        WHERE flashscore_id_jogo = $1
        LIMIT 1;
    `;

    const result = await client.query(query, [idJogo]);

    if (result.rows.length === 0) {
        return null;
    }

    const sumario = result.rows[0];

    let golsCasa;
    let golsFora;

    if (periodo === '1T') {
        golsCasa = Number(sumario.gol_1tempo_casa);
        golsFora = Number(sumario.gol_1tempo_fora);
    } else if (periodo === '2T') {
        golsCasa = Number(sumario.gol_2tempo_casa);
        golsFora = Number(sumario.gol_2tempo_fora);
    } else {
        return null;
    }

    if (!Number.isFinite(golsCasa) || !Number.isFinite(golsFora)) {
        return null;
    }

    return {
        golsCasa,
        golsFora
    };
}

async function validarResultados() {
    await client.connect();

    console.log('[SISTEMA] Iniciando validador de Greens e Reds HT...');

    let jogosProcessados = 0;
    let jogosSemEstatistica = 0;
    const relatorioMercados = {
        '1T': {},
        '2T': {}
    };

    for (const periodo of ['1T', '2T']) {
        for (const m of mercados) {
            relatorioMercados[periodo][m.res] = {
                green: 0,
                red: 0
            };
        }
    }

    try {
        const queryAnalises = `
            SELECT *
            FROM analise_jogos_ht
            ORDER BY data_jogo, hora_jogo, flashscore_id_jogo, periodo;
        `;

        const analisesResult = await client.query(queryAnalises);
        const analises = analisesResult.rows;

        if (analises.length === 0) {
            console.log('[SISTEMA] Nenhuma análise HT pendente de validação encontrada.');
            return;
        }

        console.log(`[SISTEMA] ${analises.length} análises HT pendentes encontradas.`);

        for (const analise of analises) {
            const idJogo = analise.flashscore_id_jogo;
            const periodo = analise.periodo;
            const periodoBanco = obterPeriodoBanco(periodo);

            if (!periodoBanco) {
                console.log(`[AVISO] Período inválido: ${periodo} | Jogo: ${idJogo}`);
                continue;
            }

            console.log(`\n======================================================`);
            console.log(`[HT] ${analise.nome_time_casa} x ${analise.nome_time_fora}`);
            console.log(`[ID JOGO] ${idJogo}`);
            console.log(`[PERÍODO] ${periodo} -> ${periodoBanco}`);
            console.log(`======================================================`);

            const queryStatsCasa = `
                SELECT
                    escanteios,
                    cartoes_amarelos,
                    cartao_vermelho
                FROM estatisticas_por_periodo
                WHERE flashscore_id_jogo = $1
                  AND id_time = $2
                  AND periodo = $3
                  AND eh_casa = 1
                LIMIT 1;
            `;

            const queryStatsFora = `
                SELECT
                    escanteios,
                    cartoes_amarelos,
                    cartao_vermelho
                FROM estatisticas_por_periodo
                WHERE flashscore_id_jogo = $1
                  AND id_time = $2
                  AND periodo = $3
                  AND eh_casa = 0
                LIMIT 1;
            `;

            const statsCasaRes = await client.query(
                queryStatsCasa,
                [
                    idJogo,
                    analise.id_time_casa,
                    periodoBanco
                ]
            );

            const statsForaRes = await client.query(
                queryStatsFora,
                [
                    idJogo,
                    analise.id_time_fora,
                    periodoBanco
                ]
            );

            const gols = await buscarGolsSumario(
                idJogo,
                periodo
            );

            if (
                statsCasaRes.rows.length === 0 ||
                statsForaRes.rows.length === 0 ||
                !gols
            ) {
                console.log(
                    `[AVISO] Sem estatísticas completas ${periodo} para ${analise.nome_time_casa} x ${analise.nome_time_fora}`
                );

                await marcarComoSemEstatistica(
                    idJogo,
                    periodo
                );

                jogosSemEstatistica++;
                continue;
            }

            jogosProcessados++;

            const statsCasa = statsCasaRes.rows[0];
            const statsFora = statsForaRes.rows[0];

            const golsCasa = gols.golsCasa;
            const golsFora = gols.golsFora;

            const totalGols =
                golsCasa + golsFora;

            const cantosCasa =
                Number(statsCasa.escanteios) || 0;

            const cantosFora =
                Number(statsFora.escanteios) || 0;

            const totalCantos =
                cantosCasa + cantosFora;

            const cartoesCasa =
                (Number(statsCasa.cartoes_amarelos) || 0) +
                ((Number(statsCasa.cartao_vermelho) || 0) * 2);

            const cartoesFora =
                (Number(statsFora.cartoes_amarelos) || 0) +
                ((Number(statsFora.cartao_vermelho) || 0) * 2);

            const totalCartoes =
                cartoesCasa + cartoesFora;

            const updates = {};

            if (golsCasa > golsFora) {
                updates.res_match_odds = 1;
            } else if (golsCasa === golsFora) {
                updates.res_match_odds = 0;
            } else {
                updates.res_match_odds = -1;
            }

            for (const mercado of mercados) {
                const probabilidade =
                    parseFloat(analise[mercado.prob]);

                if (
                    !Number.isFinite(probabilidade) ||
                    probabilidade <= LIMIAR_PROBABILIDADE
                ) {
                    continue;
                }

                let bateu = false;

                if (
                    mercado.prob.includes('btts') ||
                    ['p_home', 'p_draw', 'p_away'].includes(mercado.prob)
                ) {
                    bateu =
                        mercado.check(
                            golsCasa,
                            golsFora
                        );
                } else if (
                    mercado.prob.includes('casa_over') &&
                    !mercado.prob.includes('cantos') &&
                    !mercado.prob.includes('cartoes')
                ) {
                    bateu =
                        mercado.check(golsCasa);
                } else if (
                    mercado.prob.includes('fora_over') &&
                    !mercado.prob.includes('cantos') &&
                    !mercado.prob.includes('cartoes')
                ) {
                    bateu =
                        mercado.check(golsFora);
                } else if (
                    mercado.prob.includes('casa_cantos')
                ) {
                    bateu =
                        mercado.check(cantosCasa);
                } else if (
                    mercado.prob.includes('fora_cantos')
                ) {
                    bateu =
                        mercado.check(cantosFora);
                } else if (
                    mercado.prob.includes('cantos')
                ) {
                    bateu =
                        mercado.check(totalCantos);
                } else if (
                    mercado.prob.includes('casa_cartoes')
                ) {
                    bateu =
                        mercado.check(cartoesCasa);
                } else if (
                    mercado.prob.includes('fora_cartoes')
                ) {
                    bateu =
                        mercado.check(cartoesFora);
                } else if (
                    mercado.prob.includes('cartoes')
                ) {
                    bateu =
                        mercado.check(totalCartoes);
                } else {
                    bateu =
                        mercado.check(totalGols);
                }

                if (bateu) {
                    updates[mercado.res] = 1;
                    relatorioMercados[periodo][mercado.res].green++;
                } else {
                    updates[mercado.res] = 0;
                    relatorioMercados[periodo][mercado.res].red++;
                }
            }

            const campos = Object.keys(updates);

            if (campos.length > 0) {
                const valores = [];
                const atribuicoes = [];

                campos.forEach((campo, index) => {
                    valores.push(updates[campo]);
                    atribuicoes.push(
                        `${campo} = $${index + 1}`
                    );
                });

                valores.push(idJogo);
                valores.push(periodo);

                const updateQuery = `
                    UPDATE analise_jogos_ht
                    SET ${atribuicoes.join(', ')}
                    WHERE flashscore_id_jogo = $${campos.length + 1}
                      AND periodo = $${campos.length + 2};
                `;

                await client.query(
                    updateQuery,
                    valores
                );
            }

            console.log(
                `[VALIDADO HT] ${analise.nome_time_casa} x ${analise.nome_time_fora} | ${periodo} | Gols: ${golsCasa}-${golsFora} | Cantos: ${cantosCasa}-${cantosFora} | Cartões: ${cartoesCasa}-${cartoesFora}`
            );
        }

        console.log(`\n======================================================`);
        console.log(`📊 RELATÓRIO DE VALIDAÇÃO HT CONCLUÍDO`);
        console.log(`======================================================`);
        console.log(`Total de análises HT processadas : ${jogosProcessados}`);
        console.log(`Total sem estatística             : ${jogosSemEstatistica}`);
        console.log(`======================================================`);
        for (const periodo of ['1T', '2T']) {
            console.log(`\n======================================================`);
            console.log(`🏆 DESEMPENHO ${periodo} - Probabilidade > ${LIMIAR_PROBABILIDADE}%`);
            console.log(`======================================================`);

            for (const key in relatorioMercados[periodo]) {
                const greens =
                    relatorioMercados[periodo][key].green;

                const reds =
                    relatorioMercados[periodo][key].red;

                const totalSugerido =
                    greens + reds;

                if (totalSugerido > 0) {
                    const winRate =
                        ((greens / totalSugerido) * 100).toFixed(1);

                    const nomeMercado =
                        key.replace('res_', '').padEnd(28);

                    console.log(
                        `Mercado: ${nomeMercado} | Sugestões: ${String(totalSugerido).padEnd(6)} | 🟢 GREENS: ${String(greens).padEnd(6)} | 🔴 REDS: ${String(reds).padEnd(6)} | 🎯 Taxa: ${winRate}%`
                    );
                }
            }
        }

        console.log(`\n=====================================================\n`);

    } catch (err) {
        console.error(
            '[ERRO FATAL] Falha no validador HT:',
            err
        );

        process.exitCode = 1;

    } finally {
        await client.end();
    }
}

async function marcarComoSemEstatistica(
    idJogo,
    periodo
) {
    const query = `
        SELECT *
        FROM analise_jogos_ht
        WHERE flashscore_id_jogo = $1
          AND periodo = $2
        LIMIT 1;
    `;

    const res = await client.query(
        query,
        [
            idJogo,
            periodo
        ]
    );

    if (res.rows.length === 0) {
        return;
    }

    const analise = res.rows[0];

    const colunasParaAnular = [];

    colunasParaAnular.push(
        `res_match_odds = -1`
    );

    for (const mercado of mercados) {
        const probabilidade =
            parseFloat(
                analise[mercado.prob]
            );

        if (
            Number.isFinite(probabilidade) &&
            probabilidade > LIMIAR_PROBABILIDADE
        ) {
            colunasParaAnular.push(
                `${mercado.res} = -1`
            );
        }
    }

    if (colunasParaAnular.length > 0) {
        const updateQuery = `
            UPDATE analise_jogos_ht
            SET ${colunasParaAnular.join(', ')}
            WHERE flashscore_id_jogo = $1
              AND periodo = $2;
        `;

        await client.query(
            updateQuery,
            [
                idJogo,
                periodo
            ]
        );
    }
}

validarResultados();