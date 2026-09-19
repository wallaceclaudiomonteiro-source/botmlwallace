const { Client } = require('pg');
const { poisson, dixonColesCorrection } = require('./market_model');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

// Mesmo intervalo do backtest que gerou os mle_l_home / mle_l_away.
const DATA_INICIAL = '2024-01-01';
const DATA_FINAL = '2026-09-07';

const RHO_DIXON_COLES = -0.1;
const MAX_GOLS_GRADE = 10;
const LIMIAR_SUGESTAO = 0.5; // só conta como "sugestão" se prob > 50%

// ============================================================================
// GRADE DE PROBABILIDADES (placar exato) COM CORREÇÃO DIXON-COLES
// ============================================================================

function calcularGradeResultado(lambdaHome, lambdaAway, rho = RHO_DIXON_COLES, maxGols = MAX_GOLS_GRADE) {
    const grade = [];
    let somaTotal = 0;

    for (let h = 0; h <= maxGols; h++) {
        const linha = [];
        for (let a = 0; a <= maxGols; a++) {
            const pBase = poisson(lambdaHome, h) * poisson(lambdaAway, a);
            const correcao = dixonColesCorrection(h, a, lambdaHome, lambdaAway, rho);
            const p = Math.max(0, pBase * correcao);
            linha.push(p);
            somaTotal += p;
        }
        grade.push(linha);
    }

    if (somaTotal > 0) {
        for (let h = 0; h <= maxGols; h++) {
            for (let a = 0; a <= maxGols; a++) {
                grade[h][a] /= somaTotal;
            }
        }
    }

    return grade;
}

// ============================================================================
// PROBABILIDADES POR MERCADO (a partir da grade)
// ============================================================================

function derivarProbabilidadesMercados(grade) {
    const maxGols = grade.length - 1;

    let probCasa = 0, probEmpate = 0, probFora = 0;
    let probOver15 = 0, probOver25 = 0, probOver35 = 0;
    let probBTTS = 0;
    let probCasaOver05 = 0, probCasaOver15 = 0;
    let probForaOver05 = 0, probForaOver15 = 0;

    for (let h = 0; h <= maxGols; h++) {
        for (let a = 0; a <= maxGols; a++) {
            const p = grade[h][a];
            const total = h + a;

            if (h > a) probCasa += p;
            else if (h === a) probEmpate += p;
            else probFora += p;

            if (total > 1.5) probOver15 += p;
            if (total > 2.5) probOver25 += p;
            if (total > 3.5) probOver35 += p;

            if (h >= 1 && a >= 1) probBTTS += p;

            if (h >= 1) probCasaOver05 += p;
            if (h >= 2) probCasaOver15 += p;
            if (a >= 1) probForaOver05 += p;
            if (a >= 2) probForaOver15 += p;
        }
    }

    return {
        home: probCasa,
        draw: probEmpate,
        away: probFora,
        over15: probOver15,
        under15: 1 - probOver15,
        over25: probOver25,
        under25: 1 - probOver25,
        over35: probOver35,
        under35: 1 - probOver35,
        btts_yes: probBTTS,
        btts_no: 1 - probBTTS,
        casa_over05: probCasaOver05,
        casa_over15: probCasaOver15,
        fora_over05: probForaOver05,
        fora_over15: probForaOver15
    };
}

// ============================================================================
// RESULTADO REAL DE CADA MERCADO (bateu ou não, pra cada jogo)
// ============================================================================

function resultadoRealMercados(placarCasa, placarFora) {
    const total = placarCasa + placarFora;

    return {
        home: placarCasa > placarFora,
        draw: placarCasa === placarFora,
        away: placarFora > placarCasa,
        over15: total > 1.5,
        under15: total <= 1.5,
        over25: total > 2.5,
        under25: total <= 2.5,
        over35: total > 3.5,
        under35: total <= 3.5,
        btts_yes: placarCasa >= 1 && placarFora >= 1,
        btts_no: !(placarCasa >= 1 && placarFora >= 1),
        casa_over05: placarCasa >= 1,
        casa_over15: placarCasa >= 2,
        fora_over05: placarFora >= 1,
        fora_over15: placarFora >= 2
    };
}

const ORDEM_MERCADOS = [
    'home', 'draw', 'away',
    'over15', 'under15',
    'over25', 'under25',
    'over35', 'under35',
    'btts_yes', 'btts_no',
    'casa_over05', 'casa_over15',
    'fora_over05', 'fora_over15'
];

// ============================================================================
// EXECUÇÃO PRINCIPAL
// ============================================================================

async function gerarRelatorioMercadosMLE() {
    console.log(`\n--- DESEMPENHO POR MERCADO (MLE) — ${DATA_INICIAL} até ${DATA_FINAL} ---`);

    await client.connect();

    try {
        const { rows: jogos } = await client.query(`
            SELECT placar_casa, placar_fora, mle_l_home, mle_l_away
            FROM jogos
            WHERE data_jogo::date BETWEEN $1::date AND $2::date
              AND placar_casa IS NOT NULL
              AND placar_fora IS NOT NULL
              AND mle_l_home IS NOT NULL
              AND mle_l_away IS NOT NULL
        `, [DATA_INICIAL, DATA_FINAL]);

        console.log(`Jogos avaliados: ${jogos.length}\n`);

        const contadores = {};
        for (const mercado of ORDEM_MERCADOS) {
            contadores[mercado] = { sugestoes: 0, greens: 0, reds: 0 };
        }

        for (const jogo of jogos) {
            const lambdaHome = Number(jogo.mle_l_home);
            const lambdaAway = Number(jogo.mle_l_away);
            const placarCasa = Number(jogo.placar_casa);
            const placarFora = Number(jogo.placar_fora);

            if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway)) continue;

            const grade = calcularGradeResultado(lambdaHome, lambdaAway);
            const probs = derivarProbabilidadesMercados(grade);
            const real = resultadoRealMercados(placarCasa, placarFora);

            for (const mercado of ORDEM_MERCADOS) {
                if (probs[mercado] > LIMIAR_SUGESTAO) {
                    contadores[mercado].sugestoes++;
                    if (real[mercado]) contadores[mercado].greens++;
                    else contadores[mercado].reds++;
                }
            }
        }

        console.log('DESEMPENHO POR MERCADO (Probabilidade > 60%) — MLE');
        console.log('------------------------------------------------------');

        for (const mercado of ORDEM_MERCADOS) {
            const { sugestoes, greens, reds } = contadores[mercado];
            const taxa = sugestoes > 0 ? ((greens / sugestoes) * 100).toFixed(1) : '0.0';
            const nomeFormatado = mercado.padEnd(22, ' ');
            console.log(
                `Mercado: ${nomeFormatado} | Sugestões: ${sugestoes} | 🟢 GREENS: ${greens} | 🔴 REDS: ${reds} | 🎯 Taxa de Acerto: ${taxa}%`
            );
        }

        console.log('======================================================\n');

    } catch (err) {
        console.error('[ERRO]', err);
    } finally {
        await client.end();
    }
}

gerarRelatorioMercadosMLE();