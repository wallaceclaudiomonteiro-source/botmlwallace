const { criarPool } = require('../db'); // Lembre de ajustar o ../ de acordo com a pasta do arquivo

const {
    poisson,
    fatorial,
    bivariatePoisson,
    dixonColesCorrection,
    negativeBinomial,
    probOverNegativeBinomial,
    zeroInflatedPoisson,
    probOverZeroInflated,
    probOverPoisson,
    cruzarForcas,
    fatorCalibracaoLiga,
    percentual,
} = require('./markets/market_model');

const pool = criarPool('modelo', { 
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// ==========================================
// CONFIGURAÇÃO HT
// ==========================================

const PERIODOS = Object.freeze(['1T', '2T']);

const TIPOS_COMPORTAMENTO_BASE = Object.freeze([
    'ATAQUE_DEFESA_TIME',
    'ATAQUE_DEFESA_CONTRA'
]);

const BLOCOS_COMPORTAMENTO = Object.freeze({
    ATAQUE_DEFESA_TIME: 'ATAQUE_DEFESA_TIME',
    ATAQUE_DEFESA_CONTRA: 'ATAQUE_DEFESA_CONTRA'
});

const MIN_JOGOS_COMPORTAMENTO = 6;
const MAX_JOGOS_COMPORTAMENTO = 10;

const R_CANTOS_PADRAO = 4.2;
const CACHE_R_CANTOS = new Map();

// ==========================================
// NORMALIZAÇÃO DOS JOGOS USADOS
// ==========================================

function normalizarJogosUsados(valor) {
    if (!valor) return [];

    if (Array.isArray(valor)) {
        return valor;
    }

    if (typeof valor === 'string') {
        try {
            const parsed = JSON.parse(valor);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    return [];
}

// ==========================================
// EXTRAI JOGOS DO COMPORTAMENTO
// ==========================================

function extrairJogosComportamento(
    linhas,
    timeId,
    tiposDesejados
) {
    const saida = {};

    for (const tipo of tiposDesejados) {
        const linha = linhas.find(item =>
            String(item.flashscore_id_time) === String(timeId) &&
            item.tipo_analise === tipo
        );

        if (!linha) {
            saida[tipo] = {
                tipo,
                casa_fora: null,
                jogos: []
            };
            continue;
        }

        const jogos = normalizarJogosUsados(linha.jogos_usados)
            .map(jogo => {
                if (
                    typeof jogo === 'string' ||
                    typeof jogo === 'number'
                ) {
                    return {
                        id: String(jogo),
                        data: null
                    };
                }

                return {
                    id:
                        jogo.flashscore_id ||
                        jogo.flashscore_id_jogo ||
                        jogo.id_jogo ||
                        jogo.id ||
                        null,

                    data:
                        jogo.data_jogo ||
                        jogo.data ||
                        null
                };
            })
            .filter(jogo => jogo.id)
            .sort((a, b) => {
                const dataA = a.data
                    ? new Date(a.data).getTime()
                    : 0;

                const dataB = b.data
                    ? new Date(b.data).getTime()
                    : 0;

                return dataB - dataA;
            });

        saida[tipo] = {
            tipo,
            casa_fora: String(
                linha.casa_fora || ''
            ).toUpperCase(),
            jogos
        };
    }

    return saida;
}

// ==========================================
// MONTA OS 4 BLOCOS DO MATCHUP
// ==========================================

function montarBlocosComportamentoConfronto(
    linhas,
    flashscoreIdCasa,
    flashscoreIdFora,
    maxJogos = MAX_JOGOS_COMPORTAMENTO
) {
    const blocosCasa = extrairJogosComportamento(
        linhas,
        flashscoreIdCasa,
        TIPOS_COMPORTAMENTO_BASE
    );

    const blocosFora = extrairJogosComportamento(
        linhas,
        flashscoreIdFora,
        TIPOS_COMPORTAMENTO_BASE
    );

    return {
        casa_producao:
            blocosCasa[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_TIME]
                ? {
                    ...blocosCasa[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_TIME],
                    jogos: blocosCasa[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_TIME].jogos.slice(0, maxJogos)
                }
                : null,

        casa_sofrimento:
            blocosCasa[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_CONTRA]
                ? {
                    ...blocosCasa[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_CONTRA],
                    jogos: blocosCasa[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_CONTRA].jogos.slice(0, maxJogos)
                }
                : null,

        fora_producao:
            blocosFora[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_TIME]
                ? {
                    ...blocosFora[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_TIME],
                    jogos: blocosFora[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_TIME].jogos.slice(0, maxJogos)
                }
                : null,

        fora_sofrimento:
            blocosFora[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_CONTRA]
                ? {
                    ...blocosFora[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_CONTRA],
                    jogos: blocosFora[BLOCOS_COMPORTAMENTO.ATAQUE_DEFESA_CONTRA].jogos.slice(0, maxJogos)
                }
                : null
    };
}

// ==========================================
// R CANTOS DA COMPETIÇÃO POR PERÍODO
// ==========================================

async function estimarRCantosCompeticao(
    idCompeticao,
    dataAlvo,
    periodo
) {
    const periodoBanco =
        periodo === '1T'
            ? '1_tempo'
            : periodo === '2T'
                ? '2_tempo'
                : null;

    if (!periodoBanco) {
        return R_CANTOS_PADRAO;
    }

    const chave =
        `${idCompeticao}|${dataAlvo}|${periodo}`;

    if (CACHE_R_CANTOS.has(chave)) {
        return CACHE_R_CANTOS.get(chave);
    }

    try {
        const query = `
            SELECT
                e.flashscore_id_jogo,
                SUM(e.escanteios) AS total_escanteios
            FROM estatisticas_por_periodo e
            JOIN jogos j
                ON j.flashscore_id = e.flashscore_id_jogo
            WHERE j.id_competicao = $1
              AND j.data_jogo < $2::date
              AND e.periodo = $3
              AND e.escanteios IS NOT NULL
            GROUP BY e.flashscore_id_jogo
        `;

        const { rows } = await pool.query(
            query,
            [
                idCompeticao,
                dataAlvo,
                periodoBanco
            ]
        );

        const valores = rows
            .map(row => Number(row.total_escanteios))
            .filter(Number.isFinite);

        if (valores.length < 20) {
            CACHE_R_CANTOS.set(
                chave,
                R_CANTOS_PADRAO
            );

            return R_CANTOS_PADRAO;
        }

        const media =
            valores.reduce(
                (soma, valor) => soma + valor,
                0
            ) / valores.length;

        const variancia =
            valores.reduce(
                (soma, valor) =>
                    soma + Math.pow(valor - media, 2),
                0
            ) / valores.length;

        if (
            media <= 0 ||
            variancia <= media
        ) {
            CACHE_R_CANTOS.set(
                chave,
                R_CANTOS_PADRAO
            );

            return R_CANTOS_PADRAO;
        }

        const rEstimado = Math.max(
            0.25,
            Math.min(
                50,
                (media * media) /
                (variancia - media)
            )
        );

        CACHE_R_CANTOS.set(
            chave,
            rEstimado
        );

        return rEstimado;

    } catch (error) {
        CACHE_R_CANTOS.set(
            chave,
            R_CANTOS_PADRAO
        );

        return R_CANTOS_PADRAO;
    }
}

// ==========================================
// HT NÃO UTILIZA LAMBDA SHARED
// ==========================================

async function estimarLambdaShared(
    flashscoreIdCasa,
    flashscoreIdFora,
    dataAlvo,
    periodo
) {
    return 0;
}

// ==========================================
// MEDIANA
// ==========================================

function calcularMediana(valores) {
    const numeros = valores
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    if (numeros.length === 0) {
        return null;
    }

    const meio = Math.floor(
        numeros.length / 2
    );

    if (numeros.length % 2 === 0) {
        return (
            numeros[meio - 1] +
            numeros[meio]
        ) / 2;
    }

    return numeros[meio];
}

// ==========================================
// BUSCA HISTÓRICO DE ESCANTEIOS HT
// ==========================================

async function buscarEscanteiosHistoricos(
    flashscoreIdCasa,
    flashscoreIdFora,
    dataAlvo,
    periodo
) {
    try {
        const dataNormalizada =
            String(dataAlvo)
                .trim()
                .replace(/[\r\n"']/g, '');

        const periodoBanco =
            periodo === '1T'
                ? '1_tempo'
                : periodo === '2T'
                    ? '2_tempo'
                    : null;

        if (!periodoBanco) {
            return null;
        }

        const MIN_JOGOS =
            MIN_JOGOS_COMPORTAMENTO;

        const MAX_JOGOS =
            MAX_JOGOS_COMPORTAMENTO;

        const queryComportamento = `
            SELECT
                flashscore_id_time,
                tipo_analise,
                casa_fora,
                jogos_usados
            FROM analise_comportamento_times
            WHERE flashscore_id_time IN ($1, $2)
              AND data_jogo::text LIKE $3 || '%'
              AND periodo = $4
              AND tipo_analise = ANY($5::text[])
        `;

        const { rows: linhas } =
            await pool.query(
                queryComportamento,
                [
                    flashscoreIdCasa,
                    flashscoreIdFora,
                    dataNormalizada,
                    periodo,
                    TIPOS_COMPORTAMENTO_BASE
                ]
            );

        if (
            !linhas ||
            linhas.length === 0
        ) {
            console.log(
                `[CANTOS DEBUG] Nenhuma linha de comportamento encontrada para ${flashscoreIdCasa} x ${flashscoreIdFora} | ${periodo}.`
            );

            return null;
        }

        const blocos =
            montarBlocosComportamentoConfronto(
                linhas,
                flashscoreIdCasa,
                flashscoreIdFora,
                MAX_JOGOS
            );

        for (
            const [nome, bloco]
            of Object.entries(blocos)
        ) {
            if (
                !bloco ||
                bloco.jogos.length < MIN_JOGOS
            ) {
                console.log(
                    `[CANTOS DEBUG] ${periodo} | Bloco ${nome} insuficiente (${bloco ? bloco.jogos.length : 0}/${MIN_JOGOS}).`
                );

                return null;
            }
        }

        const todosIds = [
            ...new Set(
                Object.values(blocos)
                    .flatMap(bloco =>
                        bloco.jogos.map(
                            jogo => String(jogo.id)
                        )
                    )
            )
        ];

        const queryEstatisticas = `
            SELECT
                flashscore_id_jogo,
                eh_casa,
                MAX(escanteios) AS escanteios
            FROM estatisticas_por_periodo
            WHERE flashscore_id_jogo = ANY($1::text[])
              AND periodo = $2
              AND eh_casa IN (0, 1)
              AND escanteios IS NOT NULL
            GROUP BY
                flashscore_id_jogo,
                eh_casa
        `;

        const { rows: estatisticas } =
            await pool.query(
                queryEstatisticas,
                [
                    todosIds,
                    periodoBanco
                ]
            );

        const mapaEscanteios =
            new Map();

        for (
            const row of estatisticas
        ) {
            mapaEscanteios.set(
                `${String(row.flashscore_id_jogo)}_${Number(row.eh_casa)}`,
                Number(row.escanteios)
            );
        }

        function calcularMedianaBloco(
            bloco,
            nomeBloco
        ) {
            const valoresEscanteios = [];

            const ehCasaTime =
                bloco.casa_fora === 'C';

            let ehCasaEstatistica;

            if (
                bloco.tipo ===
                'ATAQUE_DEFESA_TIME'
            ) {
                ehCasaEstatistica =
                    ehCasaTime ? 1 : 0;

            } else if (
                bloco.tipo ===
                'ATAQUE_DEFESA_CONTRA'
            ) {
                ehCasaEstatistica =
                    ehCasaTime ? 0 : 1;

            } else {
                return null;
            }

            for (
                const jogo of bloco.jogos
            ) {
                const escanteios =
                    mapaEscanteios.get(
                        `${String(jogo.id)}_${ehCasaEstatistica}`
                    );

                if (
                    Number.isFinite(
                        escanteios
                    ) &&
                    escanteios >= 0
                ) {
                    valoresEscanteios.push(
                        escanteios
                    );
                }
            }

            const mediana =
                calcularMediana(
                    valoresEscanteios
                );

            console.log(
                `[CANTOS DEBUG] ${periodo} | ${nomeBloco} | Mando=${bloco.casa_fora} | Válidos=${valoresEscanteios.length}/${bloco.jogos.length} | Mediana=${mediana !== null ? mediana.toFixed(2) : 'N/A'}`
            );

            if (
                valoresEscanteios.length <
                MIN_JOGOS ||
                mediana === null
            ) {
                return null;
            }

            return mediana;
        }

        const mediana_casa_produzidos =
            calcularMedianaBloco(
                blocos.casa_producao,
                'Casa Produzidos'
            );

        const mediana_casa_concedidos =
            calcularMedianaBloco(
                blocos.casa_sofrimento,
                'Casa Concedidos'
            );

        const mediana_fora_produzidos =
            calcularMedianaBloco(
                blocos.fora_producao,
                'Fora Produzidos'
            );

        const mediana_fora_concedidos =
            calcularMedianaBloco(
                blocos.fora_sofrimento,
                'Fora Concedidos'
            );

        if (
            mediana_casa_produzidos === null ||
            mediana_casa_concedidos === null ||
            mediana_fora_produzidos === null ||
            mediana_fora_concedidos === null
        ) {
            console.log(
                `[CANTOS DEBUG] ${periodo} | Um ou mais blocos falharam no filtro mínimo.`
            );

            return null;
        }

        const lambda_casa_hist =
            cruzarForcas(
                mediana_casa_produzidos,
                mediana_fora_concedidos
            );

        const lambda_fora_hist =
            cruzarForcas(
                mediana_fora_produzidos,
                mediana_casa_concedidos
            );

        console.log(
            `[CANTOS SUCESSO] ${periodo} | Casa ${mediana_casa_produzidos.toFixed(2)} x ${mediana_fora_concedidos.toFixed(2)} -> λ ${lambda_casa_hist.toFixed(2)}`
        );

        console.log(
            `[CANTOS SUCESSO] ${periodo} | Fora ${mediana_fora_produzidos.toFixed(2)} x ${mediana_casa_concedidos.toFixed(2)} -> λ ${lambda_fora_hist.toFixed(2)}`
        );

        return {
            lambda_casa_hist,
            lambda_fora_hist,
            peso_historico: 0.30,
            mediana_casa_produzidos,
            mediana_casa_concedidos,
            mediana_fora_produzidos,
            mediana_fora_concedidos
        };

    } catch (error) {
        console.error(
            `[CANTOS ERRO FATAL] ${periodo}`,
            error.message
        );

        return null;
    }
}

// ==========================================
// FORÇA XG / XGOT
// SEM MÉDIA DA LIGA
// ==========================================

function calcularForcaXG(dados) {
    const xg =
        Number(
            dados?.xg_mediana_wma
        ) || 0;

    const xgot =
        Number(
            dados?.xgot_mediana_wma
        ) || 0;

    if (
        xg > 0 &&
        xgot > 0
    ) {
        return (
            xg * 0.75 +
            xgot * 0.25
        );
    }

    if (xg > 0) {
        return xg;
    }

    if (xgot > 0) {
        return xgot;
    }

    return 0;
}

function calcularRatingAtaque(dados) {
    return calcularForcaXG(dados);
}

function calcularRatingDefesa(dados) {
    return calcularForcaXG(dados);
}

function calcularExpectedGoals(
    producaoAtacante,
    concessaoDefensor
) {
    const forcaAtaque =
        calcularRatingAtaque(
            producaoAtacante
        );

    const vulnerabilidadeDefesa =
        calcularRatingDefesa(
            concessaoDefensor
        );

    if (
        forcaAtaque <= 0 ||
        vulnerabilidadeDefesa <= 0
    ) {
        return 0;
    }

    return cruzarForcas(
        forcaAtaque,
        vulnerabilidadeDefesa
    );
}

// ==========================================
// BLOCO 1X2
// ==========================================

function calcularMercado1x2(
    ataqueCasa,
    defesaFora,
    ataqueFora,
    defesaCasa,
    lambdaShared
) {
    const lambdaHome =
        calcularExpectedGoals(
            ataqueCasa,
            defesaFora
        );

    const lambdaAway =
        calcularExpectedGoals(
            ataqueFora,
            defesaCasa
        );

    const shared =
        Math.min(
            Math.max(
                0,
                Number(lambdaShared) || 0
            ),
            lambdaHome * 0.95,
            lambdaAway * 0.95
        );

    const lambda1 =
        Math.max(
            0,
            lambdaHome - shared
        );

    const lambda2 =
        Math.max(
            0,
            lambdaAway - shared
        );

    let p_home = 0;
    let p_draw = 0;
    let p_away = 0;

    for (
        let h = 0;
        h <= 10;
        h++
    ) {
        for (
            let a = 0;
            a <= 10;
            a++
        ) {
            const prob =
                bivariatePoisson(
                    h,
                    a,
                    lambda1,
                    lambda2,
                    shared
                );

            if (h > a) {
                p_home += prob;
            } else if (h === a) {
                p_draw += prob;
            } else {
                p_away += prob;
            }
        }
    }

    const total =
        p_home +
        p_draw +
        p_away;

    return {
        p_home:
            total > 0
                ? p_home / total
                : 0,

        p_draw:
            total > 0
                ? p_draw / total
                : 0,

        p_away:
            total > 0
                ? p_away / total
                : 0
    };
}

// ==========================================
// BLOCO DE GOLS HT
// ==========================================

function calcularMercadoGols(
    ataqueCasa,
    defesaFora,
    ataqueFora,
    defesaCasa,
    lambdaShared
) {
    const lambdaHome =
        calcularExpectedGoals(
            ataqueCasa,
            defesaFora
        );

    const lambdaAway =
        calcularExpectedGoals(
            ataqueFora,
            defesaCasa
        );

    const shared =
        Math.min(
            Math.max(
                0,
                Number(lambdaShared) || 0
            ),
            lambdaHome * 0.95,
            lambdaAway * 0.95
        );

    const lambda1 =
        Math.max(
            0,
            lambdaHome - shared
        );

    const lambda2 =
        Math.max(
            0,
            lambdaAway - shared
        );

    let p_over05 = 0;
    let p_under05 = 0;
    let p_over15 = 0;
    let p_under15 = 0;
    let p_over25 = 0;
    let p_under25 = 0;
    let p_btts_yes = 0;
    let p_btts_no = 0;

    for (
        let h = 0;
        h <= 10;
        h++
    ) {
        for (
            let a = 0;
            a <= 10;
            a++
        ) {
            const prob =
                bivariatePoisson(
                    h,
                    a,
                    lambda1,
                    lambda2,
                    shared
                );

            const totalGols =
                h + a;

            if (totalGols > 0.5) {
                p_over05 += prob;
            } else {
                p_under05 += prob;
            }

            if (totalGols > 1.5) {
                p_over15 += prob;
            } else {
                p_under15 += prob;
            }

            if (totalGols > 2.5) {
                p_over25 += prob;
            } else {
                p_under25 += prob;
            }

            if (
                h > 0 &&
                a > 0
            ) {
                p_btts_yes += prob;
            } else {
                p_btts_no += prob;
            }
        }
    }

    const total =
        p_over05 +
        p_under05;

    if (total > 0) {
        p_over05 /= total;
        p_under05 /= total;
        p_over15 /= total;
        p_under15 /= total;
        p_over25 /= total;
        p_under25 /= total;
        p_btts_yes /= total;
        p_btts_no /= total;
    }

    function probOverTime(
        lambda,
        line
    ) {
        let probUnder = 0;

        for (
            let k = 0;
            k <= Math.floor(line);
            k++
        ) {
            probUnder +=
                poisson(
                    lambda,
                    k
                );
        }

        return 1 - probUnder;
    }

    return {
        total_esperado:
            lambdaHome +
            lambdaAway,

        esperado_casa:
            lambdaHome,

        esperado_fora:
            lambdaAway,

        lambda_home:
            lambdaHome,

        lambda_away:
            lambdaAway,

        lambda_shared:
            shared,

        geral: {
            p_over05,
            p_under05,
            p_over15,
            p_under15,
            p_over25,
            p_under25,
            p_btts_yes,
            p_btts_no
        },

        times: {
            casa: {
                o05:
                    probOverTime(
                        lambdaHome,
                        0.5
                    ),

                o15:
                    probOverTime(
                        lambdaHome,
                        1.5
                    )
            },

            fora: {
                o05:
                    probOverTime(
                        lambdaAway,
                        0.5
                    ),

                o15:
                    probOverTime(
                        lambdaAway,
                        1.5
                    )
            }
        }
    };
}

// ==========================================
// BLOCO DE ESCANTEIOS
// ==========================================

function calcularMercadoEscanteios(
    historicoEscanteios,
    rCantos
) {
    if (
        !historicoEscanteios ||
        !Number.isFinite(
            Number(
                historicoEscanteios.lambda_casa_hist
            )
        ) ||
        !Number.isFinite(
            Number(
                historicoEscanteios.lambda_fora_hist
            )
        )
    ) {
        return {
            total_esperado: 0,
            esperado_casa: 0,
            esperado_fora: 0,

            geral: {
                o15: 0,
                u15: 0,
                o25: 0,
                u25: 0,
                o35: 0,
                u35: 0,
                o45: 0,
                u45: 0,
                o55: 0,
                u55: 0,
                o65: 0,
                u65: 0
            },

            times: {
                casa: {
                    o05: 0,
                    o15: 0,
                    o25: 0,
                    o35: 0
                },

                fora: {
                    o05: 0,
                    o15: 0,
                    o25: 0,
                    o35: 0
                }
            },

            r_cantos:
                R_CANTOS_PADRAO
        };
    }

    const xCantosMandante =
        Number(
            historicoEscanteios.lambda_casa_hist
        );

    const xCantosVisitante =
        Number(
            historicoEscanteios.lambda_fora_hist
        );

    const xCTotal =
        xCantosMandante +
        xCantosVisitante;

    const r =
        Number(rCantos) > 0
            ? Number(rCantos)
            : R_CANTOS_PADRAO;

    function calcularOver(
        lambda,
        linha
    ) {
        return probOverNegativeBinomial(
            lambda,
            linha,
            r
        );
    }

    const o15 =
        calcularOver(
            xCTotal,
            1.5
        );

    const o25 =
        calcularOver(
            xCTotal,
            2.5
        );

    const o35 =
        calcularOver(
            xCTotal,
            3.5
        );

    const o45 =
        calcularOver(
            xCTotal,
            4.5
        );

    const o55 =
        calcularOver(
            xCTotal,
            5.5
        );

    const o65 =
        calcularOver(
            xCTotal,
            6.5
        );

    return {
        total_esperado:
            xCTotal,

        esperado_casa:
            xCantosMandante,

        esperado_fora:
            xCantosVisitante,

        geral: {
            o15,
            u15: 1 - o15,

            o25,
            u25: 1 - o25,

            o35,
            u35: 1 - o35,

            o45,
            u45: 1 - o45,

            o55,
            u55: 1 - o55,

            o65,
            u65: 1 - o65
        },

        times: {
            casa: {
                o05:
                    calcularOver(
                        xCantosMandante,
                        0.5
                    ),

                o15:
                    calcularOver(
                        xCantosMandante,
                        1.5
                    ),

                o25:
                    calcularOver(
                        xCantosMandante,
                        2.5
                    ),

                o35:
                    calcularOver(
                        xCantosMandante,
                        3.5
                    )
            },

            fora: {
                o05:
                    calcularOver(
                        xCantosVisitante,
                        0.5
                    ),

                o15:
                    calcularOver(
                        xCantosVisitante,
                        1.5
                    ),

                o25:
                    calcularOver(
                        xCantosVisitante,
                        2.5
                    ),

                o35:
                    calcularOver(
                        xCantosVisitante,
                        3.5
                    )
            }
        },

        r_cantos: r
    };
}

// ==========================================
// BLOCO DE CARTÕES
// SEM MÉDIA DA LIGA
// ==========================================

function calcularExpectedCards(
    timeRecebeCartoes,
    adversarioProvocaCartoes
) {
    const cartoesRecebidos =
        Number(
            timeRecebeCartoes?.cartoes_amarelos_mediana_wma
        ) || 2.0;

    const faltasCometidas =
        Number(
            timeRecebeCartoes?.faltas_mediana_wma
        ) || 0;

    const desarmesTotal =
        Number(
            timeRecebeCartoes?.desarmes_total_mediana_wma
        ) || 0;

    const desarmesCertos =
        Number(
            timeRecebeCartoes?.desarmes_certos_mediana_wma
        ) || 0;

    const acoesAgressivas =
        Math.max(
            0,
            faltasCometidas +
            (
                desarmesTotal -
                desarmesCertos
            )
        );

    const refAgressividade = 17.0;

    const indiceAgressividade =
        acoesAgressivas > 0
            ? acoesAgressivas /
            refAgressividade
            : 1.0;

    const cartoesProvocados =
        Number(
            adversarioProvocaCartoes?.cartoes_amarelos_mediana_wma
        ) || 0;

    const faltasProvocadas =
        Number(
            adversarioProvocaCartoes?.faltas_mediana_wma
        ) || 0;

    const desarmesProvocadosTotal =
        Number(
            adversarioProvocaCartoes?.desarmes_total_mediana_wma
        ) || 0;

    const desarmesProvocadosCertos =
        Number(
            adversarioProvocaCartoes?.desarmes_certos_mediana_wma
        ) || 0;

    const intensidadeProvocada =
        Math.max(
            0,
            faltasProvocadas +
            (
                desarmesProvocadosTotal -
                desarmesProvocadosCertos
            )
        );

    const indiceProvocacao =
        intensidadeProvocada > 0
            ? intensidadeProvocada /
            refAgressividade
            : 1.0;

    const passesNoAtaque =
        Number(
            adversarioProvocaCartoes?.passes_terco_final_certos_mediana_wma
        ) || 0;

    const refPasses = 65.0;

    const indicePressao =
        passesNoAtaque > 0
            ? passesNoAtaque /
            refPasses
            : 1.0;

    const historicoRecebe =
        cartoesRecebidos *
        indiceAgressividade;

    const historicoProvoca =
        cartoesProvocados > 0
            ? cartoesProvocados *
            (
                indiceProvocacao * 0.50 +
                indicePressao * 0.50
            )
            : cartoesRecebidos;

    const projecaoCruzada =
        cruzarForcas(
            historicoRecebe,
            historicoProvoca
        );

    const projecaoBruta =
        (
            cartoesRecebidos * 0.35
        ) +
        (
            historicoRecebe * 0.25
        ) +
        (
            historicoProvoca * 0.15
        ) +
        (
            projecaoCruzada * 0.25
        );

    return projecaoBruta;
}

// ==========================================
// MERCADO DE CARTÕES
// ==========================================

function calcularMercadoCartoes(
    ataqueCasa,
    defesaFora,
    ataqueFora,
    defesaCasa
) {
    const xCardsMandante =
        calcularExpectedCards(
            ataqueCasa,
            defesaFora
        );

    const xCardsVisitante =
        calcularExpectedCards(
            ataqueFora,
            defesaCasa
        );

    const xCardsTotal =
        xCardsMandante +
        xCardsVisitante;

    function calcularOver(
        lambda,
        linha
    ) {
        return probOverZeroInflated(
            lambda,
            linha
        );
    }

    const o05 =
        calcularOver(
            xCardsTotal,
            0.5
        );

    const o15 =
        calcularOver(
            xCardsTotal,
            1.5
        );

    const o25 =
        calcularOver(
            xCardsTotal,
            2.5
        );

    const o35 =
        calcularOver(
            xCardsTotal,
            3.5
        );

    return {
        total_esperado:
            xCardsTotal,

        esperado_casa:
            xCardsMandante,

        esperado_fora:
            xCardsVisitante,

        geral: {
            o05,
            u05: 1 - o05,

            o15,
            u15: 1 - o15,

            o25,
            u25: 1 - o25,

            o35,
            u35: 1 - o35
        },

        times: {
            casa: {
                o05:
                    calcularOver(
                        xCardsMandante,
                        0.5
                    ),

                o15:
                    calcularOver(
                        xCardsMandante,
                        1.5
                    ),

                o25:
                    calcularOver(
                        xCardsMandante,
                        2.5
                    ),

                u25:
                    1 -
                    calcularOver(
                        xCardsMandante,
                        2.5
                    )
            },

            fora: {
                o05:
                    calcularOver(
                        xCardsVisitante,
                        0.5
                    ),

                o15:
                    calcularOver(
                        xCardsVisitante,
                        1.5
                    ),

                o25:
                    calcularOver(
                        xCardsVisitante,
                        2.5
                    ),

                u25:
                    1 -
                    calcularOver(
                        xCardsVisitante,
                        2.5
                    )
            }
        }
    };
}

// ==========================================
// ORQUESTRADOR
// ==========================================

function analisarConfrontoCompleto(
    ataqueCasa,
    defesaFora,
    ataqueFora,
    defesaCasa,
    lambdaShared,
    historicoEscanteios,
    rCantos
) {
    return {
        match_odds:
            calcularMercado1x2(
                ataqueCasa,
                defesaFora,
                ataqueFora,
                defesaCasa,
                lambdaShared
            ),

        gols:
            calcularMercadoGols(
                ataqueCasa,
                defesaFora,
                ataqueFora,
                defesaCasa,
                lambdaShared
            ),

        cantos:
            calcularMercadoEscanteios(
                historicoEscanteios,
                rCantos
            ),

        cartoes:
            calcularMercadoCartoes(
                ataqueCasa,
                defesaFora,
                ataqueFora,
                defesaCasa
            )
    };
}

// ==========================================
// PARSE DOS DADOS
// ==========================================

function parseTeamData(row) {
    if (!row) {
        return null;
    }

    const parsedRow = {
        ...row
    };

    const camposNumericos = [
        'xg_mediana_wma',
        'xgot_mediana_wma',
        'gols_marcados_mediana_wma',
        'gols_sofridos_mediana_wma',
        'finalizacoes_mediana_wma',
        'finalizacoes_no_gol_mediana_wma',
        'finalizacoes_bloqueadas_mediana_wma',
        'cruzamentos_total_mediana_wma',
        'toques_area_adversaria_mediana_wma',
        'defesas_goleiro_mediana_wma',
        'rebatidas_mediana_wma',
        'escanteios_mediana_wma',
        'faltas_mediana_wma',
        'desarmes_total_mediana_wma',
        'desarmes_certos_mediana_wma',
        'passes_terco_final_certos_mediana_wma',
        'cartoes_amarelos_mediana_wma',
        'chances_clara_mediana_wma'
    ];

    camposNumericos.forEach(campo => {
        parsedRow[campo] =
            parsedRow[campo]
                ? parseFloat(
                    parsedRow[campo]
                )
                : 0;
    });

    return parsedRow;
}

// ==========================================
// BUSCA MATCHUP HT
// ==========================================

async function buscarEstatisticasMatchup(
    flashscoreId,
    dataJogo,
    tipoAnalise,
    periodo
) {
    const dataNormalizada =
        String(dataJogo)
            .trim()
            .replace(/[\r\n"']/g, '');

    const query = `
        SELECT *
        FROM analise_comportamento_times
        WHERE flashscore_id_time = $1
          AND data_jogo::text LIKE $2 || '%'
          AND tipo_analise = $3
          AND periodo = $4
        LIMIT 1;
    `;

    const { rows } =
        await pool.query(
            query,
            [
                flashscoreId,
                dataNormalizada,
                tipoAnalise,
                periodo
            ]
        );

    return parseTeamData(
        rows[0]
    );
}

// ==========================================
// PROCESSAMENTO PELO HISTÓRICO DE JOGOS
// HT = 1T + 2T
// ==========================================

async function rodarAnalisesPorData(dataAlvo) {
    const dataLimpa = String(dataAlvo).trim().replace(/[\r\n"']/g, '');
    console.log(`Iniciando população na tabela analise_jogos_ht baseada na tabela JOGOS para a data: ${dataLimpa}...`);
    try {
        const queryJogos = `
            SELECT *
            FROM jogos
            WHERE data_jogo::text LIKE $1 || '%';
        `;
        const jogos = await pool.query(queryJogos, [dataLimpa]);
        if (jogos.rows.length === 0) {
            console.log(`Nenhum jogo encontrado na tabela jogos para a data ${dataLimpa}.`);
            return;
        }
        console.log(`[OK] ${jogos.rows.length} jogo(s) encontrado(s) na tabela jogos para ${dataLimpa}.`);
        for (const jogo of jogos.rows) {
            console.log(`\n====================================================`);
            console.log(`[JOGO] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}`);
            console.log(`[ID JOGO] ${jogo.flashscore_id}`);
            console.log(`[ID CASA] ${jogo.flashscore_id_time_casa}`);
            console.log(`[ID FORA] ${jogo.flashscore_id_time_fora}`);
            console.log(`====================================================`);
            for (const periodo of PERIODOS) {
                console.log(`\n[HT] Processando período ${periodo}...`);
                const lambdaShared = await estimarLambdaShared(
                    jogo.flashscore_id_time_casa,
                    jogo.flashscore_id_time_fora,
                    dataLimpa,
                    periodo
                );
                const historicoEscanteios = await buscarEscanteiosHistoricos(
                    jogo.flashscore_id_time_casa,
                    jogo.flashscore_id_time_fora,
                    dataLimpa,
                    periodo
                );
                const rCantos = await estimarRCantosCompeticao(
                    jogo.id_competicao,
                    dataLimpa,
                    periodo
                );
                const ataqueCasa = await buscarEstatisticasMatchup(
                    jogo.flashscore_id_time_casa,
                    dataLimpa,
                    'ATAQUE_DEFESA_TIME',
                    periodo
                );

                const defesaCasa = await buscarEstatisticasMatchup(
                    jogo.flashscore_id_time_casa,
                    dataLimpa,
                    'ATAQUE_DEFESA_CONTRA',
                    periodo
                );

                const ataqueFora = await buscarEstatisticasMatchup(
                    jogo.flashscore_id_time_fora,
                    dataLimpa,
                    'ATAQUE_DEFESA_TIME',
                    periodo
                );

                const defesaFora = await buscarEstatisticasMatchup(
                    jogo.flashscore_id_time_fora,
                    dataLimpa,
                    'ATAQUE_DEFESA_CONTRA',
                    periodo
                );
                if (!ataqueCasa || !defesaCasa || !ataqueFora || !defesaFora) {
                    console.log(`[AVISO] ${periodo} | Dados incompletos para ${jogo.nome_time_casa} x ${jogo.nome_time_fora}. Ignorando período.`);
                    continue;
                }
                const previsoes = analisarConfrontoCompleto(
                    ataqueCasa,
                    defesaFora,
                    ataqueFora,
                    defesaCasa,
                    lambdaShared,
                    historicoEscanteios,
                    rCantos
                );
                const params = [
                    jogo.flashscore_id,
                    dataLimpa,
                    jogo.hora_jogo,
                    jogo.id_time_casa,
                    jogo.id_time_fora,
                    jogo.nome_time_casa,
                    jogo.nome_time_fora,
                    jogo.id_competicao,
                    jogo.nome_competicao,
                    jogo.pais_liga,
                    jogo.rodada,
                    percentual(previsoes.match_odds.p_home),
                    percentual(previsoes.match_odds.p_draw),
                    percentual(previsoes.match_odds.p_away),
                    percentual(previsoes.gols.geral.p_over05),
                    percentual(previsoes.gols.geral.p_under05),
                    percentual(previsoes.gols.geral.p_over15),
                    percentual(previsoes.gols.geral.p_under15),
                    percentual(previsoes.gols.geral.p_over25),
                    percentual(previsoes.gols.geral.p_under25),
                    percentual(previsoes.gols.geral.p_btts_yes),
                    percentual(previsoes.gols.geral.p_btts_no),
                    percentual(previsoes.gols.times.casa.o05),
                    percentual(previsoes.gols.times.casa.o15),
                    percentual(previsoes.gols.times.fora.o05),
                    percentual(previsoes.gols.times.fora.o15),
                    previsoes.cantos.total_esperado.toFixed(2),
                    previsoes.cantos.esperado_casa.toFixed(2),
                    previsoes.cantos.esperado_fora.toFixed(2),
                    percentual(previsoes.cantos.geral.o15),
                    percentual(previsoes.cantos.geral.u15),
                    percentual(previsoes.cantos.geral.o25),
                    percentual(previsoes.cantos.geral.u25),
                    percentual(previsoes.cantos.geral.o35),
                    percentual(previsoes.cantos.geral.u35),
                    percentual(previsoes.cantos.geral.o45),
                    percentual(previsoes.cantos.geral.u45),
                    percentual(previsoes.cantos.geral.o55),
                    percentual(previsoes.cantos.geral.u55),
                    percentual(previsoes.cantos.geral.o65),
                    percentual(previsoes.cantos.geral.u65),
                    percentual(previsoes.cantos.times.casa.o05),
                    percentual(previsoes.cantos.times.casa.o15),
                    percentual(previsoes.cantos.times.casa.o25),
                    percentual(previsoes.cantos.times.casa.o35),
                    percentual(previsoes.cantos.times.fora.o05),
                    percentual(previsoes.cantos.times.fora.o15),
                    percentual(previsoes.cantos.times.fora.o25),
                    percentual(previsoes.cantos.times.fora.o35),
                    previsoes.cartoes.total_esperado.toFixed(2),
                    previsoes.cartoes.esperado_casa.toFixed(2),
                    previsoes.cartoes.esperado_fora.toFixed(2),
                    percentual(previsoes.cartoes.geral.o05),
                    percentual(previsoes.cartoes.geral.u05),
                    percentual(previsoes.cartoes.geral.o15),
                    percentual(previsoes.cartoes.geral.u15),
                    percentual(previsoes.cartoes.geral.o25),
                    percentual(previsoes.cartoes.geral.u25),
                    percentual(previsoes.cartoes.geral.o35),
                    percentual(previsoes.cartoes.geral.u35),
                    percentual(previsoes.cartoes.times.casa.o05),
                    percentual(previsoes.cartoes.times.casa.o15),
                    percentual(previsoes.cartoes.times.casa.o25),
                    percentual(previsoes.cartoes.times.casa.u25),
                    percentual(previsoes.cartoes.times.fora.o05),
                    percentual(previsoes.cartoes.times.fora.o15),
                    percentual(previsoes.cartoes.times.fora.o25),
                    percentual(previsoes.cartoes.times.fora.u25),
                    periodo
                ];
                await pool.query(
                    `
                    INSERT INTO analise_jogos_ht (
                        flashscore_id_jogo,
                        data_jogo,
                        hora_jogo,
                        id_time_casa,
                        id_time_fora,
                        nome_time_casa,
                        nome_time_fora,
                        id_competicao,
                        nome_competicao,
                        pais_liga,
                        rodada,
                        p_home,
                        p_draw,
                        p_away,
                        p_over05,
                        p_under05,
                        p_over15,
                        p_under15,
                        p_over25,
                        p_under25,
                        p_btts_yes,
                        p_btts_no,
                        p_casa_over05,
                        p_casa_over15,
                        p_fora_over05,
                        p_fora_over15,
                        total_cantos_esperado,
                        casa_cantos_esperado,
                        fora_cantos_esperado,
                        p_cantos_over15,
                        p_cantos_under15,
                        p_cantos_over25,
                        p_cantos_under25,
                        p_cantos_over35,
                        p_cantos_under35,
                        p_cantos_over45,
                        p_cantos_under45,
                        p_cantos_over55,
                        p_cantos_under55,
                        p_cantos_over65,
                        p_cantos_under65,
                        p_casa_cantos_over05,
                        p_casa_cantos_over15,
                        p_casa_cantos_over25,
                        p_casa_cantos_over35,
                        p_fora_cantos_over05,
                        p_fora_cantos_over15,
                        p_fora_cantos_over25,
                        p_fora_cantos_over35,
                        total_cartoes_esperado,
                        casa_cartoes_esperado,
                        fora_cartoes_esperado,
                        p_cartoes_over05,
                        p_cartoes_under05,
                        p_cartoes_over15,
                        p_cartoes_under15,
                        p_cartoes_over25,
                        p_cartoes_under25,
                        p_cartoes_over35,
                        p_cartoes_under35,
                        p_casa_cartoes_over05,
                        p_casa_cartoes_over15,
                        p_casa_cartoes_over25,
                        p_casa_cartoes_under25,
                        p_fora_cartoes_over05,
                        p_fora_cartoes_over15,
                        p_fora_cartoes_over25,
                        p_fora_cartoes_under25,
                        periodo
                    )
                  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
    $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
    $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
    $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,
    $41,$42,$43,$44,$45,$46,$47,$48,$49,$50,
    $51,$52,$53,$54,$55,$56,$57,$58,$59,$60,
    $61,$62,$63,$64,$65,$66,$67,$68,$69
)
                    ON CONFLICT (flashscore_id_jogo, periodo)
                    DO UPDATE SET
                        data_jogo = EXCLUDED.data_jogo,
                        hora_jogo = EXCLUDED.hora_jogo,
                        id_time_casa = EXCLUDED.id_time_casa,
                        id_time_fora = EXCLUDED.id_time_fora,
                        nome_time_casa = EXCLUDED.nome_time_casa,
                        nome_time_fora = EXCLUDED.nome_time_fora,
                        id_competicao = EXCLUDED.id_competicao,
                        nome_competicao = EXCLUDED.nome_competicao,
                        pais_liga = EXCLUDED.pais_liga,
                        rodada = EXCLUDED.rodada,
                        p_home = EXCLUDED.p_home,
                        p_draw = EXCLUDED.p_draw,
                        p_away = EXCLUDED.p_away,
                        p_over05 = EXCLUDED.p_over05,
                        p_under05 = EXCLUDED.p_under05,
                        p_over15 = EXCLUDED.p_over15,
                        p_under15 = EXCLUDED.p_under15,
                        p_over25 = EXCLUDED.p_over25,
                        p_under25 = EXCLUDED.p_under25,
                        p_btts_yes = EXCLUDED.p_btts_yes,
                        p_btts_no = EXCLUDED.p_btts_no,
                        p_casa_over05 = EXCLUDED.p_casa_over05,
                        p_casa_over15 = EXCLUDED.p_casa_over15,
                        p_fora_over05 = EXCLUDED.p_fora_over05,
                        p_fora_over15 = EXCLUDED.p_fora_over15,
                        total_cantos_esperado = EXCLUDED.total_cantos_esperado,
                        casa_cantos_esperado = EXCLUDED.casa_cantos_esperado,
                        fora_cantos_esperado = EXCLUDED.fora_cantos_esperado,
                        p_cantos_over15 = EXCLUDED.p_cantos_over15,
                        p_cantos_under15 = EXCLUDED.p_cantos_under15,
                        p_cantos_over25 = EXCLUDED.p_cantos_over25,
                        p_cantos_under25 = EXCLUDED.p_cantos_under25,
                        p_cantos_over35 = EXCLUDED.p_cantos_over35,
                        p_cantos_under35 = EXCLUDED.p_cantos_under35,
                        p_cantos_over45 = EXCLUDED.p_cantos_over45,
                        p_cantos_under45 = EXCLUDED.p_cantos_under45,
                        p_cantos_over55 = EXCLUDED.p_cantos_over55,
                        p_cantos_under55 = EXCLUDED.p_cantos_under55,
                        p_cantos_over65 = EXCLUDED.p_cantos_over65,
                        p_cantos_under65 = EXCLUDED.p_cantos_under65,
                        p_casa_cantos_over05 = EXCLUDED.p_casa_cantos_over05,
                        p_casa_cantos_over15 = EXCLUDED.p_casa_cantos_over15,
                        p_casa_cantos_over25 = EXCLUDED.p_casa_cantos_over25,
                        p_casa_cantos_over35 = EXCLUDED.p_casa_cantos_over35,
                        p_fora_cantos_over05 = EXCLUDED.p_fora_cantos_over05,
                        p_fora_cantos_over15 = EXCLUDED.p_fora_cantos_over15,
                        p_fora_cantos_over25 = EXCLUDED.p_fora_cantos_over25,
                        p_fora_cantos_over35 = EXCLUDED.p_fora_cantos_over35,
                        total_cartoes_esperado = EXCLUDED.total_cartoes_esperado,
                        casa_cartoes_esperado = EXCLUDED.casa_cartoes_esperado,
                        fora_cartoes_esperado = EXCLUDED.fora_cartoes_esperado,
                        p_cartoes_over05 = EXCLUDED.p_cartoes_over05,
                        p_cartoes_under05 = EXCLUDED.p_cartoes_under05,
                        p_cartoes_over15 = EXCLUDED.p_cartoes_over15,
                        p_cartoes_under15 = EXCLUDED.p_cartoes_under15,
                        p_cartoes_over25 = EXCLUDED.p_cartoes_over25,
                        p_cartoes_under25 = EXCLUDED.p_cartoes_under25,
                        p_cartoes_over35 = EXCLUDED.p_cartoes_over35,
                        p_cartoes_under35 = EXCLUDED.p_cartoes_under35,
                        p_casa_cartoes_over05 = EXCLUDED.p_casa_cartoes_over05,
                        p_casa_cartoes_over15 = EXCLUDED.p_casa_cartoes_over15,
                        p_casa_cartoes_over25 = EXCLUDED.p_casa_cartoes_over25,
                        p_casa_cartoes_under25 = EXCLUDED.p_casa_cartoes_under25,
                        p_fora_cartoes_over05 = EXCLUDED.p_fora_cartoes_over05,
                        p_fora_cartoes_over15 = EXCLUDED.p_fora_cartoes_over15,
                        p_fora_cartoes_over25 = EXCLUDED.p_fora_cartoes_over25,
                        p_fora_cartoes_under25 = EXCLUDED.p_fora_cartoes_under25
                    `,
                    params
                );
                console.log(`[SALVO HT] ${jogo.nome_time_casa} x ${jogo.nome_time_fora} | Período: ${periodo} | LambdaShared: ${Number(lambdaShared).toFixed(4)} | rCantos: ${Number(rCantos).toFixed(2)}`);
            }
        }
        console.log(`\n[FINALIZADO] Previsões HT concluídas para ${dataLimpa}.`);
    } catch (error) {
        console.error('Erro fatal:', error);
    } finally {
        await pool.end();
    }
}

// ==========================================
// EXECUÇÃO
// ==========================================

const DATA_ALVO =
    process.argv[2] ||
    '2026-09-01';

rodarAnalisesPorData(
    DATA_ALVO
);