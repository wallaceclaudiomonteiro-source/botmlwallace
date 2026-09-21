const { criarClient } = require('./db');
const {
    poisson, dixonColesCorrection,
    otimizarModeloConjunto, projetarExpectativaGols,
    pontosCartao, otimizarModeloCartoes, projetarExpectativaCartoes, probOverCartoes,
    otimizarModeloEscanteios, projetarExpectativaEscanteios, probOverEscanteios
} = require('./market_model');

/*
 * ================================================================
 * MERCADOS DE PERÍODO (1º TEMPO E 2º TEMPO) — AO VIVO, VIA CALENDARIO
 * ================================================================
 *
 * Versão ao vivo do script de HT: em vez de ler mle_l_home_1t/2t já
 * calculados em "jogos" (que só existem pra jogos já backtestados),
 * este script ajusta os modelos de gols/cartões/escanteios por
 * período NA HORA, por competição, pros jogos que estão em
 * "calendario" (ainda não aconteceram) — o mesmo padrão do script
 * de mercado geral já adaptado pra calendario, só que rodado duas
 * vezes por dia (uma pra 1_tempo, outra pra 2_tempo) e escrevendo
 * em analise_jogos_ht em vez de analises_jogo.
 *
 * Fonte de dados por período:
 *   - referência de liga: grid_metricas_competicoes_periodo
 *   - histórico de treino: estatisticas_por_periodo (filtrado por
 *     ep.periodo)
 *
 * A matemática dos três modelos (otimizarModeloConjunto,
 * otimizarModeloCartoes, otimizarModeloEscanteios) é a mesma do
 * script de jogo completo — só a origem dos dados muda.
 */

const client = criarClient('modelo');

const RHO_DIXON_COLES = -0.1, MAX_GOLS_GRADE = 10, JANELA_HISTORICO = '1 year', MIN_JOGOS_TREINO = 20;
const TABELA_HT = 'analise_jogos_ht';

const MERCADOS = [
    { periodoDb: '1_tempo', periodoSaida: '1T' },
    { periodoDb: '2_tempo', periodoSaida: '2T' }
];

// Só xg/xgot/gols_marcados: o modelo de gols infere a defesa a partir
// do espelho do adversário no mesmo jogo (ver market_model.js).
const METRICAS_OBRIGATORIAS_GOLS = ['xg', 'xgot', 'gols_marcados'];
const METRICAS_OBRIGATORIAS_CARTOES = ['cartoes_amarelos', 'cartao_vermelho', 'faltas', 'desarmes_total', 'duelos_ganhos'];
const METRICAS_OBRIGATORIAS_ESCANTEIOS = [
    'escanteios', 'cruzamentos_total',
    'toques_area_adversaria', 'finalizacoes_de_dentro_area', 'finalizacoes_bloqueadas',
    'rebatidas', 'defesas_goleiro', 'gols_evitados'
];

// ============================================================================
// GRADE DE RESULTADO — idêntica ao script de jogo completo / ao de HT.
// ============================================================================

function calcularGradeResultado(lambdaHome, lambdaAway, rho = RHO_DIXON_COLES, maxGols = MAX_GOLS_GRADE) {
    const grade = [];
    let somaTotal = 0;
    for (let h = 0; h <= maxGols; h++) {
        const linha = [];
        for (let a = 0; a <= maxGols; a++) {
            const pBase = poisson(lambdaHome, h) * poisson(lambdaAway, a), correcao = dixonColesCorrection(h, a, lambdaHome, lambdaAway, rho);
            const p = Math.max(0, pBase * correcao);
            linha.push(p);
            somaTotal += p;
        }
        grade.push(linha);
    }
    if (somaTotal > 0) {
        for (let h = 0; h <= maxGols; h++) {
            for (let a = 0; a <= maxGols; a++) grade[h][a] /= somaTotal;
        }
    }
    return grade;
}

// ============================================================================
// MERCADOS POR TEMPO — linhas mais baixas que o jogo completo.
// ============================================================================

function derivarProbabilidadesGolsTempo(grade) {
    const maxGols = grade.length - 1;
    let probCasa = 0, probEmpate = 0, probFora = 0, probOver05 = 0, probOver15 = 0, probOver25 = 0;
    let probBTTS = 0, probCasaOver05 = 0, probCasaOver15 = 0, probForaOver05 = 0, probForaOver15 = 0;

    for (let h = 0; h <= maxGols; h++) {
        for (let a = 0; a <= maxGols; a++) {
            const p = grade[h][a], total = h + a;
            if (h > a) probCasa += p; else if (h === a) probEmpate += p; else probFora += p;
            if (total > 0.5) probOver05 += p; if (total > 1.5) probOver15 += p; if (total > 2.5) probOver25 += p;
            if (h >= 1 && a >= 1) probBTTS += p;
            if (h >= 1) probCasaOver05 += p; if (h >= 2) probCasaOver15 += p;
            if (a >= 1) probForaOver05 += p; if (a >= 2) probForaOver15 += p;
        }
    }
    return {
        home: probCasa, draw: probEmpate, away: probFora,
        over05: probOver05, under05: 1 - probOver05,
        over15: probOver15, under15: 1 - probOver15,
        over25: probOver25, under25: 1 - probOver25,
        btts_yes: probBTTS, btts_no: 1 - probBTTS,
        casa_over05: probCasaOver05, casa_over15: probCasaOver15, fora_over05: probForaOver05, fora_over15: probForaOver15
    };
}

