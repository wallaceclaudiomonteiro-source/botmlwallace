const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    host: '100.114.225.110',
    database: 'stats_futebol',
    password: 'Wallace@22',
    port: 5432,
});

const MAX_JOGOS_ATUAIS = 20;
const JOGOS_EXTRAS = 30;
const COLUNA_RESULTADO = 'promocao_rebaixamento';

// ======================================================
// CRIAR / AJUSTAR COLUNAS
// ======================================================

async function criarColunas(client) {
    // Coluna de promoção/rebaixamento
    await client.query(`
        ALTER TABLE public.times
        ADD COLUMN IF NOT EXISTS ${COLUNA_RESULTADO} TEXT;
    `);

    // --------------------------------------------------
    // competicao_disputada precisa ser JSONB
    // e armazenar um ARRAY de IDs.
    // --------------------------------------------------

    const coluna = await client.query(`
        SELECT
            data_type,
            udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'times'
          AND column_name = 'competicao_disputada';
    `);

    if (coluna.rows.length === 0) {
        console.log('[BANCO] Criando coluna competicao_disputada como JSONB...');

        await client.query(`
            ALTER TABLE public.times
            ADD COLUMN competicao_disputada JSONB NOT NULL DEFAULT '[]'::jsonb;
        `);
    } else if (coluna.rows[0].udt_name !== 'jsonb') {
        console.log('[BANCO] Convertendo competicao_disputada para JSONB...');

        await client.query(`
            ALTER TABLE public.times
            ALTER COLUMN competicao_disputada DROP DEFAULT;
        `);

        await client.query(`
            ALTER TABLE public.times
            ALTER COLUMN competicao_disputada TYPE JSONB
            USING (
                CASE
                    WHEN competicao_disputada IS NULL
                        THEN '[]'::jsonb

                    WHEN competicao_disputada::text ~ '^\\s*\\['
                        THEN competicao_disputada::text::jsonb

                    WHEN competicao_disputada::text ~ '^\\s*[0-9]+\\s*$'
                        THEN jsonb_build_array(
                            competicao_disputada::text::integer
                        )

                    ELSE '[]'::jsonb
                END
            );
        `);

        await client.query(`
            ALTER TABLE public.times
            ALTER COLUMN competicao_disputada
            SET DEFAULT '[]'::jsonb;
        `);

        await client.query(`
            UPDATE public.times
            SET competicao_disputada = '[]'::jsonb
            WHERE competicao_disputada IS NULL;
        `);

        await client.query(`
            ALTER TABLE public.times
            ALTER COLUMN competicao_disputada SET NOT NULL;
        `);
    }

    // --------------------------------------------------
    // Normaliza casos em que a coluna já era JSONB,
    // mas algum registro ainda possui número/string
    // em vez de array.
    // --------------------------------------------------

    await client.query(`
        UPDATE public.times
        SET competicao_disputada =
            CASE
                WHEN jsonb_typeof(competicao_disputada) = 'array'
                    THEN competicao_disputada

                WHEN jsonb_typeof(competicao_disputada) = 'number'
                    THEN jsonb_build_array(competicao_disputada)

                WHEN jsonb_typeof(competicao_disputada) = 'string'
                     AND competicao_disputada #>> '{}' ~ '^[0-9]+$'
                    THEN jsonb_build_array(
                        (competicao_disputada #>> '{}')::integer
                    )

                ELSE '[]'::jsonb
            END
        WHERE competicao_disputada IS NOT NULL;
    `);

    console.log('[BANCO] Colunas verificadas.');
}

// ======================================================
// BUSCAR COMPETIÇÕES
// ======================================================

async function buscarCompeticoes(client) {
    const result = await client.query(`
        SELECT
            id,
            nome,
            pais,
            tipo_competicao
        FROM public.competicoes
        WHERE tipo_competicao = 'Liga'
        ORDER BY id ASC;
    `);

    return result.rows;
}

// ======================================================
// BUSCAR TIMES DA CLASSIFICAÇÃO
// ======================================================

