const { criarClient } = require('./db');
const {
    poisson,
    dixonColesCorrection,
    otimizarModeloConjunto,
    projetarExpectativaGols
} = require('./market_model');

const client = criarClient('modelo');

const RHO_DIXON_COLES = -0.1,
    MAX_GOLS_GRADE = 10,
    JANELA_HISTORICO = '1 year',
    MIN_JOGOS_TREINO = 20;

const METRICAS_OBRIGATORIAS = [
    'xg',
    'xgot',
    'gols_marcados',
    'xg_contra',
    'xga',
    'gols_sofridos'
];

function calcularGradeResultado(
    lambdaHome,
    lambdaAway,
    rho = RHO_DIXON_COLES,
    maxGols = MAX_GOLS_GRADE
) {
    const grade = [];
    let somaTotal = 0;

    for (let h = 0; h <= maxGols; h++) {
        const linha = [];

        for (let a = 0; a <= maxGols; a++) {
            const pBase =
                poisson(lambdaHome, h) *
                poisson(lambdaAway, a);

            const correcao =
                dixonColesCorrection(
                    h,
                    a,
                    lambdaHome,
                    lambdaAway,
                    rho
                );

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

function derivarProbabilidadesMercados(grade) {
    const maxGols = grade.length - 1;

    let probCasa = 0,
        probEmpate = 0,
        probFora = 0,
        probOver15 = 0,
        probOver25 = 0,
        probOver35 = 0;

    let probBTTS = 0,
        probCasaOver05 = 0,
        probCasaOver15 = 0,
        probForaOver05 = 0,
        probForaOver15 = 0;

    for (let h = 0; h <= maxGols; h++) {
        for (let a = 0; a <= maxGols; a++) {

            const p = grade[h][a];
            const total = h + a;

            if (h > a) {
                probCasa += p;
            } else if (h === a) {
                probEmpate += p;
            } else {
                probFora += p;
            }

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

async function buscarJogosCalendario(dataAlvo) {
    const { rows } = await client.query(
        `SELECT *
         FROM calendario
         WHERE data_jogo = $1`,
        [dataAlvo]
    );

    return rows;
}

// ============================================================================
// AJUSTE DO MLE
//
// somenteComXG = false
//     -> comportamento original
//
// somenteComXG = true
//     -> remove do histórico os jogos sem xG válido nos dois lados
// ============================================================================

async function ajustarModeloCompeticao(
    idCompeticao,
    dataAlvo,
    somenteComXG = false
) {
    const { rows: metricasLiga } = await client.query(`
        SELECT
            metrica,
            casa_mediana,
            fora_mediana
        FROM grid_metricas_competicoes
        WHERE id_competicao = $1
          AND metrica = ANY($2)
    `, [
        idCompeticao,
        METRICAS_OBRIGATORIAS
    ]);

    const referenciaLiga = {};

    for (const row of metricasLiga) {
        referenciaLiga[row.metrica] = {
            casa: Number(row.casa_mediana),
            fora: Number(row.fora_mediana)
        };
    }

    const faltantes = METRICAS_OBRIGATORIAS.filter(
        m =>
            !referenciaLiga[m] ||
            !Number.isFinite(referenciaLiga[m].casa) ||
            !Number.isFinite(referenciaLiga[m].fora)
    );

    if (faltantes.length > 0) {
        console.log(
            `[PULAR] Competição ${idCompeticao}: ` +
            `métricas incompletas em grid_metricas_competicoes ` +
            `[${faltantes.join(', ')}]`
        );

        return null;
    }

    const { rows: historicoBruto } = await client.query(`
        SELECT
            j.id,
            j.data_jogo,
            j.flashscore_id,
            j.flashscore_id_time_casa,
            j.flashscore_id_time_fora,
            j.placar_casa,
            j.placar_fora,

            sg.id_time,
            sg.eh_casa,
            sg.xg,
            sg.xgot,
            sg.xg_contra,
            sg.xga,
            sg.gols_marcados,
            sg.gols_sofridos,

            EXP(
                -0.005 *
                ($2::date - j.data_jogo::date)
            ) AS peso_tempo

        FROM jogos j

        INNER JOIN estatisticas_geral sg
            ON sg.flashscore_id_jogo = j.flashscore_id

        WHERE j.id_competicao = $1
          AND j.data_jogo::date >=
              $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL

        ORDER BY j.data_jogo::date ASC
    `, [
        idCompeticao,
        dataAlvo
    ]);

    const mapaJogos = new Map();

    for (const linha of historicoBruto) {

        const chave = String(linha.flashscore_id);

        if (!mapaJogos.has(chave)) {
            mapaJogos.set(chave, {

                flashscore_id: chave,

                casa_id: String(
                    linha.flashscore_id_time_casa
                ),

                fora_id: String(
                    linha.flashscore_id_time_fora
                ),

                gols_casa: Number(
                    linha.placar_casa
                ),

                gols_fora: Number(
                    linha.placar_fora
                ),

                xg_casa: null,
                xg_fora: null,

                xgot_casa: null,
                xgot_fora: null,

                gols_marcados_casa: null,
                gols_marcados_fora: null,

                xg_contra_casa: null,
                xg_contra_fora: null,

                xga_casa: null,
                xga_fora: null,

                gols_sofridos_casa: null,
                gols_sofridos_fora: null,

                peso_tempo:
                    Number(linha.peso_tempo) || 1
            });
        }

        const jogo = mapaJogos.get(chave);

        const xg =
            linha.xg !== null
                ? Number(linha.xg)
                : null;

        const xgot =
            linha.xgot !== null
                ? Number(linha.xgot)
                : null;

        const xgContra =
            linha.xg_contra !== null
                ? Number(linha.xg_contra)
                : null;

        const xga =
            linha.xga !== null
                ? Number(linha.xga)
                : null;

        const golsMarcados =
            linha.gols_marcados !== null
                ? Number(linha.gols_marcados)
                : null;

        const golsSofridos =
            linha.gols_sofridos !== null
                ? Number(linha.gols_sofridos)
                : null;

        if (Number(linha.eh_casa) === 1) {

            jogo.xg_casa = xg;
            jogo.xgot_casa = xgot;

            jogo.xg_contra_casa = xgContra;
            jogo.xga_casa = xga;

            jogo.gols_marcados_casa =
                golsMarcados;

            jogo.gols_sofridos_casa =
                golsSofridos;
        }

        if (Number(linha.eh_casa) === 0) {

            jogo.xg_fora = xg;
            jogo.xgot_fora = xgot;

            jogo.xg_contra_fora =
                xgContra;

            jogo.xga_fora = xga;

            jogo.gols_marcados_fora =
                golsMarcados;

            jogo.gols_sofridos_fora =
                golsSofridos;
        }
    }

    // ================================================================
    // HISTÓRICO ORIGINAL
    // ================================================================

    const jogosValidosOriginais =
        Array.from(mapaJogos.values()).filter(
            j =>
                j.casa_id &&
                j.fora_id &&
                Number.isFinite(j.gols_casa) &&
                Number.isFinite(j.gols_fora)
        );

    // ================================================================
    // HISTÓRICO USADO PELO MODELO
    // ================================================================

    let jogosValidos =
        jogosValidosOriginais;

    if (somenteComXG) {

        jogosValidos =
            jogosValidosOriginais.filter(
                j =>
                    Number.isFinite(j.xg_casa) &&
                    Number.isFinite(j.xg_fora) &&
                    j.xg_casa > 0 &&
                    j.xg_fora > 0
            );
    }

    // ================================================================
    // INFORMAÇÕES DO EXPERIMENTO
    // ================================================================

    if (somenteComXG) {

        const removidos =
            jogosValidosOriginais.length -
            jogosValidos.length;

        const percentualRemovido =
            jogosValidosOriginais.length > 0
                ? (
                    removidos /
                    jogosValidosOriginais.length
                ) * 100
                : 0;

        console.log(
            `\n[MLE SEM xG] Competição ${idCompeticao}`
        );

        console.log(
            `Histórico original : ${jogosValidosOriginais.length}`
        );

        console.log(
            `Com xG válido      : ${jogosValidos.length}`
        );

        console.log(
            `Sem xG removidos   : ${removidos}`
        );

        console.log(
            `% removido         : ${percentualRemovido.toFixed(2)}%`
        );
    }

    if (jogosValidos.length < MIN_JOGOS_TREINO) {

        console.log(
            `[PULAR] Competição ${idCompeticao}: ` +
            `histórico insuficiente ` +
            `(${jogosValidos.length} jogos` +
            `${somenteComXG ? ' com xG' : ''}, ` +
            `mínimo ${MIN_JOGOS_TREINO})`
        );

        return null;
    }

    // ================================================================
    // MLE
    // ================================================================

    const parametros =
        await otimizarModeloConjunto(
            jogosValidos,
            1500,
            0.003,
            {
                referenciaLiga,

                pesoXG: 0.50,
                pesoXGOT: 0.30,
                pesoGols: 0.20,

                pesoXGContra: 0.50,
                pesoXGA: 0.30,
                pesoGolsSofridos: 0.20,

                regularizacao: 0.015,
                gradienteMax: 5
            }
        );

    console.log(
        `[OK] Competição ${idCompeticao}: ` +
        `modelo ` +
        `${somenteComXG ? 'SEM xG' : 'ORIGINAL'} ` +
        `ajustado com ${jogosValidos.length} jogos ` +
        `(convergiu=${parametros.convergiu}, ` +
        `iterações=${parametros.iteracoes})`
    );

    return parametros;
}

// ============================================================================
// SALVAR PREVISÃO ORIGINAL
// ============================================================================

async function salvarPrevisao(
    jogo,
    lambdaHome,
    lambdaAway,
    probs
) {
    const totalGolsEsperado =
        lambdaHome + lambdaAway;

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
            p_fora_over15
        )

        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,

            $10, $11, $12,

            $13, $14, $15,

            $16, $17, $18, $19, $20, $21,
            $22, $23, $24, $25, $26, $27
        )

        ON CONFLICT (flashscore_id_jogo)
        DO UPDATE SET

            total_gols_esperado =
                EXCLUDED.total_gols_esperado,

            casa_gols_esperado =
                EXCLUDED.casa_gols_esperado,

            fora_gols_esperado =
                EXCLUDED.fora_gols_esperado,

            p_home = EXCLUDED.p_home,
            p_draw = EXCLUDED.p_draw,
            p_away = EXCLUDED.p_away,

            p_over15 = EXCLUDED.p_over15,
            p_under15 = EXCLUDED.p_under15,

            p_over25 = EXCLUDED.p_over25,
            p_under25 = EXCLUDED.p_under25,

            p_over35 = EXCLUDED.p_over35,
            p_under35 = EXCLUDED.p_under35,

            p_btts_yes =
                EXCLUDED.p_btts_yes,

            p_btts_no =
                EXCLUDED.p_btts_no,

            p_casa_over05 =
                EXCLUDED.p_casa_over05,

            p_casa_over15 =
                EXCLUDED.p_casa_over15,

            p_fora_over05 =
                EXCLUDED.p_fora_over05,

            p_fora_over15 =
                EXCLUDED.p_fora_over15
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
        (probs.fora_over15 * 100).toFixed(2)
    ]);
}

// ============================================================================
// SALVAR PREVISÃO SEM xG
// ============================================================================

async function salvarPrevisaoSemXG(
    jogo,
    lambdaHome,
    lambdaAway,
    probs
) {
    const totalGolsEsperado =
        lambdaHome + lambdaAway;

    await client.query(`
        INSERT INTO analises_jogos_mle_sem_xg (
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
            p_fora_over15
        )

        VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9,

            $10, $11, $12,

            $13, $14, $15,

            $16, $17, $18, $19, $20, $21,
            $22, $23, $24, $25, $26, $27
        )

        ON CONFLICT (flashscore_id_jogo)
        DO UPDATE SET

            total_gols_esperado =
                EXCLUDED.total_gols_esperado,

            casa_gols_esperado =
                EXCLUDED.casa_gols_esperado,

            fora_gols_esperado =
                EXCLUDED.fora_gols_esperado,

            p_home = EXCLUDED.p_home,
            p_draw = EXCLUDED.p_draw,
            p_away = EXCLUDED.p_away,

            p_over15 = EXCLUDED.p_over15,
            p_under15 = EXCLUDED.p_under15,

            p_over25 = EXCLUDED.p_over25,
            p_under25 = EXCLUDED.p_under25,

            p_over35 = EXCLUDED.p_over35,
            p_under35 = EXCLUDED.p_under35,

            p_btts_yes =
                EXCLUDED.p_btts_yes,

            p_btts_no =
                EXCLUDED.p_btts_no,

            p_casa_over05 =
                EXCLUDED.p_casa_over05,

            p_casa_over15 =
                EXCLUDED.p_casa_over15,

            p_fora_over05 =
                EXCLUDED.p_fora_over05,

            p_fora_over15 =
                EXCLUDED.p_fora_over15
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
        (probs.fora_over15 * 100).toFixed(2)
    ]);
}

// ============================================================================
// PROCESSAMENTO DA DATA
// ============================================================================

async function processarDia(dataAlvo) {

    console.log(
        `\n============================================================`
    );

    console.log(
        `PROCESSANDO DATA: ${dataAlvo}`
    );

    console.log(
        `============================================================\n`
    );

    const jogosDoDia =
        await buscarJogosCalendario(dataAlvo);

    console.log(
        `Encontrados ${jogosDoDia.length} jogo(s) ` +
        `no calendário para ${dataAlvo}.\n`
    );

    if (jogosDoDia.length === 0) {
        return;
    }

    const jogosPorCompeticao =
        new Map();

    for (const jogo of jogosDoDia) {

        const idComp =
            jogo.id_competicao;

        if (!jogosPorCompeticao.has(idComp)) {
            jogosPorCompeticao.set(
                idComp,
                []
            );
        }

        jogosPorCompeticao
            .get(idComp)
            .push(jogo);
    }

    console.log(
        `Distribuídos em ` +
        `${jogosPorCompeticao.size} competição(ões).\n`
    );

    // ================================================================
    // AJUSTA OS DOIS MLEs
    // ================================================================

    const parametrosOriginaisPorCompeticao =
        new Map();

    const parametrosSemXGPorCompeticao =
        new Map();

    for (const idComp of jogosPorCompeticao.keys()) {

        // ------------------------------------------------------------
        // MLE ORIGINAL
        // ------------------------------------------------------------

        const parametrosOriginal =
            await ajustarModeloCompeticao(
                idComp,
                dataAlvo,
                false
            );

        parametrosOriginaisPorCompeticao.set(
            idComp,
            parametrosOriginal
        );

        // ------------------------------------------------------------
        // MLE SEM xG
        // ------------------------------------------------------------

        const parametrosSemXG =
            await ajustarModeloCompeticao(
                idComp,
                dataAlvo,
                true
            );

        parametrosSemXGPorCompeticao.set(
            idComp,
            parametrosSemXG
        );
    }

    console.log(
        `\n--- PREVISÕES DOS DOIS MODELOS ---\n`
    );

    // ================================================================
    // PREVISÕES
    // ================================================================

    for (
        const [idComp, jogos]
        of jogosPorCompeticao.entries()
    ) {

        const parametrosOriginal =
            parametrosOriginaisPorCompeticao.get(
                idComp
            );

        const parametrosSemXG =
            parametrosSemXGPorCompeticao.get(
                idComp
            );

        if (!parametrosOriginal) {

            console.log(
                `(pulando ${jogos.length} jogo(s) ` +
                `da competição ${idComp} — ` +
                `modelo original não ajustado)`
            );

            continue;
        }

        for (const jogo of jogos) {

            const casaId =
                String(jogo.id_time_casa);

            const foraId =
                String(jogo.id_time_fora);

            // ========================================================
            // MODELO ORIGINAL
            // ========================================================

            let lambdaHomeOriginal;
            let lambdaAwayOriginal;

            try {

                lambdaHomeOriginal =
                    projetarExpectativaGols(
                        parametrosOriginal,
                        casaId,
                        foraId,
                        true
                    );

                lambdaAwayOriginal =
                    projetarExpectativaGols(
                        parametrosOriginal,
                        foraId,
                        casaId,
                        false
                    );

            } catch (err) {

                console.log(
                    `[ERRO ORIGINAL] ` +
                    `${jogo.nome_time_casa} x ` +
                    `${jogo.nome_time_fora}: ` +
                    `${err.message}`
                );

                continue;
            }

            const gradeOriginal =
                calcularGradeResultado(
                    lambdaHomeOriginal,
                    lambdaAwayOriginal
                );

            const probsOriginal =
                derivarProbabilidadesMercados(
                    gradeOriginal
                );

            // ========================================================
            // MODELO SEM xG
            // ========================================================

            let lambdaHomeSemXG = null;
            let lambdaAwaySemXG = null;
            let probsSemXG = null;

            if (parametrosSemXG) {

                try {

                    lambdaHomeSemXG =
                        projetarExpectativaGols(
                            parametrosSemXG,
                            casaId,
                            foraId,
                            true
                        );

                    lambdaAwaySemXG =
                        projetarExpectativaGols(
                            parametrosSemXG,
                            foraId,
                            casaId,
                            false
                        );

                    const gradeSemXG =
                        calcularGradeResultado(
                            lambdaHomeSemXG,
                            lambdaAwaySemXG
                        );

                    probsSemXG =
                        derivarProbabilidadesMercados(
                            gradeSemXG
                        );

                } catch (err) {

                    console.log(
                        `[ERRO SEM xG] ` +
                        `${jogo.nome_time_casa} x ` +
                        `${jogo.nome_time_fora}: ` +
                        `${err.message}`
                    );
                }
            }

            // ========================================================
            // LOG DA COMPARAÇÃO
            // ========================================================

            console.log(
                `\n${jogo.nome_time_casa} x ` +
                `${jogo.nome_time_fora} ` +
                `(${jogo.nome_competicao})`
            );

            console.log(
                `ORIGINAL | ` +
                `λ=${lambdaHomeOriginal.toFixed(2)} x ` +
                `${lambdaAwayOriginal.toFixed(2)} | ` +
                `1X2: ` +
                `C=${(probsOriginal.home * 100).toFixed(0)}% ` +
                `E=${(probsOriginal.draw * 100).toFixed(0)}% ` +
                `F=${(probsOriginal.away * 100).toFixed(0)}% | ` +
                `O2.5=${(probsOriginal.over25 * 100).toFixed(0)}% | ` +
                `BTTS=${(probsOriginal.btts_yes * 100).toFixed(0)}%`
            );

            if (probsSemXG) {

                const deltaHome =
                    lambdaHomeSemXG -
                    lambdaHomeOriginal;

                const deltaAway =
                    lambdaAwaySemXG -
                    lambdaAwayOriginal;

                const deltaTotal =
                    (
                        lambdaHomeSemXG +
                        lambdaAwaySemXG
                    ) -
                    (
                        lambdaHomeOriginal +
                        lambdaAwayOriginal
                    );

                console.log(
                    `SEM xG   | ` +
                    `λ=${lambdaHomeSemXG.toFixed(2)} x ` +
                    `${lambdaAwaySemXG.toFixed(2)} | ` +
                    `1X2: ` +
                    `C=${(probsSemXG.home * 100).toFixed(0)}% ` +
                    `E=${(probsSemXG.draw * 100).toFixed(0)}% ` +
                    `F=${(probsSemXG.away * 100).toFixed(0)}% | ` +
                    `O2.5=${(probsSemXG.over25 * 100).toFixed(0)}% | ` +
                    `BTTS=${(probsSemXG.btts_yes * 100).toFixed(0)}%`
                );

                console.log(
                    `Δλ       | ` +
                    `Casa=${deltaHome.toFixed(3)} | ` +
                    `Fora=${deltaAway.toFixed(3)} | ` +
                    `Total=${deltaTotal.toFixed(3)}`
                );

                console.log(
                    `Δ O2.5   | ` +
                    `${(
                        (probsSemXG.over25 -
                            probsOriginal.over25) *
                        100
                    ).toFixed(2)} pp`
                );

                console.log(
                    `Δ BTTS   | ` +
                    `${(
                        (probsSemXG.btts_yes -
                            probsOriginal.btts_yes) *
                        100
                    ).toFixed(2)} pp`
                );
            } else {

                console.log(
                    `SEM xG   | modelo não ajustado`
                );
            }

            // ========================================================
            // SALVA MODELO ORIGINAL
            // ========================================================

            await salvarPrevisao(
                {
                    flashscore_id_jogo:
                        jogo.flashscore_id,

                    data_jogo:
                        jogo.data_jogo,

                    hora_jogo:
                        jogo.hora_jogo,

                    id_time_casa:
                        jogo.id_time_casa,

                    id_time_fora:
                        jogo.id_time_fora,

                    id_competicao:
                        idComp,

                    nome_competicao:
                        jogo.nome_competicao,

                    nome_time_casa:
                        jogo.nome_time_casa,

                    nome_time_fora:
                        jogo.nome_time_fora

                },
                lambdaHomeOriginal,
                lambdaAwayOriginal,
                probsOriginal
            );

            // ========================================================
            // SALVA MODELO SEM xG
            // ========================================================

            if (probsSemXG) {

                await salvarPrevisaoSemXG(
                    {
                        flashscore_id_jogo:
                            jogo.flashscore_id,

                        data_jogo:
                            jogo.data_jogo,

                        hora_jogo:
                            jogo.hora_jogo,

                        id_time_casa:
                            jogo.id_time_casa,

                        id_time_fora:
                            jogo.id_time_fora,

                        id_competicao:
                            idComp,

                        nome_competicao:
                            jogo.nome_competicao,

                        nome_time_casa:
                            jogo.nome_time_casa,

                        nome_time_fora:
                            jogo.nome_time_fora

                    },
                    lambdaHomeSemXG,
                    lambdaAwaySemXG,
                    probsSemXG
                );
            }
        }
    }

    console.log(
        `\n🎉 ${dataAlvo} concluída.`
    );

    console.log(
        `Original → analises_jogo`
    );

    console.log(
        `Sem xG   → analises_jogos_mle_sem_xg\n`
    );
}

// ============================================================================
// PROCESSAR TODAS AS DATAS A PARTIR DA DATA ESCOLHIDA
// ============================================================================

async function processarDatasAPartirDe(
    dataInicial
) {
    try {

        const { rows } =
            await client.query(`
                SELECT
                    MAX(data_jogo::date) AS ultima_data
                FROM calendario
                WHERE data_jogo::date >= $1::date
            `, [dataInicial]);

        if (!rows[0].ultima_data) {

            console.log(
                `Nenhum jogo encontrado ` +
                `a partir de ${dataInicial}.`
            );

            return;
        }

        const ultimaData =
            rows[0].ultima_data
                .toISOString()
                .slice(0, 10);

        let dataAtual =
            new Date(
                `${dataInicial}T12:00:00`
            );

        const dataFinal =
            new Date(
                `${ultimaData}T12:00:00`
            );

        while (dataAtual <= dataFinal) {

            const dataAlvo =
                dataAtual
                    .toISOString()
                    .slice(0, 10);

            await processarDia(
                dataAlvo
            );

            dataAtual.setDate(
                dataAtual.getDate() + 1
            );
        }

    } catch (err) {

        console.error(
            '[ERRO FATAL]',
            err
        );
    }
}

// ============================================================================
// INÍCIO
// ============================================================================

async function iniciar() {

    try {

        await client.connect();

        const dataEscolhida =
            '2026-07-14';

        await processarDatasAPartirDe(
            dataEscolhida
        );

    } catch (err) {

        console.error(
            '[ERRO FATAL]',
            err
        );

    } finally {

        await client.end();
    }
}

iniciar();