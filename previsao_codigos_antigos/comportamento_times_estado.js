const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

const MANDOS = ['CASA', 'FORA'];
const PERIODOS = ['GE', '1T', '2T'];
const CLASSES_ADV = ['FORTE', 'MEDIO', 'FRACO'];
const TIPOS_ADV = ['TODOS', 'ATAQUE', 'DEFESA'];
const MIN_JOGOS = 5;

const metricasAlvo = [
    'posse_bola','xg','xga','xgot','xa','chances_clara','bolas_na_trave','xg_contra',
    'finalizacoes','finalizacoes_no_gol','finalizacoes_para_fora','finalizacoes_bloqueadas',
    'finalizacoes_de_dentro_area','finalizacoes_de_fora_area','toques_area_adversaria',
    'passes_porcentagem','passes_certos','passes_total','passes_profundidade_certos',
    'passes_longos_porcentagem','passes_longos_certos','passes_longos_total',
    'passes_terco_final_porcentagem','passes_terco_final_certos','passes_terco_final_total',
    'cruzamentos_porcentagem','cruzamentos_certos','cruzamentos_total',
    'interceptacoes','rebatidas','desarmes_porcentagem','desarmes_certos','desarmes_total',
    'duelos_ganhos','defesas_goleiro','gols_evitados','erros_resultaram_finalizacao',
    'erros_resultaram_gol','faltas','escanteios','impedimentos','cartoes_amarelos',
    'cartao_vermelho'
];

let limitesLigaPorCompeticao = {};

const round3 = val =>
    Number.isFinite(val)
        ? Math.round(val * 1000) / 1000
        : null;

function valorNumerico(valor) {
    if (valor === null || valor === undefined || valor === '') return null;

    const n = Number(valor);

    return Number.isFinite(n) ? n : null;
}

function normalizarId(id) {
    return id === null || id === undefined
        ? null
        : String(id);
}

function nomeColunaSeguro(nome) {
    return nome
        .toString()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_');
}

function calcularMediaPonderada(itens) {
    const validos = itens.filter(
        x => x && Number.isFinite(x.valor)
    );

    if (!validos.length) return null;

    const soma = validos.reduce(
        (total, item) => total + item.valor,
        0
    );

    return round3(soma / validos.length);
}

function calcularMedianaPonderada(itens) {
    const validos = itens
        .filter(x => x && Number.isFinite(x.valor))
        .map(x => x.valor)
        .sort((a, b) => a - b);

    if (!validos.length) return null;

    const meio = Math.floor(validos.length / 2);

    if (validos.length % 2 === 0) {
        return round3(
            (validos[meio - 1] + validos[meio]) / 2
        );
    }

    return round3(validos[meio]);
}

async function carregarLimitesLiga() {
    console.log('Carregando régua das competições...');

    const res = await client.query(`
        SELECT
            id_competicao,
            metrica,
            casa_limite_fraco,
            casa_limite_forte,
            fora_limite_fraco,
            fora_limite_forte
        FROM grid_metricas_competicoes
    `);

    limitesLigaPorCompeticao = {};

    for (const row of res.rows) {
        const idComp = Number(row.id_competicao);
        const metrica = nomeColunaSeguro(row.metrica);

        if (!Number.isFinite(idComp) || !metrica) continue;

        if (!limitesLigaPorCompeticao[idComp]) {
            limitesLigaPorCompeticao[idComp] = {};
        }

        limitesLigaPorCompeticao[idComp][metrica] = {
            casa_fraco: valorNumerico(row.casa_limite_fraco),
            casa_forte: valorNumerico(row.casa_limite_forte),
            fora_fraco: valorNumerico(row.fora_limite_fraco),
            fora_forte: valorNumerico(row.fora_limite_forte)
        };
    }

    console.log(
        `Réguas carregadas: ${Object.keys(limitesLigaPorCompeticao).length} competições.`
    );
}

function avaliarNivel(idCompeticao, metrica, valor, mando) {
    if (!Number.isFinite(valor)) return 'N/A';

    const comp = limitesLigaPorCompeticao[idCompeticao];

    if (!comp) return 'N/A';

    const limites = comp[metrica];

    if (!limites) return 'N/A';

    const fraco =
        mando === 'CASA'
            ? limites.casa_fraco
            : limites.fora_fraco;

    const forte =
        mando === 'CASA'
            ? limites.casa_forte
            : limites.fora_forte;

    if (!Number.isFinite(fraco) || !Number.isFinite(forte)) {
        return 'N/A';
    }

    if (valor < fraco) return 'BAIXO';

    if (valor > forte) return 'ALTO';

    return 'MEDIO';
}

