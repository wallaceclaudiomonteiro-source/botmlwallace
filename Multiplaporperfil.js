const { criarClient } = require('./db');

/*
 * ================================================================
 * ATENÇÃO
 * ================================================================
 *
 * Assumindo que `analises_jogos` e `perfil_time` vivem no mesmo
 * banco 'modelo' usado pelo backtestMle.js. Se `perfil_time`
 * estiver em outro banco, cria um segundo client pra ela.
 *
 * Esse código NÃO grava nada em nenhuma tabela. Só lê e mostra
 * no console. Quando estiver validado, aí sim adiciona o
 * INSERT/UPDATE onde tem o comentário "AQUI ENTRARIA A GRAVAÇÃO".
 */

const client = criarClient('modelo');


/*
 * ================================================================
 * MERCADOS 1X2
 * ================================================================
 *
 * Tratados à parte porque usam `res_match_odds`, que é texto
 * ("CASA" / "EMPATE" / "FORA"), não GREEN/RED como os outros
 * mercados.
 */

const MERCADOS_1X2 = {
    p_home: 'CASA',
    p_draw: 'EMPATE',
    p_away: 'FORA'
};


/*
 * ================================================================
 * 1. DESCOBRE O MAPA p_... -> res_... A PARTIR DAS COLUNAS REAIS
 *    DA TABELA analises_jogos
 * ================================================================
 *
 * Chamado uma única vez por execução (não por jogo, não por dia),
 * pra não ficar batendo em information_schema à toa.
 */

