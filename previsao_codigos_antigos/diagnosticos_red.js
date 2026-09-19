const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: '100.114.225.110',
    database: 'stats_futebol',
    password: 'Wallace@22',
    port: 5432
});

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const CONFIG = {
    FAIXAS_PROBABILIDADE: [
        { min: 0, max: 59.9999, nome: 'ABAIXO_60' },
        { min: 60, max: 64.9999, nome: '60_64' },
        { min: 65, max: 69.9999, nome: '65_69' },
        { min: 70, max: 74.9999, nome: '70_74' },
        { min: 75, max: 79.9999, nome: '75_79' },
        { min: 80, max: 100, nome: '80_PLUS' }
    ]
};

// ============================================================
// MAPA DOS MERCADOS
// ============================================================

const MAPA_MERCADOS = {
    res_home: 'p_home',
    res_draw: 'p_draw',
    res_away: 'p_away',
    res_over15: 'p_over15',
    res_under15: 'p_under15',
    res_over25: 'p_over25',
    res_under25: 'p_under25',
    res_over35: 'p_over35',
    res_under35: 'p_under35',
    res_btts_yes: 'p_btts_yes',
    res_btts_no: 'p_btts_no',
    res_casa_over05: 'p_casa_over05',
    res_casa_over15: 'p_casa_over15',
    res_fora_over05: 'p_fora_over05',
    res_fora_over15: 'p_fora_over15',
    res_cantos_over75: 'p_cantos_over75',
    res_cantos_under75: 'p_cantos_under75',
    res_cantos_over85: 'p_cantos_over85',
    res_cantos_under85: 'p_cantos_under85',
    res_cantos_over95: 'p_cantos_over95',
    res_cantos_under95: 'p_cantos_under95',
    res_casa_cantos_over35: 'p_casa_cantos_over35',
    res_casa_cantos_over45: 'p_casa_cantos_over45',
    res_fora_cantos_over25: 'p_fora_cantos_over25',
    res_fora_cantos_over35: 'p_fora_cantos_over35',
    res_fora_cantos_over45: 'p_fora_cantos_over45',
    res_cartoes_over25: 'p_cartoes_over25',
    res_cartoes_under25: 'p_cartoes_under25',
    res_cartoes_over35: 'p_cartoes_over35',
    res_cartoes_under35: 'p_cartoes_under35',
    res_cartoes_over45: 'p_cartoes_over45',
    res_cartoes_under45: 'p_cartoes_under45',
    res_casa_cartoes_over05: 'p_casa_cartoes_over05',
    res_casa_cartoes_over15: 'p_casa_cartoes_over15',
    res_casa_cartoes_over25: 'p_casa_cartoes_over25',
    res_fora_cartoes_over05: 'p_fora_cartoes_over05',
    res_fora_cartoes_over15: 'p_fora_cartoes_over15',
    res_fora_cartoes_over25: 'p_fora_cartoes_over25'
};

// ============================================================
// NOMES DOS MERCADOS
// ============================================================

const NOMES_MERCADOS = {
    res_home: 'home',
    res_draw: 'draw',
    res_away: 'away',
    res_over15: 'over15',
    res_under15: 'under15',
    res_over25: 'over25',
    res_under25: 'under25',
    res_over35: 'over35',
    res_under35: 'under35',
    res_btts_yes: 'btts_yes',
    res_btts_no: 'btts_no',
    res_casa_over05: 'casa_over05',
    res_casa_over15: 'casa_over15',
    res_fora_over05: 'fora_over05',
    res_fora_over15: 'fora_over15',
    res_cantos_over75: 'cantos_over75',
    res_cantos_under75: 'cantos_under75',
    res_cantos_over85: 'cantos_over85',
    res_cantos_under85: 'cantos_under85',
    res_cantos_over95: 'cantos_over95',
    res_cantos_under95: 'cantos_under95',
    res_casa_cantos_over35: 'casa_cantos_over35',
    res_casa_cantos_over45: 'casa_cantos_over45',
    res_fora_cantos_over25: 'fora_cantos_over25',
    res_fora_cantos_over35: 'fora_cantos_over35',
    res_fora_cantos_over45: 'fora_cantos_over45',
    res_cartoes_over25: 'cartoes_over25',
    res_cartoes_under25: 'cartoes_under25',
    res_cartoes_over35: 'cartoes_over35',
    res_cartoes_under35: 'cartoes_under35',
    res_cartoes_over45: 'cartoes_over45',
    res_cartoes_under45: 'cartoes_under45',
    res_casa_cartoes_over05: 'casa_cartoes_over05',
    res_casa_cartoes_over15: 'casa_cartoes_over15',
    res_casa_cartoes_over25: 'casa_cartoes_over25',
    res_fora_cartoes_over05: 'fora_cartoes_over05',
    res_fora_cartoes_over15: 'fora_cartoes_over15',
    res_fora_cartoes_over25: 'fora_cartoes_over25'
};

