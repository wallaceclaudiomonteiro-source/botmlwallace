const { criarPool } = require('../../db'); // Lembre de ajustar o ../ de acordo com a pasta do arquivo

const pool = criarPool('modelo', { 
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});
// =========================================================
// ⚙️ CONFIGURAÇÕES MATEMÁTICAS
// =========================================================
const CONFIG = {
    // Rating base continua com 20
    limiteJogosRating: 10,

    // Contexto/âncora passa a ter 40
    limiteJogosContexto: 40,

    // Mantém o peso temporal original do histórico
    ewmaAlpha: 0.35,

    // Teto para evitar jogo absurdo destruir média
    tetoMetricas: 3.30,

    // ==============================
    // ATAQUE
    // ==============================
    // Ataque base = xG
    // Ajuste de mira = xGOT / xG
    shrinkageAlphaAtaque: 0.25,
    minFatorMira: 0.85,
    maxFatorMira: 1.20,

    // ==============================
    // DEFESA
    // ==============================
    // Defesa base = xG contra
    // Ajuste leve = xGA / xG contra
    shrinkageAlphaDefesa: 0.08,
    minFatorDefesa: 0.92,
    maxFatorDefesa: 1.12,
};

// =========================================================
// ⚙️ CONFIGURAÇÃO DO LAMBDA HISTÓRICO
// =========================================================
const LAMBDA_JOGO_CONFIG = {
    baseUniversal: 1.35,
    minLambda: 0.35,
    maxLambda: 3.8,
    matrixLimit: 12,

    // precisa bater com o team_goals atual
    ataque: 0.60,
    defesa: 0.40,
};

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

function toNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function round2(v) {
    return +toNum(v).toFixed(2);
}

function round3(v) {
    return +toNum(v).toFixed(3);
}

function formatDateYYYYMMDD(v) {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);

    const d = new Date(v);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function ordenarJogosRecentes(jogos) {
    return [...(jogos || [])].sort(
        (a, b) => new Date(b.data_jogo) - new Date(a.data_jogo)
    );
}

function pesoCanonico(jogo, idx) {
    let peso = Math.pow(1 - CONFIG.ewmaAlpha, idx);

    // Ruído leve se houve vermelho para o próprio time naquele jogo
    if (toNum(jogo.qtd_vermelhos, 0) > 0) {
        peso *= 0.85;
    }

    return peso;
}

function mediaPonderada(jogos, getter, filterFn = () => true) {
    if (!jogos || jogos.length === 0) return 0;

    let soma = 0;
    let somaPesos = 0;

    jogos.forEach((jogo, idx) => {
        if (!filterFn(jogo)) return;

        const valor = toNum(getter(jogo), 0);
        const peso = pesoCanonico(jogo, idx);

        soma += valor * peso;
        somaPesos += peso;
    });

    return somaPesos > 0 ? soma / somaPesos : 0;
}

function contar(jogos, filterFn = () => true) {
    return (jogos || []).filter(filterFn).length;
}

// =========================================================
// 🧮 POISSON / LAMBDA HISTÓRICO DO JOGO
// =========================================================
function probPoissonExact(lambda, k) {
    const l = Math.max(Number(lambda || 0), 0);
    const kk = Math.max(Number(k || 0), 0);

    let factorial = 1;
    for (let i = 2; i <= kk; i++) factorial *= i;

    return Math.exp(-l) * Math.pow(l, kk) / factorial;
}

function calcularProbabilidadesPorLambda(lHome, lAway) {
    const limit = LAMBDA_JOGO_CONFIG.matrixLimit;

    const matrizTemp = [];
    let somaProb = 0;

    const rho =
        (lHome + lAway < 2.2)
            ? -0.15
            : (lHome + lAway > 3.0 ? -0.05 : -0.10);

    for (let i = 0; i < limit; i++) {
        matrizTemp[i] = [];

        for (let j = 0; j < limit; j++) {
            let prob = probPoissonExact(lHome, i) * probPoissonExact(lAway, j);

            // Mesmo Dixon-Coles usado no team_goals
            if (i === 0 && j === 0) prob *= 1 - lHome * lAway * rho;
            else if (i === 0 && j === 1) prob *= 1 + lHome * rho;
            else if (i === 1 && j === 0) prob *= 1 + lAway * rho;
            else if (i === 1 && j === 1) prob *= 1 - rho;

            prob = Math.max(0, prob);
            matrizTemp[i][j] = prob;
            somaProb += prob;
        }
    }

    let prob1 = 0;
    let probX = 0;
    let prob2 = 0;
    let probBTTS = 0;
    let probO15 = 0;
    let probO25 = 0;
    let probO35 = 0;

    for (let i = 0; i < limit; i++) {
        for (let j = 0; j < limit; j++) {
            const p = somaProb > 0 ? matrizTemp[i][j] / somaProb : 0;

            if (i > j) prob1 += p;
            else if (i === j) probX += p;
            else prob2 += p;

            if (i > 0 && j > 0) probBTTS += p;
            if (i + j > 1.5) probO15 += p;
            if (i + j > 2.5) probO25 += p;
            if (i + j > 3.5) probO35 += p;
        }
    }

    return {
        p_home_modelo: round2(prob1 * 100),
        p_draw_modelo: round2(probX * 100),
        p_away_modelo: round2(prob2 * 100),

        p_over15_modelo: round2(probO15 * 100),
        p_over25_modelo: round2(probO25 * 100),
        p_over35_modelo: round2(probO35 * 100),

        p_under15_modelo: round2((1 - probO15) * 100),
        p_under25_modelo: round2((1 - probO25) * 100),
        p_under35_modelo: round2((1 - probO35) * 100),

        p_btts_sim_modelo: round2(probBTTS * 100),
        p_btts_nao_modelo: round2((1 - probBTTS) * 100),
    };
}