async function buscarTimesDaClassificacao(client, idCompeticao) {
    const result = await client.query(`
        SELECT
            id_time,
            flashscore_id_time,
            nome_time,
            jogos,
            id_competicao
        FROM public.classificacao_geral_2026
        WHERE id_competicao = $1
          AND classificacao_tipo = 'GERAL'
          AND flashscore_id_time IS NOT NULL
        ORDER BY id;
    `, [idCompeticao]);

    return result.rows;
}

// ======================================================
// BUSCAR PAÍS DA COMPETIÇÃO
// ======================================================

async function buscarPaisCompeticao(client, idCompeticao) {
    const result = await client.query(`
        SELECT
            pais
        FROM public.competicoes
        WHERE id = $1
          AND tipo_competicao = 'Liga'
        LIMIT 1;
    `, [idCompeticao]);

    return result.rows[0]?.pais || null;
}

// ======================================================
// BUSCAR LIGA SUPERIOR
// ======================================================
//
// Pela estrutura atual do banco:
// ID MENOR = competição superior
// ID MAIOR = competição inferior
//
// Portanto:
// superior = maior ID abaixo da competição atual
// ======================================================

async function buscarLigaSuperior(client, idCompeticao, pais) {
    const result = await client.query(`
        SELECT
            id,
            nome,
            pais,
            tipo_competicao
        FROM public.competicoes
        WHERE pais = $1
          AND tipo_competicao = 'Liga'
          AND id < $2
        ORDER BY id DESC
        LIMIT 1;
    `, [pais, idCompeticao]);

    return result.rows[0] || null;
}

// ======================================================
// BUSCAR LIGA INFERIOR
// ======================================================

async function buscarLigaInferior(client, idCompeticao, pais) {
    const result = await client.query(`
        SELECT
            id,
            nome,
            pais,
            tipo_competicao
        FROM public.competicoes
        WHERE pais = $1
          AND tipo_competicao = 'Liga'
          AND id > $2
        ORDER BY id ASC
        LIMIT 1;
    `, [pais, idCompeticao]);

    return result.rows[0] || null;
}

// ======================================================
// BUSCAR HISTÓRICO DO TIME
// ======================================================

async function buscarJogosHistoricos(client, flashscoreIdTime, limite) {
    const result = await client.query(`
        SELECT
            id,
            data,
            flashscore_id_casa,
            flashscore_id_fora,
            id_competicao
        FROM public.jogos
        WHERE
            flashscore_id_casa = $1
            OR
            flashscore_id_fora = $1
        ORDER BY data DESC
        LIMIT $2;
    `, [flashscoreIdTime, limite]);

    return result.rows;
}

// ======================================================
// CLASSIFICAR PROMOÇÃO / REBAIXAMENTO
// ======================================================

function classificarTime(
    jogos,
    idCompeticaoAtual,
    ligaSuperior,
    ligaInferior
) {
    let resultado = 'NEUTRO';
    let jogoEvidencia = null;

    const idSuperior = ligaSuperior
        ? Number(ligaSuperior.id)
        : null;

    const idInferior = ligaInferior
        ? Number(ligaInferior.id)
        : null;

    for (const jogo of jogos) {
        const idCompeticaoJogo = Number(jogo.id_competicao);

        // --------------------------------------------------
        // Se encontrou jogo na liga superior:
        // o time estava na divisão superior e agora está
        // nesta competição -> REBAIXADO
        // --------------------------------------------------

        if (
            idSuperior !== null &&
            idCompeticaoJogo === idSuperior
        ) {
            resultado = 'REBAIXADO';
            jogoEvidencia = jogo;
            break;
        }

        // --------------------------------------------------
        // Se encontrou jogo na liga inferior:
        // o time estava na divisão inferior e agora está
        // nesta competição -> PROMOVIDO
        // --------------------------------------------------

        if (
            idInferior !== null &&
            idCompeticaoJogo === idInferior
        ) {
            resultado = 'PROMOVIDO';
            jogoEvidencia = jogo;
            break;
        }
    }

    return {
        resultado,
        jogoEvidencia
    };
}