// ============================================================
// TIPO DE MERCADO
// ============================================================

const TIPO_MERCADO = {
    res_home: 'CASA',
    res_draw: 'JOGO',
    res_away: 'FORA',
    res_over15: 'JOGO',
    res_under15: 'JOGO',
    res_over25: 'JOGO',
    res_under25: 'JOGO',
    res_over35: 'JOGO',
    res_under35: 'JOGO',
    res_btts_yes: 'JOGO',
    res_btts_no: 'JOGO',
    res_casa_over05: 'CASA',
    res_casa_over15: 'CASA',
    res_fora_over05: 'FORA',
    res_fora_over15: 'FORA',
    res_cantos_over75: 'JOGO',
    res_cantos_under75: 'JOGO',
    res_cantos_over85: 'JOGO',
    res_cantos_under85: 'JOGO',
    res_cantos_over95: 'JOGO',
    res_cantos_under95: 'JOGO',
    res_casa_cantos_over35: 'CASA',
    res_casa_cantos_over45: 'CASA',
    res_fora_cantos_over25: 'FORA',
    res_fora_cantos_over35: 'FORA',
    res_fora_cantos_over45: 'FORA',
    res_cartoes_over25: 'JOGO',
    res_cartoes_under25: 'JOGO',
    res_cartoes_over35: 'JOGO',
    res_cartoes_under35: 'JOGO',
    res_cartoes_over45: 'JOGO',
    res_cartoes_under45: 'JOGO',
    res_casa_cartoes_over05: 'CASA',
    res_casa_cartoes_over15: 'CASA',
    res_casa_cartoes_over25: 'CASA',
    res_fora_cartoes_over05: 'FORA',
    res_fora_cartoes_over15: 'FORA',
    res_fora_cartoes_over25: 'FORA'
};

const cacheComportamento = new Map();

// ============================================================
// CRIA TABELA
// ============================================================

async function criarTabelaDiagnosticoMercados() {
    console.log('Recriando tabela diagnostico_mercados...');

    await pool.query(`DROP TABLE IF EXISTS diagnostico_mercados;`);

    await pool.query(`
        CREATE TABLE diagnostico_mercados (
            id BIGSERIAL PRIMARY KEY,
            flashscore_id_jogo TEXT NOT NULL,
            data_jogo DATE NOT NULL,
            hora_jogo TIME,
            id_competicao TEXT,
            nome_competicao TEXT,
            pais_liga TEXT,
            rodada TEXT,
            id_time INTEGER NOT NULL,
            flashscore_id_time TEXT,
            nome_time TEXT NOT NULL,
            mando CHAR(1) NOT NULL,
            id_time_adversario INTEGER NOT NULL,
            flashscore_id_time_adversario TEXT,
            nome_time_adversario TEXT NOT NULL,
            mercado TEXT NOT NULL,
            coluna_resultado TEXT NOT NULL,
            probabilidade NUMERIC(10,4),
            faixa_probabilidade TEXT,
            resultado TEXT NOT NULL,
            total_gols_esperado NUMERIC(10,4),
            casa_gols_esperado NUMERIC(10,4),
            fora_gols_esperado NUMERIC(10,4),
            total_cantos_esperado NUMERIC(10,4),
            casa_cantos_esperado NUMERIC(10,4),
            fora_cantos_esperado NUMERIC(10,4),
            total_cartoes_esperado NUMERIC(10,4),
            casa_cartoes_esperado NUMERIC(10,4),
            fora_cartoes_esperado NUMERIC(10,4),
            forca_adv_ataque TEXT,
            forca_adv_defesa TEXT,
            periodo TEXT NOT NULL DEFAULT 'GE',
            criado_em TIMESTAMP DEFAULT NOW(),
            UNIQUE (flashscore_id_jogo, id_time, mercado)
        );
    `);

    await pool.query(`CREATE INDEX idx_diagnostico_mercados_time ON diagnostico_mercados (id_time);`);
    await pool.query(`CREATE INDEX idx_diagnostico_mercados_mercado ON diagnostico_mercados (mercado);`);
    await pool.query(`CREATE INDEX idx_diagnostico_mercados_resultado ON diagnostico_mercados (resultado);`);
    await pool.query(`CREATE INDEX idx_diagnostico_mercados_forcas ON diagnostico_mercados (forca_adv_ataque, forca_adv_defesa);`);
    await pool.query(`CREATE INDEX idx_diagnostico_mercados_probabilidade ON diagnostico_mercados (faixa_probabilidade);`);

    console.log('Tabela diagnostico_mercados criada com sucesso.');
}