function criarGrupo() {
    return {
        qtd: 0,
        jogos: [],
        metricas: Object.fromEntries(
            metricasAlvo.map(m => [m, []])
        ),
        adv_metricas: Object.fromEntries(
            metricasAlvo.map(m => [m, []])
        )
    };
}

function copiarMetricas(stats) {
    const resultado = {};

    if (!stats) return resultado;

    for (const metrica of metricasAlvo) {
        const valor = valorNumerico(stats[metrica]);

        if (valor !== null) {
            resultado[metrica] = valor;
        }
    }

    return resultado;
}

function adicionarJogoAoGrupo(
    grupo,
    statsTime,
    statsAdv,
    jogoInfo
) {
    if (!grupo) return;

    grupo.qtd++;

    grupo.jogos.push({
        ...jogoInfo,
        stats_time: copiarMetricas(statsTime),
        stats_adv: copiarMetricas(statsAdv)
    });
}

function recalcularPesosDoGrupo(grupo) {
    if (!grupo?.jogos?.length) return;

    grupo.metricas = Object.fromEntries(
        metricasAlvo.map(m => [m, []])
    );

    grupo.adv_metricas = Object.fromEntries(
        metricasAlvo.map(m => [m, []])
    );

    grupo.gols = [];
    grupo.gols_sofridos = [];

    for (const jogo of grupo.jogos) {

        // ========================================================
        // TODOS OS JOGOS POSSUEM O MESMO PESO.
        // NÃO EXISTE PESO POR RECÊNCIA.
        // ========================================================
        const peso = 1;

        jogo.peso = peso;

        for (const m of metricasAlvo) {
            const v = valorNumerico(
                jogo.stats_time?.[m]
            );

            const a = valorNumerico(
                jogo.stats_adv?.[m]
            );

            if (v !== null) {
                grupo.metricas[m].push({
                    valor: v,
                    peso
                });
            }

            if (a !== null) {
                grupo.adv_metricas[m].push({
                    valor: a,
                    peso
                });
            }
        }

        if (Number.isFinite(jogo.gols)) {
            grupo.gols.push({
                valor: jogo.gols,
                peso
            });
        }

        if (Number.isFinite(jogo.gols_sofridos)) {
            grupo.gols_sofridos.push({
                valor: jogo.gols_sofridos,
                peso
            });
        }
    }
}

function calcularDadosGrupo(grupo) {
    if (!grupo || !grupo.qtd) return null;

    const dados = {
        quantidade_jogos: grupo.qtd
    };

    for (const metrica of metricasAlvo) {
        dados[`media_${metrica}`] =
            calcularMediaPonderada(
                grupo.metricas[metrica] || []
            );

        dados[`mediana_${metrica}`] =
            calcularMedianaPonderada(
                grupo.metricas[metrica] || []
            );

        dados[`media_adv_${metrica}`] =
            calcularMediaPonderada(
                grupo.adv_metricas[metrica] || []
            );

        dados[`mediana_adv_${metrica}`] =
            calcularMedianaPonderada(
                grupo.adv_metricas[metrica] || []
            );
    }

    return dados;
}

function criarEstruturaTime(idTime, nomeTime) {
    return {
        flashscore_id_time: idTime,
        nome_time: nomeTime,
        id_competicao: null,

        mandos: {
            CASA: {
                GE: criarGrupo(),
                '1T': criarGrupo(),
                '2T': criarGrupo()
            },

            FORA: {
                GE: criarGrupo(),
                '1T': criarGrupo(),
                '2T': criarGrupo()
            }
        },

        adversarios: {
            CASA: {
                GE: {
                    ATAQUE: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    },
                    DEFESA: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    }
                },

                '1T': {
                    ATAQUE: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    },
                    DEFESA: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    }
                },

                '2T': {
                    ATAQUE: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    },
                    DEFESA: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    }
                }
            },

            FORA: {
                GE: {
                    ATAQUE: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    },
                    DEFESA: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    }
                },

                '1T': {
                    ATAQUE: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    },
                    DEFESA: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    }
                },

                '2T': {
                    ATAQUE: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    },
                    DEFESA: {
                        FORTE: criarGrupo(),
                        MEDIO: criarGrupo(),
                        FRACO: criarGrupo()
                    }
                }
            }
        }
    };
}

