const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:Wallace@22@100.114.225.110:5432/stats_futebol',
  connectionTimeoutMillis: 5000, // Dá timeout se não conseguir conectar em 5 segundos
});

pool.on('connect', () => {
  console.log('Conectado ao banco PostgreSQL (stats_futebol) com sucesso!');
});

pool.on('error', (err) => {
  console.error('Erro inesperado no cliente PostgreSQL:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params)
};