// ============================================================
// FAIXA DE PROBABILIDADE
// ============================================================

function obterFaixaProbabilidade(probabilidade) {
    if (probabilidade === null || probabilidade === undefined || Number.isNaN(Number(probabilidade))) {
        return 'SEM_PROBABILIDADE';
    }

    const prob = Number(probabilidade);

    for (const faixa of CONFIG.FAIXAS_PROBABILIDADE) {
        if (prob >= faixa.min && prob <= faixa.max) {
            return faixa.nome;
        }
    }

    return 'SEM_FAIXA';
}

// ============================================================
// BUSCA COMPORTAMENTO
// ============================================================

async function buscarComportamentoTime(idTime, dataJogo, mando) {
    const chave = `${idTime}|${dataJogo}|${mando}`;

    if (cacheComportamento.has(chave)) {
        return cacheComportamento.get(chave);
    }

    const result = await pool.query(`
        SELECT id, id_time, flashscore_id_time, nome_time, casa_fora, tipo_analise, grid_forca_adv, periodo, data_jogo
        FROM analise_comportamento_times
        WHERE id_time = $1
          AND data_jogo = $2
          AND casa_fora = $3
          AND periodo = 'GE'
          AND tipo_analise IN ('ATAQUE_TIME', 'DEFESA_TIME')
        ORDER BY id;
    `, [idTime, dataJogo, mando]);

    const comportamento = {
        ataque: result.rows.find(row => row.tipo_analise === 'ATAQUE_TIME') || null,
        defesa: result.rows.find(row => row.tipo_analise === 'DEFESA_TIME') || null
    };

    cacheComportamento.set(chave, comportamento);

    return comportamento;
}

// ============================================================
// RESULTADOS DO JOGO
// ============================================================

function obterResultadosDoJogo(jogo) {
    const resultados = [];

    for (const [colunaResultado, colunaProbabilidade] of Object.entries(MAPA_MERCADOS)) {
        const resultado = jogo[colunaResultado];

        if (typeof resultado !== 'string') continue;

        const resultadoNormalizado = resultado.trim().toUpperCase();

        if (resultadoNormalizado !== 'GREEN' && resultadoNormalizado !== 'RED') continue;

        resultados.push({
            colunaResultado,
            mercado: NOMES_MERCADOS[colunaResultado] || colunaResultado.replace(/^res_/, ''),
            tipo: TIPO_MERCADO[colunaResultado] || 'JOGO',
            probabilidade: jogo[colunaProbabilidade] ?? null,
            resultado: resultadoNormalizado
        });
    }

    return resultados;
}

// ============================================================
// INSERE DIAGNÓSTICO
// ============================================================

