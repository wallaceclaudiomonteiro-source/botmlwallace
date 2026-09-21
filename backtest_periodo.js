const { criarClient } = require('./db');

const {
    otimizarModeloConjunto,
    projetarExpectativaGols
} = require('./market_model');

/*
 * ================================================================
 * MERCADOS DE PERÍODO (1º TEMPO E 2º TEMPO)
 * ================================================================
 */

const MERCADOS = [
    { periodo: '1_tempo', sufixo: '1t' },
    { periodo: '2_tempo', sufixo: '2t' }
];

const client = criarClient('modelo');

const METRICAS_OBRIGATORIAS = [
    'xg',
    'xgot',
    'gols_marcados',
    'xg_contra',
    'xga',
    'gols_sofridos'
];

/*
 * ================================================================
 * REFERÊNCIA DE LIGA (GRID PRÉ-CALCULADO, POR PERÍODO)
 * ================================================================
 */

const ligasCache = new Map();

async function calcularReferenciaLiga(id_competicao, periodo) {
    const chaveCache = `${id_competicao}_${periodo}`;

    if (ligasCache.has(chaveCache)) {
        return ligasCache.get(chaveCache);
    }

    const { rows } = await client.query(`
        SELECT
            metrica,
            casa_mediana,
            fora_mediana
        FROM grid_metricas_competicoes_periodo
        WHERE id_competicao = $1
          AND periodo = $2
          AND metrica IN (
              'xg',
              'xgot',
              'gols_marcados',
              'xg_contra',
              'xga',
              'gols_sofridos'
          )
    `, [id_competicao, periodo]);

    const referenciaLiga = {};

    for (const row of rows) {
        referenciaLiga[row.metrica] = {
            casa: Number(row.casa_mediana),
            fora: Number(row.fora_mediana)
        };
    }

    ligasCache.set(chaveCache, referenciaLiga);
    return referenciaLiga;
}

/*
 * ================================================================
 * HISTÓRICO DE TREINO (ON-THE-FLY, POR PERÍODO)
 * ================================================================
 */

async function buscarHistorico(id_competicao, dataLimite, periodo) {
    const { rows: historicoBruto } = await client.query(`
        SELECT
            j.id,
            j.data_jogo,
            j.flashscore_id,
            j.flashscore_id_time_casa,
            j.flashscore_id_time_fora,

            ep.id_time,
            ep.eh_casa,
            ep.xg,
            ep.xgot,
            ep.xg_contra,
            ep.xga,
            ep.gols_marcados,
            ep.gols_sofridos,

            EXP(
                -0.005 *
                (
                    $2::date -
                    j.data_jogo::date
                )
            ) AS peso_tempo

        FROM jogos j
        INNER JOIN estatisticas_por_periodo ep
            ON ep.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND ep.periodo = $3
          AND j.data_jogo::date >= $2::date - INTERVAL '1 year'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY
            j.data_jogo::date ASC
    `, [id_competicao, dataLimite, periodo]);

    const mapaJogos = new Map();

    for (const linha of historicoBruto) {
        const chave = String(linha.flashscore_id);

        if (!mapaJogos.has(chave)) {
            mapaJogos.set(chave, {
                casa_id: String(linha.flashscore_id_time_casa),
                fora_id: String(linha.flashscore_id_time_fora),
                gols_casa: null,
                gols_fora: null,
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
                peso_tempo: Number(linha.peso_tempo) || 1
            });
        }

        const jogo = mapaJogos.get(chave);
        const xg = linha.xg !== null ? Number(linha.xg) : null;
        const xgot = linha.xgot !== null ? Number(linha.xgot) : null;
        const xgContra = linha.xg_contra !== null ? Number(linha.xg_contra) : null;
        const xga = linha.xga !== null ? Number(linha.xga) : null;
        const golsMarcados = linha.gols_marcados !== null ? Number(linha.gols_marcados) : null;
        const golsSofridos = linha.gols_sofridos !== null ? Number(linha.gols_sofridos) : null;

        if (Number(linha.eh_casa) === 1) {
            jogo.xg_casa = xg;
            jogo.xgot_casa = xgot;
            jogo.xg_contra_casa = xgContra;
            jogo.xga_casa = xga;
            jogo.gols_marcados_casa = golsMarcados;
            jogo.gols_sofridos_casa = golsSofridos;
            jogo.gols_casa = golsMarcados;
        }

        if (Number(linha.eh_casa) === 0) {
            jogo.xg_fora = xg;
            jogo.xgot_fora = xgot;
            jogo.xg_contra_fora = xgContra;
            jogo.xga_fora = xga;
            jogo.gols_marcados_fora = golsMarcados;
            jogo.gols_sofridos_fora = golsSofridos;
            jogo.gols_fora = golsMarcados;
        }
    }

    return Array.from(mapaJogos.values());
}