// ======================================================
// ATUALIZAR TIME
// ======================================================
//
// IMPORTANTE:
//
// competicao_disputada NÃO É MAIS SOBRESCRITA.
//
// Cada vez que o time é encontrado em uma liga,
// adicionamos o ID dessa liga ao array.
//
// Exemplo:
//
// antes:
// [160]
//
// processa liga 198:
//
// depois:
// [160,198]
//
// processa liga 601:
//
// depois:
// [160,198,601]
//
// Além disso, mantemos apenas competições do MESMO PAÍS
// e que sejam do tipo Liga.
//
// O array fica sempre sem duplicações e ordenado.
// ======================================================

async function atualizarTime(
    client,
    flashscoreIdTime,
    resultado,
    idCompeticao
) {
    const pais = await buscarPaisCompeticao(
        client,
        idCompeticao
    );

    if (!pais) {
        console.log(
            `[AVISO] País não encontrado para competição ${idCompeticao}.`
        );

        await client.query(`
            UPDATE public.times
            SET promocao_rebaixamento = $1
            WHERE flashscore_id = $2;
        `, [
            resultado,
            flashscoreIdTime
        ]);

        return;
    }

    await client.query(`
        UPDATE public.times
        SET
            promocao_rebaixamento = $1,
            competicao_disputada = (
                SELECT COALESCE(
                    jsonb_agg(id ORDER BY id),
                    '[]'::jsonb
                )
                FROM (
                    SELECT DISTINCT
                        c.id
                    FROM (
                        SELECT
                            x.id::integer AS id
                        FROM jsonb_array_elements_text(
                            CASE
                                WHEN jsonb_typeof(
                                    COALESCE(
                                        public.times.competicao_disputada,
                                        '[]'::jsonb
                                    )
                                ) = 'array'
                                THEN COALESCE(
                                    public.times.competicao_disputada,
                                    '[]'::jsonb
                                )

                                WHEN jsonb_typeof(
                                    COALESCE(
                                        public.times.competicao_disputada,
                                        '[]'::jsonb
                                    )
                                ) = 'number'
                                THEN jsonb_build_array(
                                    public.times.competicao_disputada
                                )

                                ELSE '[]'::jsonb
                            END
                        ) AS x(id)

                        UNION

                        SELECT $2::integer
                    ) AS existentes
                    INNER JOIN public.competicoes c
                        ON c.id = existentes.id
                       AND c.pais = $4
                       AND c.tipo_competicao = 'Liga'
                ) AS competencias
            )
        WHERE flashscore_id = $3;
    `, [
        resultado,
        Number(idCompeticao),
        flashscoreIdTime,
        pais
    ]);
}

// ======================================================
// PROCESSAR UMA COMPETIÇÃO
// ======================================================