async function inserirDiagnostico({ jogo, time, adversario, mando, comportamento, resultadoMercado }) {
    if (!comportamento.ataque && !comportamento.defesa) return false;

    const forcaAdvAtaque = comportamento.ataque?.grid_forca_adv || null;
    const forcaAdvDefesa = comportamento.defesa?.grid_forca_adv || null;

    const flashscoreIdTime =
        comportamento.ataque?.flashscore_id_time ||
        comportamento.defesa?.flashscore_id_time ||
        time.flashscore_id_time ||
        null;

    const faixaProbabilidade = obterFaixaProbabilidade(resultadoMercado.probabilidade);

    await pool.query(`
        INSERT INTO diagnostico_mercados (
            flashscore_id_jogo, data_jogo, hora_jogo, id_competicao, nome_competicao, pais_liga, rodada,
            id_time, flashscore_id_time, nome_time, mando,
            id_time_adversario, flashscore_id_time_adversario, nome_time_adversario,
            mercado, coluna_resultado, probabilidade, faixa_probabilidade, resultado,
            total_gols_esperado, casa_gols_esperado, fora_gols_esperado,
            total_cantos_esperado, casa_cantos_esperado, fora_cantos_esperado,
            total_cartoes_esperado, casa_cartoes_esperado, fora_cartoes_esperado,
            forca_adv_ataque, forca_adv_defesa, periodo
        )
        VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
            $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,'GE'
        )
        ON CONFLICT (flashscore_id_jogo, id_time, mercado)
        DO UPDATE SET
            data_jogo = EXCLUDED.data_jogo,
            hora_jogo = EXCLUDED.hora_jogo,
            id_competicao = EXCLUDED.id_competicao,
            nome_competicao = EXCLUDED.nome_competicao,
            pais_liga = EXCLUDED.pais_liga,
            rodada = EXCLUDED.rodada,
            flashscore_id_time = EXCLUDED.flashscore_id_time,
            nome_time = EXCLUDED.nome_time,
            mando = EXCLUDED.mando,
            id_time_adversario = EXCLUDED.id_time_adversario,
            flashscore_id_time_adversario = EXCLUDED.flashscore_id_time_adversario,
            nome_time_adversario = EXCLUDED.nome_time_adversario,
            coluna_resultado = EXCLUDED.coluna_resultado,
            probabilidade = EXCLUDED.probabilidade,
            faixa_probabilidade = EXCLUDED.faixa_probabilidade,
            resultado = EXCLUDED.resultado,
            total_gols_esperado = EXCLUDED.total_gols_esperado,
            casa_gols_esperado = EXCLUDED.casa_gols_esperado,
            fora_gols_esperado = EXCLUDED.fora_gols_esperado,
            total_cantos_esperado = EXCLUDED.total_cantos_esperado,
            casa_cantos_esperado = EXCLUDED.casa_cantos_esperado,
            fora_cantos_esperado = EXCLUDED.fora_cantos_esperado,
            total_cartoes_esperado = EXCLUDED.total_cartoes_esperado,
            casa_cartoes_esperado = EXCLUDED.casa_cartoes_esperado,
            fora_cartoes_esperado = EXCLUDED.fora_cartoes_esperado,
            forca_adv_ataque = EXCLUDED.forca_adv_ataque,
            forca_adv_defesa = EXCLUDED.forca_adv_defesa,
            periodo = EXCLUDED.periodo;
    `, [
        jogo.flashscore_id_jogo, jogo.data_jogo, jogo.hora_jogo || null,
        jogo.id_competicao || null, jogo.nome_competicao || null, jogo.pais_liga || null, jogo.rodada || null,
        time.id_time, flashscoreIdTime, time.nome_time, mando,
        adversario.id_time, adversario.flashscore_id_time || null, adversario.nome_time,
        resultadoMercado.mercado, resultadoMercado.colunaResultado,
        resultadoMercado.probabilidade, faixaProbabilidade, resultadoMercado.resultado,
        jogo.total_gols_esperado ?? null, jogo.casa_gols_esperado ?? null, jogo.fora_gols_esperado ?? null,
        jogo.total_cantos_esperado ?? null, jogo.casa_cantos_esperado ?? null, jogo.fora_cantos_esperado ?? null,
        jogo.total_cartoes_esperado ?? null, jogo.casa_cartoes_esperado ?? null, jogo.fora_cartoes_esperado ?? null,
        forcaAdvAtaque, forcaAdvDefesa
    ]);

    return true;
}

// ============================================================
// PROCESSA UM JOGO
// ============================================================

async function processarJogoDiagnostico(jogo) {
    const resultados = obterResultadosDoJogo(jogo);

    if (resultados.length === 0) {
        return {
            jogo: jogo.flashscore_id_jogo,
            resultados: 0,
            greens: 0,
            reds: 0,
            registros: 0,
            semComportamento: 0
        };
    }

    const comportamentoCasa = await buscarComportamentoTime(jogo.id_time_casa, jogo.data_jogo, 'C');
    const comportamentoFora = await buscarComportamentoTime(jogo.id_time_fora, jogo.data_jogo, 'F');

    const flashscoreCasa =
        comportamentoCasa.ataque?.flashscore_id_time ||
        comportamentoCasa.defesa?.flashscore_id_time ||
        null;

    const flashscoreFora =
        comportamentoFora.ataque?.flashscore_id_time ||
        comportamentoFora.defesa?.flashscore_id_time ||
        null;

    const timeCasa = {
        id_time: jogo.id_time_casa,
        flashscore_id_time: flashscoreCasa,
        nome_time: jogo.nome_time_casa
    };

    const timeFora = {
        id_time: jogo.id_time_fora,
        flashscore_id_time: flashscoreFora,
        nome_time: jogo.nome_time_fora
    };

    const adversarioCasa = {
        id_time: jogo.id_time_fora,
        flashscore_id_time: flashscoreFora,
        nome_time: jogo.nome_time_fora
    };

    const adversarioFora = {
        id_time: jogo.id_time_casa,
        flashscore_id_time: flashscoreCasa,
        nome_time: jogo.nome_time_casa
    };

    let registros = 0;
    let semComportamento = 0;
    let greens = 0;
    let reds = 0;

    for (const resultadoMercado of resultados) {
        if (resultadoMercado.resultado === 'GREEN') greens++;
        if (resultadoMercado.resultado === 'RED') reds++;

        if (resultadoMercado.tipo === 'CASA') {
            const inseriu = await inserirDiagnostico({
                jogo,
                time: timeCasa,
                adversario: adversarioCasa,
                mando: 'C',
                comportamento: comportamentoCasa,
                resultadoMercado
            });

            if (inseriu) registros++;
            else semComportamento++;

            continue;
        }

        if (resultadoMercado.tipo === 'FORA') {
            const inseriu = await inserirDiagnostico({
                jogo,
                time: timeFora,
                adversario: adversarioFora,
                mando: 'F',
                comportamento: comportamentoFora,
                resultadoMercado
            });

            if (inseriu) registros++;
            else semComportamento++;

            continue;
        }

        const inseriuCasa = await inserirDiagnostico({
            jogo,
            time: timeCasa,
            adversario: adversarioCasa,
            mando: 'C',
            comportamento: comportamentoCasa,
            resultadoMercado
        });

        if (inseriuCasa) registros++;
        else semComportamento++;

        const inseriuFora = await inserirDiagnostico({
            jogo,
            time: timeFora,
            adversario: adversarioFora,
            mando: 'F',
            comportamento: comportamentoFora,
            resultadoMercado
        });

        if (inseriuFora) registros++;
        else semComportamento++;
    }

    return {
        jogo: jogo.flashscore_id_jogo,
        resultados: resultados.length,
        greens,
        reds,
        registros,
        semComportamento
    };
}

