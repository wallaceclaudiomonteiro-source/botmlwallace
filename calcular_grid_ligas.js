const { Client } = require('pg');

const READY_FOR_GRID = 1;
const GRID_PROCESSED = 10;
const MAX_EXCECOES_PERMITIDAS = 3;

async function registrarErroPipeline(client, payload) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS grid_pipeline_erros (
            id SERIAL PRIMARY KEY,
            id_competicao INTEGER,
            nome_liga TEXT,
            pais_liga TEXT,
            flashscore_slug_liga TEXT,
            flashscore_slug_pais TEXT,
            tipo TEXT NOT NULL,
            motivo TEXT NOT NULL,
            detalhes JSONB,
            times_faltantes JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
    `);

    await client.query(`
        ALTER TABLE grid_pipeline_erros
        ADD COLUMN IF NOT EXISTS pais_liga TEXT,
        ADD COLUMN IF NOT EXISTS times_faltantes JSONB DEFAULT '[]'::jsonb;
    `);

    await client.query(`
        INSERT INTO grid_pipeline_erros (
            id_competicao,
            nome_liga,
            pais_liga,
            flashscore_slug_liga,
            flashscore_slug_pais,
            tipo,
            motivo,
            detalhes,
            times_faltantes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
        payload.id_competicao ?? null,
        payload.nome_liga ?? null,
        payload.pais_liga ?? null,
        payload.flashscore_slug_liga ?? null,
        payload.flashscore_slug_pais ?? null,
        payload.tipo ?? 'desconhecido',
        payload.motivo ?? 'sem motivo informado',
        payload.detalhes ? JSON.stringify(payload.detalhes) : JSON.stringify({}),
        payload.times_faltantes ? JSON.stringify(payload.times_faltantes) : JSON.stringify([])
    ]);
}

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

// ======================================================
// 1. Função para calcular os tercis (33% e 66%)
// ======================================================
function calcularLimitesDaLiga(ratings) {
    const numeros = ratings
        .filter(r => r !== null && r !== undefined && !isNaN(r))
        .map(r => parseFloat(r));

    // Funciona perfeitamente com números negativos (ex: -1.5 < +0.5)
    numeros.sort((a, b) => a - b);

    const total = numeros.length;
    if (total === 0) return { limite_33: null, limite_66: null };

    const index33 = Math.floor(total * 0.33);
    const index66 = Math.floor(total * 0.66);

    return {
        limite_33: numeros[index33],
        limite_66: numeros[index66]
    };
}
// ======================================================
// 1. Função Auxiliar: Expectativa Pitagórica (Expoente 1.7)
// ======================================================
function calcularForcaPitagorica(ataque, defesa) {
    if (ataque === null || ataque === undefined || defesa === null || defesa === undefined) return 0;
    
    const atkExp = Math.pow(Math.max(0, ataque), 1.7);
    const defExp = Math.pow(Math.max(0, defesa), 1.7);
    const denominador = atkExp + defExp;
    
    return denominador === 0 ? 0 : atkExp / denominador;
}