function calcularLambdaDoJogoHistorico(ratingCasa, ratingFora) {
    const base = LAMBDA_JOGO_CONFIG.baseUniversal;

    const casaAtaque = toNum(ratingCasa?.statsC?.ataque, 0);
    const casaDefesa = toNum(ratingCasa?.statsC?.defesa, 0);

    const foraAtaque = toNum(ratingFora?.statsF?.ataque, 0);
    const foraDefesa = toNum(ratingFora?.statsF?.defesa, 0);

    const ratingsValidos =
        casaAtaque > 0 &&
        casaDefesa > 0 &&
        foraAtaque > 0 &&
        foraDefesa > 0;

    let lHome =
        base *
        Math.pow(casaAtaque / base, LAMBDA_JOGO_CONFIG.ataque) *
        Math.pow(foraDefesa / base, LAMBDA_JOGO_CONFIG.defesa);

    let lAway =
        base *
        Math.pow(foraAtaque / base, LAMBDA_JOGO_CONFIG.ataque) *
        Math.pow(casaDefesa / base, LAMBDA_JOGO_CONFIG.defesa);

    lHome = clamp(
        lHome,
        LAMBDA_JOGO_CONFIG.minLambda,
        LAMBDA_JOGO_CONFIG.maxLambda
    );

    lAway = clamp(
        lAway,
        LAMBDA_JOGO_CONFIG.minLambda,
        LAMBDA_JOGO_CONFIG.maxLambda
    );

    const totalLambda = lHome + lAway;
    const lambdaMin = Math.min(lHome, lAway);
    const lambdaMax = Math.max(lHome, lAway);
    const lambdaDiff = Math.abs(lHome - lAway);

    const probs = calcularProbabilidadesPorLambda(lHome, lAway);

    return {
        lambda_ok: ratingsValidos ? 1 : 0,
        motivo_lambda: ratingsValidos ? 'ok' : 'rating_zero_ou_incompleto',

        l_home_modelo: round3(lHome),
        l_away_modelo: round3(lAway),
        lambda_total_modelo: round3(totalLambda),
        lambda_min_modelo: round3(lambdaMin),
        lambda_max_modelo: round3(lambdaMax),
        lambda_diff_modelo: round3(lambdaDiff),
        lambda_share_favorito_modelo: round3(
            lambdaMax / Math.max(totalLambda, 0.0001)
        ),

        rating_usado: {
            casa_rating_ataque: round3(casaAtaque),
            casa_rating_defesa: round3(casaDefesa),
            fora_rating_ataque: round3(foraAtaque),
            fora_rating_defesa: round3(foraDefesa),
            pesos_lambda: {
                ataque: LAMBDA_JOGO_CONFIG.ataque,
                defesa: LAMBDA_JOGO_CONFIG.defesa,
            },
        },

        ...probs,
    };
}

function montarContextoLambdaParaLinha(jogo, lambdaBase, ladoTime) {
    const isCasa = ladoTime === 'casa';

    const placarCasa = toNum(jogo.placar_casa, 0);
    const placarFora = toNum(jogo.placar_fora, 0);
    const golsTotal = toNum(jogo.gols_total, placarCasa + placarFora);

    const golsTime = isCasa ? placarCasa : placarFora;
    const golsAdv = isCasa ? placarFora : placarCasa;

    const xgHome = toNum(jogo.xg_home, 0);
    const xgAway = toNum(jogo.xg_away, 0);

    const xgotHome = toNum(jogo.xgot_home, 0);
    const xgotAway = toNum(jogo.xgot_away, 0);

    const xgContraHome = toNum(jogo.xg_contra_home, 0);
    const xgContraAway = toNum(jogo.xg_contra_away, 0);

    // xga no banco = xGOT enfrentado
    const xgaHome = toNum(jogo.xga_home, 0);
    const xgaAway = toNum(jogo.xga_away, 0);

    const xgTotal = toNum(jogo.xg_total, xgHome + xgAway);
    const xgotTotal = toNum(jogo.xgot_total, xgotHome + xgotAway);
    const xgContraTotal = toNum(jogo.xg_contra_total, xgContraHome + xgContraAway);
    const xgaTotal = toNum(jogo.xga_total, xgaHome + xgaAway);

    const xgTime = isCasa ? xgHome : xgAway;
    const xgAdv = isCasa ? xgAway : xgHome;

    const xgotTime = isCasa ? xgotHome : xgotAway;
    const xgotAdv = isCasa ? xgotAway : xgotHome;

    const xgContraTime = isCasa ? xgContraHome : xgContraAway;
    const xgContraAdv = isCasa ? xgContraAway : xgContraHome;

    const xgaTime = isCasa ? xgaHome : xgaAway;
    const xgaAdv = isCasa ? xgaAway : xgaHome;

    const bttsSim = placarCasa > 0 && placarFora > 0 ? 1 : 0;

    const over15 = golsTotal > 1 ? 1 : 0;
    const over25 = golsTotal > 2 ? 1 : 0;
    const over35 = golsTotal > 3 ? 1 : 0;

    const under15 = golsTotal <= 1 ? 1 : 0;
    const under25 = golsTotal <= 2 ? 1 : 0;
    const under35 = golsTotal <= 3 ? 1 : 0;

    const lHome = toNum(lambdaBase.l_home_modelo, 0);
    const lAway = toNum(lambdaBase.l_away_modelo, 0);
    const lambdaTotal = toNum(lambdaBase.lambda_total_modelo, 0);

    return {
        ...lambdaBase,

        lado_time: ladoTime,

        data_jogo: formatDateYYYYMMDD(jogo.data_jogo),
        flashscore_id_jogo: jogo.flashscore_id_jogo,
        flashscore_slug_liga: jogo.flashscore_slug_liga,

        id_time_casa: Number(jogo.id_time_casa),
        id_time_fora: Number(jogo.id_time_fora),

        flashscore_id_time_casa: jogo.flashscore_id_time_casa,
        flashscore_id_time_fora: jogo.flashscore_id_time_fora,

        nome_time_casa: jogo.nome_time_casa,
        nome_time_fora: jogo.nome_time_fora,

        id_time_analisado: isCasa
            ? Number(jogo.id_time_casa)
            : Number(jogo.id_time_fora),

        id_time_adversario: isCasa
            ? Number(jogo.id_time_fora)
            : Number(jogo.id_time_casa),

        gols_time: golsTime,
        gols_adversario: golsAdv,
        gols_total: golsTotal,

        // Produção real do jogo.
        // Ajuda a separar placar justo, placar enganoso, eficiência e fragilidade defensiva.
        metricas_reais: {
            gols_home: placarCasa,
            gols_away: placarFora,
            gols_total: golsTotal,

            xg_home: round3(xgHome),
            xg_away: round3(xgAway),
            xg_total: round3(xgTotal),

            xgot_home: round3(xgotHome),
            xgot_away: round3(xgotAway),
            xgot_total: round3(xgotTotal),

            // xG contra estrutural
            xg_contra_home: round3(xgContraHome),
            xg_contra_away: round3(xgContraAway),
            xg_contra_total: round3(xgContraTotal),

            // xGA no banco = xGOT enfrentado
            xga_home: round3(xgaHome),
            xga_away: round3(xgaAway),
            xga_total: round3(xgaTotal),

            lado_time: ladoTime,

            xg_time: round3(xgTime),
            xg_adversario: round3(xgAdv),

            xgot_time: round3(xgotTime),
            xgot_adversario: round3(xgotAdv),

            xg_contra_time: round3(xgContraTime),
            xg_contra_adversario: round3(xgContraAdv),

            xga_time: round3(xgaTime),
            xga_adversario: round3(xgaAdv),
        },

        resultado_real: {
            placar: `${placarCasa}-${placarFora}`,

            over15,
            over25,
            over35,

            under15,
            under25,
            under35,

            btts_sim: bttsSim,
            btts_nao: bttsSim ? 0 : 1,

            home_win: placarCasa > placarFora ? 1 : 0,
            draw: placarCasa === placarFora ? 1 : 0,
            away_win: placarCasa < placarFora ? 1 : 0,
        },

        residual_real_vs_modelo: {
            gols_total_menos_lambda: round3(
                golsTotal - lambdaTotal
            ),

            over15_hit_menos_prob: round3(
                over15 - (lambdaBase.p_over15_modelo / 100)
            ),

            over25_hit_menos_prob: round3(
                over25 - (lambdaBase.p_over25_modelo / 100)
            ),

            over35_hit_menos_prob: round3(
                over35 - (lambdaBase.p_over35_modelo / 100)
            ),

            under35_hit_menos_prob: round3(
                under35 - (lambdaBase.p_under35_modelo / 100)
            ),

            btts_hit_menos_prob: round3(
                bttsSim - (lambdaBase.p_btts_sim_modelo / 100)
            ),
        },

        residual_producao_vs_modelo: {
            xg_total_menos_lambda: round3(
                xgTotal - lambdaTotal
            ),

            xgot_total_menos_lambda: round3(
                xgotTotal - lambdaTotal
            ),

            gols_total_menos_xg: round3(
                golsTotal - xgTotal
            ),

            gols_total_menos_xgot: round3(
                golsTotal - xgotTotal
            ),

            xgot_total_menos_xg_total: round3(
                xgotTotal - xgTotal
            ),

            xg_home_menos_l_home: round3(
                xgHome - lHome
            ),

            xg_away_menos_l_away: round3(
                xgAway - lAway
            ),

            xgot_home_menos_l_home: round3(
                xgotHome - lHome
            ),

            xgot_away_menos_l_away: round3(
                xgotAway - lAway
            ),

            gols_home_menos_xg_home: round3(
                placarCasa - xgHome
            ),

            gols_away_menos_xg_away: round3(
                placarFora - xgAway
            ),

            gols_time_menos_xg_time: round3(
                golsTime - xgTime
            ),

            gols_time_menos_xgot_time: round3(
                golsTime - xgotTime
            ),

            gols_adversario_menos_xg_adversario: round3(
                golsAdv - xgAdv
            ),

            gols_adversario_menos_xgot_adversario: round3(
                golsAdv - xgotAdv
            ),

            // Defesa estrutural real vs modelo
            xg_contra_home_menos_l_away: round3(
                xgContraHome - lAway
            ),

            xg_contra_away_menos_l_home: round3(
                xgContraAway - lHome
            ),

            xg_contra_time_menos_lambda_adversario: round3(
                xgContraTime - (isCasa ? lAway : lHome)
            ),

            xg_contra_adversario_menos_lambda_time: round3(
                xgContraAdv - (isCasa ? lHome : lAway)
            ),

            // Perigo real no alvo sofrido vs modelo
            xga_home_menos_l_away: round3(
                xgaHome - lAway
            ),

            xga_away_menos_l_home: round3(
                xgaAway - lHome
            ),

            xga_time_menos_lambda_adversario: round3(
                xgaTime - (isCasa ? lAway : lHome)
            ),

            xga_adversario_menos_lambda_time: round3(
                xgaAdv - (isCasa ? lHome : lAway)
            ),
        },
    };
}