/*
 * ================================================================
 * PROCESSAR UM MERCADO (1T OU 2T) PARA UM JOGO-ALVO
 * ================================================================
 */

async function processarMercado(alvo, id_competicao, periodo, sufixo) {
    const referenciaLiga = await calcularReferenciaLiga(id_competicao, periodo);

    const faltantes = METRICAS_OBRIGATORIAS.filter(metrica =>
        !referenciaLiga[metrica] ||
        !Number.isFinite(referenciaLiga[metrica].casa) ||
        !Number.isFinite(referenciaLiga[metrica].fora)
    );

    if (faltantes.length > 0) {
        console.log(
            `[${alvo.data_jogo}] Pulando jogo ${alvo.id} - ` +
            `competição ${id_competicao} sem métricas completas [${periodo}]: ` +
            `${faltantes.join(', ')}`
        );
        return false;
    }

    console.log(`\nReferências da competição ${id_competicao} [${periodo}]:`);

    for (const metrica of METRICAS_OBRIGATORIAS) {
        console.log(
            `${metrica.padEnd(15)} CASA=${referenciaLiga[metrica].casa.toFixed(3)} ` +
            `FORA=${referenciaLiga[metrica].fora.toFixed(3)}`
        );
    }

    const jogosValidos = (await buscarHistorico(id_competicao, alvo.data_jogo, periodo))
        .filter(j =>
            j.casa_id &&
            j.fora_id &&
            Number.isFinite(j.gols_casa) &&
            Number.isFinite(j.gols_fora)
        );

    if (jogosValidos.length < 20) {
        console.log(
            `[${alvo.data_jogo}] Pulando jogo ${alvo.id} - ` +
            `competição ${id_competicao} - histórico insuficiente [${periodo}] ` +
            `(${jogosValidos.length} jogos).`
        );
        return false;
    }

    const comXG = jogosValidos.filter(j => j.xg_casa !== null && j.xg_fora !== null).length;
    const comXGOT = jogosValidos.filter(j => j.xgot_casa !== null && j.xgot_fora !== null).length;
    const comXGContra = jogosValidos.filter(j => j.xg_contra_casa !== null && j.xg_contra_fora !== null).length;
    const comXGA = jogosValidos.filter(j => j.xga_casa !== null && j.xga_fora !== null).length;
    const comGolsMarcados = jogosValidos.filter(j => j.gols_marcados_casa !== null && j.gols_marcados_fora !== null).length;
    const comGolsSofridos = jogosValidos.filter(j => j.gols_sofridos_casa !== null && j.gols_sofridos_fora !== null).length;

    console.log(
        `Histórico [${periodo}]: ${jogosValidos.length} jogos | ` +
        `xG: ${comXG} | xGOT: ${comXGOT} | xG contra: ${comXGContra} | ` +
        `xGA: ${comXGA} | Gols marcados: ${comGolsMarcados} | Gols sofridos: ${comGolsSofridos}`
    );

    /*
     * ============================================================
     * MLE CONJUNTO
     * ============================================================
     */

    const parametros = await otimizarModeloConjunto(
        jogosValidos,
        1500,
        0.003,
        {
            referenciaLiga,
            pesoXG: 0.30,
            pesoXGOT: 0.50,
            pesoGols: 0.20,
            pesoXGContra: 0.50,
            pesoXGA: 0.30,
            pesoGolsSofridos: 0.20,
            regularizacao: 0.015,
            gradienteMax: 5
        }
    );

    const casaId = String(alvo.flashscore_id_time_casa);
    const foraId = String(alvo.flashscore_id_time_fora);

    const casaAtq = parametros.ataque?.[casaId] ?? 0;
    const casaDef = parametros.defesa?.[casaId] ?? 0;
    const foraAtq = parametros.ataque?.[foraId] ?? 0;
    const foraDef = parametros.defesa?.[foraId] ?? 0;

    const mle_l_home = projetarExpectativaGols(parametros, casaId, foraId, true);
    const mle_l_away = projetarExpectativaGols(parametros, foraId, casaId, false);

    /*
     * ============================================================
     * SALVAR NO JOGO (COLUNAS COM SUFIXO DO PERÍODO)
     * ============================================================
     */

    await client.query(`
        UPDATE jogos
        SET
            mle_casa_ataque_${sufixo} = $1,
            mle_casa_defesa_${sufixo} = $2,
            mle_fora_ataque_${sufixo} = $3,
            mle_fora_defesa_${sufixo} = $4,
            mle_l_home_${sufixo} = $5,
            mle_l_away_${sufixo} = $6
        WHERE id = $7
    `, [
        casaAtq,
        casaDef,
        foraAtq,
        foraDef,
        mle_l_home,
        mle_l_away,
        alvo.id
    ]);

    console.log(
        `[${alvo.data_jogo}] Competição ${id_competicao} | ` +
        `Jogo ${alvo.id} processado [${periodo}]! MLE λ: ` +
        `${mle_l_home.toFixed(3)} x ${mle_l_away.toFixed(3)}`
    );

    console.log(`  Casa ${casaId}: ATQ=${casaAtq.toFixed(3)} DEF=${casaDef.toFixed(3)}`);
    console.log(`  Fora ${foraId}: ATQ=${foraAtq.toFixed(3)} DEF=${foraDef.toFixed(3)}`);

    return true;
}

