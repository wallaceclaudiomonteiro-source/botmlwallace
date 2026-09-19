const { Client } = require('pg');

const {
    otimizarModeloConjunto,
    projetarExpectativaGols
} = require('./market_model');

const client = new Client({
    connectionString:
        'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});


async function rodarBacktest(
    dataInicio,
    dataFim
) {

    try {

        await client.connect();

        console.log(
            `Iniciando simulação de ${dataInicio} até ${dataFim}...`
        );


        /*
         * ============================================================
         * JOGOS-ALVO
         * ============================================================
         *
         * IMPORTANTE:
         *
         * Não existe mais filtro por competição.
         *
         * Todos os jogos do período são processados.
         *
         * A competição é determinada individualmente pelo
         * id_competicao de cada jogo.
         */

        const { rows: jogosAlvo } = await client.query(`

            SELECT

                id,

                data_jogo,

                id_competicao,

                flashscore_id,

                flashscore_id_time_casa,

                flashscore_id_time_fora,

                placar_casa,

                placar_fora

            FROM jogos

            WHERE data_jogo::date
                  BETWEEN $1::date AND $2::date

              AND placar_casa IS NOT NULL

              AND placar_fora IS NOT NULL

              AND id_competicao IS NOT NULL

            ORDER BY
                data_jogo::date ASC,
                id ASC

        `, [

            dataInicio,

            dataFim

        ]);


        console.log(
            `\nEncontrados ${jogosAlvo.length} jogos para processar.`
        );


        /*
         * ============================================================
         * PROCESSAR CADA JOGO-ALVO
         * ============================================================
         */

        for (const alvo of jogosAlvo) {


            /*
             * ========================================================
             * COMPETIÇÃO DO PRÓPRIO JOGO
             * ========================================================
             */

            const id_competicao =
                Number(alvo.id_competicao);


            console.log(
                `\n============================================================`
            );


            console.log(
                `Processando jogo ${alvo.id} - ${alvo.data_jogo}`
            );


            console.log(
                `Competição: ${id_competicao}`
            );


            /*
             * ========================================================
             * REFERÊNCIAS DA COMPETIÇÃO DO JOGO
             * ========================================================
             *
             * Só xg/xgot/gols_marcados: otimizarModeloConjunto
             * infere a defesa a partir do espelho do adversário
             * no mesmo jogo, não usa xg_contra/xga/gols_sofridos.
             */

            const { rows: metricasLiga } = await client.query(`

                SELECT
                    metrica,
                    casa_mediana,
                    fora_mediana

                FROM grid_metricas_competicoes

                WHERE id_competicao = $1

                  AND metrica IN (
                      'xg',
                      'xgot',
                      'gols_marcados'
                  )

            `, [

                id_competicao

            ]);


            const referenciaLiga = {};


            for (const row of metricasLiga) {

                referenciaLiga[row.metrica] = {

                    casa:
                        Number(row.casa_mediana),

                    fora:
                        Number(row.fora_mediana)

                };
            }


            /*
             * ========================================================
             * MÉTRICAS OBRIGATÓRIAS
             * ========================================================
             */

            const metricasObrigatorias = [

                'xg',

                'xgot',

                'gols_marcados'

            ];


            const faltantes =
                metricasObrigatorias.filter(
                    metrica =>

                        !referenciaLiga[metrica] ||

                        !Number.isFinite(
                            referenciaLiga[metrica].casa
                        ) ||

                        !Number.isFinite(
                            referenciaLiga[metrica].fora
                        )
                );


            if (faltantes.length > 0) {

                console.log(

                    `[${alvo.data_jogo}] ` +

                    `Pulando jogo ${alvo.id} - ` +

                    `competição ${id_competicao} sem métricas completas: ` +

                    `${faltantes.join(', ')}`

                );

                continue;
            }


            /*
             * ========================================================
             * EXIBIR REFERÊNCIAS
             * ========================================================
             */

            console.log(
                `\nReferências da competição ${id_competicao}:`
            );


            console.log(
                `xG              CASA=${referenciaLiga.xg.casa.toFixed(3)} ` +
                `FORA=${referenciaLiga.xg.fora.toFixed(3)}`
            );


            console.log(
                `xGOT            CASA=${referenciaLiga.xgot.casa.toFixed(3)} ` +
                `FORA=${referenciaLiga.xgot.fora.toFixed(3)}`
            );


            console.log(
                `GOLS MARCADOS   CASA=${referenciaLiga.gols_marcados.casa.toFixed(3)} ` +
                `FORA=${referenciaLiga.gols_marcados.fora.toFixed(3)}`
            );


            /*
             * ========================================================
             * HISTÓRICO ANTERIOR AO JOGO-ALVO
             * ========================================================
             *
             * IMPORTANTE:
             *
             * O histórico agora usa o id_competicao DO PRÓPRIO
             * jogo-alvo.
             *
             * Portanto cada jogo é calibrado contra o histórico
             * da sua própria competição.
             */

            const { rows: historicoBruto } = await client.query(`

                SELECT

                    j.id,

                    j.data_jogo,

                    j.flashscore_id,

                    j.flashscore_id_time_casa,

                    j.flashscore_id_time_fora,

                    j.placar_casa,

                    j.placar_fora,

                    sg.id_time,

                    sg.eh_casa,

                    sg.xg,

                    sg.xgot,

                    sg.gols_marcados,

                    EXP(
                        -0.005 *
                        (
                            $2::date -
                            j.data_jogo::date
                        )
                    ) AS peso_tempo

                FROM jogos j

                INNER JOIN estatisticas_geral sg

                    ON sg.flashscore_id_jogo =
                       j.flashscore_id

                WHERE j.id_competicao = $1

                  AND j.data_jogo::date >=
                      $2::date - INTERVAL '1 year'

                  AND j.data_jogo::date <
                      $2::date

                  AND j.placar_casa IS NOT NULL

                  AND j.placar_fora IS NOT NULL

                ORDER BY
                    j.data_jogo::date ASC

            `, [

                id_competicao,

                alvo.data_jogo

            ]);


            /*
             * ========================================================
             * TRANSFORMAR AS DUAS LINHAS
             * DA ESTATISTICAS_GERAL
             * EM UM ÚNICO JOGO
             * ========================================================
             */

            const mapaJogos = new Map();


            for (const linha of historicoBruto) {


                const chave =
                    String(linha.flashscore_id);


                if (!mapaJogos.has(chave)) {

                    mapaJogos.set(
                        chave,
                        {

                            casa_id:
                                String(
                                    linha.flashscore_id_time_casa
                                ),

                            fora_id:
                                String(
                                    linha.flashscore_id_time_fora
                                ),


                            /*
                             * PLACAR REAL
                             */

                            gols_casa:
                                Number(
                                    linha.placar_casa
                                ),

                            gols_fora:
                                Number(
                                    linha.placar_fora
                                ),


                            /*
                             * ATAQUE
                             */

                            xg_casa: null,

                            xg_fora: null,

                            xgot_casa: null,

                            xgot_fora: null,

                            gols_marcados_casa: null,

                            gols_marcados_fora: null,


                            /*
                             * PESO TEMPORAL
                             */

                            peso_tempo:
                                Number(
                                    linha.peso_tempo
                                ) || 1

                        }
                    );
                }


                const jogo =
                    mapaJogos.get(chave);


                /*
                 * ====================================================
                 * CONVERTER VALORES
                 * ====================================================
                 */

                const xg =
                    linha.xg !== null
                        ? Number(linha.xg)
                        : null;


                const xgot =
                    linha.xgot !== null
                        ? Number(linha.xgot)
                        : null;


                const golsMarcados =
                    linha.gols_marcados !== null
                        ? Number(linha.gols_marcados)
                        : null;


                /*
                 * ====================================================
                 * TIME DA CASA
                 * ====================================================
                 */

                if (Number(linha.eh_casa) === 1) {

                    jogo.xg_casa =
                        xg;

                    jogo.xgot_casa =
                        xgot;

                    jogo.gols_marcados_casa =
                        golsMarcados;
                }


                /*
                 * ====================================================
                 * TIME FORA
                 * ====================================================
                 */

                if (Number(linha.eh_casa) === 0) {

                    jogo.xg_fora =
                        xg;

                    jogo.xgot_fora =
                        xgot;

                    jogo.gols_marcados_fora =
                        golsMarcados;
                }
            }


            /*
             * ========================================================
             * CONVERTER MAP PARA ARRAY
             * ========================================================
             */

            const jogosTreino =
                Array.from(
                    mapaJogos.values()
                );


            /*
             * ========================================================
             * FILTRAR JOGOS VÁLIDOS
             * ========================================================
             */

            const jogosValidos =
                jogosTreino.filter(j =>

                    j.casa_id &&

                    j.fora_id &&

                    Number.isFinite(
                        j.gols_casa
                    ) &&

                    Number.isFinite(
                        j.gols_fora
                    )

                );


            if (jogosValidos.length < 20) {

                console.log(

                    `[${alvo.data_jogo}] ` +

                    `Pulando jogo ${alvo.id} - ` +

                    `competição ${id_competicao} - ` +

                    `histórico insuficiente ` +

                    `(${jogosValidos.length} jogos).`

                );

                continue;
            }


            /*
             * ========================================================
             * DIAGNÓSTICO DOS DADOS
             * ========================================================
             */

            const comXG =
                jogosValidos.filter(j =>

                    j.xg_casa !== null &&

                    j.xg_fora !== null

                ).length;


            const comXGOT =
                jogosValidos.filter(j =>

                    j.xgot_casa !== null &&

                    j.xgot_fora !== null

                ).length;


            const comGolsMarcados =
                jogosValidos.filter(j =>

                    j.gols_marcados_casa !== null &&

                    j.gols_marcados_fora !== null

                ).length;


            console.log(

                `Histórico: ${jogosValidos.length} jogos | ` +

                `xG: ${comXG} | ` +

                `xGOT: ${comXGOT} | ` +

                `Gols marcados: ${comGolsMarcados}`

            );


            /*
             * ========================================================
             * MLE CONJUNTO
             * ========================================================
             *
             * A defesa não tem pesos próprios: ela é inferida do
             * espelho do adversário no mesmo jogo (xg/xgot/gols do
             * time B alimentam gradDefesa do time A). Por isso só
             * existem pesos de ATAQUE aqui.
             *
             * ATAQUE
             *
             * xG       = 30%
             * xGOT     = 50%
             * gols     = 20%
             */

            const parametros =
                await otimizarModeloConjunto(

                    jogosValidos,

                    1500,

                    0.003,

                    {

                        referenciaLiga,


                        /*
                         * ============================
                         * ATAQUE
                         * ============================
                         */

                        pesoXG:
                            0.30,

                        pesoXGOT:
                            0.50,

                        pesoGols:
                            0.20,


                        /*
                         * ============================
                         * REGULARIZAÇÃO
                         * ============================
                         */

                        regularizacao:
                            0.015,

                        gradienteMax:
                            5
                    }
                );


            /*
             * ========================================================
             * IDS DOS TIMES DO JOGO-ALVO
             * ========================================================
             */

            const casaId =
                String(
                    alvo.flashscore_id_time_casa
                );


            const foraId =
                String(
                    alvo.flashscore_id_time_fora
                );


            /*
             * ========================================================
             * FORÇAS MLE
             * ========================================================
             */

            const casaAtq =
                parametros.ataque?.[casaId] ??
                0;


            const casaDef =
                parametros.defesa?.[casaId] ??
                0;


            const foraAtq =
                parametros.ataque?.[foraId] ??
                0;


            const foraDef =
                parametros.defesa?.[foraId] ??
                0;


            /*
             * ========================================================
             * LAMBDA CASA
             * ========================================================
             */

            const mle_l_home =
                projetarExpectativaGols(

                    parametros,

                    casaId,

                    foraId,

                    true

                );


            /*
             * ========================================================
             * LAMBDA FORA
             * ========================================================
             */

            const mle_l_away =
                projetarExpectativaGols(

                    parametros,

                    foraId,

                    casaId,

                    false

                );


            /*
             * ========================================================
             * SALVAR NO JOGO
             * ========================================================
             */

            await client.query(`

                UPDATE jogos

                SET

                    mle_casa_ataque = $1,

                    mle_casa_defesa = $2,

                    mle_fora_ataque = $3,

                    mle_fora_defesa = $4,

                    mle_l_home = $5,

                    mle_l_away = $6

                WHERE id = $7

            `, [

                casaAtq,

                casaDef,

                foraAtq,

                foraDef,

                mle_l_home,

                mle_l_away,

                alvo.id

            ]);


            /*
             * ========================================================
             * LOG
             * ========================================================
             */

            console.log(

                `[${alvo.data_jogo}] ` +

                `Competição ${id_competicao} | ` +

                `Jogo ${alvo.id} processado! ` +

                `MLE λ: ` +

                `${mle_l_home.toFixed(3)} x ` +

                `${mle_l_away.toFixed(3)}`

            );


            console.log(

                `  Casa ${casaId}: ` +

                `ATQ=${casaAtq.toFixed(3)} ` +

                `DEF=${casaDef.toFixed(3)}`

            );


            console.log(

                `  Fora ${foraId}: ` +

                `ATQ=${foraAtq.toFixed(3)} ` +

                `DEF=${foraDef.toFixed(3)}`

            );
        }


        console.log(
            '\nSimulação concluída com sucesso!'
        );


    } catch (error) {

        console.error(
            'Erro durante o backtest:',
            error
        );

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
 * Não existe mais competição fixa.
 */

rodarBacktest(
    '2023-01-01',
    '2026-09-07'
);