// ======================================================
// 2. FUNÇÃO: CLASSIFICAR OS TIMES NA TABELA JOGOS
// ======================================================
async function atualizarClassesNaTabelaJogos(client, idCompeticao, slugLiga, limitesGrid) {
    console.log(`Aplicando Grid de Força Pitagórica (1.7) nos jogos da competição: ${slugLiga} (ID: ${idCompeticao})...`);

    const sql = `
        UPDATE jogos
        SET 
            casa_classe_forca = CASE 
                WHEN (POWER(GREATEST(0, casa_rating_ataque), 1.7) / NULLIF(POWER(GREATEST(0, casa_rating_ataque), 1.7) + POWER(GREATEST(0, casa_rating_defesa), 1.7), 0)) <= $1 THEN 'FRACO'
                WHEN (POWER(GREATEST(0, casa_rating_ataque), 1.7) / NULLIF(POWER(GREATEST(0, casa_rating_ataque), 1.7) + POWER(GREATEST(0, casa_rating_defesa), 1.7), 0)) <= $2 THEN 'MEDIO'
                ELSE 'FORTE'
            END,
            
            fora_classe_forca = CASE 
                WHEN (POWER(GREATEST(0, fora_rating_ataque), 1.7) / NULLIF(POWER(GREATEST(0, fora_rating_ataque), 1.7) + POWER(GREATEST(0, fora_rating_defesa), 1.7), 0)) <= $3 THEN 'FRACO'
                WHEN (POWER(GREATEST(0, fora_rating_ataque), 1.7) / NULLIF(POWER(GREATEST(0, fora_rating_ataque), 1.7) + POWER(GREATEST(0, fora_rating_defesa), 1.7), 0)) <= $4 THEN 'MEDIO'
                ELSE 'FORTE'
            END
            
        WHERE (id_competicao = $5 OR flashscore_slug_liga = $6)
          AND casa_rating_ataque IS NOT NULL
          AND casa_rating_defesa IS NOT NULL
          AND fora_rating_ataque IS NOT NULL
          AND fora_rating_defesa IS NOT NULL;
    `;

    const values = [
        limitesGrid.limite_33_casa_forca, limitesGrid.limite_66_casa_forca, // $1, $2
        limitesGrid.limite_33_fora_forca, limitesGrid.limite_66_fora_forca, // $3, $4
        idCompeticao,                                                     // $5
        slugLiga                                                          // $6
    ];

    try {
        await client.query(sql, values);
        console.log(`✅ [SUCESSO] Jogos da competição ${slugLiga} classificados com Força Pitagórica!`);
    } catch (err) {
        console.error(`❌ Erro ao classificar jogos da competição ${slugLiga}:`, err.message);
        throw err;
    }
}