// ============================================================
// POPULA TABELA
// ============================================================

async function popularDiagnosticoMercados() {
    console.log('======================================================');
    console.log('INICIANDO DIAGNÓSTICO COMPLETO DOS MERCADOS');
    console.log('======================================================');

    cacheComportamento.clear();

    await criarTabelaDiagnosticoMercados();

    const result = await pool.query(`
        SELECT *
        FROM analises_jogo
        WHERE data_jogo IS NOT NULL
        ORDER BY data_jogo, flashscore_id_jogo;
    `);

    console.log(`Jogos encontrados: ${result.rows.length}`);

    let jogosProcessados = 0;
    let totalGreens = 0;
    let totalReds = 0;
    let totalResultados = 0;
    let totalRegistros = 0;
    let totalSemComportamento = 0;

    for (let i = 0; i < result.rows.length; i++) {
        const jogo = result.rows[i];

        try {
            const diagnostico = await processarJogoDiagnostico(jogo);

            jogosProcessados++;
            totalGreens += diagnostico.greens;
            totalReds += diagnostico.reds;
            totalResultados += diagnostico.resultados;
            totalRegistros += diagnostico.registros;
            totalSemComportamento += diagnostico.semComportamento;

            if (diagnostico.resultados > 0) {
                console.log(
                    `[${i + 1}/${result.rows.length}] ${jogo.data_jogo} | ` +
                    `${jogo.nome_time_casa} x ${jogo.nome_time_fora} | ` +
                    `Resultados: ${diagnostico.resultados} | ` +
                    `GREEN: ${diagnostico.greens} | ` +
                    `RED: ${diagnostico.reds} | ` +
                    `Registros: ${diagnostico.registros}`
                );
            }
        } catch (erro) {
            console.error(`Erro no jogo ${jogo.flashscore_id_jogo}:`, erro.message);
        }
    }

    console.log('======================================================');
    console.log('DIAGNÓSTICO FINALIZADO');
    console.log(`Jogos processados: ${jogosProcessados}`);
    console.log(`Resultados analisados: ${totalResultados}`);
    console.log(`GREENS encontrados: ${totalGreens}`);
    console.log(`REDS encontrados: ${totalReds}`);
    console.log(`Registros gerados: ${totalRegistros}`);
    console.log(`Sem comportamento: ${totalSemComportamento}`);
    console.log('======================================================');
}

// ============================================================
// DESEMPENHO GERAL POR MERCADO
// ============================================================