async function criarTabelaNova() {
    console.log('Removendo tabela antiga...');

    await client.query(`
        DROP TABLE IF EXISTS perfil_times_estatisticas
    `);

    console.log('Criando nova tabela...');

    const colunas = [
        'id BIGSERIAL PRIMARY KEY',
        'flashscore_id_time TEXT NOT NULL',
        'nome_time TEXT NOT NULL',
        'id_competicao INTEGER NOT NULL',
        'mando VARCHAR(4) NOT NULL CHECK (mando IN (\'CASA\',\'FORA\'))',
        'periodo VARCHAR(5) NOT NULL CHECK (periodo IN (\'GE\',\'1T\',\'2T\'))',
        'tipo_adv VARCHAR(10) NOT NULL CHECK (tipo_adv IN (\'TODOS\',\'ATAQUE\',\'DEFESA\'))',
        'classe_adv VARCHAR(10)',
        'quantidade_jogos INTEGER NOT NULL DEFAULT 0'
    ];

    for (const metrica of metricasAlvo) {
        colunas.push(`media_${metrica} NUMERIC`);
        colunas.push(`mediana_${metrica} NUMERIC`);
        colunas.push(`nivel_media_${metrica} VARCHAR(10)`);
        colunas.push(`nivel_mediana_${metrica} VARCHAR(10)`);

        colunas.push(`media_adv_${metrica} NUMERIC`);
        colunas.push(`mediana_adv_${metrica} NUMERIC`);
        colunas.push(`nivel_media_adv_${metrica} VARCHAR(10)`);
        colunas.push(`nivel_mediana_adv_${metrica} VARCHAR(10)`);
    }

    colunas.push(
        'atualizado_em TIMESTAMP NOT NULL DEFAULT NOW()'
    );

    await client.query(`
        CREATE TABLE perfil_times_estatisticas (
            ${colunas.join(',\n')}
        )
    `);

    await client.query(`
        CREATE UNIQUE INDEX perfil_times_estatisticas_unico
        ON perfil_times_estatisticas (
            flashscore_id_time,
            id_competicao,
            mando,
            periodo,
            tipo_adv,
            classe_adv
        )
    `);

    console.log('Nova tabela criada.');
}

async function carregarTimesECompeticaoPredominante() {
    console.log(
        '\n[ETAPA 1] Determinando competição predominante dos times...'
    );

    const res = await client.query(`
        WITH jogos_validos AS (
            SELECT
                j.flashscore_id,
                j.flashscore_id_time_casa,
                j.flashscore_id_time_fora,
                j.nome_time_casa,
                j.nome_time_fora,
                j.id_competicao
            FROM jogos j
            WHERE j.flashscore_id_time_casa IS NOT NULL
              AND j.flashscore_id_time_fora IS NOT NULL
              AND j.placar_casa IS NOT NULL
              AND j.placar_fora IS NOT NULL
              AND EXISTS (
                  SELECT 1
                  FROM estatisticas_geral eg
                  WHERE eg.flashscore_id_jogo = j.flashscore_id
              )
        ),

        participacoes AS (
            SELECT
                flashscore_id_time_casa AS flashscore_id_time,
                nome_time_casa AS nome_time,
                id_competicao
            FROM jogos_validos

            UNION ALL

            SELECT
                flashscore_id_time_fora AS flashscore_id_time,
                nome_time_fora AS nome_time,
                id_competicao
            FROM jogos_validos
        ),

        contagem AS (
            SELECT
                flashscore_id_time,
                MAX(nome_time) AS nome_time,
                id_competicao,
                COUNT(*) AS quantidade
            FROM participacoes
            GROUP BY
                flashscore_id_time,
                id_competicao
        ),

        ranking AS (
            SELECT
                *,
                ROW_NUMBER() OVER (
                    PARTITION BY flashscore_id_time
                    ORDER BY quantidade DESC, id_competicao
                ) AS rn
            FROM contagem
        )

        SELECT
            flashscore_id_time,
            nome_time,
            id_competicao,
            quantidade
        FROM ranking
        WHERE rn = 1
        ORDER BY flashscore_id_time
    `);

    const times = [];

    for (const row of res.rows) {
        const idTime =
            normalizarId(row.flashscore_id_time);

        if (!idTime) continue;

        times.push({
            flashscore_id_time: idTime,
            nome_time: row.nome_time,
            id_competicao: Number(row.id_competicao),
            quantidade: Number(row.quantidade)
        });
    }

    console.log(
        `> ${times.length} times encontrados.`
    );

    return times;
}

