const { criarClient } = require('./db');
const client = criarClient('modelo');

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
    'faltas', 'faltas_cobradas', 'laterais_cobradas', 'escanteios', 'impedimentos', 'cartoes_amarelos',
    'cartao_vermelho'
];

// ==========================================
// FUNÇÕES EWMA, MEDIANA E LIMITES
// ==========================================

function round3(num) {
    return Math.round(num * 1000) / 1000;
}

function pesoCanonico(idx) {
    const alpha = 0.15;
    return Math.pow(1 - alpha, idx);
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

    return somaPesos > 0
        ? round3(somaPesada / somaPesos)
        : 0;
}

function calcularMediana(valores) {
    const numeros = valores
        .filter(v => v !== null && v !== undefined && !isNaN(v))
        .map(Number)
        .sort((a, b) => a - b);

    const total = numeros.length;

    if (total === 0) return null;

    const meio = Math.floor(total / 2);

    if (total % 2 !== 0) {
        return round3(numeros[meio]);
    }

    return round3(
        (numeros[meio - 1] + numeros[meio]) / 2
    );
}

function calcularLimitesDaLiga(valores) {
    const numeros = valores
        .filter(r => r !== null && r !== undefined && !isNaN(r))
        .map(r => parseFloat(r));

    numeros.sort((a, b) => a - b);

    const total = numeros.length;

    if (total === 0) {
        return {
            limite_fraco: null,
            limite_forte: null
        };
    }

    const index33 = Math.floor(total * 0.33);
    const index66 = Math.floor(total * 0.66);

    return {
        limite_fraco: numeros[index33],
        limite_forte: numeros[index66]
    };
}

// ==========================================
// BUSCA E CÁLCULO POR TIME
// ==========================================

async function calcularMetricasTimeWMA(
    client,
    idCompeticao,
    flashscoreIdTime,
    mando,
    buscarQualquerCompeticao = false
) {
    const valorEhCasa = mando === 'C' ? 1 : 0;

    const colunaTime =
        valorEhCasa === 1
            ? 'j.flashscore_id_time_casa'
            : 'j.flashscore_id_time_fora';

    let query;
    let params;

    if (buscarQualquerCompeticao) {
        query = `
            SELECT e.*
            FROM jogos j
            INNER JOIN estatisticas_geral e
                ON j.flashscore_id = e.flashscore_id_jogo
            WHERE ${colunaTime} = $1
              AND e.eh_casa = $2
            ORDER BY j.data_jogo DESC
            LIMIT 10
        `;

        params = [
            flashscoreIdTime,
            valorEhCasa
        ];

    } else {
        query = `
            SELECT e.*
            FROM jogos j
            INNER JOIN estatisticas_geral e
                ON j.flashscore_id = e.flashscore_id_jogo
            WHERE j.id_competicao = $1
              AND ${colunaTime} = $2
              AND e.eh_casa = $3
            ORDER BY j.data_jogo DESC
            LIMIT 10
        `;

        params = [
            idCompeticao,
            flashscoreIdTime,
            valorEhCasa
        ];
    }

    const { rows } = await client.query(query, params);

    if (rows.length === 0) {
        return null;
    }

    // ==========================================
    // CONSIDERA SOMENTE JOGOS COM XG VÁLIDO
    // ==========================================

    const jogosValidos = rows.filter(linha => {
        const xg = linha.xg;

        return (
            xg !== null &&
            xg !== undefined &&
            xg !== '' &&
            !Number.isNaN(Number(xg))
        );
    });

    // ==========================================
    // MÍNIMO DE 5 JOGOS COM XG
    // ==========================================

    if (jogosValidos.length < 5) {
        return null;
    }

    const metricasTime = {};

    metricasAlvo.forEach(coluna => {
        const itensComPeso = [];

        jogosValidos.forEach((linhaStat, idx) => {
            const peso = pesoCanonico(idx);
            const valorRaw = linhaStat[coluna];

            if (
                valorRaw !== null &&
                valorRaw !== undefined &&
                valorRaw !== '' &&
                !Number.isNaN(Number(valorRaw))
            ) {
                itensComPeso.push({
                    valor: Number(valorRaw),
                    peso
                });
            }
        });

        metricasTime[coluna] =
            calcularMediaPonderadaEstatistica(itensComPeso);
    });

    return metricasTime;
}


// ==========================================
// MOTOR PRINCIPAL
// ==========================================