// =========================================================
// 🧮 MOTOR DE CÁLCULO DE RATING (PURO E BLINDADO)
// =========================================================
function calcularEWMA(itens) {
    if (!itens || itens.length === 0) return 0;

    let somaPesada = 0;
    let somaPesos = 0;

    itens.forEach((item, idx) => {
        const peso = Math.pow(1 - CONFIG.ewmaAlpha, idx);
        somaPesada += item.valor * peso;
        somaPesos += peso;
    });

    return somaPesos > 0 ? somaPesada / somaPesos : 0;
}

function processarRatingMando(jogos) {
    if (!jogos || jogos.length < 6) {
        return {
            ataque: 0,
            defesa: 0,
            ewmaXg: 0,
            ewmaXga: 0,
            fatorMira: 1,
            fatorDefesa: 1,
            amostra: jogos ? jogos.length : 0,
        };
    }

    jogos.sort((a, b) => new Date(b.data_jogo) - new Date(a.data_jogo));

    const xgLivre = [];
    const xgotLivre = [];

    // Defesa estrutural: xG contra
    const xgContraLivre = [];

    // xGA atual do banco = xGOT enfrentado
    const xgaLivre = [];

   jogos.forEach((j) => {
    // Se não tiver xG ou xG Contra base, aí sim ignoramos o jogo
    if (j.xg == null || j.xg_contra == null) return;

    // 1. Base Ataque (xG)
    let valXg = Math.max(0.01, toNum(j.xg, 0));
    valXg = Math.min(valXg, CONFIG.tetoMetricas);

    // 2. Base Defesa (xG Contra)
    let valXgContra = Math.max(0.01, toNum(j.xg_contra, 0));
    valXgContra = Math.min(valXgContra, CONFIG.tetoMetricas);

    // 3. HÍBRIDO ATAQUE: Se xGOT for nulo, assumimos o valor do xG (fator = 1)
    let rawXgot = j.xgot != null ? j.xgot : j.xg;
    let valXgot = Math.max(0.01, toNum(rawXgot, 0));
    valXgot = Math.min(valXgot, CONFIG.tetoMetricas);

    // 4. HÍBRIDO DEFESA: Se xGA for nulo, assumimos o valor do xG Contra (fator = 1)
    let rawXga = j.xga != null ? j.xga : j.xg_contra;
    let valXga = Math.max(0.01, toNum(rawXga, 0));
    valXga = Math.min(valXga, CONFIG.tetoMetricas);

    xgLivre.push({ valor: valXg });
    xgotLivre.push({ valor: valXgot });
    xgContraLivre.push({ valor: valXgContra });
    xgaLivre.push({ valor: valXga });
  });

    const ewmaXg = calcularEWMA(xgLivre);
    const ewmaXgot = calcularEWMA(xgotLivre);

    // Mantém o nome ewmaXga por compatibilidade com a coluna casa_ewma_xga/fora_ewma_xga.
    // Mas agora ele representa xG contra estrutural.
    const ewmaXga = calcularEWMA(xgContraLivre);

    // xGA do banco = xGOT enfrentado. Entra só como ajuste leve defensivo.
    const ewmaXgotContra = calcularEWMA(xgaLivre);

    const baseXg = ewmaXg <= 0 ? 0.01 : ewmaXg;

    const fatorMira = clamp(
        1 + CONFIG.shrinkageAlphaAtaque * ((ewmaXgot / baseXg) - 1),
        CONFIG.minFatorMira,
        CONFIG.maxFatorMira
    );

    const ataqueFinal = ewmaXg * fatorMira;

    const baseXgContra = ewmaXga <= 0 ? 0.01 : ewmaXga;

    const fatorDefesa = clamp(
        1 + CONFIG.shrinkageAlphaDefesa * ((ewmaXgotContra / baseXgContra) - 1),
        CONFIG.minFatorDefesa,
        CONFIG.maxFatorDefesa
    );

    const defesaFinal = ewmaXga * fatorDefesa;

    return {
        ataque: ataqueFinal,
        defesa: defesaFinal,
        ewmaXg,
        ewmaXga,
        fatorMira,
        fatorDefesa,
        amostra: jogos.length,
    };
}

