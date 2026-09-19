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
const TABELA_HT = 'analise_jogos_ht';

// ============================================================================
// GRADE DE RESULTADO — genérica (Poisson + Dixon-Coles), usada pra montar a
// matriz placar-a-placar de qualquer período a partir dos λ daquele período.
// O mercado geral (jogo completo) usa a mesma função, mas vive num script
// separado — aqui ela só serve de base pros mercados de 1T/2T.
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
// MERCADOS POR TEMPO (1T / 2T) — linhas mais baixas que o jogo completo:
// gols 0.5/1.5/2.5, cartões 0.5/1.5/2.5/3.5, cantos 1.5 a 6.5.
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
// BUSCA — só os campos de identificação do jogo + os MLE de 1º/2º tempo
// (gols, cartões, escanteios). O gate de entrada (WHERE) continua usando
// mle_l_home/mle_l_away do jogo completo como proxy de "já tem MLE
// calculado pra esse jogo" — mesmo critério que o script de mercado geral
// usa, então os dois scripts pegam o mesmo conjunto de jogos prontos.
// Cartões/escanteios de cada tempo continuam opcionais.
// ============================================================================

async function buscarJogosParaProcessar(dataInicial) {
    const { rows } = await client.query(`
        SELECT
            flashscore_id, data_jogo, hora_jogo,
            id_competicao, nome_competicao, pais_liga, rodada,
            id_time_casa, id_time_fora,
            nome_time_casa, nome_time_fora,
            mle_l_home_1t, mle_l_away_1t,
            mle_cartoes_home_1t, mle_cartoes_away_1t,
            mle_escanteios_home_1t, mle_escanteios_away_1t,
            mle_l_home_2t, mle_l_away_2t,
            mle_cartoes_home_2t, mle_cartoes_away_2t,
            mle_escanteios_home_2t, mle_escanteios_away_2t
        FROM jogos
        WHERE data_jogo::date >= $1::date
          AND mle_l_home IS NOT NULL
          AND mle_l_away IS NOT NULL
        ORDER BY data_jogo::date ASC, id ASC
    `, [dataInicial]);

    return rows;
}

// ============================================================================
// TABELA DE SAÍDA POR TEMPO (analise_jogos_ht)
// Uma linha por jogo+período ('1T' ou '2T'). Monta o INSERT/UPSERT
// dinamicamente a partir de um objeto {coluna: valor} — com ~70 colunas
// nessa tabela, contar placeholders $N na mão seria um convite a erro.
// As colunas res_* (resultado real, usadas pra backtest) NÃO entram aqui:
// são preenchidas por outro processo depois do jogo, e como não fazem parte
// do INSERT/UPDATE, o upsert nunca toca nelas.
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
// LOOP PRINCIPAL — só cuida de 1T/2T. O jogo completo é responsabilidade do
// outro script (mercado geral), que grava em analises_jogo.
// ============================================================================

async function processarJogos(dataInicial) {
    await client.connect();

    try {
        console.log(`\n============================================================`);
        console.log(`PROCESSANDO MERCADOS POR TEMPO A PARTIR DE: ${dataInicial}`);
        console.log(`============================================================\n`);

        await garantirConstraintHt();

        const jogos = await buscarJogosParaProcessar(dataInicial);
        console.log(`Encontrados ${jogos.length} jogo(s) com MLE de gols já calculado a partir de ${dataInicial}.\n`);

        let salvos = 0;
        let pulados = 0;

        for (const jogo of jogos) {
            const l1tHome = Number(jogo.mle_l_home_1t);
            const l1tAway = Number(jogo.mle_l_away_1t);
            if (Number.isFinite(l1tHome) && Number.isFinite(l1tAway) && l1tHome > 0 && l1tAway > 0) {
                await processarPeriodo(
                    jogo, '1T', l1tHome, l1tAway,
                    jogo.mle_cartoes_home_1t, jogo.mle_cartoes_away_1t,
                    jogo.mle_escanteios_home_1t, jogo.mle_escanteios_away_1t
                );
                salvos++;
            } else {
                console.log(`[1T pulado] ${jogo.nome_time_casa} x ${jogo.nome_time_fora} (${jogo.data_jogo}): mle_l_home_1t/mle_l_away_1t ausente/inválido.`);
                pulados++;
            }

            const l2tHome = Number(jogo.mle_l_home_2t);
            const l2tAway = Number(jogo.mle_l_away_2t);
            if (Number.isFinite(l2tHome) && Number.isFinite(l2tAway) && l2tHome > 0 && l2tAway > 0) {
                await processarPeriodo(
                    jogo, '2T', l2tHome, l2tAway,
                    jogo.mle_cartoes_home_2t, jogo.mle_cartoes_away_2t,
                    jogo.mle_escanteios_home_2t, jogo.mle_escanteios_away_2t
                );
                salvos++;
            } else {
                console.log(`[2T pulado] ${jogo.nome_time_casa} x ${jogo.nome_time_fora} (${jogo.data_jogo}): mle_l_home_2t/mle_l_away_2t ausente/inválido.`);
                pulados++;
            }
        }

        console.log(`\n🎉 Previsões por tempo salvas: ${salvos}. Pulados (MLE de período ausente/inválido): ${pulados}.`);

    } catch (err) {
        console.error('[ERRO FATAL]', err);
    } finally {
        await client.end();
    }
}

const dataEscolhida = '2023-01-01';
processarJogos(dataEscolhida);