async function processarTime(timeInfo, indice, total) {
    const idTime = timeInfo.flashscore_id_time;
    const idComp = timeInfo.id_competicao;

    if (
        !idComp ||
        !limitesLigaPorCompeticao[idComp]
    ) {
        console.log(
            `[${indice}/${total}] ${timeInfo.nome_time} -> sem régua para competição ${idComp}.`
        );

        return;
    }

    console.log(
        `\n[${indice}/${total}] ${timeInfo.nome_time} | COMPETIÇÃO ${idComp} | ${timeInfo.quantidade} jogos`
    );

    const resJogos = await client.query(`
        SELECT
            j.flashscore_id,
            j.flashscore_id_time_casa,
            j.flashscore_id_time_fora,
            j.nome_time_casa,
            j.nome_time_fora,
            j.placar_casa,
            j.placar_fora,
            j.id_competicao,

            j.casa_classe_ataque,
            j.casa_classe_defesa,
            j.fora_classe_ataque,
            j.fora_classe_defesa

        FROM jogos j

        WHERE (
            j.flashscore_id_time_casa = $1
            OR j.flashscore_id_time_fora = $1
        )

        AND j.flashscore_id_time_casa IS NOT NULL
        AND j.flashscore_id_time_fora IS NOT NULL

        AND j.placar_casa IS NOT NULL
        AND j.placar_fora IS NOT NULL

        AND j.id_competicao = $2

        AND EXISTS (
            SELECT 1
            FROM estatisticas_geral eg
            WHERE eg.flashscore_id_jogo = j.flashscore_id
        )

        ORDER BY j.flashscore_id DESC
    `, [idTime, idComp]);

    if (!resJogos.rows.length) {
        console.log('> Nenhum jogo válido.');
        return;
    }

    const jogos = resJogos.rows;

    const idsJogos = [
        ...new Set(
            jogos.map(j =>
                normalizarId(j.flashscore_id)
            )
        )
    ];

    const colunasStats = [
        'flashscore_id_jogo',
        'flashscore_id_time_casa',
        'flashscore_id_time_fora',
        'eh_casa',
        ...metricasAlvo
    ];

    const selectStats = colunasStats
        .map(nome => `"${nome}"`)
        .join(',');

    const [
        resStatsGeral,
        resStatsPeriodo
    ] = await Promise.all([

        client.query(`
            SELECT ${selectStats}
            FROM estatisticas_geral
            WHERE flashscore_id_jogo = ANY($1::text[])
        `, [idsJogos]),

        client.query(`
            SELECT
                flashscore_id_jogo,
                flashscore_id_time_casa,
                flashscore_id_time_fora,
                eh_casa,
                periodo,
                ${metricasAlvo.map(m => `"${m}"`).join(',')}
            FROM estatisticas_por_periodo
            WHERE flashscore_id_jogo = ANY($1::text[])
        `, [idsJogos])
    ]);

    const statsGeralPorJogoTime = new Map();

    for (const s of resStatsGeral.rows) {
        const jogoId =
            normalizarId(s.flashscore_id_jogo);

        const idStatsTime =
            normalizarId(
                Number(s.eh_casa) === 1
                    ? s.flashscore_id_time_casa
                    : s.flashscore_id_time_fora
            );

        if (!jogoId || !idStatsTime) continue;

        statsGeralPorJogoTime.set(
            `${jogoId}_${idStatsTime}`,
            s
        );
    }

    const statsPeriodoPorJogoTime = new Map();

    for (const s of resStatsPeriodo.rows) {
        let periodo = String(
            s.periodo || ''
        )
            .trim()
            .toLowerCase();

        if (
            periodo === '1_tempo' ||
            periodo === '1t'
        ) {
            periodo = '1T';

        } else if (
            periodo === '2_tempo' ||
            periodo === '2t'
        ) {
            periodo = '2T';

        } else {
            periodo = periodo.toUpperCase();
        }

        if (!PERIODOS.includes(periodo)) continue;

        const jogoId =
            normalizarId(s.flashscore_id_jogo);

        const idStatsTime =
            normalizarId(
                Number(s.eh_casa) === 1
                    ? s.flashscore_id_time_casa
                    : s.flashscore_id_time_fora
            );

        if (!jogoId || !idStatsTime) continue;

        statsPeriodoPorJogoTime.set(
            `${jogoId}_${idStatsTime}_${periodo}`,
            s
        );
    }

    const time = criarEstruturaTime(
        idTime,
        timeInfo.nome_time
    );

    time.id_competicao = idComp;

    for (
        let ordem = 0;
        ordem < jogos.length;
        ordem++
    ) {
        const jogo = jogos[ordem];

        const golsCasa =
            valorNumerico(jogo.placar_casa);

        const golsFora =
            valorNumerico(jogo.placar_fora);

        if (
            golsCasa === null ||
            golsFora === null
        ) {
            continue;
        }

        const jogoId =
            normalizarId(jogo.flashscore_id);

        const ehCasa =
            normalizarId(
                jogo.flashscore_id_time_casa
            ) === idTime;

        const idAdv =
            normalizarId(
                ehCasa
                    ? jogo.flashscore_id_time_fora
                    : jogo.flashscore_id_time_casa
            );

        const nomeAdv =
            ehCasa
                ? jogo.nome_time_fora
                : jogo.nome_time_casa;

        const mando =
            ehCasa ? 'CASA' : 'FORA';

        const statsTime =
            statsGeralPorJogoTime.get(
                `${jogoId}_${idTime}`
            );

        const statsAdv =
            statsGeralPorJogoTime.get(
                `${jogoId}_${idAdv}`
            );

        if (!statsTime || !statsAdv) continue;

        // ========================================================
        // IDENTIFICA A CLASSE DO ADVERSÁRIO
        //
        // Se o time analisado está CASA:
        //   adversário é o FORA
        //
        // Se o time analisado está FORA:
        //   adversário é o CASA
        // ========================================================

        const classeAdvAtaque =
            String(
                ehCasa
                    ? jogo.fora_classe_ataque
                    : jogo.casa_classe_ataque
            )
                .trim()
                .toUpperCase();

        const classeAdvDefesa =
            String(
                ehCasa
                    ? jogo.fora_classe_defesa
                    : jogo.casa_classe_defesa
            )
                .trim()
                .toUpperCase();

        const classeAtaqueValida =
            CLASSES_ADV.includes(
                classeAdvAtaque
            );

        const classeDefesaValida =
            CLASSES_ADV.includes(
                classeAdvDefesa
            );

        const info = {
            jogo_id: jogoId,
            ordem,
            id_competicao: Number(
                jogo.id_competicao
            ),
            adversario_id: idAdv,
            adversario_nome: nomeAdv,

            classe_adv_ataque:
                classeAtaqueValida
                    ? classeAdvAtaque
                    : null,

            classe_adv_defesa:
                classeDefesaValida
                    ? classeAdvDefesa
                    : null,

            gols:
                ehCasa
                    ? golsCasa
                    : golsFora,

            gols_sofridos:
                ehCasa
                    ? golsFora
                    : golsCasa
        };

        // ========================================================
        // GRUPO GERAL
        // ========================================================

        adicionarJogoAoGrupo(
            time.mandos[mando].GE,
            statsTime,
            statsAdv,
            info
        );

        // ========================================================
        // CLASSIFICAÇÃO DO ADVERSÁRIO - ATAQUE
        // ========================================================

        if (classeAtaqueValida) {
            adicionarJogoAoGrupo(
                time.adversarios[mando].GE.ATAQUE[
                    classeAdvAtaque
                ],
                statsTime,
                statsAdv,
                info
            );
        }

        // ========================================================
        // CLASSIFICAÇÃO DO ADVERSÁRIO - DEFESA
        // ========================================================

        if (classeDefesaValida) {
            adicionarJogoAoGrupo(
                time.adversarios[mando].GE.DEFESA[
                    classeAdvDefesa
                ],
                statsTime,
                statsAdv,
                info
            );
        }

        // ========================================================
        // PRIMEIRO E SEGUNDO TEMPO
        // ========================================================

        for (const periodo of ['1T', '2T']) {

            const statsPeriodoTime =
                statsPeriodoPorJogoTime.get(
                    `${jogoId}_${idTime}_${periodo}`
                );

            const statsPeriodoAdv =
                statsPeriodoPorJogoTime.get(
                    `${jogoId}_${idAdv}_${periodo}`
                );

            if (
                !statsPeriodoTime ||
                !statsPeriodoAdv
            ) {
                continue;
            }

            const infoPeriodo = {
                ...info,
                periodo
            };

            // GRUPO GERAL

            adicionarJogoAoGrupo(
                time.mandos[mando][periodo],
                statsPeriodoTime,
                statsPeriodoAdv,
                infoPeriodo
            );

            // ADVERSÁRIO - ATAQUE

            if (classeAtaqueValida) {
                adicionarJogoAoGrupo(
                    time.adversarios[mando][periodo].ATAQUE[
                        classeAdvAtaque
                    ],
                    statsPeriodoTime,
                    statsPeriodoAdv,
                    infoPeriodo
                );
            }

            // ADVERSÁRIO - DEFESA

            if (classeDefesaValida) {
                adicionarJogoAoGrupo(
                    time.adversarios[mando][periodo].DEFESA[
                        classeAdvDefesa
                    ],
                    statsPeriodoTime,
                    statsPeriodoAdv,
                    infoPeriodo
                );
            }
        }
    }

    const linhas = [];

    // ============================================================
    // FUNÇÃO PARA GERAR LINHA DE RESULTADO
    // ============================================================

    function gerarLinha(
        grupo,
        mando,
        periodo,
        tipoAdv,
        classeAdv
    ) {
        if (
            !grupo ||
            grupo.qtd < MIN_JOGOS
        ) {
            return;
        }

        recalcularPesosDoGrupo(grupo);

        const dados =
            calcularDadosGrupo(grupo);

        if (!dados) return;

        const linha = {
            flashscore_id_time:
                time.flashscore_id_time,

            nome_time:
                time.nome_time,

            id_competicao:
                idComp,

            mando,

            periodo,

            tipo_adv:
                tipoAdv,

            classe_adv:
                classeAdv,

            quantidade_jogos:
                grupo.qtd
        };

        for (const metrica of metricasAlvo) {

            const media =
                dados[`media_${metrica}`];

            const mediana =
                dados[`mediana_${metrica}`];

            const mediaAdv =
                dados[`media_adv_${metrica}`];

            const medianaAdv =
                dados[`mediana_adv_${metrica}`];

            linha[`media_${metrica}`] =
                media;

            linha[`mediana_${metrica}`] =
                mediana;

            linha[`nivel_media_${metrica}`] =
                avaliarNivel(
                    idComp,
                    metrica,
                    media,
                    mando
                );

            linha[`nivel_mediana_${metrica}`] =
                avaliarNivel(
                    idComp,
                    metrica,
                    mediana,
                    mando
                );

            linha[`media_adv_${metrica}`] =
                mediaAdv;

            linha[`mediana_adv_${metrica}`] =
                medianaAdv;

            linha[`nivel_media_adv_${metrica}`] =
                avaliarNivel(
                    idComp,
                    metrica,
                    mediaAdv,
                    mando === 'CASA'
                        ? 'FORA'
                        : 'CASA'
                );

            linha[`nivel_mediana_adv_${metrica}`] =
                avaliarNivel(
                    idComp,
                    metrica,
                    medianaAdv,
                    mando === 'CASA'
                        ? 'FORA'
                        : 'CASA'
                );
        }

        linhas.push(linha);
    }

    // ============================================================
    // GERA TODAS AS LINHAS
    // ============================================================

    for (const mando of MANDOS) {

        for (const periodo of PERIODOS) {

            // ----------------------------------------------------
            // 1. PERFIL GERAL
            // ----------------------------------------------------

            gerarLinha(
                time.mandos[mando][periodo],
                mando,
                periodo,
                'TODOS',
                null
            );

            // ----------------------------------------------------
            // 2. PERFIL CONTRA ATAQUE DO ADVERSÁRIO
            // ----------------------------------------------------

            for (const classe of CLASSES_ADV) {

                gerarLinha(
                    time.adversarios[mando][periodo].ATAQUE[
                        classe
                    ],
                    mando,
                    periodo,
                    'ATAQUE',
                    classe
                );
            }

            // ----------------------------------------------------
            // 3. PERFIL CONTRA DEFESA DO ADVERSÁRIO
            // ----------------------------------------------------

            for (const classe of CLASSES_ADV) {

                gerarLinha(
                    time.adversarios[mando][periodo].DEFESA[
                        classe
                    ],
                    mando,
                    periodo,
                    'DEFESA',
                    classe
                );
            }
        }
    }

    if (linhas.length) {
        await salvarResultadosEmLotes(linhas);
    }

    time.mandos = null;
    time.adversarios = null;

    resJogos.rows.length = 0;
    resStatsGeral.rows.length = 0;
    resStatsPeriodo.rows.length = 0;

    statsGeralPorJogoTime.clear();
    statsPeriodoPorJogoTime.clear();

    console.log(
        `> ${timeInfo.nome_time}: ${linhas.length} registros agregados.`
    );
}

