const { Pool } = require('pg');
const {
  analyzeTeamGolsFromFiltered,
  closeDb: closeTeamGoalsDb,
} = require('../markets/team_goals');

const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || '100.114.225.110',
  database: process.env.PGDATABASE || 'stats_futebol',
  password: process.env.PGPASSWORD || 'Wallace@22',
  port: Number(process.env.PGPORT || 5432),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('⚠️ LOG BD (db_gols): Erro inesperado no Pool de conexão.', err.message);
});

async function closeDb() {
  await pool.end();
  await closeTeamGoalsDb();
}

async function pegaJogosDoDia(dataEscolhida) {
  const query = `
    SELECT
      c.flashscore_id,
      c.data_jogo,
      c.hora_jogo,
      c.nome_time_casa,
      c.nome_time_fora,
      c.id_time_casa,
      c.id_time_fora,
      c.flashscore_id_casa,
      c.flashscore_id_fora,
      c.id_competicao,
      c.flashscore_id_competicao,
      c.flashscore_slug_liga,
      c.url,
      comp.media_gols_por_jogo
    FROM calendario c
    LEFT JOIN competicoes comp
      ON comp.flashscore_slug = c.flashscore_slug_liga
    WHERE c.data_jogo = $1
    ORDER BY c.hora_jogo ASC, c.flashscore_id ASC
  `;

  const res = await pool.query(query, [dataEscolhida]);

  return res.rows.map((row) => ({
    flashscore_id: row.flashscore_id,
    data_jogo: row.data_jogo,
    hora_jogo: row.hora_jogo,
    id_competicao: row.id_competicao,
    flashscore_id_competicao: row.flashscore_id_competicao,
    id_time_casa: row.id_time_casa,
    id_time_fora: row.id_time_fora,
    nome_time_casa: row.nome_time_casa,
    nome_time_fora: row.nome_time_fora,
    flashscore_id_time_casa: row.flashscore_id_casa,
    flashscore_id_time_fora: row.flashscore_id_fora,
    flashscore_slug_liga: row.flashscore_slug_liga,
    url: row.url,
    media_gols_por_jogo: row.media_gols_por_jogo
  }));
}
async function analisarJogosDoDia(dataEscolhida) {
  const jogos = await pegaJogosDoDia(dataEscolhida);

  if (jogos.length === 0) {
    return [];
  }

  const analises = await Promise.all(
    jogos.map(async (jogo) => {
      const resultado = await analyzeTeamGolsFromFiltered(jogo);

      return {
        ...resultado,
        data_jogo: jogo.data_jogo,
        hora_jogo: jogo.hora_jogo,
        id_competicao: jogo.id_competicao,
        mandante: {
          id_time: jogo.id_time_casa,
          nome_time: jogo.nome_time_casa,
          flashscore_id_time: jogo.flashscore_id_time_casa,
        },
        visitante: {
          id_time: jogo.id_time_fora,
          nome_time: jogo.nome_time_fora,
          flashscore_id_time: jogo.flashscore_id_time_fora,
        },
      };
    })
  );

  return analises;
}

module.exports = {
  pegaJogosDoDia,
  analisarJogosDoDia,
  closeDb,
};