async function gerarGridMetricasLiga(client, liga) {
    console.log(`\n=========================================`);
    console.log(
        `[ID: ${liga.id}] Calculando Grid de Métricas: ${liga.nome}`
    );
    let isCopa = false;
    // ==========================================
    // 1. TENTA IDENTIFICAR COMO LIGA NORMAL
    // ==========================================

    const queryTimes = `
        SELECT DISTINCT flashscore_id_time
        FROM classificacao_geral_2026
        WHERE flashscore_slug_liga = $1
          AND flashscore_slug_pais = $2
          AND classificacao_tipo = 'GERAL'
    `;

    const resTimes = await client.query(
        queryTimes,
        [
            liga.flashscore_slug,
            liga.flashscore_slug_pais
        ]
    );

    let listaIdsTimes =
        resTimes.rows.map(t => t.flashscore_id_time);



    // ==========================================
    // 2. SE NÃO FOR LIGA, É COPA (NACIONAL OU INTERNACIONAL)
    // ==========================================

    if (listaIdsTimes.length === 0) {
        isCopa = true;
        console.log(
            `🏆 [COPA DETECTADA] Calculando grid baseado exclusivamente nos times participantes de ${liga.nome}...`
        );

        const queryTimesCopa = `
            SELECT DISTINCT time_id
            FROM (
                SELECT flashscore_id_time_casa AS time_id
                FROM jogos
                WHERE id_competicao = $1
                  AND flashscore_id_time_casa IS NOT NULL

                UNION

                SELECT flashscore_id_time_fora AS time_id
                FROM jogos
                WHERE id_competicao = $1
                  AND flashscore_id_time_fora IS NOT NULL
            ) sub
        `;

        const resCopa = await client.query(queryTimesCopa, [liga.id]);

        listaIdsTimes = resCopa.rows.map(t => t.time_id);

        console.log(
            `🌍 Encontrados ${listaIdsTimes.length} times participantes. Os que tiverem menos de 5 jogos válidos serão filtrados automaticamente.`
        );
    }

    // ==========================================
    // VALIDAÇÃO
    // ==========================================

    if (listaIdsTimes.length === 0) {
        console.log(
            `[AVISO] Nenhum time encontrado para ${liga.nome}.`
        );
        return;
    }

    // ==========================================
    // ESTRUTURA PARA ARMAZENAR VALORES
    // ==========================================

    const valoresPorMetrica = {};

    metricasAlvo.forEach(m => {
        valoresPorMetrica[m] = {
            casa: [],
            fora: []
        };
    });

    // ==========================================
    // CALCULA WMA DOS TIMES
    // ==========================================

    for (const idTime of listaIdsTimes) {
        const statsCasa =
            await calcularMetricasTimeWMA(
                client,
                liga.id,
                idTime,
                'C',
                isCopa
            );

        const statsFora =
            await calcularMetricasTimeWMA(
                client,
                liga.id,
                idTime,
                'F',
                isCopa
            );
        metricasAlvo.forEach(m => {
            if (
                statsCasa &&
                statsCasa[m] !== undefined &&
                statsCasa[m] !== null
            ) {
                valoresPorMetrica[m].casa.push(
                    statsCasa[m]
                );
            }

            if (
                statsFora &&
                statsFora[m] !== undefined &&
                statsFora[m] !== null
            ) {
                valoresPorMetrica[m].fora.push(
                    statsFora[m]
                );
            }
        });
    }

    // ==========================================
    // CALCULA MEDIANA + LIMITES E SALVA
    // ==========================================

    for (const metrica of metricasAlvo) {
        const medianaCasa =
            calcularMediana(
                valoresPorMetrica[metrica].casa
            );

        const medianaFora =
            calcularMediana(
                valoresPorMetrica[metrica].fora
            );

        const limitesCasa =
            calcularLimitesDaLiga(
                valoresPorMetrica[metrica].casa
            );

        const limitesFora =
            calcularLimitesDaLiga(
                valoresPorMetrica[metrica].fora
            );

        if (
            limitesCasa.limite_fraco !== null &&
            limitesFora.limite_fraco !== null
        ) {
            const queryUpsert = `
                INSERT INTO grid_metricas_competicoes (
                    id_competicao,
                    nome_competicao,
                    metrica,
                    casa_mediana,
                    casa_limite_fraco,
                    casa_limite_forte,
                    fora_mediana,
                    fora_limite_fraco,
                    fora_limite_forte,
                    atualizado_em
                )
                VALUES (
                    $1, $2, $3,
                    $4, $5, $6,
                    $7, $8, $9,
                    CURRENT_TIMESTAMP
                )

                ON CONFLICT (id_competicao, metrica)
                DO UPDATE SET
                    nome_competicao = EXCLUDED.nome_competicao,
                    casa_mediana = EXCLUDED.casa_mediana,
                    casa_limite_fraco = EXCLUDED.casa_limite_fraco,
                    casa_limite_forte = EXCLUDED.casa_limite_forte,
                    fora_mediana = EXCLUDED.fora_mediana,
                    fora_limite_fraco = EXCLUDED.fora_limite_fraco,
                    fora_limite_forte = EXCLUDED.fora_limite_forte,
                    atualizado_em = CURRENT_TIMESTAMP
            `;

            await client.query(queryUpsert, [
                liga.id,
                liga.nome,
                metrica,

                medianaCasa,
                limitesCasa.limite_fraco,
                limitesCasa.limite_forte,

                medianaFora,
                limitesFora.limite_fraco,
                limitesFora.limite_forte
            ]);
        }
    }

    console.log(
        `✅ Grid calculado e salvo para ${liga.nome}!`
    );
}

// ==========================================
// EXECUÇÃO
// ==========================================

async function executar() {
    try {
        await client.connect();

        const resLigas = await client.query(`
            SELECT
                id,
                flashscore_slug,
                flashscore_slug_pais,
                nome
            FROM competicoes
            WHERE pronta_para_grid = 10
            ORDER BY id ASC
        `);

        console.log(
            `Encontradas ${resLigas.rowCount} ligas/competições com grid calculado para processar métricas.`
        );

        for (const liga of resLigas.rows) {
            await gerarGridMetricasLiga(
                client,
                liga
            );
        }

    } catch (error) {
        console.error(
            'Erro na execução:',
            error.message
        );

    } finally {
        await client.end();

        console.log(
            '\nProcesso finalizado.'
        );
    }
}

executar();