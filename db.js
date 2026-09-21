const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Pool, Client } = require('pg');

const PASTA_SEGREDOS = process.env.PASTA_SEGREDOS || 'D:/segredos';

// Lê o arquivo do perfil ('modelo' ou 'site') sem misturar perfis no process.env
function lerConfig(perfil = 'site') {
    const arquivo = path.join(PASTA_SEGREDOS, `${perfil}.env`);
    if (!fs.existsSync(arquivo)) throw new Error(`Arquivo de segredos não encontrado: ${arquivo}`);

    const v = dotenv.parse(fs.readFileSync(arquivo));
    const faltando = ['PGHOST', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].filter(k => !v[k]);
    if (faltando.length) throw new Error(`Faltam variáveis em ${arquivo}: ${faltando.join(', ')}`);

    return {
        host: v.PGHOST,
        port: Number(v.PGPORT || 5432),
        user: v.PGUSER,
        password: v.PGPASSWORD,
        database: v.PGDATABASE
    };
}

const criarPool = (perfil = 'site', extra = {}) => new Pool({ ...lerConfig(perfil), max: 10, ...extra });
const criarClient = (perfil = 'site') => new Client(lerConfig(perfil));

module.exports = { criarPool, criarClient };