// =========================================================
// ⚓ ÂNCORA DOS ÚLTIMOS 12 DO MESMO HISTÓRICO DO RATING
// =========================================================
function calcularAncoraUlt12DoRating(jogos) {
    const jogosOrd = ordenarJogosRecentes(jogos).slice(0, 12);

    if (jogosOrd.length < 6) {
        return {
            sample: jogosOrd.length,
            media_gols_marcados: 0,
            media_gols_sofridos: 0,
            gols_marcados: [],
            gols_sofridos: [],
            media_gols_total: 0,
            taxa_over25: 0,
            gols_totais: [],
        };
    }

    const golsMarcados = jogosOrd.map((j) => toNum(j.gols_marcados_time, 0));
    const golsSofridos = jogosOrd.map((j) => toNum(j.gols_sofridos_time, 0));
    const golsTotais = jogosOrd.map((j) => toNum(j.gols_total_partida, 0));

    const somaMarcados = golsMarcados.reduce((acc, n) => acc + n, 0);
    const somaSofridos = golsSofridos.reduce((acc, n) => acc + n, 0);
    const somaTotais = golsTotais.reduce((acc, n) => acc + n, 0);

    const mediaMarcados = somaMarcados / golsMarcados.length;
    const mediaSofridos = somaSofridos / golsSofridos.length;
    const mediaTotal = somaTotais / golsTotais.length;

    const taxaOver25 =
        golsTotais.filter((g) => g > 2.5).length / golsTotais.length;

    return {
        sample: jogosOrd.length,
        media_gols_marcados: round3(mediaMarcados),
        media_gols_sofridos: round3(mediaSofridos),
        media_gols_total: round3(mediaTotal),
        taxa_over25: round3(taxaOver25),
        gols_marcados: golsMarcados,
        gols_sofridos: golsSofridos,
        gols_totais: golsTotais,
    };
}

// =========================================================
// 🧠 PERFIL RESIDUAL / COMPORTAMENTAL
// =========================================================
function calcularPerfilResidualMandoUnificado(jogos) {
    const jogosOrd = ordenarJogosRecentes(jogos);

    if (!jogosOrd.length) {
        return {
            sample_total: 0,
            sample_low_pos: 0,
            perfil_ativo: 0,
            ameaca_transicao: 0,
            controle_esteril: 0,
        };
    }

    const sampleTotal = jogosOrd.length;
    const sampleLowPos = contar(jogosOrd, (j) => toNum(j.posse, 50) <= 45);

    if (sampleTotal < 6) {
        return {
            sample_total: sampleTotal,
            sample_low_pos: sampleLowPos,
            perfil_ativo: 0,
            ameaca_transicao: 0,
            controle_esteril: 0,
        };
    }

    const avg = (getter, filterFn = () => true) =>
        mediaPonderada(jogosOrd, getter, filterFn);

    const lowPosXg = avg((j) => j.xg, (j) => toNum(j.posse, 50) <= 45);
    const lowPosBig = avg((j) => j.big_chances, (j) => toNum(j.posse, 50) <= 45);
    const lowPosDepth = avg((j) => j.depth_passes, (j) => toNum(j.posse, 50) <= 45);

    const ameacaTransicao =
        sampleLowPos >= 2
            ? (0.55 * lowPosXg) + (0.25 * lowPosBig) + (0.20 * lowPosDepth)
            : 0;

    const posse = avg((j) => j.posse);
    const passPct = avg((j) => j.pass_pct);
    const xg = avg((j) => j.xg);
    const boxTouches = avg((j) => j.box_touches);
    const big = avg((j) => j.big_chances);

    const controleEsteril =
        ((posse / 100) * 0.45 + (passPct / 100) * 0.35) -
        (xg * 0.12 + boxTouches * 0.015 + big * 0.10);

    return {
        sample_total: sampleTotal,
        sample_low_pos: sampleLowPos,
        perfil_ativo: 1,
        ameaca_transicao: round3(ameacaTransicao),
        controle_esteril: round3(controleEsteril),
    };
}

