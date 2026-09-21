const { criarPool } = require('../db');
const pool = criarPool('modelo', { max: 10 });

pool.on('connect', () => {
  console.log('Conectado ao banco PostgreSQL (stats_futebol) com sucesso!');
});

pool.on('error', (err) => {
  console.error('Erro inesperado no cliente PostgreSQL:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params)
};