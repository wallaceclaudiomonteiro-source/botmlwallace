const { Client } = require('pg');

const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

/*
 * ================================================================
 * TESTE DE HIPÓTESE — "ERRADOS" PREDIZEM MELHOR QUE "TOTAL"?
 * ================================================================
 *
 * Em cima de estatisticas_geral (um registro por time/jogo),
 * compara a correlação de Pearson (e o R², que é o que vira peso
 * nos modelos MLE) entre:
 *
 *   1) desarmes_total / desarmes_certos / desarmes_errados
 *      (= desarmes_total - desarmes_certos)
 *      ...contra os cartões do PRÓPRIO time no mesmo jogo
 *      (pontos = amarelos + vermelhos*2, igual pontosCartao()).
 *
 *   2) cruzamentos_total / cruzamentos_certos / cruzamentos_errados
 *      (= cruzamentos_total - cruzamentos_certos)
 *      ...contra os escanteios do PRÓPRIO time no mesmo jogo.
 *
 * Tudo calculado no banco via CORR() — não traz linha nenhuma pra
 * memória do Node, só os coeficientes finais. Pool de casa+fora
 * junto (cada linha de estatisticas_geral já é um time/jogo); pra
 * separar por mando, é só adicionar "AND eh_casa = 1" (ou 0) nas
 * queries abaixo.
 */

function imprimirLinha(nome, corr) {
    const c = Number(corr) || 0;
    const r2 = c * c;
    console.log(`  ${nome} | corr=${c.toFixed(4)} | R²=${r2.toFixed(4)}`);
}

async function testarDesarmes() {
    const { rows } = await client.query(`
        SELECT
            COUNT(*) AS n,
            CORR(desarmes_total::float, cartoes_pontos)                     AS corr_total,
            CORR(desarmes_certos::float, cartoes_pontos)                    AS corr_certos,
            CORR((desarmes_total - desarmes_certos)::float, cartoes_pontos) AS corr_errados
        FROM (
            SELECT
                desarmes_total,
                desarmes_certos,
                (cartoes_amarelos + cartao_vermelho * 2)::float AS cartoes_pontos
            FROM estatisticas_geral
            WHERE desarmes_total IS NOT NULL
              AND desarmes_certos IS NOT NULL
              AND cartoes_amarelos IS NOT NULL
              AND cartao_vermelho IS NOT NULL
        ) sub
    `);

    const r = rows[0];
    console.log('\n=== DESARMES vs CARTÕES (próprio time) ===');
    console.log(`n = ${r.n}`);
    imprimirLinha('desarmes_total  ', r.corr_total);
    imprimirLinha('desarmes_certos ', r.corr_certos);
    imprimirLinha('desarmes_errados', r.corr_errados);
}

async function testarCruzamentos() {
    const { rows } = await client.query(`
        SELECT
            COUNT(*) AS n,
            CORR(cruzamentos_total::float, escanteios::float)                        AS corr_total,
            CORR(cruzamentos_certos::float, escanteios::float)                       AS corr_certos,
            CORR((cruzamentos_total - cruzamentos_certos)::float, escanteios::float) AS corr_errados
        FROM estatisticas_geral
        WHERE cruzamentos_total IS NOT NULL
          AND cruzamentos_certos IS NOT NULL
          AND escanteios IS NOT NULL
    `);

    const r = rows[0];
    console.log('\n=== CRUZAMENTOS vs ESCANTEIOS (próprio time) ===');
    console.log(`n = ${r.n}`);
    imprimirLinha('cruzamentos_total  ', r.corr_total);
    imprimirLinha('cruzamentos_certos ', r.corr_certos);
    imprimirLinha('cruzamentos_errados', r.corr_errados);
}

async function rodar() {
    await client.connect();
    try {
        await testarDesarmes();
        await testarCruzamentos();
    } catch (err) {
        console.error('[ERRO]', err);
    } finally {
        await client.end();
    }
}

rodar();