// =========================================================
// 📦 FEATURES DE MERCADO UNIFICADAS
// =========================================================
function calcularFeaturesMercadoMandoUnificadas(jogos) {
    const jogosOrd = ordenarJogosRecentes(jogos);

    if (!jogosOrd.length) {
        return {
            sample: 0,
            cnt_low_pos: 0,

            xg: 0,
            xgot: 0,

            // Defesa nova auditável
            xg_contra: 0,
            xga: 0,

            xa: 0,
            big_chances: 0,
            sot: 0,
            box_shots: 0,
            box_touches: 0,
            depth_passes: 0,

            opp_xg: 0,
            opp_xgot: 0,
            opp_sot: 0,
            opp_box_shots: 0,
            opp_box_touches: 0,

            errors_to_shot: 0,
            errors_goal: 0,
            goalkeeper_saves: 0,

            posse: 0,
            pass_pct: 0,
            final_third_pass_pct: 0,

            low_xg: 0,
            low_xgot: 0,
            low_big_chances: 0,
            low_box_shots: 0,
            low_box_touches: 0,
            low_depth_passes: 0,
        };
    }

    const avg = (getter, filterFn = () => true) =>
        round3(mediaPonderada(jogosOrd, getter, filterFn));

    return {
        sample: jogosOrd.length,
        cnt_low_pos: contar(jogosOrd, (j) => toNum(j.posse, 50) <= 45),

        xg: avg((j) => j.xg),
        xgot: avg((j) => j.xgot),

        // Defesa nova auditável
        xg_contra: avg((j) => j.xg_contra),
        xga: avg((j) => j.xga),

        xa: avg((j) => j.xa),
        big_chances: avg((j) => j.big_chances),
        sot: avg((j) => j.sot),
        box_shots: avg((j) => j.box_shots),
        box_touches: avg((j) => j.box_touches),
        depth_passes: avg((j) => j.depth_passes),

        opp_xg: avg((j) => j.opp_xg),
        opp_xgot: avg((j) => j.opp_xgot),
        opp_sot: avg((j) => j.opp_sot),
        opp_box_shots: avg((j) => j.opp_box_shots),
        opp_box_touches: avg((j) => j.opp_box_touches),

        errors_to_shot: avg((j) => j.errors_to_shot),
        errors_goal: avg((j) => j.errors_goal),
        goalkeeper_saves: avg((j) => j.goalkeeper_saves),

        posse: avg((j) => j.posse),
        pass_pct: avg((j) => j.pass_pct),
        final_third_pass_pct: avg((j) => j.final_third_pass_pct),

        low_xg: avg((j) => j.xg, (j) => toNum(j.posse, 50) <= 45),
        low_xgot: avg((j) => j.xgot, (j) => toNum(j.posse, 50) <= 45),
        low_big_chances: avg((j) => j.big_chances, (j) => toNum(j.posse, 50) <= 45),
        low_box_shots: avg((j) => j.box_shots, (j) => toNum(j.posse, 50) <= 45),
        low_box_touches: avg((j) => j.box_touches, (j) => toNum(j.posse, 50) <= 45),
        low_depth_passes: avg((j) => j.depth_passes, (j) => toNum(j.posse, 50) <= 45),
    };
}

// =========================================================
// 🔎 BUSCAR JOGOS DA DATA PARA CALCULAR LAMBDA HISTÓRICO
// =========================================================
async function buscarJogosDoDiaParaLambda(client, DATA_ALVO) {
    const res = await client.query(
        `
        SELECT
            j.id AS id_jogo,
            j.flashscore_id AS flashscore_id_jogo,
            j.data_jogo,
            j.flashscore_slug_liga,

            tc.id AS id_time_casa,
            tf.id AS id_time_fora,

            j.flashscore_id_time_casa,
            j.flashscore_id_time_fora,

            tc.nome AS nome_time_casa,
            tf.nome AS nome_time_fora,

            COALESCE(j.placar_casa, 0) AS placar_casa,
            COALESCE(j.placar_fora, 0) AS placar_fora,

            COALESCE(j.placar_casa, 0) + COALESCE(j.placar_fora, 0) AS gols_total,

            -- Métricas reais do mandante
            COALESCE(ec.xg, 0) AS xg_home,
            COALESCE(ec.xgot, 0) AS xgot_home,
            COALESCE(ec.xg_contra, 0) AS xg_contra_home,
            COALESCE(ec.xga, 0) AS xga_home,

            -- Métricas reais do visitante
            COALESCE(ef.xg, 0) AS xg_away,
            COALESCE(ef.xgot, 0) AS xgot_away,
            COALESCE(ef.xg_contra, 0) AS xg_contra_away,
            COALESCE(ef.xga, 0) AS xga_away,

            -- Totais de produção real do jogo
            COALESCE(ec.xg, 0) + COALESCE(ef.xg, 0) AS xg_total,
            COALESCE(ec.xgot, 0) + COALESCE(ef.xgot, 0) AS xgot_total,

            -- Totais defensivos auditáveis
            COALESCE(ec.xg_contra, 0) + COALESCE(ef.xg_contra, 0) AS xg_contra_total,
            COALESCE(ec.xga, 0) + COALESCE(ef.xga, 0) AS xga_total

        FROM jogos j
        JOIN times tc
          ON tc.flashscore_id = j.flashscore_id_time_casa

        JOIN times tf
          ON tf.flashscore_id = j.flashscore_id_time_fora

        LEFT JOIN estatisticas_geral ec
          ON ec.flashscore_id_jogo = j.flashscore_id
         AND ec.id_time = tc.id
         AND ec.eh_casa = 1

        LEFT JOIN estatisticas_geral ef
          ON ef.flashscore_id_jogo = j.flashscore_id
         AND ef.id_time = tf.id
         AND ef.eh_casa = 0

        WHERE j.data_jogo = $1
          AND j.estatisticas_coletadas = 1
          AND j.total_esperado IS NULL 
          AND (j.sem_xg_para_rating IS NULL OR j.sem_xg_para_rating = 1)
          `,
        [DATA_ALVO]
    );

    return res.rows;
}