async function processarCompeticao(client, competencia) {
    const idCompeticao = Number(competencia.id);
    const nomeCompeticao = competencia.nome;
    const pais = competencia.pais;

    console.log('');
    console.log('======================================================');
    console.log(`PROCESSANDO: ${nomeCompeticao} | ID: ${idCompeticao} | PAÍS: ${pais}`);
    console.log('======================================================');

    const times = await buscarTimesDaClassificacao(client, idCompeticao);

    if (!times.length) {
        console.log('[AVISO] Nenhum time encontrado na classificação.');
        return;
    }

    // ==================================================
    // PRIMEIRO: REGISTRAR A COMPETIÇÃO PARA TODOS OS TIMES
    // ==================================================
    //
    // Isso acontece ANTES de qualquer regra de limite
    // de jogos.
    //
    // Portanto, mesmo que a competição tenha mais de
    // MAX_JOGOS_ATUAIS, ela continua sendo registrada
    // em competicao_disputada.
    //
    // Exemplo:
    //
    // Cruzeiro já possui [160]
    // Encontrado agora na 198
    // Resultado -> [160,198]
    //
    // ==================================================

    console.log(`[COMPETIÇÃO] Registrando ${idCompeticao} para ${times.length} time(s)...`);

    for (const time of times) {
        const flashscoreIdTime = time.flashscore_id_time;

        await atualizarTime(
            client,
            flashscoreIdTime,
            null,
            idCompeticao
        );

        console.log(
            `[COMPETIÇÃO] ${time.nome_time} -> adicionada ${idCompeticao}`
        );
    }

    // ==================================================
    // AGORA SIM VERIFICAR SE PODE FAZER A ANÁLISE
    // DE PROMOÇÃO / REBAIXAMENTO
    // ==================================================

    const maiorQuantidadeJogos = Math.max(
        ...times.map(t => Number(t.jogos || 0))
    );

    if (maiorQuantidadeJogos > MAX_JOGOS_ATUAIS) {
        console.log(
            `[SKIP ANÁLISE] Competição possui ${maiorQuantidadeJogos} jogos atuais.`
        );
        console.log(
            `[OK] A competição ${idCompeticao} já foi registrada em competicao_disputada.`
        );
        return;
    }

    // ==================================================
    // BUSCAR LIGA SUPERIOR E INFERIOR
    // ==================================================

    const ligaSuperior = await buscarLigaSuperior(
        client,
        idCompeticao,
        pais
    );

    const ligaInferior = await buscarLigaInferior(
        client,
        idCompeticao,
        pais
    );

    console.log(
        `[HIERARQUIA] Superior: ${
            ligaSuperior
                ? `${ligaSuperior.id} - ${ligaSuperior.nome}`
                : 'NÃO ENCONTRADA'
        }`
    );

    console.log(
        `[HIERARQUIA] Inferior: ${
            ligaInferior
                ? `${ligaInferior.id} - ${ligaInferior.nome}`
                : 'NÃO ENCONTRADA'
        }`
    );

    // ==================================================
    // ANALISAR PROMOÇÃO / REBAIXAMENTO
    // ==================================================

    for (const time of times) {
        const flashscoreIdTime = time.flashscore_id_time;
        const nomeTime = time.nome_time;

        console.log(`\n[ TIME ] ${nomeTime} (${flashscoreIdTime})`);

        const jogosHistoricos = await buscarJogosHistoricos(
            client,
            flashscoreIdTime,
            Number(time.jogos || 0) + JOGOS_EXTRAS
        );

        const classificacao = classificarTime(
            jogosHistoricos,
            idCompeticao,
            ligaSuperior,
            ligaInferior
        );

        console.log(
            `[RESULTADO] ${nomeTime}: ${classificacao.resultado}`
        );

        if (classificacao.jogoEvidencia) {
            console.log(
                `[EVIDÊNCIA] Competição encontrada no histórico: ${classificacao.jogoEvidencia.id_competicao}`
            );
        }

        // Aqui NÃO precisamos adicionar novamente a competição.
        // Ela já foi registrada no primeiro loop.
        //
        // Agora atualizamos somente o resultado de
        // promoção/rebaixamento.

        await client.query(`
            UPDATE public.times
            SET promocao_rebaixamento = $1
            WHERE flashscore_id = $2;
        `, [
            classificacao.resultado,
            flashscoreIdTime
        ]);
    }
}

// ======================================================
// MAIN
// ======================================================

async function main() {
    const client = await pool.connect();

    try {
        console.log('======================================================');
        console.log('INICIANDO ATUALIZAÇÃO DE COMPETIÇÕES DOS TIMES');
        console.log('======================================================');

        await criarColunas(client);

        const competicoes = await buscarCompeticoes(client);

        console.log(
            `[SISTEMA] ${competicoes.length} competições encontradas.`
        );

        for (const competencia of competicoes) {
            try {
                await processarCompeticao(
                    client,
                    competencia
                );
            } catch (error) {
                console.error(
                    `\n[ERRO] Competição ${competencia.id} - ${competencia.nome}`
                );
                console.error(error.message);
            }
        }

        console.log('');
        console.log('======================================================');
        console.log('PROCESSAMENTO FINALIZADO');
        console.log('======================================================');

    } catch (error) {
        console.error(
            '[ERRO FATAL]',
            error
        );
    } finally {
        client.release();
        await pool.end();
    }
}

main();