function derivarProbabilidadesCartoesTempo(lambdaCasa, lambdaFora) {
    const total = lambdaCasa + lambdaFora;

    const over05 = probOverCartoes(total, 0.5);
    const over15 = probOverCartoes(total, 1.5);
    const over25 = probOverCartoes(total, 2.5);
    const over35 = probOverCartoes(total, 3.5);

    const casaOver05 = probOverCartoes(lambdaCasa, 0.5);
    const casaOver15 = probOverCartoes(lambdaCasa, 1.5);
    const casaOver25 = probOverCartoes(lambdaCasa, 2.5);

    const foraOver05 = probOverCartoes(lambdaFora, 0.5);
    const foraOver15 = probOverCartoes(lambdaFora, 1.5);
    const foraOver25 = probOverCartoes(lambdaFora, 2.5);

    return {
        total,
        over05, under05: 1 - over05,
        over15, under15: 1 - over15,
        over25, under25: 1 - over25,
        over35, under35: 1 - over35,
        casa_over05: casaOver05,
        casa_over15: casaOver15,
        casa_over25: casaOver25,
        casa_under25: 1 - casaOver25,
        fora_over05: foraOver05,
        fora_over15: foraOver15,
        fora_over25: foraOver25,
        fora_under25: 1 - foraOver25
    };
}

function derivarProbabilidadesEscanteiosTempo(lambdaCasa, lambdaFora) {
    const total = lambdaCasa + lambdaFora;

    const over15 = probOverEscanteios(total, 1.5);
    const over25 = probOverEscanteios(total, 2.5);
    const over35 = probOverEscanteios(total, 3.5);
    const over45 = probOverEscanteios(total, 4.5);
    const over55 = probOverEscanteios(total, 5.5);
    const over65 = probOverEscanteios(total, 6.5);

    return {
        total,
        over15, under15: 1 - over15,
        over25, under25: 1 - over25,
        over35, under35: 1 - over35,
        over45, under45: 1 - over45,
        over55, under55: 1 - over55,
        over65, under65: 1 - over65,
        casa_over05: probOverEscanteios(lambdaCasa, 0.5),
        casa_over15: probOverEscanteios(lambdaCasa, 1.5),
        casa_over25: probOverEscanteios(lambdaCasa, 2.5),
        casa_over35: probOverEscanteios(lambdaCasa, 3.5),
        fora_over05: probOverEscanteios(lambdaFora, 0.5),
        fora_over15: probOverEscanteios(lambdaFora, 1.5),
        fora_over25: probOverEscanteios(lambdaFora, 2.5),
        fora_over35: probOverEscanteios(lambdaFora, 3.5)
    };
}

// ============================================================================
// REFERÊNCIA DE LIGA POR PERÍODO (grid pré-calculado), COM CACHE
// ============================================================================
//
// Cacheado por competição+período+conjunto de métricas, já que o mesmo
// grid é reaproveitado em todos os dias do intervalo processado.

const cacheReferenciaLiga = new Map();

async function buscarReferenciaLigaPeriodo(idCompeticao, periodoDb, metricas) {

    const chaveCache = `${idCompeticao}_${periodoDb}_${metricas.join(',')}`;

    if (cacheReferenciaLiga.has(chaveCache)) {
        return cacheReferenciaLiga.get(chaveCache);
    }

    const { rows } = await client.query(
        `SELECT metrica, casa_mediana, fora_mediana
         FROM grid_metricas_competicoes_periodo
         WHERE id_competicao = $1 AND periodo = $2 AND metrica = ANY($3)`,
        [idCompeticao, periodoDb, metricas]
    );

    const referencia = {};
    for (const row of rows) {
        referencia[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };
    }

    cacheReferenciaLiga.set(chaveCache, referencia);
    return referencia;
}

// ============================================================================
// GOLS POR PERÍODO
// ============================================================================