async function montarMapaMercados(client) {

    const { rows } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'analises_jogos_backup'
    `);

    const colunas = new Set(rows.map(r => r.column_name));
    const mapa = {};

    for (const col of colunas) {
        if (col.startsWith('p_') && !['p_home', 'p_draw', 'p_away'].includes(col)) {
            const resCol = 'res_' + col.slice(2);
            if (colunas.has(resCol)) {
                mapa[col] = resCol;
            }
        }
    }

    return mapa;
}


/*
 * ================================================================
 * 2. ESTILO DO TIME (casa ou fora) NA TABELA perfil_time
 * ================================================================
 */

async function estiloDoTime(idTime, mando, client) {

    if (!['casa', 'fora'].includes(mando)) {
        throw new Error(`mando inválido: ${mando}`);
    }

    const coluna = `estilo_posse_${mando}`;

    const { rows } = await client.query(`
        SELECT ${coluna} AS estilo
        FROM perfil_times
        WHERE id_time = $1
        LIMIT 1
    `, [idTime]);

    return rows.length ? rows[0].estilo : null;
}


/*
 * ================================================================
 * 3. TAXA DE ACERTO DE UM MERCADO OVER/UNDER (GREEN/RED)
 * ================================================================
 *
 * Histórico = jogos em que o MESMO time da casa enfrentou, fora
 * de casa, adversários do MESMO estilo, E o robô também previu
 * esse mercado >= 50% naquele jogo.
 *
 * `dataLimite` é a data do jogo que estamos avaliando agora — só
 * entra histórico com data_jogo ESTRITAMENTE ANTERIOR a ela. Isso
 * é o que garante que não estamos olhando o futuro.
 */

async function avaliarMercado(client, {
    idTimeCasa,
    estiloAlvo,
    dataLimite,
    pCol,
    resCol,
    previsaoAtual,
    limiteAcerto,
    amostraMinima
}) {

    const { rows } = await client.query(`
        SELECT aj.${resCol} AS resultado
        FROM analises_jogos_backup aj
        INNER JOIN perfil_times pt
            ON pt.id_time = aj.id_time_fora
        WHERE aj.id_time_casa = $1
          AND pt.estilo_posse_fora = $2
          AND aj.${pCol} >= 50
          AND aj.${resCol} IS NOT NULL
          AND aj.data_jogo < $3::date
    `, [idTimeCasa, estiloAlvo, dataLimite]);

    const amostra = rows.length;
    if (amostra === 0) return null;

    const green = rows.filter(r => r.resultado === 'GREEN').length;
    const red = rows.filter(r => r.resultado === 'RED').length;
    const taxa = Number(((green / amostra) * 100).toFixed(1));
    const entraMultipla = taxa >= limiteAcerto && amostra >= amostraMinima;

    return { mercado: pCol, previsaoAtual, amostra, green, red, taxa, entraMultipla };
}


/*
 * ================================================================
 * 4. MESMA COISA, SÓ QUE PRO MERCADO 1X2 (res_match_odds é texto)
 * ================================================================
 */

async function avaliarMercado1x2(client, {
    idTimeCasa,
    estiloAlvo,
    dataLimite,
    pCol,
    resultadoAlvo,
    previsaoAtual,
    limiteAcerto,
    amostraMinima
}) {

    const { rows } = await client.query(`
        SELECT aj.res_match_odds AS resultado
        FROM analises_jogos_backup aj
        INNER JOIN perfil_times pt
            ON pt.id_time = aj.id_time_fora
        WHERE aj.id_time_casa = $1
          AND pt.estilo_posse_fora = $2
          AND aj.${pCol} >= 50
          AND aj.res_match_odds IS NOT NULL
          AND aj.data_jogo < $3::date
    `, [idTimeCasa, estiloAlvo, dataLimite]);

    const amostra = rows.length;
    if (amostra === 0) return null;

    const acertos = rows.filter(r => r.resultado === resultadoAlvo).length;
    const taxa = Number(((acertos / amostra) * 100).toFixed(1));
    const entraMultipla = taxa >= limiteAcerto && amostra >= amostraMinima;

    return {
        mercado: pCol,
        previsaoAtual,
        amostra,
        green: acertos,
        red: amostra - acertos,
        taxa,
        entraMultipla
    };
}


/*
 * ================================================================
 * 5. ANALISA UM JOGO (linha vinda direto de analises_jogos_backup)
 * ================================================================
 *
 * jogoRow já é a linha da tabela pro dia sendo processado — já
 * tem id_time_casa, id_time_fora, nome_time_casa, nome_time_fora,
 * data_jogo e todas as colunas p_... preenchidas pelo robô.
 */

async function analisarJogo(jogoRow, client, mapaMercados, opts = {}) {

    const limiteAcerto = opts.limiteAcerto ?? 70;
    const amostraMinima = opts.amostraMinima ?? 8;

    const idTimeCasa = jogoRow.id_time_casa;
    const idTimeFora = jogoRow.id_time_fora;
    const dataLimite = jogoRow.data_jogo;

    const estiloVisitante = await estiloDoTime(idTimeFora, 'fora', client);

    if (!estiloVisitante) {
        console.log(
            `  [AVISO] Sem perfil pro visitante '${jogoRow.nome_time_fora}' — pulando jogo.`
        );
        return { estiloVisitante: null, resultados: [] };
    }

    const resultados = [];

    for (const [pCol, resCol] of Object.entries(mapaMercados)) {

        const bruto = jogoRow[pCol];
        const previsaoAtual = (bruto === null || bruto === undefined) ? null : Number(bruto);
        if (previsaoAtual === null || previsaoAtual < 50) continue;

        const r = await avaliarMercado(client, {
            idTimeCasa,
            estiloAlvo: estiloVisitante,
            dataLimite,
            pCol,
            resCol,
            previsaoAtual,
            limiteAcerto,
            amostraMinima
        });

        if (r) resultados.push(r);
    }

    for (const [pCol, resultadoAlvo] of Object.entries(MERCADOS_1X2)) {

        const bruto = jogoRow[pCol];
        const previsaoAtual = (bruto === null || bruto === undefined) ? null : Number(bruto);
        if (previsaoAtual === null || previsaoAtual < 50) continue;

        const r = await avaliarMercado1x2(client, {
            idTimeCasa,
            estiloAlvo: estiloVisitante,
            dataLimite,
            pCol,
            resultadoAlvo,
            previsaoAtual,
            limiteAcerto,
            amostraMinima
        });

        if (r) resultados.push(r);
    }

    resultados.sort((a, b) => (b.entraMultipla - a.entraMultipla) || (b.taxa - a.taxa));

    return { estiloVisitante, resultados };
}


/*
 * ================================================================
 * 6. MONTA AS DUAS MÚLTIPLAS DE UM DIA
 * ================================================================
 *
 * MÚLTIPLA 1 (conservadora): só mercados com taxa de acerto no
 * contexto >= limiteConservador (padrão 85%).
 *
 * MÚLTIPLA 2 (moderada): todos os mercados que passaram no filtro
 * padrão (>= limiteAcerto, padrão 70%) — inclui os da conservadora.
 */

async function montarMultiplasDoDia(jogosDoDia, client, mapaMercados, opts = {}) {

    const limiteConservador = opts.limiteConservador ?? 85;
    const limiteAcerto = opts.limiteAcerto ?? 70;
    const amostraMinima = opts.amostraMinima ?? 8;
    const maxMercadosPorJogo = opts.maxMercadosPorJogo ?? 1;

    const linhas = [];

    for (const jogo of jogosDoDia) {

        console.log(`  Analisando: ${jogo.nome_time_casa} x ${jogo.nome_time_fora}`);

        const { estiloVisitante, resultados } = await analisarJogo(
            jogo, client, mapaMercados, { limiteAcerto, amostraMinima }
        );

        const aprovados = resultados
            .filter(r => r.entraMultipla)
            .slice(0, maxMercadosPorJogo);

        for (const r of aprovados) {
            linhas.push({
                jogo: `${jogo.nome_time_casa} x ${jogo.nome_time_fora}`,
                estiloAdversario: estiloVisitante,
                mercado: r.mercado,
                previsaoRobo: r.previsaoAtual,
                amostraHistorica: r.amostra,
                green: r.green,
                red: r.red,
                taxaAcertoContexto: r.taxa
            });
        }
    }

    const multipla2Moderada = linhas;
    const multipla1Conservadora = linhas.filter(l => l.taxaAcertoContexto >= limiteConservador);

    return { multipla1Conservadora, multipla2Moderada };
}


/*
 * ================================================================
 * 7. LOOP PRINCIPAL: DIA A DIA, DE dataInicio ATÉ dataFim
 * ================================================================
 */

function formatarData(date) {
    return date.toISOString().slice(0, 10);
}

function proximoDia(date) {
    const d = new Date(date);
    d.setUTCDate(d.getUTCDate() + 1);
    return d;
}

async function rodarMultiplaDiaria(dataInicio, dataFim, client, opts = {}) {

    const mapaMercados = await montarMapaMercados(client);

    let dataAtual = new Date(`${dataInicio}T00:00:00Z`);
    const dataFinal = new Date(`${dataFim}T00:00:00Z`);

    while (dataAtual <= dataFinal) {

        const dataStr = formatarData(dataAtual);

        console.log(`\n============================================================`);
        console.log(`DATA: ${dataStr}`);
        console.log(`============================================================`);

        const { rows: jogosDoDia } = await client.query(`
            SELECT *
            FROM analises_jogos_backup
            WHERE data_jogo = $1::date
            ORDER BY hora_jogo ASC
        `, [dataStr]);

        if (jogosDoDia.length === 0) {
            console.log('Nenhum jogo encontrado nessa data.');
            dataAtual = proximoDia(dataAtual);
            continue;
        }

        console.log(`${jogosDoDia.length} jogo(s) encontrado(s).\n`);

        const { multipla1Conservadora, multipla2Moderada } =
            await montarMultiplasDoDia(jogosDoDia, client, mapaMercados, opts);

        console.log(`\n--- MÚLTIPLA 1 (CONSERVADORA, >= ${opts.limiteConservador ?? 85}%) ---`);
        if (multipla1Conservadora.length) {
            console.table(multipla1Conservadora);
        } else {
            console.log('Nenhum mercado qualificado.');
        }

        console.log(`\n--- MÚLTIPLA 2 (MODERADA, >= ${opts.limiteAcerto ?? 70}%) ---`);
        if (multipla2Moderada.length) {
            console.table(multipla2Moderada);
        } else {
            console.log('Nenhum mercado qualificado.');
        }

        /*
         * ============================================================
         * AQUI ENTRARIA A GRAVAÇÃO (INSERT/UPDATE) — DE PROPÓSITO
         * DESLIGADA POR ENQUANTO. Só ativar depois de validar os
         * resultados acima em cima de um período maior.
         * ============================================================
         */

        dataAtual = proximoDia(dataAtual);
    }
}


module.exports = {
    montarMapaMercados,
    estiloDoTime,
    avaliarMercado,
    avaliarMercado1x2,
    analisarJogo,
    montarMultiplasDoDia,
    rodarMultiplaDiaria
};


/*
 * ================================================================
 * EXECUÇÃO DIRETA
 * ================================================================
 *
 * Ajusta dataInicio/dataFim aqui embaixo.
 */

if (require.main === module) {

    (async () => {

        try {

            await client.connect();

            await rodarMultiplaDiaria(
                '2024-06-02',
                '2025-05-15',
                client,
                {
                    limiteConservador: 85,
                    limiteAcerto: 70,
                    amostraMinima: 8,
                    maxMercadosPorJogo: 1
                }
            );

            console.log('\nProcessamento concluído.');

        } catch (error) {

            console.error('Erro ao montar múltiplas diárias:', error);

        } finally {

            await client.end();
        }
    })();
}