async function relatorioGeralPorMercado() {
    console.log('\n======================================================');
    console.log('DESEMPENHO GERAL POR MERCADO');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto
        FROM diagnostico_mercados
        GROUP BY mercado
        ORDER BY taxa_acerto ASC, total DESC;
    `);

    for (const row of result.rows) {
        console.log(
            `MERCADO: ${row.mercado} | TOTAL: ${row.total} | ` +
            `GREEN: ${row.greens} | RED: ${row.reds} | ` +
            `ACERTO: ${row.taxa_acerto}%`
        );
    }
}

// ============================================================
// DESEMPENHO POR CRUZAMENTO DE FORÇAS
// ============================================================

async function relatorioPorCruzamentoForcas() {
    console.log('\n======================================================');
    console.log('DESEMPENHO POR CRUZAMENTO DE FORÇAS');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            forca_adv_ataque,
            forca_adv_defesa,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto
        FROM diagnostico_mercados
        GROUP BY mercado, forca_adv_ataque, forca_adv_defesa
        ORDER BY taxa_acerto ASC, total DESC;
    `);

    let ultimoMercado = null;

    for (const row of result.rows) {
        if (row.mercado !== ultimoMercado) {
            console.log(`\nMERCADO: ${row.mercado}`);
            ultimoMercado = row.mercado;
        }

        console.log(
            `ATAQUE ADV: ${row.forca_adv_ataque || 'SEM_FORCA'} | ` +
            `DEFESA ADV: ${row.forca_adv_defesa || 'SEM_FORCA'} | ` +
            `TOTAL: ${row.total} | GREEN: ${row.greens} | ` +
            `RED: ${row.reds} | ACERTO: ${row.taxa_acerto}%`
        );
    }
}

// ============================================================
// DESEMPENHO POR PROBABILIDADE
// ============================================================

async function relatorioPorProbabilidade() {
    console.log('\n======================================================');
    console.log('DESEMPENHO POR FAIXA DE PROBABILIDADE');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            faixa_probabilidade,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto
        FROM diagnostico_mercados
        GROUP BY mercado, faixa_probabilidade
        ORDER BY
            mercado,
            CASE faixa_probabilidade
                WHEN 'ABAIXO_60' THEN 1
                WHEN '60_64' THEN 2
                WHEN '65_69' THEN 3
                WHEN '70_74' THEN 4
                WHEN '75_79' THEN 5
                WHEN '80_PLUS' THEN 6
                ELSE 7
            END;
    `);

    let ultimoMercado = null;

    for (const row of result.rows) {
        if (row.mercado !== ultimoMercado) {
            console.log(`\nMERCADO: ${row.mercado}`);
            ultimoMercado = row.mercado;
        }

        console.log(
            `FAIXA: ${row.faixa_probabilidade} | TOTAL: ${row.total} | ` +
            `GREEN: ${row.greens} | RED: ${row.reds} | ` +
            `ACERTO: ${row.taxa_acerto}%`
        );
    }
}

// ============================================================
// DESEMPENHO POR EXPECTATIVA DE GOLS
// ============================================================

async function relatorioPorGolsEsperados() {
    console.log('\n======================================================');
    console.log('DESEMPENHO POR GOLS ESPERADOS');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            CASE
                WHEN total_gols_esperado < 1.50 THEN 'ABAIXO_1.50'
                WHEN total_gols_esperado < 2.00 THEN '1.50_1.99'
                WHEN total_gols_esperado < 2.50 THEN '2.00_2.49'
                WHEN total_gols_esperado < 3.00 THEN '2.50_2.99'
                WHEN total_gols_esperado < 3.50 THEN '3.00_3.49'
                ELSE '3.50_PLUS'
            END AS faixa_gols_esperados,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto,
            ROUND(AVG(total_gols_esperado), 3) AS media_gols_esperado
        FROM diagnostico_mercados
        WHERE total_gols_esperado IS NOT NULL
        GROUP BY mercado, faixa_gols_esperados
        ORDER BY mercado, MIN(total_gols_esperado);
    `);

    let ultimoMercado = null;

    for (const row of result.rows) {
        if (row.mercado !== ultimoMercado) {
            console.log(`\nMERCADO: ${row.mercado}`);
            ultimoMercado = row.mercado;
        }

        console.log(
            `GOLS ESPERADOS: ${row.faixa_gols_esperados} | ` +
            `MÉDIA: ${row.media_gols_esperado} | TOTAL: ${row.total} | ` +
            `GREEN: ${row.greens} | RED: ${row.reds} | ` +
            `ACERTO: ${row.taxa_acerto}%`
        );
    }
}

// ============================================================
// DESEMPENHO POR EXPECTATIVA DE ESCANTEIOS
// ============================================================

