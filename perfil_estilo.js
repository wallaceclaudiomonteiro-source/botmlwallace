// ============================================================================
// PERFIL DE ESTILO
// Camada de contexto comportamental.
// NÃO entra diretamente no lambda de nenhum mercado.
// ============================================================================

const METRICAS_CONTROLE = [
    'posse_bola',
    'passes_porcentagem',
    'passes_terco_final_porcentagem'
];

const METRICAS_DIRETIVIDADE = [
    'passes_longos_porcentagem',
    'cruzamentos_total',
    'passes_profundidade_certos'
];

const METRICAS_PRESSAO = [
    'desarmes_total',
    'interceptacoes',
    'faltas'
];

// Qualidade/eficiência ofensiva
const METRICAS_PERIGO = [
    'xg_por_chute',
    'precisao_finalizacao',
    'gols_por_chute'
];

// ============================================================================
// NOVO:
// Mercados produtivos que serão analisados separadamente.
// ============================================================================

const METRICAS_MERCADOS = [
    'gols_marcados',
    'xg',
    'xgot',
    'escanteios',
    'cartoes'
];

const TODAS_METRICAS = [
    ...METRICAS_CONTROLE,
    ...METRICAS_DIRETIVIDADE,
    ...METRICAS_PRESSAO,
    ...METRICAS_PERIGO,
    ...METRICAS_MERCADOS
];

// ============================================================================
// EXTRAI AS MÉTRICAS
// ============================================================================

function extrairMetricas(linha) {
    const valores = {};

    const xg = Number(linha.xg);
    const xgot = Number(linha.xgot);

    const chutes = Number(linha.finalizacoes);
    const noGol = Number(linha.finalizacoes_no_gol);
    const gols = Number(linha.gols_marcados);

    valores.xg = Number.isFinite(xg) ? xg : null;
    valores.xgot = Number.isFinite(xgot) ? xgot : null;

    valores.gols_marcados =
        Number.isFinite(gols) ? gols : null;

    valores.escanteios =
        Number.isFinite(Number(linha.escanteios))
            ? Number(linha.escanteios)
            : null;

    valores.cartoes =
        Number.isFinite(Number(linha.cartoes))
            ? Number(linha.cartoes)
            : null;

    // ------------------------------------------------------------------------
    // Eficiências
    // ------------------------------------------------------------------------

    valores.xg_por_chute =
        Number.isFinite(chutes) && chutes > 0 && Number.isFinite(xg)
            ? xg / chutes
            : null;

    valores.precisao_finalizacao =
        Number.isFinite(chutes) && chutes > 0 && Number.isFinite(noGol)
            ? noGol / chutes
            : null;

    valores.gols_por_chute =
        Number.isFinite(chutes) && chutes > 0 && Number.isFinite(gols)
            ? gols / chutes
            : null;

    // ------------------------------------------------------------------------
    // Métricas normais
    // ------------------------------------------------------------------------

    const metricasNormais = [
        ...METRICAS_CONTROLE,
        ...METRICAS_DIRETIVIDADE,
        ...METRICAS_PRESSAO
    ];

    for (const m of metricasNormais) {
        const v = Number(linha[m]);

        valores[m] =
            Number.isFinite(v)
                ? v
                : null;
    }

    return valores;
}

// ============================================================================
// ACUMULADORES
// ============================================================================

function construirAcumuladores(historico) {
    const acc = {};

    for (const m of TODAS_METRICAS) {
        acc[m] = {
            soma: 0,
            somaQuadrados: 0,
            n: 0
        };
    }

    for (const jogo of historico) {
        for (const m of TODAS_METRICAS) {
            const v = jogo[m];

            if (v === null || !Number.isFinite(v)) {
                continue;
            }

            acc[m].soma += v;
            acc[m].somaQuadrados += v * v;
            acc[m].n += 1;
        }
    }

    return acc;
}

// ============================================================================
// MÉDIA / DESVIO LEAVE-ONE-OUT
// ============================================================================