async function ajustarModeloGolsCompeticaoPeriodo(idCompeticao, dataAlvo, periodoDb) {

    const referenciaLiga = await buscarReferenciaLigaPeriodo(idCompeticao, periodoDb, METRICAS_OBRIGATORIAS_GOLS);

    const faltantes = METRICAS_OBRIGATORIAS_GOLS.filter(
        m => !referenciaLiga[m] || !Number.isFinite(referenciaLiga[m].casa) || !Number.isFinite(referenciaLiga[m].fora)
    );

    if (faltantes.length > 0) {
        console.log(`[PULAR GOLS ${periodoDb}] Competição ${idCompeticao}: métricas incompletas em grid_metricas_competicoes_periodo [${faltantes.join(', ')}]`);
        return null;
    }

    const { rows: historicoBruto } = await client.query(`
        SELECT
            j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
            ep.id_time, ep.eh_casa,
            ep.xg, ep.xgot, ep.gols_marcados,
            EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
        FROM jogos j
        INNER JOIN estatisticas_por_periodo ep ON ep.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND ep.periodo = $3
          AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [idCompeticao, dataAlvo, periodoDb]);

    /*
     * Não existe placar de período em "jogos" — o placar usado no
     * filtro de validade (gols_casa/gols_fora) é o próprio
     * gols_marcados de cada lado NESSE período. O MLE em si nunca lê
     * esse campo diretamente, só o filtro de jogosValidos.
     */

    const mapaJogos = new Map();

    for (const linha of historicoBruto) {

        const chave = String(linha.flashscore_id);

        if (!mapaJogos.has(chave)) {
            mapaJogos.set(chave, {
                casa_id: String(linha.flashscore_id_time_casa),
                fora_id: String(linha.flashscore_id_time_fora),
                gols_casa: null, gols_fora: null,
                xg_casa: null, xg_fora: null,
                xgot_casa: null, xgot_fora: null,
                gols_marcados_casa: null, gols_marcados_fora: null,
                peso_tempo: Number(linha.peso_tempo) || 1
            });
        }

        const jogo = mapaJogos.get(chave);

        const xg = linha.xg !== null ? Number(linha.xg) : null;
        const xgot = linha.xgot !== null ? Number(linha.xgot) : null;
        const golsMarcados = linha.gols_marcados !== null ? Number(linha.gols_marcados) : null;

        if (Number(linha.eh_casa) === 1) {
            jogo.xg_casa = xg;
            jogo.xgot_casa = xgot;
            jogo.gols_marcados_casa = golsMarcados;
            jogo.gols_casa = golsMarcados;
        }

        if (Number(linha.eh_casa) === 0) {
            jogo.xg_fora = xg;
            jogo.xgot_fora = xgot;
            jogo.gols_marcados_fora = golsMarcados;
            jogo.gols_fora = golsMarcados;
        }
    }

    const jogosValidos = Array.from(mapaJogos.values()).filter(
        j => j.casa_id && j.fora_id && Number.isFinite(j.gols_casa) && Number.isFinite(j.gols_fora)
    );

    if (jogosValidos.length < MIN_JOGOS_TREINO) {
        console.log(`[PULAR GOLS ${periodoDb}] Competição ${idCompeticao}: histórico insuficiente (${jogosValidos.length} jogos, mínimo ${MIN_JOGOS_TREINO})`);
        return null;
    }

    // Pesos mantidos iguais ao backtest_periodo.js já existente
    // (pesoXG=0.50/pesoXGOT=0.30 — invertido em relação ao jogo
    // completo, ainda não confirmado se é proposital).
    const parametros = await otimizarModeloConjunto(jogosValidos, 1500, 0.003, {
        referenciaLiga,
        pesoXG: 0.30,
        pesoXGOT: 0.50,
        pesoGols: 0.20,
        regularizacao: 0.015,
        gradienteMax: 5
    });

    console.log(`[OK GOLS ${periodoDb}] Competição ${idCompeticao}: ajustado com ${jogosValidos.length} jogos (convergiu=${parametros.convergiu}, iterações=${parametros.iteracoes})`);
    return parametros;
}

// ============================================================================
// CARTÕES POR PERÍODO — mesma lógica do modelo de jogo completo,
// só trocando estatisticas_geral/grid_metricas_competicoes por
// estatisticas_por_periodo/grid_metricas_competicoes_periodo.
// ============================================================================

async function ajustarModeloCartoesCompeticaoPeriodo(idCompeticao, dataAlvo, periodoDb) {

    const brutoLiga = await buscarReferenciaLigaPeriodo(idCompeticao, periodoDb, METRICAS_OBRIGATORIAS_CARTOES);

    const faltantes = METRICAS_OBRIGATORIAS_CARTOES.filter(
        m => !brutoLiga[m] || !Number.isFinite(brutoLiga[m].casa) || !Number.isFinite(brutoLiga[m].fora)
    );

    if (faltantes.length > 0) {
        console.log(`[PULAR CARTÕES ${periodoDb}] Competição ${idCompeticao}: métricas incompletas em grid_metricas_competicoes_periodo [${faltantes.join(', ')}]`);
        return null;
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

    const { rows: historicoBruto } = await client.query(`
        SELECT
            j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
            ep.id_time, ep.eh_casa,
            ep.cartoes_amarelos, ep.cartao_vermelho, ep.faltas, ep.desarmes_total, ep.duelos_ganhos,
            EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
        FROM jogos j
        INNER JOIN estatisticas_por_periodo ep ON ep.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND ep.periodo = $3
          AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [idCompeticao, dataAlvo, periodoDb]);

    const mapaJogos = new Map();

    for (const linha of historicoBruto) {

        const chave = String(linha.flashscore_id);

        if (!mapaJogos.has(chave)) {
            mapaJogos.set(chave, {
                casa_id: String(linha.flashscore_id_time_casa),
                fora_id: String(linha.flashscore_id_time_fora),
                cartoes_casa: null, cartoes_fora: null,
                faltas_casa: null, faltas_fora: null,
                intensidade_casa: null, intensidade_fora: null,
                peso_tempo: Number(linha.peso_tempo) || 1
            });
        }

        const jogo = mapaJogos.get(chave);

        const amarelos = linha.cartoes_amarelos !== null ? Number(linha.cartoes_amarelos) : 0;
        const vermelhos = linha.cartao_vermelho !== null ? Number(linha.cartao_vermelho) : 0;
        const cartoes = pontosCartao(amarelos, vermelhos);

        const faltas = linha.faltas !== null ? Number(linha.faltas) : null;

        const desarmes = linha.desarmes_total !== null ? Number(linha.desarmes_total) : null;
        const duelos = linha.duelos_ganhos !== null ? Number(linha.duelos_ganhos) : null;
        const intensidade = (Number.isFinite(desarmes) && Number.isFinite(duelos)) ? desarmes + duelos : null;

        if (Number(linha.eh_casa) === 1) {
            jogo.cartoes_casa = cartoes;
            jogo.faltas_casa = faltas;
            jogo.intensidade_casa = intensidade;
        }

        if (Number(linha.eh_casa) === 0) {
            jogo.cartoes_fora = cartoes;
            jogo.faltas_fora = faltas;
            jogo.intensidade_fora = intensidade;
        }
    }

    const jogosValidos = Array.from(mapaJogos.values()).filter(
        j => j.casa_id && j.fora_id && Number.isFinite(j.cartoes_casa) && Number.isFinite(j.cartoes_fora)
    );

    if (jogosValidos.length < MIN_JOGOS_TREINO) {
        console.log(`[PULAR CARTÕES ${periodoDb}] Competição ${idCompeticao}: histórico insuficiente (${jogosValidos.length} jogos, mínimo ${MIN_JOGOS_TREINO})`);
        return null;
    }

    const parametros = await otimizarModeloCartoes(jogosValidos, 1500, 0.003, {
        referenciaLiga,
        pesoCartoes: 0.55, pesoFaltasCometidas: 0.30, pesoIntensidade: 0.15,
        pesoCartoesProvocados: 0.55, pesoFaltasProvocadas: 0.30, pesoIntensidadeProvocada: 0.15,
        regularizacao: 0.02, gradienteMax: 5
    });

    console.log(`[OK CARTÕES ${periodoDb}] Competição ${idCompeticao}: ajustado com ${jogosValidos.length} jogos (convergiu=${parametros.convergiu}, iterações=${parametros.iteracoes})`);
    return parametros;
}