// ======================================================
// 3. Função Universal para Processar Ligas e Copas (Atualizada)
// ======================================================
async function gerarGridDaLiga(client, liga) {
    try {
        let listaIdsTimes = [];
        let isCopa = false;

        const queryTimesLiga = `
            SELECT DISTINCT flashscore_id_time
            FROM classificacao_geral_2026
            WHERE flashscore_slug_liga = $1 
              AND flashscore_slug_pais = $2
              AND classificacao_tipo = 'GERAL'
        `;
        const { rows: timesClassificacao } = await client.query(queryTimesLiga, [liga.flashscore_slug, liga.flashscore_slug_pais]);

        if (timesClassificacao.length > 0) {
            console.log(`[LIGA DETECTADA] Usando tabela de classificação para: ${liga.nome}`);
            listaIdsTimes = timesClassificacao.map(t => t.flashscore_id_time);
        } else {
            isCopa = true;
            console.log(`🏆 [COPA/INT. DETECTADA] Buscando times participantes de ${liga.nome}...`);
            const queryTimesCopa = `
                SELECT DISTINCT time_id
                FROM (
                    SELECT flashscore_id_time_casa AS time_id FROM jogos WHERE id_competicao = $1 AND flashscore_id_time_casa IS NOT NULL
                    UNION
                    SELECT flashscore_id_time_fora AS time_id FROM jogos WHERE id_competicao = $1 AND flashscore_id_time_fora IS NOT NULL
                ) sub
            `;
            const { rows: timesCopa } = await client.query(queryTimesCopa, [liga.id]);
            listaIdsTimes = timesCopa.map(t => t.time_id);
        }

        if (listaIdsTimes.length === 0) {
            console.log(`[AVISO] Nenhum time encontrado para a competição: ${liga.nome}`);
            await registrarErroPipeline(client, {
                id_competicao: liga.id,
                nome_liga: liga.nome,
                pais_liga: liga.pais_liga || liga.flashscore_slug_pais || null,
                flashscore_slug_liga: liga.flashscore_slug,
                flashscore_slug_pais: liga.flashscore_slug_pais,
                tipo: 'competicao_sem_times',
                motivo: 'Nenhum time encontrado na classificação nem na tabela de jogos.',
                detalhes: { fonte: isCopa ? 'copa' : 'classificacao', total_times: 0 }
            });
            return;
        }

        const arraysRatings = {
            casa_forca: [],
            fora_forca: []
        };

        const MIN_JOGOS_EXIGIDO = 5;
        let timesAbaixoDoMinimo = 0;

        if (isCopa) {
            console.log(`Buscando histórico geral (10 últimos jogos casa/fora) para Copas...`);
            for (const idTime of listaIdsTimes) {
                const queryCasa = `
                    SELECT casa_rating_ataque, casa_rating_defesa
                    FROM jogos
                    WHERE flashscore_id_time_casa = $1 AND casa_rating_ataque IS NOT NULL AND casa_rating_defesa IS NOT NULL
                    ORDER BY data_jogo DESC LIMIT 10
                `;
                const { rows: jogosCasa } = await client.query(queryCasa, [idTime]);

                const queryFora = `
                    SELECT fora_rating_ataque, fora_rating_defesa
                    FROM jogos
                    WHERE flashscore_id_time_fora = $1 AND fora_rating_ataque IS NOT NULL AND fora_rating_defesa IS NOT NULL
                    ORDER BY data_jogo DESC LIMIT 10
                `;
                const { rows: jogosFora } = await client.query(queryFora, [idTime]);

                if (jogosCasa.length >= MIN_JOGOS_EXIGIDO) {
                    jogosCasa.forEach(j => {
                        arraysRatings.casa_forca.push(
                            calcularForcaPitagorica(j.casa_rating_ataque, j.casa_rating_defesa)
                        );
                    });
                }

                if (jogosFora.length >= MIN_JOGOS_EXIGIDO) {
                    jogosFora.forEach(j => {
                        arraysRatings.fora_forca.push(
                            calcularForcaPitagorica(j.fora_rating_ataque, j.fora_rating_defesa)
                        );
                    });
                }

                if (jogosCasa.length < MIN_JOGOS_EXIGIDO || jogosFora.length < MIN_JOGOS_EXIGIDO) {
                    const queryInvestigacao = `
                        INSERT INTO logs_times_sem_rating (
                            id_competicao, nome_liga, flashscore_slug_liga, flashscore_slug_pais, flashscore_id_time, total_ratings
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                    `;
                    await client.query(queryInvestigacao, [liga.id, liga.nome, liga.flashscore_slug, liga.flashscore_slug_pais, idTime, (jogosCasa.length + jogosFora.length)]);
                }
            }
        } else {
            const contagemTimes = {};
            listaIdsTimes.forEach(id => { contagemTimes[id] = { total_ratings: 0 }; });

            const queryJogosLiga = `
                SELECT 
                    flashscore_id_time_casa, casa_rating_ataque, casa_rating_defesa,
                    flashscore_id_time_fora, fora_rating_ataque, fora_rating_defesa
                FROM jogos
                WHERE id_competicao = $1
                  AND (flashscore_id_time_casa = ANY($2) OR flashscore_id_time_fora = ANY($2))
            `;
            const { rows: jogos } = await client.query(queryJogosLiga, [liga.id, listaIdsTimes]);

            jogos.forEach(jogo => {
                if (jogo.flashscore_id_time_casa && contagemTimes[jogo.flashscore_id_time_casa] && jogo.casa_rating_ataque !== null && jogo.casa_rating_defesa !== null) {
                    contagemTimes[jogo.flashscore_id_time_casa].total_ratings += 1;
                    arraysRatings.casa_forca.push(
                        calcularForcaPitagorica(jogo.casa_rating_ataque, jogo.casa_rating_defesa)
                    );
                }

                if (jogo.flashscore_id_time_fora && contagemTimes[jogo.flashscore_id_time_fora] && jogo.fora_rating_ataque !== null && jogo.fora_rating_defesa !== null) {
                    contagemTimes[jogo.flashscore_id_time_fora].total_ratings += 1;
                    arraysRatings.fora_forca.push(
                        calcularForcaPitagorica(jogo.fora_rating_ataque, jogo.fora_rating_defesa)
                    );
                }
            });

            for (const idTime of listaIdsTimes) {
                const total = contagemTimes[idTime].total_ratings;
                if (total < MIN_JOGOS_EXIGIDO) {
                    timesAbaixoDoMinimo++;
                    const queryInvestigacao = `
                        INSERT INTO logs_times_sem_rating (
                            id_competicao, nome_liga, flashscore_slug_liga, flashscore_slug_pais, flashscore_id_time, total_ratings
                        ) VALUES ($1, $2, $3, $4, $5, $6)
                    `;
                    await client.query(queryInvestigacao, [liga.id, liga.nome, liga.flashscore_slug, liga.flashscore_slug_pais, idTime, total]);
                }
            }
        }

        if (timesAbaixoDoMinimo > MAX_EXCECOES_PERMITIDAS) {
            console.log(`⛔ ALERTA: ${liga.nome} tem ${timesAbaixoDoMinimo} time(s) reprovado(s) na validação. Grid abortado.`);
            await client.query(`UPDATE competicoes SET pronta_para_grid = $1 WHERE id = $2`, [READY_FOR_GRID, liga.id]);
            await registrarErroPipeline(client, {
                id_competicao: liga.id,
                nome_liga: liga.nome,
                pais_liga: liga.pais_liga || liga.flashscore_slug_pais || null,
                flashscore_slug_liga: liga.flashscore_slug,
                flashscore_slug_pais: liga.flashscore_slug_pais,
                tipo: 'validacao_grid',
                motivo: 'Excedeu o limite de times sem rating suficiente.',
                detalhes: { times_abaixo_do_minimo: timesAbaixoDoMinimo, max_permitido: MAX_EXCECOES_PERMITIDAS, total_times: listaIdsTimes.length }
            });
            return;
        }

        console.log(`✅ COMPETIÇÃO APROVADA: ${liga.nome} passou na validação. Calculando grid pitagórico...`);

        const limitesCasaForca = calcularLimitesDaLiga(arraysRatings.casa_forca);
        const limitesForaForca = calcularLimitesDaLiga(arraysRatings.fora_forca);

        const queryUpdate = `
            UPDATE competicoes
            SET 
                casa_forca_limite_fraco = $1, 
                casa_forca_limite_forte = $2,
                fora_forca_limite_fraco = $3, 
                fora_forca_limite_forte = $4,
                pronta_para_grid = $5
            WHERE id = $6
        `;

        await client.query(queryUpdate, [
            limitesCasaForca.limite_33, limitesCasaForca.limite_66,
            limitesForaForca.limite_33, limitesForaForca.limite_66,
            GRID_PROCESSED,
            liga.id
        ]);

        console.log(`✅ SUCESSO: Limites de Força Pitagórica de ${liga.nome} salvos na tabela competicoes!`);

        const limitesGrid = {
            limite_33_casa_forca: limitesCasaForca.limite_33,
            limite_66_casa_forca: limitesCasaForca.limite_66,
            limite_33_fora_forca: limitesForaForca.limite_33,
            limite_66_fora_forca: limitesForaForca.limite_66
        };

        await atualizarClassesNaTabelaJogos(client, liga.id, liga.flashscore_slug, limitesGrid);

    } catch (error) {
        console.error(`Erro ao processar grid de ${liga.nome}:`, error.message);
    }
}