async function relatorioPorCantosEsperados() {
    console.log('\n======================================================');
    console.log('DESEMPENHO POR ESCANTEIOS ESPERADOS');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            CASE
                WHEN total_cantos_esperado < 7.00 THEN 'ABAIXO_7'
                WHEN total_cantos_esperado < 8.00 THEN '7.00_7.99'
                WHEN total_cantos_esperado < 9.00 THEN '8.00_8.99'
                WHEN total_cantos_esperado < 10.00 THEN '9.00_9.99'
                WHEN total_cantos_esperado < 11.00 THEN '10.00_10.99'
                ELSE '11_PLUS'
            END AS faixa_cantos_esperados,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto,
            ROUND(AVG(total_cantos_esperado), 3) AS media_cantos_esperado
        FROM diagnostico_mercados
        WHERE total_cantos_esperado IS NOT NULL
        GROUP BY mercado, faixa_cantos_esperados
        ORDER BY mercado, MIN(total_cantos_esperado);
    `);

    let ultimoMercado = null;

    for (const row of result.rows) {
        if (row.mercado !== ultimoMercado) {
            console.log(`\nMERCADO: ${row.mercado}`);
            ultimoMercado = row.mercado;
        }

        console.log(
            `CANTOS ESPERADOS: ${row.faixa_cantos_esperados} | ` +
            `MÉDIA: ${row.media_cantos_esperado} | TOTAL: ${row.total} | ` +
            `GREEN: ${row.greens} | RED: ${row.reds} | ` +
            `ACERTO: ${row.taxa_acerto}%`
        );
    }
}

// ============================================================
// DESEMPENHO POR EXPECTATIVA DE CARTÕES
// ============================================================

async function relatorioPorCartoesEsperados() {
    console.log('\n======================================================');
    console.log('DESEMPENHO POR CARTÕES ESPERADOS');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            CASE
                WHEN total_cartoes_esperado < 3.00 THEN 'ABAIXO_3'
                WHEN total_cartoes_esperado < 4.00 THEN '3.00_3.99'
                WHEN total_cartoes_esperado < 5.00 THEN '4.00_4.99'
                WHEN total_cartoes_esperado < 6.00 THEN '5.00_5.99'
                WHEN total_cartoes_esperado < 7.00 THEN '6.00_6.99'
                ELSE '7_PLUS'
            END AS faixa_cartoes_esperados,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto,
            ROUND(AVG(total_cartoes_esperado), 3) AS media_cartoes_esperado
        FROM diagnostico_mercados
        WHERE total_cartoes_esperado IS NOT NULL
        GROUP BY mercado, faixa_cartoes_esperados
        ORDER BY mercado, MIN(total_cartoes_esperado);
    `);

    let ultimoMercado = null;

    for (const row of result.rows) {
        if (row.mercado !== ultimoMercado) {
            console.log(`\nMERCADO: ${row.mercado}`);
            ultimoMercado = row.mercado;
        }

        console.log(
            `CARTÕES ESPERADOS: ${row.faixa_cartoes_esperados} | ` +
            `MÉDIA: ${row.media_cartoes_esperado} | TOTAL: ${row.total} | ` +
            `GREEN: ${row.greens} | RED: ${row.reds} | ` +
            `ACERTO: ${row.taxa_acerto}%`
        );
    }
}

// ============================================================
// RELATÓRIO COMPLETO
// ============================================================

