const { Client } = require('pg');
const {
    poisson, dixonColesCorrection,
    probOverCartoes, probOverEscanteios
} = require('./market_model');

const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

const RHO_DIXON_COLES = -0.1;
const MAX_GOLS_GRADE = 10;

// ============================================================================
// GRADE E MERCADOS DE GOLS — SEM ALTERAÇÃO
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

// ============================================================================
// MERCADOS DE CARTÕES — SEM ALTERAÇÃO
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

// ============================================================================
// MERCADOS DE ESCANTEIOS — SEM ALTERAÇÃO
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

// ============================================================================
// BUSCA — direto na tabela jogos, sem calendario e sem treino por competição.
// Só entra jogo com o MLE de gols já calculado (mle_l_home/mle_l_away);
// cartões e escanteios são opcionais (podem estar null pra alguns jogos e o
// mercado correspondente simplesmente não é salvo nesse caso).
// ============================================================================

async function buscarJogosParaProcessar(dataInicial) {
    const { rows } = await client.query(`
        SELECT
            flashscore_id, data_jogo, hora_jogo,
            id_competicao, nome_competicao,
            id_time_casa, id_time_fora,
            nome_time_casa, nome_time_fora,
            mle_l_home, mle_l_away,
            mle_cartoes_home, mle_cartoes_away,
            mle_escanteios_home, mle_escanteios_away
        FROM jogos
        WHERE data_jogo::date >= $1::date
          AND mle_l_home IS NOT NULL
          AND mle_l_away IS NOT NULL
        ORDER BY data_jogo::date ASC, id ASC
    `, [dataInicial]);

    return rows;
}

// ============================================================================
// TABELA DE SAÍDA — GOLS + CARTÕES + ESCANTEIOS (sem alteração)
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
            $10, $11, $12,
            $13, $14, $15,
            $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27,
            $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44,
            $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58
        )
        ON CONFLICT (flashscore_id_jogo) DO UPDATE SET
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
// LOOP PRINCIPAL — só lê o que já está pronto em jogos e distribui/salva.
// Não treina nada, não consulta grid_metricas_competicoes nem estatisticas_geral.
// ============================================================================

async function processarJogos(dataInicial) {
    await client.connect();

    try {
        console.log(`\n============================================================`);
        console.log(`PROCESSANDO JOGOS A PARTIR DE: ${dataInicial}`);
        console.log(`============================================================\n`);

        const jogos = await buscarJogosParaProcessar(dataInicial);
        console.log(`Encontrados ${jogos.length} jogo(s) com MLE de gols já calculado a partir de ${dataInicial}.\n`);

        let salvos = 0;
        let pulados = 0;

        for (const jogo of jogos) {
            const lambdaHome = Number(jogo.mle_l_home);
            const lambdaAway = Number(jogo.mle_l_away);

            if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway) || lambdaHome <= 0 || lambdaAway <= 0) {
                console.log(`[PULAR] ${jogo.nome_time_casa} x ${jogo.nome_time_fora} (${jogo.data_jogo}): mle_l_home/mle_l_away inválido.`);
                pulados++;
                continue;
            }

            const grade = calcularGradeResultado(lambdaHome, lambdaAway);
            const probs = derivarProbabilidadesMercados(grade);

            let cartoes = null;
            const lambdaCartoesCasa = Number(jogo.mle_cartoes_home);
            const lambdaCartoesFora = Number(jogo.mle_cartoes_away);
            if (Number.isFinite(lambdaCartoesCasa) && Number.isFinite(lambdaCartoesFora) && lambdaCartoesCasa > 0 && lambdaCartoesFora > 0) {
                cartoes = derivarProbabilidadesCartoes(lambdaCartoesCasa, lambdaCartoesFora);
                cartoes.casaExpectativa = lambdaCartoesCasa;
                cartoes.foraExpectativa = lambdaCartoesFora;
            }

            let escanteios = null;
            const lambdaEscanteiosCasa = Number(jogo.mle_escanteios_home);
            const lambdaEscanteiosFora = Number(jogo.mle_escanteios_away);
            if (Number.isFinite(lambdaEscanteiosCasa) && Number.isFinite(lambdaEscanteiosFora) && lambdaEscanteiosCasa > 0 && lambdaEscanteiosFora > 0) {
                escanteios = derivarProbabilidadesEscanteios(lambdaEscanteiosCasa, lambdaEscanteiosFora);
                escanteios.casaExpectativa = lambdaEscanteiosCasa;
                escanteios.foraExpectativa = lambdaEscanteiosFora;
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
                id_competicao: jogo.id_competicao,
                nome_competicao: jogo.nome_competicao,
                nome_time_casa: jogo.nome_time_casa,
                nome_time_fora: jogo.nome_time_fora
            }, lambdaHome, lambdaAway, probs, cartoes, escanteios);

            salvos++;
        }

        console.log(`\n🎉 Previsões salvas: ${salvos}. Pulados (MLE inválido): ${pulados}.`);

    } catch (err) {
        console.error('[ERRO FATAL]', err);
    } finally {
        await client.end();
    }
}

const dataEscolhida = '2023-01-01';
processarJogos(dataEscolhida);