// ======================================================
// 4. VERIFICAR SE TODOS OS TIMES DA COMPETIÇÃO FORAM COLETADOS
// ======================================================
async function verificarTimesColetados(client, idCompeticao) {
    const queryStatus = `
        SELECT
            tc.flashscore_id_time AS flashscore_id_time,
            t.coletado
        FROM (
            SELECT DISTINCT flashscore_id_time
            FROM classificacao_geral_2026
            WHERE id_competicao = $1
              AND flashscore_id_time IS NOT NULL
              AND classificacao_tipo = 'GERAL'

            UNION

            SELECT DISTINCT time_id
            FROM (
                SELECT flashscore_id_time_casa AS time_id FROM jogos WHERE id_competicao = $1 AND flashscore_id_time_casa IS NOT NULL
                UNION
                SELECT flashscore_id_time_fora AS time_id FROM jogos WHERE id_competicao = $1 AND flashscore_id_time_fora IS NOT NULL
            ) sub
        ) tc
        LEFT JOIN times t
            ON t.flashscore_id = tc.flashscore_id_time
        ORDER BY tc.flashscore_id_time;
    `;

    const { rows: rowsStatus } = await client.query(queryStatus, [idCompeticao]);

    if (!rowsStatus || rowsStatus.length === 0) {
        return { ok: false, total_times: 0, total_coletados: 0, total_pendentes: 0, naoEncontrados: 0, ids_times: [], ids_faltantes: [], faltantes: [] };
    }

    const idsTimes = rowsStatus.map(r => r.flashscore_id_time).filter(Boolean);
    const idsFaltantes = rowsStatus.filter(r => r.coletado == null || Number(r.coletado) !== 10).map(r => r.flashscore_id_time).filter(Boolean);

    const total = idsTimes.length;
    const coletados = rowsStatus.filter(r => Number(r.coletado) === 10).length;
    const totalPendentes = idsFaltantes.length;
    const naoEncontrados = rowsStatus.filter(r => r.coletado == null).length;

    return {
        ok: total > 0 && total === coletados,
        total_times: total,
        total_coletados: coletados,
        total_pendentes: totalPendentes,
        naoEncontrados,
        ids_times: idsTimes,
        ids_faltantes: idsFaltantes,
        faltantes: idsFaltantes
    };
}