async function atualizarLambdaHistoricoDaData(client, DATA_ALVO, ratingsCalculadosMap) {
    const jogosDia = await buscarJogosDoDiaParaLambda(client, DATA_ALVO);

    let countLambda = 0;
    let countSemRating = 0;

    const queryUpdate = `
        UPDATE rating_times_historico
        SET
            lambda_jogo_contexto = $3,
            atualizado_em = CURRENT_TIMESTAMP
        WHERE data_referencia = $1
          AND id_time = $2
    `;

    const queryUpdateJogo = `
        UPDATE jogos 
        SET 
            casa_rating_ataque = $1,
            casa_rating_defesa = $2,
            fora_rating_ataque = $3,
            fora_rating_defesa = $4,
            l_home = $5,
            l_away = $6,
            total_esperado = $7
        WHERE flashscore_id = $8
    `;

    for (const jogo of jogosDia) {
        const ratingCasa = ratingsCalculadosMap.get(String(jogo.id_time_casa));
        const ratingFora = ratingsCalculadosMap.get(String(jogo.id_time_fora));

        if (!ratingCasa || !ratingFora) {
            countSemRating++;
            continue;
        }

        const lambdaBase = calcularLambdaDoJogoHistorico(ratingCasa, ratingFora);

        const contextoCasa = montarContextoLambdaParaLinha(
            jogo,
            lambdaBase,
            'casa'
        );

        const contextoFora = montarContextoLambdaParaLinha(
            jogo,
            lambdaBase,
            'fora'
        );

        await client.query(queryUpdate, [
            DATA_ALVO,
            jogo.id_time_casa,
            JSON.stringify(contextoCasa),
        ]);

        await client.query(queryUpdate, [
            DATA_ALVO,
            jogo.id_time_fora,
            JSON.stringify(contextoFora),
        ]);

        await client.query(queryUpdateJogo, [
            ratingCasa.statsC.ataque,
            ratingCasa.statsC.defesa,
            ratingFora.statsF.ataque,
            ratingFora.statsF.defesa,
            lambdaBase.l_home_modelo,
            lambdaBase.l_away_modelo,
            lambdaBase.lambda_total_modelo,
            jogo.flashscore_id_jogo
        ]);

        countLambda += 2;
    }

    return {
        linhas_atualizadas: countLambda,
        jogos_sem_rating_completo: countSemRating,
    };
}