async function salvarResultadosEmLotes(linhas) {
    const TAMANHO_LOTE = 20;

    const colunas =
        Object.keys(linhas[0]);

    const colunasSql =
        colunas.join(', ');

    for (
        let i = 0;
        i < linhas.length;
        i += TAMANHO_LOTE
    ) {
        const lote =
            linhas.slice(
                i,
                i + TAMANHO_LOTE
            );

        const valores = [];
        const blocos = [];

        let contador = 1;

        for (const linha of lote) {

            const placeholders = [];

            for (const coluna of colunas) {

                placeholders.push(
                    `$${contador++}`
                );

                valores.push(
                    linha[coluna]
                );
            }

            blocos.push(
                `(${placeholders.join(',')})`
            );
        }

        const updates =
            colunas
                .filter(c => ![
                    'flashscore_id_time',
                    'id_competicao',
                    'mando',
                    'periodo',
                    'tipo_adv',
                    'classe_adv'
                ].includes(c))
                .map(
                    c =>
                        `${c}=EXCLUDED.${c}`
                )
                .join(', ');

        try {

            await client.query(`
                INSERT INTO perfil_times_estatisticas (
                    ${colunasSql}
                )
                VALUES ${blocos.join(',')}
                ON CONFLICT (
                    flashscore_id_time,
                    id_competicao,
                    mando,
                    periodo,
                    tipo_adv,
                    classe_adv
                )
                DO UPDATE SET
                    ${updates},
                    atualizado_em=NOW()
            `, valores);

        } catch (erro) {

            console.error(
                'Erro ao salvar lote:',
                erro.message
            );
        }
    }
}

