const { criarPool } = require('./db');
const pool = criarPool('modelo', { max: 20 });

// A função agora recebe a data desejada no formato 'YYYY-MM-DD'
async function transferirNovosJogosPorData(dataDoJogo) {
  const query = `
    INSERT INTO jogos (
        flashscore_id, data_jogo, hora_jogo, id_competicao, id_time_casa, id_time_fora,
        nome_competicao, nome_time_casa, nome_time_fora, flashscore_id_time_casa, 
        flashscore_id_time_fora, flashscore_id_competicao, flashscore_slug_liga,
        rodada, pais_liga, flashscore_slug_pais_liga, link_estatisticas, estatisticas_coletadas
    )
    SELECT 
        c.flashscore_id, c.data_jogo, c.hora_jogo, c.id_competicao, c.id_time_casa, c.id_time_fora,
        c.nome_competicao, c.nome_time_casa, c.nome_time_fora, c.flashscore_id_casa, 
        c.flashscore_id_fora, c.flashscore_id_competicao, c.flashscore_slug_liga,
        c.rodada, c.pais_liga, c.flashscore_slug_pais_liga, c.url, 0
    FROM calendario c
    WHERE c.data_jogo = $1 
      AND NOT EXISTS (
        SELECT 1 
        FROM jogos j 
        WHERE j.flashscore_id = c.flashscore_id
    );
  `;

  try {
    console.log(`Verificando o calendário para a data: ${dataDoJogo}...`);
    
    // O array [dataDoJogo] substitui o $1 na query de forma segura
    const result = await pool.query(query, [dataDoJogo]);
    
    console.log(`Sucesso! ${result.rowCount} novos jogos inseridos na tabela 'jogos' para o dia ${dataDoJogo}.`);
  } catch (error) {
    console.error('Erro ao executar a query:', error.message);
  } finally {
    await pool.end();
  }
}

// Chame a função passando a data que você quiser (formato Ano-Mês-Dia)
const minhaData = '2026-07-14';
transferirNovosJogosPorData(minhaData);