function mediaDesvioExcluindo(acumulador, valorDoJogo) {
    if (
        valorDoJogo === null ||
        !Number.isFinite(valorDoJogo)
    ) {
        return null;
    }

    const n = acumulador.n - 1;

    if (n < 5) {
        return null;
    }

    const soma =
        acumulador.soma - valorDoJogo;

    const somaQuadrados =
        acumulador.somaQuadrados -
        valorDoJogo * valorDoJogo;

    const media =
        soma / n;

    const variancia =
        Math.max(
            0,
            somaQuadrados / n -
            media * media
        );

    const desvio =
        Math.sqrt(variancia);

    return {
        media,
        desvio:
            desvio > 0.00001
                ? desvio
                : null
    };
}

// ============================================================================
// Z-SCORES
// ============================================================================

function calcularZScoresJogo(jogo, acumuladores) {
    const zScores = {};

    for (const m of TODAS_METRICAS) {
        const valor = jogo[m];

        const stats =
            mediaDesvioExcluindo(
                acumuladores[m],
                valor
            );

        if (
            stats === null ||
            stats.desvio === null
        ) {
            zScores[m] = null;
            continue;
        }

        zScores[m] =
            (valor - stats.media) /
            stats.desvio;
    }

    return zScores;
}

// ============================================================================
// AGREGA EIXO
// ============================================================================

function agregarEixo(zScores, metricasDoEixo) {
    const validos =
        metricasDoEixo
            .map(m => zScores[m])
            .filter(
                z =>
                    z !== null &&
                    Number.isFinite(z)
            );

    if (validos.length === 0) {
        return null;
    }

    return (
        validos.reduce(
            (soma, z) => soma + z,
            0
        ) / validos.length
    );
}

// ============================================================================
// EIXOS
// ============================================================================

function calcularEixosJogo(jogo, acumuladores) {
    const zScores =
        calcularZScoresJogo(
            jogo,
            acumuladores
        );

    return {
        zControle:
            agregarEixo(
                zScores,
                METRICAS_CONTROLE
            ),

        zDiretividade:
            agregarEixo(
                zScores,
                METRICAS_DIRETIVIDADE
            ),

        zPressao:
            agregarEixo(
                zScores,
                METRICAS_PRESSAO
            ),

        zPerigo:
            agregarEixo(
                zScores,
                METRICAS_PERIGO
            ),

        zScoresBrutos:
            zScores
    };
}

// ============================================================================
// IDENTIDADE
// ============================================================================

function calcularIdentidadeMedia(historico) {
    const acc =
        construirAcumuladores(
            historico
        );

    const media = {};

    for (const m of TODAS_METRICAS) {
        media[m] =
            acc[m].n > 0
                ? acc[m].soma / acc[m].n
                : null;
    }

    return media;
}

// ============================================================================
// MEDIANA
// ============================================================================

function mediana(valores) {
    const arr =
        valores
            .filter(
                v =>
                    v !== null &&
                    Number.isFinite(v)
            )
            .sort((a, b) => a - b);

    if (arr.length === 0) {
        return null;
    }

    const meio =
        Math.floor(arr.length / 2);

    if (arr.length % 2 === 0) {
        return (
            arr[meio - 1] +
            arr[meio]
        ) / 2;
    }

    return arr[meio];
}

// ============================================================================
// MEDIANAS DOS MERCADOS
// ============================================================================

function calcularMedianasMercados(historico) {
    const resultado = {};

    for (const m of METRICAS_MERCADOS) {
        resultado[m] =
            mediana(
                historico.map(
                    jogo => jogo[m]
                )
            );
    }

    return resultado;
}

// ============================================================================
// MEDIANAS DOS MERCADOS POR SUBCONJUNTO
// ============================================================================

function calcularMedianasSubgrupo(jogos) {
    return calcularMedianasMercados(jogos);
}

module.exports = {
    METRICAS_CONTROLE,
    METRICAS_DIRETIVIDADE,
    METRICAS_PRESSAO,
    METRICAS_PERIGO,
    METRICAS_MERCADOS,
    TODAS_METRICAS,

    extrairMetricas,
    construirAcumuladores,
    calcularZScoresJogo,
    calcularEixosJogo,
    calcularIdentidadeMedia,

    mediana,
    calcularMedianasMercados,
    calcularMedianasSubgrupo
};