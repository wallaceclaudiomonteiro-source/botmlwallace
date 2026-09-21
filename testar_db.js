const { criarPool } = require('./db');
const pool = criarPool('modelo', { max: 1 });
pool.query('SELECT current_user, current_database()')
    .then(r => console.log('Conexão OK:', r.rows[0]))
    .catch(e => console.error('Falha:', e.message))
    .finally(() => pool.end());