/*
 * ================================================================
 * LOOP PRINCIPAL
 * ================================================================
 */

async function rodarBacktest(dataInicio, dataFim) {
    try {
        await client.connect();
        console.log(`Iniciando simulação [1T + 2T] de ${dataInicio} até ${dataFim}...`);

        // AQUI ESTÁ A ALTERAÇÃO: Adicionado o filtro para pegar apenas jogos onde mle_l_home_1t ou 2t sejam NULL
        const { rows: jogosAlvo } = await client.query(`
            SELECT
                id,
                data_jogo,
                id_competicao,
                flashscore_id,
                flashscore_id_time_casa,
                flashscore_id_time_fora,
                placar_casa,
                placar_fora
            FROM jogos
            WHERE data_jogo::date BETWEEN $1::date AND $2::date
              AND placar_casa IS NOT NULL
              AND placar_fora IS NOT NULL
              AND id_competicao IS NOT NULL
              AND (mle_l_home_1t IS NULL OR mle_l_home_2t IS NULL)
            ORDER BY
                data_jogo::date ASC,
                id ASC
        `, [dataInicio, dataFim]);

        console.log(`\nEncontrados ${jogosAlvo.length} jogos não calculados para processar.`);

        for (const alvo of jogosAlvo) {
            const id_competicao = Number(alvo.id_competicao);

            console.log(`\n============================================================`);
            console.log(`Processando jogo ${alvo.id} - ${alvo.data_jogo}`);
            console.log(`Competição: ${id_competicao}`);

            for (const { periodo, sufixo } of MERCADOS) {
                await processarMercado(alvo, id_competicao, periodo, sufixo);
            }
        }

        console.log('\nSimulação [1T + 2T] concluída com sucesso!');

    } catch (error) {
        console.error('Erro durante o backtest [1T + 2T]:', error);
    } finally {
        await client.end();
    }
}

rodarBacktest(
    '2025-01-01',
    '2026-09-20'
);