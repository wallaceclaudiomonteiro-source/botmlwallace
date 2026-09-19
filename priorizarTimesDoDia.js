const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace@22@100.114.225.110:5432/stats_futebol'
});

client.connect();

// ==========================================
// ATUALIZA OS TIMES PARA COLETA
// ==========================================
//
// Mantém a lógica original:
// GRUPO 1 = times que jogam no dia
// GRUPO 2 = todos os times da mesma liga
//
async function atualizarTimesParaColeta(client, dataAlvo) {
    try {
        const query = `
            UPDATE times
            SET coletado = 5
            WHERE flashscore_id IN (

                -- GRUPO 1: Pega os times (casa e fora)
                -- que vão jogar no dia
                SELECT unnest(
                    array[
                        c.flashscore_id_casa,
                        c.flashscore_id_fora
                    ]
                )
                FROM calendario c
                JOIN competicoes comp
                    ON c.flashscore_slug_liga = comp.flashscore_slug
                    AND c.flashscore_slug_pais_liga = comp.flashscore_slug_pais
                WHERE c.data_jogo = $1
                  AND comp.tem_estatisticas = 1

                UNION

                -- GRUPO 2: Pega TODOS os times da mesma liga
                -- usando classificacao_geral_2026
                SELECT cl.flashscore_id_time
                FROM classificacao_geral_2026 cl
                JOIN calendario c
                    ON cl.flashscore_slug_liga = c.flashscore_slug_liga
                    AND cl.flashscore_slug_pais = c.flashscore_slug_pais_liga
                JOIN competicoes comp
                    ON c.flashscore_slug_liga = comp.flashscore_slug
                    AND c.flashscore_slug_pais_liga = comp.flashscore_slug_pais
                WHERE c.data_jogo = $1
                  AND comp.tem_estatisticas = 1
            );
        `;

        const res = await client.query(query, [dataAlvo]);

        console.log(
            `[${dataAlvo}] Total de times atualizados para coletado = 5: ${res.rowCount}`
        );

    } catch (error) {
        console.error(
            'Erro ao atualizar times:',
            error.message
        );
    }
}


// ==========================================
// MARCA AS COMPETIÇÕES PARA GERAR O GRID
// ==========================================

async function atualizarCompeticoesParaGrid(client, dataAlvo) {
    try {
        const query = `
            UPDATE competicoes
            SET pronta_para_grid = 1
            WHERE id IN (
                SELECT DISTINCT c.id_competicao
                FROM calendario c
                JOIN competicoes comp
                    ON comp.id = c.id_competicao
                WHERE c.data_jogo = $1
                  AND c.id_competicao IS NOT NULL
                  AND comp.tem_estatisticas = 1
            );
        `;

        const res = await client.query(query, [dataAlvo]);

        console.log(
            `[${dataAlvo}] Total de competições atualizadas para pronta_para_grid = 1: ${res.rowCount}`
        );

    } catch (error) {
        console.error(
            'Erro ao atualizar competições:',
            error.message
        );
    }
}


// ==========================================
// NOVA ETAPA:
// MARCA TODOS OS TIMES DAS COMPETIÇÕES
// ENCONTRADAS NO CALENDÁRIO
// ==========================================
//
// Usa o id_competicao do calendario.
//
// Depois consulta classificacao_geral_2026:
//
//     id_competicao
//          ↓
//     todos os registros daquela competição
//          ↓
//     flashscore_id_time
//          ↓
//     times.coletado = 10
//
// ==========================================

async function atualizarTimesDasCompeticoes(client, dataAlvo) {
    try {
        const query = `
            UPDATE times
            SET coletado = 5
            WHERE flashscore_id IN (

                SELECT DISTINCT cl.flashscore_id_time
                FROM classificacao_geral_2026 cl

                WHERE cl.id_competicao IN (

                    SELECT DISTINCT c.id_competicao
                    FROM calendario c
                    JOIN competicoes comp
                        ON comp.id = c.id_competicao

                    WHERE c.data_jogo = $1
                      AND c.id_competicao IS NOT NULL
                      AND comp.tem_estatisticas = 1
                )

                AND cl.flashscore_id_time IS NOT NULL
            );
        `;

        const res = await client.query(query, [dataAlvo]);

        console.log(
            `[${dataAlvo}] Times das competições marcados para coleta inicial (coletado = 5): ${res.rowCount}`
        );

    } catch (error) {
        console.error(
            'Erro ao atualizar times das competições:',
            error.message
        );
    }
}


// ==========================================
// EXECUÇÃO
// ==========================================

async function executar() {
    try {

        const dataAlvo = '2026-09-19';
        // ==========================================
        // 1. MANTÉM A LÓGICA ATUAL DOS TIMES
        // ==========================================
        await atualizarTimesParaColeta(client, dataAlvo);


        // ==========================================
        // 2. MANTÉM A LÓGICA ATUAL DAS COMPETIÇÕES
        // ==========================================
        await atualizarCompeticoesParaGrid(client, dataAlvo);


        // ==========================================
        // 3. NOVA LÓGICA
        // Usa os id_competicao do calendario
        // para buscar todos os times da competição
        // na classificacao_geral_2026
        // ==========================================
        await atualizarTimesDasCompeticoes(client, dataAlvo);

    } catch (error) {
        console.error(
            'Erro na execução:',
            error.message
        );
    } finally {
        await client.end();
    }
}

executar();