// ============================================================================
// ESCANTEIOS POR PERÍODO — mesmo padrão de cartões acima.
// ============================================================================

async function ajustarModeloEscanteiosCompeticaoPeriodo(idCompeticao, dataAlvo, periodoDb) {

    const referenciaLiga = await buscarReferenciaLigaPeriodo(idCompeticao, periodoDb, METRICAS_OBRIGATORIAS_ESCANTEIOS);

    const faltantes = METRICAS_OBRIGATORIAS_ESCANTEIOS.filter(
        m => !referenciaLiga[m] || !Number.isFinite(referenciaLiga[m].casa) || !Number.isFinite(referenciaLiga[m].fora)
    );

    if (faltantes.length > 0) {
        console.log(`[PULAR ESCANTEIOS ${periodoDb}] Competição ${idCompeticao}: métricas incompletas em grid_metricas_competicoes_periodo [${faltantes.join(', ')}]`);
        return null;
    }

    const { rows: historicoBruto } = await client.query(`
        SELECT
            j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
            ep.id_time, ep.eh_casa,
            ep.escanteios, ep.cruzamentos_total, ep.toques_area_adversaria,
            ep.finalizacoes_de_dentro_area, ep.finalizacoes_bloqueadas,
            ep.rebatidas, ep.defesas_goleiro, ep.gols_evitados,
            EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
        FROM jogos j
        INNER JOIN estatisticas_por_periodo ep ON ep.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND ep.periodo = $3
          AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [idCompeticao, dataAlvo, periodoDb]);

    const mapaJogos = new Map();

    for (const linha of historicoBruto) {

        const chave = String(linha.flashscore_id);

        if (!mapaJogos.has(chave)) {
            mapaJogos.set(chave, {
                casa_id: String(linha.flashscore_id_time_casa),
                fora_id: String(linha.flashscore_id_time_fora),
                escanteios_casa: null, escanteios_fora: null,
                cruzamentos_total_casa: null, cruzamentos_total_fora: null,
                toques_area_adversaria_casa: null, toques_area_adversaria_fora: null,
                finalizacoes_de_dentro_area_casa: null, finalizacoes_de_dentro_area_fora: null,
                finalizacoes_bloqueadas_casa: null, finalizacoes_bloqueadas_fora: null,
                rebatidas_casa: null, rebatidas_fora: null,
                defesas_goleiro_casa: null, defesas_goleiro_fora: null,
                gols_evitados_casa: null, gols_evitados_fora: null,
                peso_tempo: Number(linha.peso_tempo) || 1
            });
        }

        const jogo = mapaJogos.get(chave);
        const lado = Number(linha.eh_casa) === 1 ? 'casa' : (Number(linha.eh_casa) === 0 ? 'fora' : null);
        if (!lado) continue;

        jogo[`escanteios_${lado}`] = linha.escanteios !== null ? Number(linha.escanteios) : null;
        jogo[`cruzamentos_total_${lado}`] = linha.cruzamentos_total !== null ? Number(linha.cruzamentos_total) : null;
        jogo[`toques_area_adversaria_${lado}`] = linha.toques_area_adversaria !== null ? Number(linha.toques_area_adversaria) : null;
        jogo[`finalizacoes_de_dentro_area_${lado}`] = linha.finalizacoes_de_dentro_area !== null ? Number(linha.finalizacoes_de_dentro_area) : null;
        jogo[`finalizacoes_bloqueadas_${lado}`] = linha.finalizacoes_bloqueadas !== null ? Number(linha.finalizacoes_bloqueadas) : null;
        jogo[`rebatidas_${lado}`] = linha.rebatidas !== null ? Number(linha.rebatidas) : null;
        jogo[`defesas_goleiro_${lado}`] = linha.defesas_goleiro !== null ? Number(linha.defesas_goleiro) : null;
        jogo[`gols_evitados_${lado}`] = linha.gols_evitados !== null ? Number(linha.gols_evitados) : null;
    }

    const jogosValidos = Array.from(mapaJogos.values()).filter(
        j => j.casa_id && j.fora_id && Number.isFinite(j.escanteios_casa) && Number.isFinite(j.escanteios_fora)
    );

    if (jogosValidos.length < MIN_JOGOS_TREINO) {
        console.log(`[PULAR ESCANTEIOS ${periodoDb}] Competição ${idCompeticao}: histórico insuficiente (${jogosValidos.length} jogos, mínimo ${MIN_JOGOS_TREINO})`);
        return null;
    }

    const parametros = await otimizarModeloEscanteios(jogosValidos, 1500, 0.003, {
        referenciaLiga,
        pesoEscanteios: 0.6000,
        pesoCruzamentos: 0.1599,
        pesoToquesArea: 0.0979,
        pesoFinDentroArea: 0.0790,
        pesoFinBloqueadas: 0.0632,
        pesoEscanteiosConcedidos: 0.6000,
        pesoCruzamentosConcedidos: 0.1260,
        pesoToquesAreaConcedidos: 0.0771,
        pesoFinDentroAreaConcedidas: 0.0623,
        pesoRebatidas: 0.0547,
        pesoFinBloqueadasConcedidas: 0.0498,
        pesoDefesasGoleiro: 0.0205,
        pesoGolsEvitados: 0.0096,
        regularizacao: 0.02,
        gradienteMax: 5
    });

    console.log(`[OK ESCANTEIOS ${periodoDb}] Competição ${idCompeticao}: ajustado com ${jogosValidos.length} jogos (convergiu=${parametros.convergiu}, iterações=${parametros.iteracoes})`);
    return parametros;
}

// ============================================================================
// BUSCA DE JOGOS DO DIA — mesma origem (calendario) do script de
// mercado geral já adaptado.
// ============================================================================

async function buscarJogosCalendario(dataAlvo) {
    const { rows } = await client.query(`SELECT * FROM calendario WHERE data_jogo = $1`, [dataAlvo]);
    return rows;
}

// ============================================================================
// TABELA DE SAÍDA POR TEMPO (analise_jogos_ht) — idêntica ao script de HT.
// ============================================================================

async function garantirConstraintHt() {
    await client.query(`
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint WHERE conname = 'analise_jogos_ht_jogo_periodo_key'
            ) THEN
                ALTER TABLE ${TABELA_HT}
                ADD CONSTRAINT analise_jogos_ht_jogo_periodo_key UNIQUE (flashscore_id_jogo, periodo);
            END IF;
        END $$;
    `);
}

async function salvarPrevisaoTempo(jogo, periodo, lambdaHome, lambdaAway, golsProbs, cartoes, escanteios) {
    const totalGolsEsperado = lambdaHome + lambdaAway;
    const temCartoes = cartoes !== null && cartoes !== undefined;
    const temEscanteios = escanteios !== null && escanteios !== undefined;

    const campos = {
        flashscore_id_jogo: jogo.flashscore_id,
        data_jogo: jogo.data_jogo,
        hora_jogo: jogo.hora_jogo || null,
        id_time_casa: jogo.id_time_casa || null,
        id_time_fora: jogo.id_time_fora || null,
        nome_time_casa: jogo.nome_time_casa,
        nome_time_fora: jogo.nome_time_fora,
        id_competicao: jogo.id_competicao,
        nome_competicao: jogo.nome_competicao,
        pais_liga: jogo.pais_liga || null,
        rodada: jogo.rodada || null,

        p_home: (golsProbs.home * 100).toFixed(2),
        p_draw: (golsProbs.draw * 100).toFixed(2),
        p_away: (golsProbs.away * 100).toFixed(2),
        p_over05: (golsProbs.over05 * 100).toFixed(2),
        p_under05: (golsProbs.under05 * 100).toFixed(2),
        p_over15: (golsProbs.over15 * 100).toFixed(2),
        p_under15: (golsProbs.under15 * 100).toFixed(2),
        p_over25: (golsProbs.over25 * 100).toFixed(2),
        p_under25: (golsProbs.under25 * 100).toFixed(2),
        p_btts_yes: (golsProbs.btts_yes * 100).toFixed(2),
        p_btts_no: (golsProbs.btts_no * 100).toFixed(2),
        p_casa_over05: (golsProbs.casa_over05 * 100).toFixed(2),
        p_casa_over15: (golsProbs.casa_over15 * 100).toFixed(2),
        p_fora_over05: (golsProbs.fora_over05 * 100).toFixed(2),
        p_fora_over15: (golsProbs.fora_over15 * 100).toFixed(2),

        total_cantos_esperado: temEscanteios ? escanteios.total.toFixed(2) : null,
        casa_cantos_esperado: temEscanteios ? escanteios.casaExpectativa.toFixed(2) : null,
        fora_cantos_esperado: temEscanteios ? escanteios.foraExpectativa.toFixed(2) : null,
        p_cantos_over15: temEscanteios ? (escanteios.over15 * 100).toFixed(2) : null,
        p_cantos_under15: temEscanteios ? (escanteios.under15 * 100).toFixed(2) : null,
        p_cantos_over25: temEscanteios ? (escanteios.over25 * 100).toFixed(2) : null,
        p_cantos_under25: temEscanteios ? (escanteios.under25 * 100).toFixed(2) : null,
        p_cantos_over35: temEscanteios ? (escanteios.over35 * 100).toFixed(2) : null,
        p_cantos_under35: temEscanteios ? (escanteios.under35 * 100).toFixed(2) : null,
        p_cantos_over45: temEscanteios ? (escanteios.over45 * 100).toFixed(2) : null,
        p_cantos_under45: temEscanteios ? (escanteios.under45 * 100).toFixed(2) : null,
        p_cantos_over55: temEscanteios ? (escanteios.over55 * 100).toFixed(2) : null,
        p_cantos_under55: temEscanteios ? (escanteios.under55 * 100).toFixed(2) : null,
        p_cantos_over65: temEscanteios ? (escanteios.over65 * 100).toFixed(2) : null,
        p_cantos_under65: temEscanteios ? (escanteios.under65 * 100).toFixed(2) : null,
        p_casa_cantos_over05: temEscanteios ? (escanteios.casa_over05 * 100).toFixed(2) : null,
        p_casa_cantos_over15: temEscanteios ? (escanteios.casa_over15 * 100).toFixed(2) : null,
        p_casa_cantos_over25: temEscanteios ? (escanteios.casa_over25 * 100).toFixed(2) : null,
        p_casa_cantos_over35: temEscanteios ? (escanteios.casa_over35 * 100).toFixed(2) : null,
        p_fora_cantos_over05: temEscanteios ? (escanteios.fora_over05 * 100).toFixed(2) : null,
        p_fora_cantos_over15: temEscanteios ? (escanteios.fora_over15 * 100).toFixed(2) : null,
        p_fora_cantos_over25: temEscanteios ? (escanteios.fora_over25 * 100).toFixed(2) : null,
        p_fora_cantos_over35: temEscanteios ? (escanteios.fora_over35 * 100).toFixed(2) : null,

        total_cartoes_esperado: temCartoes ? cartoes.total.toFixed(2) : null,
        casa_cartoes_esperado: temCartoes ? cartoes.casaExpectativa.toFixed(2) : null,
        fora_cartoes_esperado: temCartoes ? cartoes.foraExpectativa.toFixed(2) : null,
        p_cartoes_over05: temCartoes ? (cartoes.over05 * 100).toFixed(2) : null,
        p_cartoes_under05: temCartoes ? (cartoes.under05 * 100).toFixed(2) : null,
        p_cartoes_over15: temCartoes ? (cartoes.over15 * 100).toFixed(2) : null,
        p_cartoes_under15: temCartoes ? (cartoes.under15 * 100).toFixed(2) : null,
        p_cartoes_over25: temCartoes ? (cartoes.over25 * 100).toFixed(2) : null,
        p_cartoes_under25: temCartoes ? (cartoes.under25 * 100).toFixed(2) : null,
        p_cartoes_over35: temCartoes ? (cartoes.over35 * 100).toFixed(2) : null,
        p_cartoes_under35: temCartoes ? (cartoes.under35 * 100).toFixed(2) : null,
        p_casa_cartoes_over05: temCartoes ? (cartoes.casa_over05 * 100).toFixed(2) : null,
        p_casa_cartoes_over15: temCartoes ? (cartoes.casa_over15 * 100).toFixed(2) : null,
        p_casa_cartoes_over25: temCartoes ? (cartoes.casa_over25 * 100).toFixed(2) : null,
        p_casa_cartoes_under25: temCartoes ? (cartoes.casa_under25 * 100).toFixed(2) : null,
        p_fora_cartoes_over05: temCartoes ? (cartoes.fora_over05 * 100).toFixed(2) : null,
        p_fora_cartoes_over15: temCartoes ? (cartoes.fora_over15 * 100).toFixed(2) : null,
        p_fora_cartoes_over25: temCartoes ? (cartoes.fora_over25 * 100).toFixed(2) : null,
        p_fora_cartoes_under25: temCartoes ? (cartoes.fora_under25 * 100).toFixed(2) : null,

        total_gols_esperado: totalGolsEsperado.toFixed(2),
        casa_gols_esperado: lambdaHome.toFixed(2),
        fora_gols_esperado: lambdaAway.toFixed(2),

        periodo
    };

    const colunas = Object.keys(campos);
    const valores = Object.values(campos);
    const placeholders = colunas.map((_, i) => `$${i + 1}`).join(', ');
    const updateSet = colunas
        .filter(c => c !== 'flashscore_id_jogo' && c !== 'periodo')
        .map(c => `${c} = EXCLUDED.${c}`)
        .join(',\n            ');

    await client.query(`
        INSERT INTO ${TABELA_HT} (${colunas.join(', ')})
        VALUES (${placeholders})
        ON CONFLICT (flashscore_id_jogo, periodo) DO UPDATE SET
            ${updateSet}
    `, valores);
}

async function processarPeriodo(jogo, periodo, lambdaHome, lambdaAway, lHomeCartoes, lAwayCartoes, lHomeEscanteios, lAwayEscanteios) {
    const grade = calcularGradeResultado(lambdaHome, lambdaAway);
    const golsProbs = derivarProbabilidadesGolsTempo(grade);

    let cartoes = null;
    const lCartoesCasa = Number(lHomeCartoes);
    const lCartoesFora = Number(lAwayCartoes);
    if (Number.isFinite(lCartoesCasa) && Number.isFinite(lCartoesFora) && lCartoesCasa > 0 && lCartoesFora > 0) {
        cartoes = derivarProbabilidadesCartoesTempo(lCartoesCasa, lCartoesFora);
        cartoes.casaExpectativa = lCartoesCasa;
        cartoes.foraExpectativa = lCartoesFora;
    }

    let escanteios = null;
    const lEscanteiosCasa = Number(lHomeEscanteios);
    const lEscanteiosFora = Number(lAwayEscanteios);
    if (Number.isFinite(lEscanteiosCasa) && Number.isFinite(lEscanteiosFora) && lEscanteiosCasa > 0 && lEscanteiosFora > 0) {
        escanteios = derivarProbabilidadesEscanteiosTempo(lEscanteiosCasa, lEscanteiosFora);
        escanteios.casaExpectativa = lEscanteiosCasa;
        escanteios.foraExpectativa = lEscanteiosFora;
    }

    console.log(
        `  [${periodo}] ${jogo.nome_time_casa} x ${jogo.nome_time_fora} | ` +
        `λ_gols=${lambdaHome.toFixed(2)} x ${lambdaAway.toFixed(2)} | ` +
        `1X2: C=${(golsProbs.home * 100).toFixed(0)}% E=${(golsProbs.draw * 100).toFixed(0)}% F=${(golsProbs.away * 100).toFixed(0)}% | ` +
        `O0.5=${(golsProbs.over05 * 100).toFixed(0)}%` +
        (cartoes ? ` | λ_cartões=${cartoes.casaExpectativa.toFixed(2)} x ${cartoes.foraExpectativa.toFixed(2)}` : ' | cartões: n/d') +
        (escanteios ? ` | λ_cantos=${escanteios.casaExpectativa.toFixed(2)} x ${escanteios.foraExpectativa.toFixed(2)}` : ' | cantos: n/d')
    );

    await salvarPrevisaoTempo(jogo, periodo, lambdaHome, lambdaAway, golsProbs, cartoes, escanteios);
}

// ============================================================================
// LOOP PRINCIPAL — por dia, por período (1T/2T), por competição.
// ============================================================================

async function processarDiaPeriodos(dataAlvo) {

    console.log(`\n============================================================`);
    console.log(`PROCESSANDO MERCADOS POR TEMPO [CALENDARIO] — DATA: ${dataAlvo}`);
    console.log(`============================================================\n`);

    const jogosDoDia = await buscarJogosCalendario(dataAlvo);
    console.log(`Encontrados ${jogosDoDia.length} jogo(s) no calendário para ${dataAlvo}.\n`);
    if (jogosDoDia.length === 0) return;

    const jogosPorCompeticao = new Map();
    for (const jogo of jogosDoDia) {
        const idComp = jogo.id_competicao;
        if (!jogosPorCompeticao.has(idComp)) jogosPorCompeticao.set(idComp, []);
        jogosPorCompeticao.get(idComp).push(jogo);
    }
    console.log(`Distribuídos em ${jogosPorCompeticao.size} competição(ões).\n`);

    for (const { periodoDb, periodoSaida } of MERCADOS) {

        console.log(`\n--- AJUSTANDO MODELOS [${periodoSaida}] ---\n`);

        const parametrosGolsPorCompeticao = new Map();
        const parametrosCartoesPorCompeticao = new Map();
        const parametrosEscanteiosPorCompeticao = new Map();

        for (const idComp of jogosPorCompeticao.keys()) {
            parametrosGolsPorCompeticao.set(idComp, await ajustarModeloGolsCompeticaoPeriodo(idComp, dataAlvo, periodoDb));
            parametrosCartoesPorCompeticao.set(idComp, await ajustarModeloCartoesCompeticaoPeriodo(idComp, dataAlvo, periodoDb));
            parametrosEscanteiosPorCompeticao.set(idComp, await ajustarModeloEscanteiosCompeticaoPeriodo(idComp, dataAlvo, periodoDb));
        }

        console.log(`\n--- PREVISÕES [${periodoSaida}] ---\n`);

        for (const [idComp, jogos] of jogosPorCompeticao.entries()) {
            const parametrosGols = parametrosGolsPorCompeticao.get(idComp);
            const parametrosCartoes = parametrosCartoesPorCompeticao.get(idComp);
            const parametrosEscanteios = parametrosEscanteiosPorCompeticao.get(idComp);

            if (!parametrosGols) {
                console.log(`(pulando ${jogos.length} jogo(s) da competição ${idComp} [${periodoSaida}] — modelo de gols não ajustado)`);
                continue;
            }

            for (const jogo of jogos) {
                const casaId = String(jogo.flashscore_id_casa);
                const foraId = String(jogo.flashscore_id_fora);

                let lambdaHome, lambdaAway;
                try {
                    lambdaHome = projetarExpectativaGols(parametrosGols, casaId, foraId, true);
                    lambdaAway = projetarExpectativaGols(parametrosGols, foraId, casaId, false);
                } catch (err) {
                    console.log(`[ERRO GOLS ${periodoSaida}] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}: ${err.message}`);
                    continue;
                }

                let lambdaCartoesCasa = null, lambdaCartoesFora = null;
                if (parametrosCartoes) {
                    try {
                        lambdaCartoesCasa = projetarExpectativaCartoes(parametrosCartoes, casaId, foraId, true);
                        lambdaCartoesFora = projetarExpectativaCartoes(parametrosCartoes, foraId, casaId, false);
                    } catch (err) {
                        console.log(`[ERRO CARTÕES ${periodoSaida}] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}: ${err.message}`);
                    }
                }

                let lambdaEscanteiosCasa = null, lambdaEscanteiosFora = null;
                if (parametrosEscanteios) {
                    try {
                        lambdaEscanteiosCasa = projetarExpectativaEscanteios(parametrosEscanteios, casaId, foraId, true);
                        lambdaEscanteiosFora = projetarExpectativaEscanteios(parametrosEscanteios, foraId, casaId, false);
                    } catch (err) {
                        console.log(`[ERRO ESCANTEIOS ${periodoSaida}] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}: ${err.message}`);
                    }
                }

                await processarPeriodo(
                    {
                        flashscore_id: jogo.flashscore_id,
                        data_jogo: jogo.data_jogo,
                        hora_jogo: jogo.hora_jogo,
                        id_time_casa: jogo.id_time_casa,
                        id_time_fora: jogo.id_time_fora,
                        id_competicao: idComp,
                        nome_competicao: jogo.nome_competicao,
                        pais_liga: jogo.pais_liga,
                        rodada: jogo.rodada,
                        nome_time_casa: jogo.nome_time_casa,
                        nome_time_fora: jogo.nome_time_fora
                    },
                    periodoSaida,
                    lambdaHome, lambdaAway,
                    lambdaCartoesCasa, lambdaCartoesFora,
                    lambdaEscanteiosCasa, lambdaEscanteiosFora
                );
            }
        }
    }

    console.log(`\n🎉 Previsões por tempo salvas para ${dataAlvo}.`);
}

// ============================================================================
// DRIVER — mesmo padrão do script de mercado geral: percorre todas as
// datas do calendario a partir da data inicial.
// ============================================================================

async function processarDatasPeriodos(dataInicial) {
    await client.connect();
    try {
        await garantirConstraintHt();

        const { rows } = await client.query(
            `SELECT MAX(data_jogo::date) AS ultima_data FROM calendario WHERE data_jogo::date >= $1::date`,
            [dataInicial]
        );

        if (!rows[0].ultima_data) {
            console.log(`Nenhum jogo encontrado a partir de ${dataInicial}.`);
            return;
        }

        const ultimaData = rows[0].ultima_data.toISOString().slice(0, 10);
        let dataAtual = new Date(`${dataInicial}T12:00:00`);
        const dataFinal = new Date(`${ultimaData}T12:00:00`);

        while (dataAtual <= dataFinal) {
            const dataAlvo = dataAtual.toISOString().slice(0, 10);
            await processarDiaPeriodos(dataAlvo);
            dataAtual.setDate(dataAtual.getDate() + 1);
        }

    } catch (err) {
        console.error('[ERRO FATAL]', err);
    } finally {
        await client.end();
    }
}

const dataEscolhida = '2026-09-10';
processarDatasPeriodos(dataEscolhida);