async function prepararTimesFaltantesParaColeta(client, liga, idsFaltantes) {
    if (!Array.isArray(idsFaltantes) || idsFaltantes.length === 0) {
        return { marcados: [], naoCadastrados: [] };
    }

    const marcados = [];
    const naoCadastrados = [];

    for (const flashscoreId of idsFaltantes) {
        const { rows } = await client.query(`SELECT id, flashscore_id FROM times WHERE flashscore_id = $1 LIMIT 1;`, [flashscoreId]);

        if (!rows || rows.length === 0) {
            naoCadastrados.push(flashscoreId);
            continue;
        }

        await client.query(`UPDATE times SET coletado = 5 WHERE flashscore_id = $1;`, [flashscoreId]);
        marcados.push(flashscoreId);
    }

    if (naoCadastrados.length > 0) {
        const idsFormatados = naoCadastrados.map(String);
        await registrarErroPipeline(client, {
            id_competicao: liga.id,
            nome_liga: liga.nome,
            pais_liga: liga.pais_liga || liga.flashscore_slug_pais || null,
            flashscore_slug_liga: liga.flashscore_slug,
            flashscore_slug_pais: liga.flashscore_slug_pais,
            tipo: 'time_nao_cadastrado',
            motivo: 'Time ausente na tabela times; cadastre antes de rodar o scraper.',
            times_faltantes: idsFormatados,
            detalhes: { ids_nao_cadastrados: idsFormatados, competicao: liga.nome }
        });
    }

    return { marcados, naoCadastrados };
}

async function executar() {
    try {
        await client.connect();
        console.log('Buscando competições marcadas com pronta_para_grid = 1...');
        await client.query('TRUNCATE TABLE logs_times_sem_rating');

        const queryLigas = `
            SELECT DISTINCT
                c.id, c.flashscore_slug, c.flashscore_slug_pais, c.nome,
                CASE WHEN cl.id_competicao IS NOT NULL THEN 1 ELSE 2 END AS ordem_prioridade
            FROM competicoes c
            LEFT JOIN classificacao_geral_2026 cl ON c.id = cl.id_competicao
            WHERE c.pronta_para_grid = $1
            ORDER BY ordem_prioridade ASC, c.nome ASC;
        `;
        const { rows: ligasProntas } = await client.query(queryLigas, [READY_FOR_GRID]);

        if (ligasProntas.length === 0) {
            console.log('Nenhuma competição pendente no momento.');
        } else {
            for (const liga of ligasProntas) {
                console.log(`\n---------------------------------`);
                console.log(`Analisando: ${liga.nome} (ID: ${liga.id})`);

                const verificacaoColeta = await verificarTimesColetados(client, liga.id);

                if (!verificacaoColeta.ok) {
                    console.log(`⏳ [AGUARDANDO] A competição ${liga.nome} possui times pendentes de coleta. Pulando...`);
                    await registrarErroPipeline(client, {
                        id_competicao: liga.id,
                        nome_liga: liga.nome,
                        pais_liga: liga.pais_liga || liga.flashscore_slug_pais || null,
                        flashscore_slug_liga: liga.flashscore_slug,
                        flashscore_slug_pais: liga.flashscore_slug_pais,
                        tipo: 'coleta_incompleta',
                        motivo: 'Nem todos os times da competição foram coletados com status 10.',
                        times_faltantes: verificacaoColeta.ids_faltantes || [],
                        detalhes: verificacaoColeta
                    });

                    await prepararTimesFaltantesParaColeta(client, liga, verificacaoColeta.ids_faltantes || []);
                    continue;
                }

                console.log(`✅ Todos os times coletados! Iniciando cálculos...`);
                await gerarGridDaLiga(client, liga);
            }
        }
    } catch (error) {
        console.log('Erro na execução principal:', error.message);
    } finally {
        await client.end();
        console.log('\nProcesso finalizado com segurança.');
    }
}

executar();