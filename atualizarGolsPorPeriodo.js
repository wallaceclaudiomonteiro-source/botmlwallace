const { criarClient } = require('./db');
const client = criarClient('modelo');

async function atualizarGolsPorPeriodo() {
    await client.connect();
    console.log('[SISTEMA] Iniciando recálculo de gols por período...');

    try {
        // 1. Identifica apenas os jogos que estão com gols NULL
        const queryJogosNulos = `
            SELECT DISTINCT flashscore_id_jogo 
            FROM estatisticas_por_periodo 
            WHERE gols_marcados IS NULL OR gols_sofridos IS NULL;
        `;
        const resJogosNulos = await client.query(queryJogosNulos);
        const jogosNulos = resJogosNulos.rows.map(r => r.flashscore_id_jogo);

        if (jogosNulos.length === 0) {
            console.log('[SISTEMA] Nenhum jogo com estatísticas nulas encontrado.');
            return;
        }

        console.log(`[SISTEMA] Encontrados ${jogosNulos.length} jogos com dados nulos. Buscando eventos...`);

        // 2. Inicializa os contadores com ZERO (Garante que jogos que terminaram 0x0 saiam do NULL)
        const golsPorJogo = {};
        for (const idJogo of jogosNulos) {
            golsPorJogo[idJogo] = {
                casa: { '1_tempo': 0, '2_tempo': 0 },
                fora: { '1_tempo': 0, '2_tempo': 0 }
            };
        }

        // 3. Busca eventos de gol APENAS para os jogos filtrados
        const queryEventos = `
            SELECT flashscore_id_jogo, periodo, time, descricao_evento
            FROM eventos_jogo 
            WHERE flashscore_id_jogo = ANY($1)
              AND (
                  tipo_evento = 'gol'
                  OR (
                      tipo_evento = 'desconhecido' 
                      AND (
                          descricao_evento ILIKE '%Pênalti%' 
                          OR descricao_evento ILIKE '%Gol Contra%'
                          OR descricao_evento ILIKE '%Penalty%'
                          OR descricao_evento ILIKE '%Own Goal%'
                      )
                  )
              );
        `;
        const resEventos = await client.query(queryEventos, [jogosNulos]);
        const eventosGols = resEventos.rows;

        // 4. Preenche os gols no objeto (apenas onde houveram gols)
        for (const evento of eventosGols) {
            const idJogo = evento.flashscore_id_jogo;
            const timeEvento = evento.time; // 'casa' ou 'fora'
            const periodoBanco = evento.periodo; // '1T' ou '2T'

            let periodoKey = null;
            if (periodoBanco === '1T' || periodoBanco === '1_tempo') periodoKey = '1_tempo';
            else if (periodoBanco === '2T' || periodoBanco === '2_tempo') periodoKey = '2_tempo';

            if (periodoKey && (timeEvento === 'casa' || timeEvento === 'fora')) {
                golsPorJogo[idJogo][timeEvento][periodoKey]++;
            }
        }

        let jogosAtualizados = 0;

        // 5. Atualiza a tabela (Jogos 0x0 agora serão corretamente definidos como 0 em vez de ficarem eternamente NULL)
        for (const idJogo of Object.keys(golsPorJogo)) {
            const dados = golsPorJogo[idJogo];

            // ================= 1º TEMPO =================
            await client.query(`
                UPDATE estatisticas_por_periodo 
                SET gols_marcados = $1, gols_sofridos = $2 
                WHERE flashscore_id_jogo = $3 AND periodo = '1_tempo' AND eh_casa = 1;
            `, [dados.casa['1_tempo'], dados.fora['1_tempo'], idJogo]);

            await client.query(`
                UPDATE estatisticas_por_periodo 
                SET gols_marcados = $1, gols_sofridos = $2 
                WHERE flashscore_id_jogo = $3 AND periodo = '1_tempo' AND eh_casa = 0;
            `, [dados.fora['1_tempo'], dados.casa['1_tempo'], idJogo]);

            // ================= 2º TEMPO =================
            await client.query(`
                UPDATE estatisticas_por_periodo 
                SET gols_marcados = $1, gols_sofridos = $2 
                WHERE flashscore_id_jogo = $3 AND periodo = '2_tempo' AND eh_casa = 1;
            `, [dados.casa['2_tempo'], dados.fora['2_tempo'], idJogo]);

            await client.query(`
                UPDATE estatisticas_por_periodo 
                SET gols_marcados = $1, gols_sofridos = $2 
                WHERE flashscore_id_jogo = $3 AND periodo = '2_tempo' AND eh_casa = 0;
            `, [dados.fora['2_tempo'], dados.casa['2_tempo'], idJogo]);

            jogosAtualizados++;
        }

        console.log(`[SISTEMA] Sucesso! Gols inseridos/atualizados para ${jogosAtualizados} jogos.`);

    } catch (err) {
        console.error('[ERRO FATAL]', err);
    } finally {
        await client.end();
    }
}

atualizarGolsPorPeriodo();