// =========================================================
// 🚀 PROCESSAR UMA DATA
// =========================================================
async function processarData(client, DATA_ALVO, indiceAtual, totalDatas) {
    let emTransacao = false;

    console.log(`\n📅 [${indiceAtual}/${totalDatas}] Processando data ${DATA_ALVO}`);
    console.log(`🚀 [ETL] Iniciando Motor Blindado Unificado para: ${DATA_ALVO}`);

    try {
        const resChecagem = await client.query(
            `
            SELECT COUNT(*) AS count
            FROM jogos
            WHERE data_jogo = $1
            `,
            [DATA_ALVO]
        );

        if (toNum(resChecagem.rows[0].count, 0) === 0) {
            console.log('ℹ️ Nenhum jogo encontrado no calendário para esta data.');
            return;
        }

        const dataMinHistorico = new Date(`${DATA_ALVO}T00:00:00`);
        dataMinHistorico.setFullYear(dataMinHistorico.getFullYear() - 2);

        const yyyy = dataMinHistorico.getFullYear();
        const mm = String(dataMinHistorico.getMonth() + 1).padStart(2, '0');
        const dd = String(dataMinHistorico.getDate()).padStart(2, '0');
        const DATA_MIN_HISTORICO = `${yyyy}-${mm}-${dd}`;

        await client.query('BEGIN');
        emTransacao = true;

        const queryMaster = `
  WITH JogosDoDia AS (
    SELECT DISTINCT
      j.flashscore_id,
      j.data_jogo,
      j.flashscore_slug_liga,
      j.flashscore_id_time_casa,
      j.flashscore_id_time_fora
    FROM jogos j
    WHERE j.data_jogo = $2
      AND j.total_esperado IS NULL 
      AND j.flashscore_id_time_casa IS NOT NULL
      AND j.flashscore_id_time_fora IS NOT NULL
      AND j.flashscore_slug_liga IS NOT NULL
  ),

  TimesDoDia AS (
    SELECT
      tc.id AS id_time,
      jd.flashscore_id_time_casa AS flashscore_id_time,
      jd.flashscore_slug_liga AS liga_alvo
    FROM JogosDoDia jd
    JOIN times tc
      ON tc.flashscore_id = jd.flashscore_id_time_casa

    UNION

    SELECT
      tf.id AS id_time,
      jd.flashscore_id_time_fora AS flashscore_id_time,
      jd.flashscore_slug_liga AS liga_alvo
    FROM JogosDoDia jd
    JOIN times tf
      ON tf.flashscore_id = jd.flashscore_id_time_fora
  ),

  TimesDoDiaMando AS (
    SELECT
      td.id_time,
      td.flashscore_id_time,
      td.liga_alvo,
      1 AS eh_casa
    FROM TimesDoDia td

    UNION ALL

    SELECT
      td.id_time,
      td.flashscore_id_time,
      td.liga_alvo,
      0 AS eh_casa
    FROM TimesDoDia td
  ),

  /* 
   * 1) BASE GERAL: Busca TODOS os jogos, removendo a trava de liga do JOIN. 
   * Cria a fila global (rn_global) e identifica quem é da liga alvo.
   */
  JogosHistoricosBase AS (
    SELECT
      tdm.id_time,
      tdm.flashscore_id_time,
      tdm.liga_alvo,
      tdm.eh_casa,

      j.id AS id_jogo,
      j.flashscore_id AS flashscore_id_jogo,
      j.data_jogo,
      j.flashscore_slug_liga,
      j.flashscore_id_time_casa,
      j.flashscore_id_time_fora,
      COALESCE(j.placar_casa, 0) AS placar_casa,
      COALESCE(j.placar_fora, 0) AS placar_fora,

      -- Fila 1: Qualquer liga (Histórico Global)
      ROW_NUMBER() OVER (
        PARTITION BY tdm.id_time, tdm.liga_alvo, tdm.eh_casa
        ORDER BY j.data_jogo DESC, j.id DESC
      ) AS rn_global,
      
      -- Identificador se o jogo é da liga alvo
      CASE WHEN j.flashscore_slug_liga = tdm.liga_alvo THEN 1 ELSE 0 END AS eh_mesma_liga

    FROM TimesDoDiaMando tdm
    JOIN jogos j
      ON j.estatisticas_coletadas = 1
     AND j.data_jogo < $2
     AND j.data_jogo >= $3
     AND (
       (tdm.eh_casa = 1 AND j.flashscore_id_time_casa = tdm.flashscore_id_time)
       OR
       (tdm.eh_casa = 0 AND j.flashscore_id_time_fora = tdm.flashscore_id_time)
     )
  ),

  /* 
   * 2) FILA ESPECÍFICA DA LIGA: Cria um contador secundário apenas
   * para os jogos que pertencem à liga alvo.
   */
  JogosHistoricosFilaLiga AS (
    SELECT 
      *,
      CASE WHEN eh_mesma_liga = 1 THEN
        ROW_NUMBER() OVER (
          PARTITION BY id_time, liga_alvo, eh_casa, eh_mesma_liga
          ORDER BY data_jogo DESC, id_jogo DESC
        ) 
      ELSE NULL END AS rn_liga
    FROM JogosHistoricosBase
  ),

  /* 
   * 3) MAPEAMENTO DO CENÁRIO: Quantos jogos esse time tem 
   * especificamente na liga alvo?
   */
  AvaliacaoCenario AS (
    SELECT 
      id_time, 
      liga_alvo, 
      eh_casa,
      COUNT(CASE WHEN eh_mesma_liga = 1 THEN 1 END) AS total_jogos_liga
    FROM JogosHistoricosBase
    GROUP BY id_time, liga_alvo, eh_casa
  ),

  /* 
   * 4) DISJUNTOR INTELIGENTE: Decide qual trilha de dados usar
   * com base na amostra da liga.
   */
  JogosTopContexto AS (
    SELECT f.*
    FROM JogosHistoricosFilaLiga f
    JOIN AvaliacaoCenario a 
      ON a.id_time = f.id_time 
     AND a.liga_alvo = f.liga_alvo 
     AND a.eh_casa = f.eh_casa
    WHERE 
      -- CADASTRADO E ESTÁVEL: Tem >= 6 jogos na liga? Pega SOMENTE a liga.
      (a.total_jogos_liga >= 6 AND f.eh_mesma_liga = 1 AND f.rn_liga <= $1)
      OR 
      -- FALLBACK GLOBAL: Tem < 6 jogos na liga? Aciona o histórico global.
      (a.total_jogos_liga < 6 AND f.rn_global <= $1)
  )

  SELECT
    jt.id_time,
    jt.flashscore_id_time AS flashscore_id_time,
    tnome.nome AS nome_time,
    jt.liga_alvo,
    CASE WHEN jt.eh_casa = 1 THEN 'casa' ELSE 'fora' END AS mando,

    e.xg,
    e.xgot,
    e.xg_contra,
    e.xga,

    COALESCE(e.xa, 0) AS xa,
    COALESCE(e.chances_clara, 0) AS big_chances,
    COALESCE(e.finalizacoes_no_gol, 0) AS sot,
    COALESCE(e.finalizacoes_de_dentro_area, 0) AS box_shots,
    COALESCE(e.toques_area_adversaria, 0) AS box_touches,
    COALESCE(e.passes_profundidade_certos, 0) AS depth_passes,
    COALESCE(e.posse_bola, 50) AS posse,
    COALESCE(e.passes_porcentagem, 0) AS pass_pct,
    COALESCE(e.passes_terco_final_porcentagem, 0) AS final_third_pass_pct,
    COALESCE(e.erros_resultaram_finalizacao, 0) AS errors_to_shot,
    COALESCE(e.erros_resultaram_gol, 0) AS errors_goal,
    COALESCE(e.defesas_goleiro, 0) AS goalkeeper_saves,

    COALESCE(adv.xg, 0) AS opp_xg,
    COALESCE(adv.xgot, 0) AS opp_xgot,
    COALESCE(adv.finalizacoes_no_gol, 0) AS opp_sot,
    COALESCE(adv.finalizacoes_de_dentro_area, 0) AS opp_box_shots,
    COALESCE(adv.toques_area_adversaria, 0) AS opp_box_touches,

    0 AS qtd_vermelhos,
    0 AS qtd_penaltis,

    CASE
      WHEN jt.eh_casa = 1 THEN jt.placar_casa
      ELSE jt.placar_fora
    END AS gols_marcados_time,

    CASE
      WHEN jt.eh_casa = 1 THEN jt.placar_fora
      ELSE jt.placar_casa
    END AS gols_sofridos_time,

    (COALESCE(jt.placar_casa, 0) + COALESCE(jt.placar_fora, 0)) AS gols_total_partida,

    jt.data_jogo,
    jt.id_jogo AS id_partida_interna,
    jt.flashscore_id_jogo,
    jt.flashscore_slug_liga,
    jt.flashscore_id_time_casa,
    jt.flashscore_id_time_fora

  FROM JogosTopContexto jt
  LEFT JOIN times tnome
    ON tnome.id = jt.id_time
  JOIN estatisticas_geral e
    ON e.flashscore_id_jogo = jt.flashscore_id_jogo
   AND e.id_time = jt.id_time
   AND e.xg IS NOT NULL
   AND e.xg_contra IS NOT NULL
   AND e.eh_casa = jt.eh_casa
  JOIN estatisticas_geral adv
    ON adv.flashscore_id_jogo = jt.flashscore_id_jogo
   AND adv.id_time <> jt.id_time
  ORDER BY jt.id_time, jt.eh_casa DESC, jt.data_jogo DESC, jt.id_jogo DESC;
`;

        const resHists = await client.query(queryMaster, [
            CONFIG.limiteJogosContexto,
            DATA_ALVO,
            DATA_MIN_HISTORICO,
        ]);

        if (resHists.rows.length === 0) {
            console.log('ℹ️ Sem dados vinculados suficientes.');
            await client.query('ROLLBACK');
            emTransacao = false;
            return;
        }

        const timesMap = new Map();

        resHists.rows.forEach((r) => {
            const k = String(r.id_time);

            if (!timesMap.has(k)) {
                timesMap.set(k, {
                    id_original: r.id_time,
                    fs_id: r.flashscore_id_time,
                    nome: r.nome_time,
                    liga_alvo: r.liga_alvo,
                    casa: [],
                    fora: [],
                });
            }

            timesMap.get(k)[r.mando].push(r);
        });

        let countSalvos = 0;
        const ratingsCalculadosMap = new Map();

        const queryInsert = `
  INSERT INTO rating_times_historico (
    data_referencia,
    id_time, flashscore_id_time, nome_time,
    casa_amostra, casa_rating_ataque, casa_rating_defesa, casa_ewma_xg, casa_ewma_xga, casa_fator_mira, casa_perfil, casa_market_features, casa_anchor_ult5,
    fora_amostra, fora_rating_ataque, fora_rating_defesa, fora_ewma_xg, fora_ewma_xga, fora_fator_mira, fora_perfil, fora_market_features, fora_anchor_ult5,
    atualizado_em
  ) VALUES (
    $1,
    $2, $3, $4,
    $5, $6, $7, $8, $9, $10, $11, $12, $13,
    $14, $15, $16, $17, $18, $19, $20, $21, $22,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (data_referencia, id_time) DO UPDATE SET
    flashscore_id_time = EXCLUDED.flashscore_id_time,
    nome_time = EXCLUDED.nome_time,

    casa_amostra = EXCLUDED.casa_amostra,
    casa_rating_ataque = EXCLUDED.casa_rating_ataque,
    casa_rating_defesa = EXCLUDED.casa_rating_defesa,
    casa_ewma_xg = EXCLUDED.casa_ewma_xg,
    casa_ewma_xga = EXCLUDED.casa_ewma_xga,
    casa_fator_mira = EXCLUDED.casa_fator_mira,
    casa_perfil = EXCLUDED.casa_perfil,
    casa_market_features = EXCLUDED.casa_market_features,
    casa_anchor_ult5 = EXCLUDED.casa_anchor_ult5,

    fora_amostra = EXCLUDED.fora_amostra,
    fora_rating_ataque = EXCLUDED.fora_rating_ataque,
    fora_rating_defesa = EXCLUDED.fora_rating_defesa,
    fora_ewma_xg = EXCLUDED.fora_ewma_xg,
    fora_ewma_xga = EXCLUDED.fora_ewma_xga,
    fora_fator_mira = EXCLUDED.fora_fator_mira,
    fora_perfil = EXCLUDED.fora_perfil,
    fora_market_features = EXCLUDED.fora_market_features,
    fora_anchor_ult5 = EXCLUDED.fora_anchor_ult5,
    atualizado_em = CURRENT_TIMESTAMP;
`;

        for (const [, dados] of timesMap.entries()) {
            const casaJogosContexto = ordenarJogosRecentes(dados.casa);
            const foraJogosContexto = ordenarJogosRecentes(dados.fora);

            const casaJogosRating = casaJogosContexto.slice(0, CONFIG.limiteJogosRating);
            const foraJogosRating = foraJogosContexto.slice(0, CONFIG.limiteJogosRating);

            const statsC = processarRatingMando(casaJogosRating);
            const statsF = processarRatingMando(foraJogosRating);

            if (Number(statsC.amostra) < 6 || Number(statsF.amostra) < 6) {
                continue;
            }

            ratingsCalculadosMap.set(String(dados.id_original), {
                id_time: dados.id_original,
                flashscore_id_time: dados.fs_id,
                nome_time: dados.nome,
                liga_alvo: dados.liga_alvo,

                statsC,
                statsF,

                casaJogosRating,
                foraJogosRating,

                casaJogosContexto,
                foraJogosContexto,
            });

            const perfilCasa = calcularPerfilResidualMandoUnificado(casaJogosRating);
            const perfilFora = calcularPerfilResidualMandoUnificado(foraJogosRating);

            const featuresCasa = calcularFeaturesMercadoMandoUnificadas(casaJogosRating);
            const featuresFora = calcularFeaturesMercadoMandoUnificadas(foraJogosRating);

            const anchorCasa = calcularAncoraUlt12DoRating(casaJogosRating);
            const anchorFora = calcularAncoraUlt12DoRating(foraJogosRating);

            await client.query(queryInsert, [
                DATA_ALVO,

                dados.id_original,
                dados.fs_id,
                dados.nome,

                statsC.amostra,
                statsC.ataque,
                statsC.defesa,
                statsC.ewmaXg,
                statsC.ewmaXga,
                statsC.fatorMira,
                JSON.stringify(perfilCasa),
                JSON.stringify(featuresCasa),
                JSON.stringify(anchorCasa),

                statsF.amostra,
                statsF.ataque,
                statsF.defesa,
                statsF.ewmaXg,
                statsF.ewmaXga,
                statsF.fatorMira,
                JSON.stringify(perfilFora),
                JSON.stringify(featuresFora),
                JSON.stringify(anchorFora),
            ]);

            countSalvos++;
        }

        const resumoLambda = await atualizarLambdaHistoricoDaData(
            client,
            DATA_ALVO,
            ratingsCalculadosMap
        );

        console.log(
            `🧮 [LAMBDA HISTÓRICO] ${resumoLambda.linhas_atualizadas} linhas atualizadas | jogos sem rating completo: ${resumoLambda.jogos_sem_rating_completo}`
        );

        await client.query('COMMIT');
        emTransacao = false;

        console.log(
            `✅ [SUCESSO] ${countSalvos} times atualizados | rating=${CONFIG.limiteJogosRating} jogos | contexto=${CONFIG.limiteJogosContexto} jogos.`
        );
    } catch (e) {
        if (emTransacao) {
            await client.query('ROLLBACK');
        }
        console.error(`❌ Erro fatal em ${DATA_ALVO}:`, e.message);
    }
}