async function processamentoCompleto() {
    console.log(
        '\n============================================================'
    );

    console.log(
        ' INICIANDO AGREGAÇÃO DAS ESTATÍSTICAS DOS TIMES'
    );

    console.log(
        '============================================================'
    );

    const times =
        await carregarTimesECompeticaoPredominante();

    if (!times.length) {
        console.log(
            'Nenhum time encontrado.'
        );

        return;
    }

    console.log(
        `\n[ETAPA 2] Processando ${times.length} times individualmente...`
    );

    for (
        let i = 0;
        i < times.length;
        i++
    ) {

        try {

            await processarTime(
                times[i],
                i + 1,
                times.length
            );

            if (
                i < times.length - 1
            ) {
                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            10
                        )
                );
            }

        } catch (erro) {

            console.error(
                `ERRO processando ${times[i].nome_time}:`,
                erro.message
            );
        }
    }

    console.log(
        '\n============================================================'
    );

    console.log(
        ' PROCESSAMENTO DE TODOS OS TIMES CONCLUIDO'
    );

    console.log(
        '============================================================'
    );
}

async function main() {
    console.time(
        'Tempo Total de Processamento'
    );

    try {

        await client.connect();

        console.log(
            'Banco conectado.'
        );

        await carregarLimitesLiga();

        await criarTabelaNova();

        await processamentoCompleto();

        console.log(
            '\nProcessamento finalizado com sucesso.'
        );

    } catch (erro) {

        console.error(
            'ERRO FATAL:',
            erro
        );

    } finally {

        try {
            await client.end();
        } catch (e) {}

        console.timeEnd(
            'Tempo Total de Processamento'
        );
    }
}

main();