async function relatorioCompleto() {
    console.log('\n======================================================');
    console.log('RELATÓRIO COMPLETO');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            mando,
            faixa_probabilidade,
            forca_adv_ataque,
            forca_adv_defesa,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto,
            ROUND(AVG(total_gols_esperado), 3) AS media_gols_esperado,
            ROUND(AVG(total_cantos_esperado), 3) AS media_cantos_esperado,
            ROUND(AVG(total_cartoes_esperado), 3) AS media_cartoes_esperado
        FROM diagnostico_mercados
        GROUP BY mercado, mando, faixa_probabilidade, forca_adv_ataque, forca_adv_defesa
        ORDER BY taxa_acerto ASC, total DESC;
    `);

    for (const row of result.rows) {
        console.log(
            `MERCADO: ${row.mercado} | MANDO: ${row.mando} | ` +
            `PROB: ${row.faixa_probabilidade} | ` +
            `ATAQUE ADV: ${row.forca_adv_ataque || 'SEM_FORCA'} | ` +
            `DEFESA ADV: ${row.forca_adv_defesa || 'SEM_FORCA'}`
        );

        console.log(
            `TOTAL: ${row.total} | GREEN: ${row.greens} | ` +
            `RED: ${row.reds} | ACERTO: ${row.taxa_acerto}% | ` +
            `GOLS ESP: ${row.media_gols_esperado ?? '-'} | ` +
            `CANTOS ESP: ${row.media_cantos_esperado ?? '-'} | ` +
            `CARTÕES ESP: ${row.media_cartoes_esperado ?? '-'}`
        );

        console.log('------------------------------------------------------');
    }
}

// ============================================================
// PIORES CENÁRIOS
// ============================================================

async function relatorioPioresCenarios() {
    console.log('\n======================================================');
    console.log('PIORES CENÁRIOS DO MODELO');
    console.log('======================================================');

    const result = await pool.query(`
        SELECT
            mercado,
            mando,
            faixa_probabilidade,
            forca_adv_ataque,
            forca_adv_defesa,
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds,
            ROUND(
                100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
                / NULLIF(COUNT(*), 0),
                2
            ) AS taxa_acerto,
            ROUND(AVG(total_gols_esperado), 3) AS media_gols_esperado,
            ROUND(AVG(total_cantos_esperado), 3) AS media_cantos_esperado,
            ROUND(AVG(total_cartoes_esperado), 3) AS media_cartoes_esperado
        FROM diagnostico_mercados
        GROUP BY mercado, mando, faixa_probabilidade, forca_adv_ataque, forca_adv_defesa
        HAVING (
            100.0 * COUNT(*) FILTER (WHERE resultado = 'GREEN')
            / NULLIF(COUNT(*), 0)
        ) < 60
        ORDER BY taxa_acerto ASC, total DESC;
    `);

    if (result.rows.length === 0) {
        console.log('Nenhum cenário abaixo de 60% encontrado.');
        return;
    }

    for (const row of result.rows) {
        console.log(
            `\nMERCADO: ${row.mercado} | MANDO: ${row.mando} | ` +
            `PROB: ${row.faixa_probabilidade}`
        );

        console.log(
            `ATAQUE ADV: ${row.forca_adv_ataque || 'SEM_FORCA'} | ` +
            `DEFESA ADV: ${row.forca_adv_defesa || 'SEM_FORCA'}`
        );

        console.log(
            `TOTAL: ${row.total} | GREEN: ${row.greens} | ` +
            `RED: ${row.reds} | ACERTO: ${row.taxa_acerto}%`
        );

        console.log(
            `GOLS ESP: ${row.media_gols_esperado ?? '-'} | ` +
            `CANTOS ESP: ${row.media_cantos_esperado ?? '-'} | ` +
            `CARTÕES ESP: ${row.media_cartoes_esperado ?? '-'}`
        );

        console.log('------------------------------------------------------');
    }
}

// ============================================================
// CONFERÊNCIA DOS TOTAIS
// ============================================================

async function conferirTotaisDiagnostico() {
    console.log('\n======================================================');
    console.log('CONFERÊNCIA DOS TOTAIS');
    console.log('======================================================');

    const jogosResult = await pool.query(`
        SELECT *
        FROM analises_jogo
        WHERE data_jogo IS NOT NULL;
    `);

    let resultadosOriginais = 0;
    let registrosEsperados = 0;

    for (const jogo of jogosResult.rows) {
        const resultados = obterResultadosDoJogo(jogo);

        for (const resultado of resultados) {
            resultadosOriginais++;

            if (resultado.tipo === 'JOGO') {
                registrosEsperados += 2;
            } else {
                registrosEsperados += 1;
            }
        }
    }

    const resultadoDiagnostico = await pool.query(`
        SELECT
            COUNT(*) AS total_registros,
            COUNT(*) FILTER (WHERE resultado = 'GREEN') AS greens,
            COUNT(*) FILTER (WHERE resultado = 'RED') AS reds
        FROM diagnostico_mercados;
    `);

    const totalRegistros = Number(resultadoDiagnostico.rows[0].total_registros || 0);
    const greens = Number(resultadoDiagnostico.rows[0].greens || 0);
    const reds = Number(resultadoDiagnostico.rows[0].reds || 0);

    console.log(`Resultados em analises_jogo: ${resultadosOriginais}`);
    console.log(`Registros teoricamente esperados: ${registrosEsperados}`);
    console.log(`Registros encontrados: ${totalRegistros}`);
    console.log(`GREEN armazenados: ${greens}`);
    console.log(`RED armazenados: ${reds}`);

    const diferenca = registrosEsperados - totalRegistros;

    if (diferenca === 0) {
        console.log('RESULTADO: OK - TODOS OS REGISTROS FORAM GERADOS');
    } else {
        console.log(`RESULTADO: DIFERENÇA DE ${diferenca} REGISTROS`);
        console.log('A diferença pode representar times sem comportamento disponível.');
    }
}

// ============================================================
// EXECUÇÃO
// ============================================================

async function executarDiagnosticoMercados() {
    try {
        await popularDiagnosticoMercados();
        await conferirTotaisDiagnostico();
        await relatorioGeralPorMercado();
        await relatorioPorCruzamentoForcas();
        await relatorioPorProbabilidade();
        await relatorioPorGolsEsperados();
        await relatorioPorCantosEsperados();
        await relatorioPorCartoesEsperados();
        await relatorioCompleto();
        await relatorioPioresCenarios();
    } catch (erro) {
        console.error('Erro geral:', erro);
    } finally {
        await pool.end();
    }
}

executarDiagnosticoMercados();