// =========================================================
// 📚 BUSCAR TODAS AS DATAS DA TABELA CALENDARIO (SÓ PENDENTES)
// MAIS ANTIGA -> MAIS NOVA
// =========================================================
async function buscarDatasProcessamento(client) {
    const res = await client.query(`
        SELECT DISTINCT data_jogo
        FROM jogos
        WHERE data_jogo IS NOT NULL
          AND TRIM(data_jogo) <> ''
          AND data_jogo >= '2024-01-01'
          AND data_jogo <= CURRENT_DATE::text
          AND total_esperado IS NULL -- Pega apenas as datas que têm jogos novos não calculados
          AND (sem_xg_para_rating IS NULL OR sem_xg_para_rating = 1)
        ORDER BY data_jogo ASC
    `);

    return res.rows
        .map((r) => formatDateYYYYMMDD(r.data_jogo))
        .filter(Boolean);
}
// =========================================================
// 🚀 PIPELINE PRINCIPAL AUTOMÁTICO
// =========================================================
async function runETLHistoricoCompleto() {
    const client = await pool.connect();

    try {
        const datas = await buscarDatasProcessamento(client);

        if (!datas.length) {
            console.log('ℹ️ Nenhuma data encontrada na tabela calendario.');
            return;
        }

        console.log(`\n📚 [HISTÓRICO] ${datas.length} datas encontradas no calendario para processamento.`);

        for (let i = 0; i < datas.length; i++) {
            const dataAlvo = datas[i];
            await processarData(client, dataAlvo, i + 1, datas.length);
        }

        console.log(`\n🏁 [FINALIZADO] ${datas.length} datas processadas.`);
    } catch (e) {
        console.error('❌ Erro fatal no histórico completo:', e.message);
    } finally {
        client.release();
        await pool.end();
    }
}

runETLHistoricoCompleto();