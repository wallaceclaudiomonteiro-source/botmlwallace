const { criarClient } = require('./db');

/*
 * ================================================================
 * ATENÇÃO
 * ================================================================
 *
 * Assumindo que `analises_jogo` e `perfil_times` vivem no mesmo
 * banco 'modelo' usado pelo backtestMle.js. Se `perfil_times`
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
 * Tratados como mercado TOTAL (dependem dos dois times), usando
 * `res_match_odds` (texto "CASA"/"EMPATE"/"FORA") em vez de
 * GREEN/RED.
 */

const MERCADOS_1X2 = {
    p_home: 'CASA',
    p_draw: 'EMPATE',
    p_away: 'FORA'
};


/*
 * ================================================================
 * 1. DESCOBRE O MAPA p_... -> res_... A PARTIR DAS COLUNAS REAIS
 *    DA TABELA analises_jogo
 * ================================================================
 */

async function montarMapaMercados(client) {

    const { rows } = await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'analises_jogo'
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
 * 2. CLASSIFICA O MERCADO: INDIVIDUAL (de um time só) OU TOTAL
 *    (depende dos dois times)
 * ================================================================
 *
 * p_casa_... / p_fora_... -> individual (gols, cantos ou cartões
 * de um time específico).
 * Qualquer outro (over/under geral, cartões totais, cantos
 * totais, BTTS) -> total. O 1X2 também é tratado como total.
 */

function classificarMercado(pCol) {
    if (pCol.startsWith('p_casa_')) return 'individual_casa';
    if (pCol.startsWith('p_fora_')) return 'individual_fora';
    return 'total';
}


/*
 * ================================================================
 * 3. ESTILO DO TIME (casa ou fora) NA TABELA perfil_times
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
 * 4. ÚLTIMOS N JOGOS DE UM TIME CONTRA ADVERSÁRIOS DE UM ESTILO
 * ================================================================
 *
 * mando = 'casa'  -> idTime jogando em casa; olha o estilo do
 *                    adversário quando ele joga FORA
 *                    (estilo_posse_fora do adversário)
 * mando = 'fora'  -> idTime jogando fora; olha o estilo do
 *                    adversário quando ele joga EM CASA
 *                    (estilo_posse_casa do adversário)
 *
 * Busca só jogos com data_jogo < dataLimite (sem olhar o futuro),
 * ordenado do mais recente pro mais antigo, limitado a `limite`
 * jogos (padrão 10). Traz a linha inteira (aj.*) porque depois
 * vamos calcular a taxa de VÁRIOS mercados em cima desse mesmo
 * conjunto de jogos, sem precisar de uma query por mercado.
 */

async function ultimosJogosVsEstilo(client, { idTime, mando, estiloAdversario, dataLimite, limite = 10 }) {

    const colTime = mando === 'casa' ? 'id_time_casa' : 'id_time_fora';
    const colAdversario = mando === 'casa' ? 'id_time_fora' : 'id_time_casa';
    const colEstiloAdversario = mando === 'casa' ? 'estilo_posse_fora' : 'estilo_posse_casa';

    const { rows } = await client.query(`
        SELECT aj.*
        FROM analises_jogo aj
        INNER JOIN perfil_times pt
            ON pt.id_time = aj.${colAdversario}
        WHERE aj.${colTime} = $1
          AND pt.${colEstiloAdversario} = $2
          AND aj.data_jogo < $3::date
        ORDER BY aj.data_jogo DESC
        LIMIT $4
    `, [idTime, estiloAdversario, dataLimite, limite]);

    return rows;
}


/*
 * ================================================================
 * 5. TAXA DE ACERTO DE UM MERCADO DENTRO DE UM POÇO DE JOGOS
 *    (cálculo em JS, sem ir de novo ao banco)
 * ================================================================
 *
 * Dentro do poço (até 10 jogos), filtra só os jogos em que o
 * robô TAMBÉM tinha dado >= 50% pra esse mercado, e calcula
 * green/total sobre esse subconjunto.
 */

function taxaMercadoNoPoco(pool, pCol, resCol) {

    const elegiveis = pool.filter(row => {
        const p = row[pCol];
        return p !== null && p !== undefined && Number(p) >= 50 && row[resCol] !== null;
    });

    const amostra = elegiveis.length;
    if (amostra === 0) return null;

    const green = elegiveis.filter(row => row[resCol] === 'GREEN').length;

    return {
        amostra,
        green,
        red: amostra - green,
        taxa: Number(((green / amostra) * 100).toFixed(1))
    };
}

function taxaMercado1x2NoPoco(pool, pCol, resultadoAlvo) {

    const elegiveis = pool.filter(row => {
        const p = row[pCol];
        return p !== null && p !== undefined && Number(p) >= 50 && row.res_match_odds !== null;
    });

    const amostra = elegiveis.length;
    if (amostra === 0) return null;

    const acertos = elegiveis.filter(row => row.res_match_odds === resultadoAlvo).length;

    return {
        amostra,
        green: acertos,
        red: amostra - acertos,
        taxa: Number(((acertos / amostra) * 100).toFixed(1))
    };
}


/*
 * ================================================================
 * 6. ANALISA UM JOGO DA VITRINE (analises_jogo) E DEVOLVE TODOS
 *    OS MERCADOS APROVADOS PRA MÚLTIPLA
 * ================================================================
 *
 * jogoRow = a linha do jogo (id_time_casa = A, id_time_fora = B),
 * já com as previsões do robô (p_...) preenchidas.
 *
 * Regras:
 *  - só entra na disputa mercado com previsão >= 50% NESSE jogo
 *  - o poço de histórico é sempre filtrado por perfil do adversário
 *    (nunca "jogos gerais"), limitado aos `janelaJogos` mais
 *    recentes (padrão 15)
 *  - CORTE POR JOGO (não por mercado): se o poço de A OU o poço de
 *    B tiver menos que `amostraMinima` jogos (padrão 6), o JOGO
 *    INTEIRO é descartado — nenhum mercado dele entra na múltipla,
 *    nem individual nem total. Os dois times precisam ter base
 *    histórica suficiente pro jogo ser avaliado.
 *  - passado esse corte: individual (casa_X / fora_X) só precisa
 *    bater >= limiteAcerto no poço do time dono do mercado; total
 *    (o resto + 1X2) precisa bater >= limiteAcerto NOS DOIS poços
 */

async function analisarJogoVitrine(jogoRow, client, mapaMercados, opts = {}) {

    const limiteAcerto = opts.limiteAcerto ?? 65;
    const janelaJogos = opts.janelaJogos ?? 15;
    const amostraMinima = opts.amostraMinima ?? 6; // exigência dura: abaixo disso, mercado é descartado

    const idTimeA = jogoRow.id_time_casa;
    const idTimeB = jogoRow.id_time_fora;
    const dataLimite = jogoRow.data_jogo;

    const estiloA = await estiloDoTime(idTimeA, 'casa', client);
    const estiloB = await estiloDoTime(idTimeB, 'fora', client);

    if (!estiloA || !estiloB) {
        console.log(
            `  [AVISO] Sem perfil completo (A='${jogoRow.nome_time_casa}', B='${jogoRow.nome_time_fora}') — pulando jogo.`
        );
        return { aprovados: [] };
    }

    const poolA = await ultimosJogosVsEstilo(client, {
        idTime: idTimeA, mando: 'casa', estiloAdversario: estiloB, dataLimite, limite: janelaJogos
    });

    const poolB = await ultimosJogosVsEstilo(client, {
        idTime: idTimeB, mando: 'fora', estiloAdversario: estiloA, dataLimite, limite: janelaJogos
    });

    console.log(
        `  ${jogoRow.nome_time_casa} (${estiloA}) x ${jogoRow.nome_time_fora} (${estiloB}) — ` +
        `poço A: ${poolA.length} jogo(s) | poço B: ${poolB.length} jogo(s)`
    );

    // ---- corte por jogo: os DOIS times precisam ter pelo menos amostraMinima
    // jogos no poço (contra o mesmo perfil de adversário). Se qualquer um dos
    // dois não tiver, o jogo INTEIRO é descartado — nenhum mercado dele entra
    // na múltipla, nem individual nem total.
    if (poolA.length < amostraMinima || poolB.length < amostraMinima) {
        console.log(
            `    [DESCARTADO] jogo inteiro: poço A=${poolA.length}, poço B=${poolB.length} ` +
            `(mínimo exigido para os dois: ${amostraMinima}).`
        );
        return { estiloA, estiloB, aprovados: [] };
    }

    const aprovados = [];

    // ---- mercados normais (individual ou total) ----
    for (const [pCol, resCol] of Object.entries(mapaMercados)) {

        const bruto = jogoRow[pCol];
        const previsaoAtual = (bruto === null || bruto === undefined) ? null : Number(bruto);
        if (previsaoAtual === null || previsaoAtual < 50) continue;

        const tipo = classificarMercado(pCol);

        if (tipo === 'individual_casa') {

            const r = taxaMercadoNoPoco(poolA, pCol, resCol);
            if (!r) continue;

            if (r.taxa >= limiteAcerto) {
                aprovados.push({
                    mercado: pCol, tipo, previsaoAtual,
                    contexto: 'Time A (casa)',
                    amostra: r.amostra, green: r.green, red: r.red, taxa: r.taxa
                });
            }

        } else if (tipo === 'individual_fora') {

            const r = taxaMercadoNoPoco(poolB, pCol, resCol);
            if (!r) continue;

            if (r.taxa >= limiteAcerto) {
                aprovados.push({
                    mercado: pCol, tipo, previsaoAtual,
                    contexto: 'Time B (fora)',
                    amostra: r.amostra, green: r.green, red: r.red, taxa: r.taxa
                });
            }

        } else { // total -> precisa bater nos dois poços

            const rA = taxaMercadoNoPoco(poolA, pCol, resCol);
            const rB = taxaMercadoNoPoco(poolB, pCol, resCol);
            if (!rA || !rB) continue;

            if (rA.taxa >= limiteAcerto && rB.taxa >= limiteAcerto) {
                aprovados.push({
                    mercado: pCol, tipo, previsaoAtual,
                    contexto: 'Total (A e B)',
                    amostraA: rA.amostra, taxaA: rA.taxa,
                    amostraB: rB.amostra, taxaB: rB.taxa
                });
            }
        }
    }

    // ---- 1X2 (sempre total) ----
    for (const [pCol, resultadoAlvo] of Object.entries(MERCADOS_1X2)) {

        const bruto = jogoRow[pCol];
        const previsaoAtual = (bruto === null || bruto === undefined) ? null : Number(bruto);
        if (previsaoAtual === null || previsaoAtual < 50) continue;

        const rA = taxaMercado1x2NoPoco(poolA, pCol, resultadoAlvo);
        const rB = taxaMercado1x2NoPoco(poolB, pCol, resultadoAlvo);
        if (!rA || !rB) continue;

        if (rA.taxa >= limiteAcerto && rB.taxa >= limiteAcerto) {
            aprovados.push({
                mercado: pCol, tipo: 'total', previsaoAtual,
                contexto: 'Total (A e B)',
                amostraA: rA.amostra, taxaA: rA.taxa,
                amostraB: rB.amostra, taxaB: rB.taxa
            });
        }
    }

    return { estiloA, estiloB, aprovados };
}


/*
 * ================================================================
 * 7. MONTA A MÚLTIPLA DE UM DIA (VÁRIOS JOGOS DA VITRINE)
 * ================================================================
 *
 * Um jogo pode contribuir com MAIS de uma perna, se mais de um
 * mercado dele passar no critério.
 */

async function montarMultiplaDoDia(jogosDoDia, client, mapaMercados, opts = {}) {

    const linhas = [];

    for (const jogo of jogosDoDia) {

        const { aprovados } = await analisarJogoVitrine(jogo, client, mapaMercados, opts);

        for (const a of aprovados) {
            linhas.push({
                jogo: `${jogo.nome_time_casa} x ${jogo.nome_time_fora}`,
                mercado: a.mercado,
                tipo: a.tipo,
                previsaoRobo: a.previsaoAtual,
                contexto: a.contexto,
                ...(a.tipo === 'total'
                    ? { amostraA: a.amostraA, taxaA: a.taxaA, amostraB: a.amostraB, taxaB: a.taxaB }
                    : { amostra: a.amostra, green: a.green, red: a.red, taxa: a.taxa })
            });
        }
    }

    return linhas;
}


/*
 * ================================================================
 * 8. LOOP PRINCIPAL: DIA A DIA, DE dataInicio ATÉ dataFim
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

    const limiteAcerto = opts.limiteAcerto ?? 65;
    const janelaJogos = opts.janelaJogos ?? 15;
    const amostraMinima = opts.amostraMinima ?? 6;

    console.log(
        `[CONFIG] limiteAcerto=${limiteAcerto}% | janelaJogos=${janelaJogos} | ` +
        `amostraMinima=${amostraMinima} (corte por jogo, exige nos dois times)`
    );

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
            FROM analises_jogo
            WHERE data_jogo = $1::date
            ORDER BY hora_jogo ASC
        `, [dataStr]);

        if (jogosDoDia.length === 0) {
            console.log('Nenhum jogo encontrado nessa data.');
            dataAtual = proximoDia(dataAtual);
            continue;
        }

        console.log(`${jogosDoDia.length} jogo(s) encontrado(s).\n`);

        const multipla = await montarMultiplaDoDia(jogosDoDia, client, mapaMercados, opts);

        console.log(
            `\n--- MÚLTIPLA DO DIA (limite de acerto >= ${opts.limiteAcerto ?? 65}%, ` +
            `janela de ${opts.janelaJogos ?? 15} jogos, amostra mínima ${opts.amostraMinima ?? 6}) ---`
        );
        if (multipla.length) {
            console.table(multipla);
        } else {
            console.log('Nenhum mercado aprovado nesse dia.');
        }

        /*
         * ============================================================
         * AQUI ENTRARIA A GRAVAÇÃO (INSERT/UPDATE) — DE PROPÓSITO
         * DESLIGADA POR ENQUANTO.
         * ============================================================
         */

        dataAtual = proximoDia(dataAtual);
    }
}


module.exports = {
    montarMapaMercados,
    classificarMercado,
    estiloDoTime,
    ultimosJogosVsEstilo,
    taxaMercadoNoPoco,
    taxaMercado1x2NoPoco,
    analisarJogoVitrine,
    montarMultiplaDoDia,
    rodarMultiplaDiaria
};


/*
 * ================================================================
 * EXECUÇÃO DIRETA
 * ================================================================
 */

if (require.main === module) {

    (async () => {

        try {

            await client.connect();

            await rodarMultiplaDiaria(
                '2026-09-08',
                '2026-09-15',
                client,
                {
                    limiteAcerto: 65,
                    janelaJogos: 15,
                    amostraMinima: 6
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