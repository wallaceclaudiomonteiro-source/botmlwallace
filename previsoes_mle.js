const { Client } = require('pg');
const {
    poisson, dixonColesCorrection,
    otimizarModeloConjunto, projetarExpectativaGols,
    pontosCartao, otimizarModeloCartoes, projetarExpectativaCartoes, probOverCartoes,
    otimizarModeloEscanteios, projetarExpectativaEscanteios, probOverEscanteios
} = require('./market_model');

const client = new Client({ connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol' });

const RHO_DIXON_COLES = -0.1, MAX_GOLS_GRADE = 10, JANELA_HISTORICO = '1 year', MIN_JOGOS_TREINO = 20;
const METRICAS_OBRIGATORIAS = ['xg', 'xgot', 'gols_marcados'];
const METRICAS_OBRIGATORIAS_CARTOES = ['cartoes_amarelos', 'cartao_vermelho', 'faltas', 'desarmes_total', 'duelos_ganhos'];
const METRICAS_OBRIGATORIAS_ESCANTEIOS = [
    'escanteios', 'cruzamentos_total',
    'toques_area_adversaria', 'finalizacoes_de_dentro_area', 'finalizacoes_bloqueadas',
    'rebatidas', 'defesas_goleiro', 'gols_evitados'
];
// ============================================================================
// GOLS — SEM NENHUMA ALTERAÇÃO EM RELAÇÃO AO SEU SCRIPT ATUAL
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

function derivarProbabilidadesMercados(grade) {
    const maxGols = grade.length - 1;
    let probCasa = 0, probEmpate = 0, probFora = 0, probOver15 = 0, probOver25 = 0, probOver35 = 0;
    let probBTTS = 0, probCasaOver05 = 0, probCasaOver15 = 0, probForaOver05 = 0, probForaOver15 = 0;

    for (let h = 0; h <= maxGols; h++) {
        for (let a = 0; a <= maxGols; a++) {
            const p = grade[h][a], total = h + a;
            if (h > a) probCasa += p; else if (h === a) probEmpate += p; else probFora += p;
            if (total > 1.5) probOver15 += p; if (total > 2.5) probOver25 += p; if (total > 3.5) probOver35 += p;
            if (h >= 1 && a >= 1) probBTTS += p;
            if (h >= 1) probCasaOver05 += p; if (h >= 2) probCasaOver15 += p;
            if (a >= 1) probForaOver05 += p; if (a >= 2) probForaOver15 += p;
        }
    }
    return {
        home: probCasa, draw: probEmpate, away: probFora,
        over15: probOver15, under15: 1 - probOver15, over25: probOver25, under25: 1 - probOver25, over35: probOver35, under35: 1 - probOver35,
        btts_yes: probBTTS, btts_no: 1 - probBTTS,
        casa_over05: probCasaOver05, casa_over15: probCasaOver15, fora_over05: probForaOver05, fora_over15: probForaOver15
    };
}

async function buscarJogosCalendario(dataAlvo) {
    const { rows } = await client.query(`SELECT * FROM calendario WHERE data_jogo = $1`, [dataAlvo]);
    return rows;
}

async function ajustarModeloCompeticao(idCompeticao, dataAlvo) {
    const { rows: metricasLiga } = await client.query(`SELECT metrica, casa_mediana, fora_mediana FROM grid_metricas_competicoes WHERE id_competicao = $1 AND metrica = ANY($2)`, [idCompeticao, METRICAS_OBRIGATORIAS]);
    const referenciaLiga = {};
    for (const row of metricasLiga) referenciaLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };

    const faltantes = METRICAS_OBRIGATORIAS.filter(m => !referenciaLiga[m] || !Number.isFinite(referenciaLiga[m].casa) || !Number.isFinite(referenciaLiga[m].fora));
    if (faltantes.length > 0) { console.log(`[PULAR] Competição ${idCompeticao}: métricas incompletas em grid_metricas_competicoes [${faltantes.join(', ')}]`); return null; }

    const { rows: historicoBruto } = await client.query(`
        SELECT
            j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
            j.placar_casa, j.placar_fora,
            sg.id_time, sg.eh_casa,
            sg.xg, sg.xgot, sg.gols_marcados,
            EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
        FROM jogos j
        INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [idCompeticao, dataAlvo]);

    const mapaJogos = new Map();
    for (const linha of historicoBruto) {
        const chave = String(linha.flashscore_id);
        if (!mapaJogos.has(chave)) {
            mapaJogos.set(chave, {
                casa_id: String(linha.flashscore_id_time_casa), fora_id: String(linha.flashscore_id_time_fora), gols_casa: Number(linha.placar_casa), gols_fora: Number(linha.placar_fora),
                xg_casa: null, xg_fora: null, xgot_casa: null, xgot_fora: null, gols_marcados_casa: null, gols_marcados_fora: null,
                xg_contra_casa: null, xg_contra_fora: null, xga_casa: null, xga_fora: null, gols_sofridos_casa: null, gols_sofridos_fora: null, peso_tempo: Number(linha.peso_tempo) || 1
            });
        }
        const jogo = mapaJogos.get(chave);
        const xg = linha.xg !== null ? Number(linha.xg) : null, xgot = linha.xgot !== null ? Number(linha.xgot) : null;
        const golsMarcados = linha.gols_marcados !== null ? Number(linha.gols_marcados) : null;

        if (Number(linha.eh_casa) === 1) { jogo.xg_casa = xg; jogo.xgot_casa = xgot; jogo.gols_marcados_casa = golsMarcados; }
        if (Number(linha.eh_casa) === 0) { jogo.xg_fora = xg; jogo.xgot_fora = xgot; jogo.gols_marcados_fora = golsMarcados; }
    }

    // DERIVAÇÃO: xg_contra, xga e gols_sofridos vêm da linha do adversário no mesmo jogo
    for (const jogo of mapaJogos.values()) {
        jogo.xg_contra_casa = jogo.xg_fora;
        jogo.xg_contra_fora = jogo.xg_casa;
        jogo.xga_casa = jogo.xgot_fora;
        jogo.xga_fora = jogo.xgot_casa;
        jogo.gols_sofridos_casa = jogo.gols_marcados_fora;
        jogo.gols_sofridos_fora = jogo.gols_marcados_casa;
    }

    const jogosValidos = Array.from(mapaJogos.values()).filter(j => j.casa_id && j.fora_id && Number.isFinite(j.gols_casa) && Number.isFinite(j.gols_fora));
    if (jogosValidos.length < MIN_JOGOS_TREINO) { console.log(`[PULAR] Competição ${idCompeticao}: histórico insuficiente (${jogosValidos.length} jogos, mínimo ${MIN_JOGOS_TREINO})`); return null; }

    const parametros = await otimizarModeloConjunto(jogosValidos, 1500, 0.003, { referenciaLiga, pesoXG: 0.30, pesoXGOT: 0.50, pesoGols: 0.20, pesoXGContra: 0.30, pesoXGA: 0.50, pesoGolsSofridos: 0.20, regularizacao: 0.015, gradienteMax: 5 });
    console.log(`[OK] Competição ${idCompeticao}: modelo de gols ajustado com ${jogosValidos.length} jogos (convergiu=${parametros.convergiu}, iterações=${parametros.iteracoes})`);
    return parametros;
}

// ============================================================================
// CARTÕES — SEM ALTERAÇÃO NA LÓGICA (só o bug de casa/fora_cartoes_esperado
// no salvarPrevisao foi corrigido, ver comentário lá embaixo)
// ============================================================================

function derivarProbabilidadesCartoes(lambdaCasa, lambdaFora) {
    const total = lambdaCasa + lambdaFora;

    const over25 = probOverCartoes(total, 2.5);
    const over35 = probOverCartoes(total, 3.5);
    const over45 = probOverCartoes(total, 4.5);

    const casaOver05 = probOverCartoes(lambdaCasa, 0.5);
    const casaOver15 = probOverCartoes(lambdaCasa, 1.5);
    const casaOver25 = probOverCartoes(lambdaCasa, 2.5);

    const foraOver05 = probOverCartoes(lambdaFora, 0.5);
    const foraOver15 = probOverCartoes(lambdaFora, 1.5);
    const foraOver25 = probOverCartoes(lambdaFora, 2.5);

    return {
        total,
        over25, under25: 1 - over25,
        over35, under35: 1 - over35,
        over45, under45: 1 - over45,
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

async function ajustarModeloCartoesCompeticao(idCompeticao, dataAlvo) {
    const { rows: metricasLiga } = await client.query(
        `SELECT metrica, casa_mediana, fora_mediana FROM grid_metricas_competicoes WHERE id_competicao = $1 AND metrica = ANY($2)`,
        [idCompeticao, METRICAS_OBRIGATORIAS_CARTOES]
    );

    const brutoLiga = {};
    for (const row of metricasLiga) brutoLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };

    const faltantes = METRICAS_OBRIGATORIAS_CARTOES.filter(
        m => !brutoLiga[m] || !Number.isFinite(brutoLiga[m].casa) || !Number.isFinite(brutoLiga[m].fora)
    );

    if (faltantes.length > 0) {
        console.log(`[PULAR CARTÕES] Competição ${idCompeticao}: métricas incompletas em grid_metricas_competicoes [${faltantes.join(', ')}]`);
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
            j.placar_casa, j.placar_fora,
            sg.id_time, sg.eh_casa,
            sg.cartoes_amarelos, sg.cartao_vermelho, sg.faltas, sg.desarmes_total, sg.duelos_ganhos,
            EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
        FROM jogos j
        INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [idCompeticao, dataAlvo]);

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

    const jogosValidos = Array.from(mapaJogos.values()).filter(j =>
        j.casa_id && j.fora_id && Number.isFinite(j.cartoes_casa) && Number.isFinite(j.cartoes_fora)
    );

    if (jogosValidos.length < MIN_JOGOS_TREINO) {
        console.log(`[PULAR CARTÕES] Competição ${idCompeticao}: histórico insuficiente (${jogosValidos.length} jogos, mínimo ${MIN_JOGOS_TREINO})`);
        return null;
    }

    const parametros = await otimizarModeloCartoes(jogosValidos, 1500, 0.003, {
        referenciaLiga,
        pesoCartoes: 0.55, pesoFaltasCometidas: 0.30, pesoIntensidade: 0.15,
        pesoCartoesProvocados: 0.55, pesoFaltasProvocadas: 0.30, pesoIntensidadeProvocada: 0.15,
        regularizacao: 0.02, gradienteMax: 5
    });

    console.log(`[OK] Competição ${idCompeticao}: modelo de cartões ajustado com ${jogosValidos.length} jogos (convergiu=${parametros.convergiu}, iterações=${parametros.iteracoes})`);
    return parametros;
}

// ============================================================================
// ESCANTEIOS — NOVO, MESMO PADRÃO DE CARTÕES
// ============================================================================

function derivarProbabilidadesEscanteios(lambdaCasa, lambdaFora) {
    const total = lambdaCasa + lambdaFora;

    const over75 = probOverEscanteios(total, 7.5);
    const over85 = probOverEscanteios(total, 8.5);
    const over95 = probOverEscanteios(total, 9.5);

    return {
        total,
        over75, under75: 1 - over75,
        over85, under85: 1 - over85,
        over95, under95: 1 - over95,
        casa_over35: probOverEscanteios(lambdaCasa, 3.5),
        casa_over45: probOverEscanteios(lambdaCasa, 4.5),
        fora_over25: probOverEscanteios(lambdaFora, 2.5),
        fora_over35: probOverEscanteios(lambdaFora, 3.5),
        fora_over45: probOverEscanteios(lambdaFora, 4.5)
    };
}

async function ajustarModeloEscanteiosCompeticao(idCompeticao, dataAlvo) {
    const { rows: metricasLiga } = await client.query(
        `SELECT metrica, casa_mediana, fora_mediana FROM grid_metricas_competicoes WHERE id_competicao = $1 AND metrica = ANY($2)`,
        [idCompeticao, METRICAS_OBRIGATORIAS_ESCANTEIOS]
    );

    const referenciaLiga = {};
    for (const row of metricasLiga) referenciaLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };

    const faltantes = METRICAS_OBRIGATORIAS_ESCANTEIOS.filter(
        m => !referenciaLiga[m] || !Number.isFinite(referenciaLiga[m].casa) || !Number.isFinite(referenciaLiga[m].fora)
    );

    if (faltantes.length > 0) {
        console.log(`[PULAR ESCANTEIOS] Competição ${idCompeticao}: métricas incompletas em grid_metricas_competicoes [${faltantes.join(', ')}]`);
        return null;
    }

    const { rows: historicoBruto } = await client.query(`
        SELECT
            j.id, j.data_jogo, j.flashscore_id, j.flashscore_id_time_casa, j.flashscore_id_time_fora,
            j.placar_casa, j.placar_fora,
            sg.id_time, sg.eh_casa,
            sg.escanteios, sg.cruzamentos_total, sg.toques_area_adversaria,
            sg.finalizacoes_de_dentro_area, sg.finalizacoes_bloqueadas,
            sg.rebatidas, sg.defesas_goleiro, sg.gols_evitados,
            EXP(-0.005 * ($2::date - j.data_jogo::date)) AS peso_tempo
        FROM jogos j
        INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [idCompeticao, dataAlvo]);

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

    const jogosValidos = Array.from(mapaJogos.values()).filter(j =>
        j.casa_id && j.fora_id && Number.isFinite(j.escanteios_casa) && Number.isFinite(j.escanteios_fora)
    );

    if (jogosValidos.length < MIN_JOGOS_TREINO) {
        console.log(`[PULAR ESCANTEIOS] Competição ${idCompeticao}: histórico insuficiente (${jogosValidos.length} jogos, mínimo ${MIN_JOGOS_TREINO})`);
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

    console.log(`[OK] Competição ${idCompeticao}: modelo de escanteios ajustado com ${jogosValidos.length} jogos (convergiu=${parametros.convergiu}, iterações=${parametros.iteracoes})`);
    return parametros;
}

// ============================================================================
// TABELA DE SAÍDA — GOLS + CARTÕES + ESCANTEIOS
// ============================================================================

async function salvarPrevisao(jogo, lambdaHome, lambdaAway, probs, cartoes, escanteios) {
    const totalGolsEsperado = lambdaHome + lambdaAway;
    const temCartoes = cartoes !== null && cartoes !== undefined;
    const temEscanteios = escanteios !== null && escanteios !== undefined;

    await client.query(`
        INSERT INTO analises_jogo (
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
            total_gols_esperado,
            casa_gols_esperado,
            fora_gols_esperado,

            p_home,
            p_draw,
            p_away,

            p_over15,
            p_under15,
            p_over25,
            p_under25,
            p_over35,
            p_under35,
            p_btts_yes,
            p_btts_no,
            p_casa_over05,
            p_casa_over15,
            p_fora_over05,
            p_fora_over15,

            total_cartoes_esperado,
            casa_cartoes_esperado,
            fora_cartoes_esperado,
            p_cartoes_over25,
            p_cartoes_under25,
            p_cartoes_over35,
            p_cartoes_under35,
            p_cartoes_over45,
            p_cartoes_under45,
            p_casa_cartoes_over05,
            p_casa_cartoes_over15,
            p_casa_cartoes_over25,
            p_casa_cartoes_under25,
            p_fora_cartoes_over05,
            p_fora_cartoes_over15,
            p_fora_cartoes_over25,
            p_fora_cartoes_under25,

            total_cantos_esperado,
            casa_cantos_esperado,
            fora_cantos_esperado,
            p_cantos_over75,
            p_cantos_under75,
            p_cantos_over85,
            p_cantos_under85,
            p_cantos_over95,
            p_cantos_under95,
            p_casa_cantos_over35,
            p_casa_cantos_over45,
            p_fora_cantos_over25,
            p_fora_cantos_over35,
            p_fora_cantos_over45
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13,
            $14, $15, $16,          
            $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28,
            $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45,
            $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59 
        )
        ON CONFLICT (flashscore_id_jogo) DO UPDATE SET
            pais_liga = EXCLUDED.pais_liga,
            total_gols_esperado = EXCLUDED.total_gols_esperado,
            casa_gols_esperado = EXCLUDED.casa_gols_esperado,
            fora_gols_esperado = EXCLUDED.fora_gols_esperado,

            p_home = EXCLUDED.p_home,
            p_draw = EXCLUDED.p_draw,
            p_away = EXCLUDED.p_away,

            p_over15 = EXCLUDED.p_over15,
            p_under15 = EXCLUDED.p_under15,
            p_over25 = EXCLUDED.p_over25,
            p_under25 = EXCLUDED.p_under25,
            p_over35 = EXCLUDED.p_over35,
            p_under35 = EXCLUDED.p_under35,
            p_btts_yes = EXCLUDED.p_btts_yes,
            p_btts_no = EXCLUDED.p_btts_no,
            p_casa_over05 = EXCLUDED.p_casa_over05,
            p_casa_over15 = EXCLUDED.p_casa_over15,
            p_fora_over05 = EXCLUDED.p_fora_over05,
            p_fora_over15 = EXCLUDED.p_fora_over15,

            total_cartoes_esperado = EXCLUDED.total_cartoes_esperado,
            casa_cartoes_esperado = EXCLUDED.casa_cartoes_esperado,
            fora_cartoes_esperado = EXCLUDED.fora_cartoes_esperado,
            p_cartoes_over25 = EXCLUDED.p_cartoes_over25,
            p_cartoes_under25 = EXCLUDED.p_cartoes_under25,
            p_cartoes_over35 = EXCLUDED.p_cartoes_over35,
            p_cartoes_under35 = EXCLUDED.p_cartoes_under35,
            p_cartoes_over45 = EXCLUDED.p_cartoes_over45,
            p_cartoes_under45 = EXCLUDED.p_cartoes_under45,
            p_casa_cartoes_over05 = EXCLUDED.p_casa_cartoes_over05,
            p_casa_cartoes_over15 = EXCLUDED.p_casa_cartoes_over15,
            p_casa_cartoes_over25 = EXCLUDED.p_casa_cartoes_over25,
            p_casa_cartoes_under25 = EXCLUDED.p_casa_cartoes_under25,
            p_fora_cartoes_over05 = EXCLUDED.p_fora_cartoes_over05,
            p_fora_cartoes_over15 = EXCLUDED.p_fora_cartoes_over15,
            p_fora_cartoes_over25 = EXCLUDED.p_fora_cartoes_over25,
            p_fora_cartoes_under25 = EXCLUDED.p_fora_cartoes_under25,

            total_cantos_esperado = EXCLUDED.total_cantos_esperado,
            casa_cantos_esperado = EXCLUDED.casa_cantos_esperado,
            fora_cantos_esperado = EXCLUDED.fora_cantos_esperado,
            p_cantos_over75 = EXCLUDED.p_cantos_over75,
            p_cantos_under75 = EXCLUDED.p_cantos_under75,
            p_cantos_over85 = EXCLUDED.p_cantos_over85,
            p_cantos_under85 = EXCLUDED.p_cantos_under85,
            p_cantos_over95 = EXCLUDED.p_cantos_over95,
            p_cantos_under95 = EXCLUDED.p_cantos_under95,
            p_casa_cantos_over35 = EXCLUDED.p_casa_cantos_over35,
            p_casa_cantos_over45 = EXCLUDED.p_casa_cantos_over45,
            p_fora_cantos_over25 = EXCLUDED.p_fora_cantos_over25,
            p_fora_cantos_over35 = EXCLUDED.p_fora_cantos_over35,
            p_fora_cantos_over45 = EXCLUDED.p_fora_cantos_over45
    `, [
        jogo.flashscore_id_jogo,
        jogo.data_jogo,
        jogo.hora_jogo || null,
        jogo.id_time_casa || null,
        jogo.id_time_fora || null,
        jogo.nome_time_casa,
        jogo.nome_time_fora,
        jogo.id_competicao,
        jogo.nome_competicao,
        jogo.pais_liga || null,

        totalGolsEsperado.toFixed(2),
        lambdaHome.toFixed(2),
        lambdaAway.toFixed(2),

        (probs.home * 100).toFixed(2),
        (probs.draw * 100).toFixed(2),
        (probs.away * 100).toFixed(2),

        (probs.over15 * 100).toFixed(2),
        (probs.under15 * 100).toFixed(2),
        (probs.over25 * 100).toFixed(2),
        (probs.under25 * 100).toFixed(2),
        (probs.over35 * 100).toFixed(2),
        (probs.under35 * 100).toFixed(2),
        (probs.btts_yes * 100).toFixed(2),
        (probs.btts_no * 100).toFixed(2),

        (probs.casa_over05 * 100).toFixed(2),
        (probs.casa_over15 * 100).toFixed(2),
        (probs.fora_over05 * 100).toFixed(2),
        (probs.fora_over15 * 100).toFixed(2),

        // BUG CORRIGIDO: antes essas duas linhas tinham um placeholder errado
        // (cartoes.total - foraExpectativa, e null fixo). Agora usam direto
        // as expectativas individuais já calculadas no loop.
        temCartoes ? cartoes.total.toFixed(2) : null,
        temCartoes ? cartoes.casaExpectativa.toFixed(2) : null,
        temCartoes ? cartoes.foraExpectativa.toFixed(2) : null,
        temCartoes ? (cartoes.over25 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.under25 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.over35 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.under35 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.over45 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.under45 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.casa_over05 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.casa_over15 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.casa_over25 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.casa_under25 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.fora_over05 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.fora_over15 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.fora_over25 * 100).toFixed(2) : null,
        temCartoes ? (cartoes.fora_under25 * 100).toFixed(2) : null,

        temEscanteios ? escanteios.total.toFixed(2) : null,
        temEscanteios ? escanteios.casaExpectativa.toFixed(2) : null,
        temEscanteios ? escanteios.foraExpectativa.toFixed(2) : null,
        temEscanteios ? (escanteios.over75 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.under75 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.over85 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.under85 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.over95 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.under95 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.casa_over35 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.casa_over45 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.fora_over25 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.fora_over35 * 100).toFixed(2) : null,
        temEscanteios ? (escanteios.fora_over45 * 100).toFixed(2) : null
    ]);
}

// ============================================================================
// LOOP PRINCIPAL — AGORA AJUSTANDO OS TRÊS MODELOS POR COMPETIÇÃO
// ============================================================================

async function processarDia(dataAlvo) {
    console.log(`\n============================================================`);
    console.log(`PROCESSANDO DATA: ${dataAlvo}`);
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

    const parametrosGolsPorCompeticao = new Map();
    const parametrosCartoesPorCompeticao = new Map();
    const parametrosEscanteiosPorCompeticao = new Map();

    for (const idComp of jogosPorCompeticao.keys()) {
        parametrosGolsPorCompeticao.set(idComp, await ajustarModeloCompeticao(idComp, dataAlvo));
        parametrosCartoesPorCompeticao.set(idComp, await ajustarModeloCartoesCompeticao(idComp, dataAlvo));
        parametrosEscanteiosPorCompeticao.set(idComp, await ajustarModeloEscanteiosCompeticao(idComp, dataAlvo));
    }

    console.log('\n--- PREVISÕES ---\n');

    for (const [idComp, jogos] of jogosPorCompeticao.entries()) {
        const parametrosGols = parametrosGolsPorCompeticao.get(idComp);
        const parametrosCartoes = parametrosCartoesPorCompeticao.get(idComp);
        const parametrosEscanteios = parametrosEscanteiosPorCompeticao.get(idComp);

        if (!parametrosGols) {
            console.log(`(pulando ${jogos.length} jogo(s) da competição ${idComp} — modelo de gols não ajustado)`);
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
                console.log(`[ERRO GOLS] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}: ${err.message}`);
                continue;
            }

            const grade = calcularGradeResultado(lambdaHome, lambdaAway);
            const probs = derivarProbabilidadesMercados(grade);

            let cartoes = null;
            if (parametrosCartoes) {
                try {
                    const lambdaCartoesCasa = projetarExpectativaCartoes(parametrosCartoes, casaId, foraId, true);
                    const lambdaCartoesFora = projetarExpectativaCartoes(parametrosCartoes, foraId, casaId, false);
                    cartoes = derivarProbabilidadesCartoes(lambdaCartoesCasa, lambdaCartoesFora);
                    cartoes.casaExpectativa = lambdaCartoesCasa;
                    cartoes.foraExpectativa = lambdaCartoesFora;
                } catch (err) {
                    console.log(`[ERRO CARTÕES] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}: ${err.message}`);
                }
            }

            let escanteios = null;
            if (parametrosEscanteios) {
                try {
                    const lambdaEscanteiosCasa = projetarExpectativaEscanteios(parametrosEscanteios, casaId, foraId, true);
                    const lambdaEscanteiosFora = projetarExpectativaEscanteios(parametrosEscanteios, foraId, casaId, false);
                    escanteios = derivarProbabilidadesEscanteios(lambdaEscanteiosCasa, lambdaEscanteiosFora);
                    escanteios.casaExpectativa = lambdaEscanteiosCasa;
                    escanteios.foraExpectativa = lambdaEscanteiosFora;
                } catch (err) {
                    console.log(`[ERRO ESCANTEIOS] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}: ${err.message}`);
                }
            }

            console.log(
                `${jogo.nome_time_casa} x ${jogo.nome_time_fora} (${jogo.nome_competicao}) | ` +
                `λ_gols=${lambdaHome.toFixed(2)} x ${lambdaAway.toFixed(2)} | ` +
                `1X2: C=${(probs.home * 100).toFixed(0)}% E=${(probs.draw * 100).toFixed(0)}% F=${(probs.away * 100).toFixed(0)}% | ` +
                `O2.5=${(probs.over25 * 100).toFixed(0)}% | BTTS=${(probs.btts_yes * 100).toFixed(0)}%` +
                (cartoes ? ` | λ_cartões=${cartoes.casaExpectativa.toFixed(2)} x ${cartoes.foraExpectativa.toFixed(2)}` : ' | cartões: n/d') +
                (escanteios ? ` | λ_cantos=${escanteios.casaExpectativa.toFixed(2)} x ${escanteios.foraExpectativa.toFixed(2)}` : ' | cantos: n/d')
            );

            await salvarPrevisao({
                flashscore_id_jogo: jogo.flashscore_id,
                data_jogo: jogo.data_jogo,
                hora_jogo: jogo.hora_jogo,
                id_time_casa: jogo.id_time_casa,
                id_time_fora: jogo.id_time_fora,
                id_competicao: idComp,
                nome_competicao: jogo.nome_competicao,
                nome_time_casa: jogo.nome_time_casa,
                nome_time_fora: jogo.nome_time_fora,
                pais_liga: jogo.pais_liga 
            }, lambdaHome, lambdaAway, probs, cartoes, escanteios);
        }
    }

    console.log(`\n🎉 Previsões salvas para ${dataAlvo}.`);
}

async function processarDatasAPartirDe(dataInicial) {
    await client.connect();
    try {
        const { rows } = await client.query(`SELECT MAX(data_jogo::date) AS ultima_data FROM calendario WHERE data_jogo::date >= $1::date`, [dataInicial]);
        if (!rows[0].ultima_data) { console.log(`Nenhum jogo encontrado a partir de ${dataInicial}.`); return; }

        const ultimaData = rows[0].ultima_data.toISOString().slice(0, 10);
        let dataAtual = new Date(`${dataInicial}T12:00:00`);
        const dataFinal = new Date(`${ultimaData}T12:00:00`);

        while (dataAtual <= dataFinal) {
            const dataAlvo = dataAtual.toISOString().slice(0, 10);
            await processarDia(dataAlvo);
            dataAtual.setDate(dataAtual.getDate() + 1);
        }
    } catch (err) {
        console.error('[ERRO FATAL]', err);
    } finally {
        await client.end();
    }
}

const dataEscolhida = '2026-07-01';
processarDatasAPartirDe(dataEscolhida);