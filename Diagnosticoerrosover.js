const { Client } = require('pg');

const client = new Client({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

const IDS_FLAGRADOS = [
    198, 188, 1360, 1513, 163, 1185, 1443, 232, 440, 1462, 441, 667,
    1104, 570, 345, 1504, 828, 1061, 1086, 353, 851, 1521, 404, 1043, 1121
];

const DATA_INICIAL = '2025-01-01';
const DATA_FINAL = '2026-09-02';

const LIMIAR_COBERTURA_BAIXA = 50; // % — abaixo disso, consideramos "sem xG suficiente no momento"

async function verificarCoberturaNoMomentoDoCalculo() {
    console.log(`\n--- COBERTURA DE XG/XGOT NO MOMENTO DO CÁLCULO (por jogo-alvo) ---\n`);

    await client.connect();

    try {
        const { rows: jogosAlvo } = await client.query(`
            SELECT id, data_jogo, id_competicao, nome_competicao, flashscore_id
            FROM jogos
            WHERE id_competicao = ANY($1)
              AND data_jogo::date BETWEEN $2::date AND $3::date
              AND placar_casa IS NOT NULL
              AND placar_fora IS NOT NULL
              AND mle_l_home IS NOT NULL
              AND mle_l_away IS NOT NULL
            ORDER BY id_competicao, data_jogo
        `, [IDS_FLAGRADOS, DATA_INICIAL, DATA_FINAL]);

        console.log(`Jogos-alvo a verificar: ${jogosAlvo.length} (isso roda 1 query por jogo — pode levar um instante)\n`);

        const porCompeticao = new Map();

        let processados = 0;

        for (const alvo of jogosAlvo) {
            const { rows: historico } = await client.query(`
                SELECT sg.xg, sg.xgot
                FROM jogos j
                INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
                WHERE j.id_competicao = $1
                  AND j.data_jogo::date >= $2::date - INTERVAL '1 year'
                  AND j.data_jogo::date < $2::date
                  AND j.placar_casa IS NOT NULL
                  AND j.placar_fora IS NOT NULL
            `, [alvo.id_competicao, alvo.data_jogo]);

            const totalLinhas = historico.length;
            const comXG = historico.filter(r => r.xg !== null && Number(r.xg) > 0).length;
            const comXGOT = historico.filter(r => r.xgot !== null && Number(r.xgot) > 0).length;

            const pctXG = totalLinhas > 0 ? (comXG / totalLinhas) * 100 : 0;
            const pctXGOT = totalLinhas > 0 ? (comXGOT / totalLinhas) * 100 : 0;

            if (!porCompeticao.has(alvo.id_competicao)) {
                porCompeticao.set(alvo.id_competicao, {
                    nome: alvo.nome_competicao,
                    jogosAvaliados: 0,
                    somaPctXG: 0,
                    somaPctXGOT: 0,
                    somaTamanhoPool: 0,
                    jogosComPoolFraco: 0,
                    jogosComPoolVazio: 0
                });
            }

            const stats = porCompeticao.get(alvo.id_competicao);
            stats.jogosAvaliados++;
            stats.somaPctXG += pctXG;
            stats.somaPctXGOT += pctXGOT;
            stats.somaTamanhoPool += totalLinhas;
            if (pctXG < LIMIAR_COBERTURA_BAIXA) stats.jogosComPoolFraco++;
            if (totalLinhas === 0) stats.jogosComPoolVazio++;

            processados++;
            if (processados % 200 === 0) {
                console.log(`... ${processados}/${jogosAlvo.length} jogos processados`);
            }
        }

        console.log('\nRESULTADO — COBERTURA MÉDIA NO POOL DE TREINO USADO PARA CADA JOGO-ALVO');
        console.log('--------------------------------------------------------------------------------------------------');
        console.log(
            'id'.padEnd(6) + 'Competição'.padEnd(24) + 'Jogos'.padEnd(8) +
            'PoolMédio'.padEnd(11) + '%xG médio'.padEnd(11) + '%xGOT médio'.padEnd(13) +
            `<${LIMIAR_COBERTURA_BAIXA}% xG`.padEnd(10) + 'Pool vazio'
        );
        console.log('--------------------------------------------------------------------------------------------------');

        const linhas = Array.from(porCompeticao.entries()).map(([id, s]) => ({
            id,
            nome: s.nome,
            jogosAvaliados: s.jogosAvaliados,
            poolMedio: s.somaTamanhoPool / s.jogosAvaliados,
            pctXGMedio: s.somaPctXG / s.jogosAvaliados,
            pctXGOTMedio: s.somaPctXGOT / s.jogosAvaliados,
            jogosComPoolFraco: s.jogosComPoolFraco,
            jogosComPoolVazio: s.jogosComPoolVazio
        }));

        linhas.sort((a, b) => a.pctXGMedio - b.pctXGMedio);

        for (const l of linhas) {
            console.log(
                String(l.id).padEnd(6) +
                (l.nome || '?').slice(0, 22).padEnd(24) +
                String(l.jogosAvaliados).padEnd(8) +
                l.poolMedio.toFixed(0).padEnd(11) +
                `${l.pctXGMedio.toFixed(1)}%`.padEnd(11) +
                `${l.pctXGOTMedio.toFixed(1)}%`.padEnd(13) +
                `${l.jogosComPoolFraco}`.padEnd(10) +
                `${l.jogosComPoolVazio}`
            );
        }

        console.log('--------------------------------------------------------------------------------------------------\n');
        console.log('Leitura: "%xG médio" é a média, entre todos os jogos-alvo dessa competição, da cobertura de xG');
        console.log(`no pool de histórico usado pra treinar aquele jogo especificamente. "<${LIMIAR_COBERTURA_BAIXA}% xG" conta`);
        console.log('quantos jogos-alvo tiveram pool de treino com cobertura de xG abaixo do limiar — ou seja, foram');
        console.log('calculados majoritariamente no fallback (mais ruidoso), não no canal principal de xG/xGOT.\n');

    } catch (err) {
        console.error('[ERRO]', err);
    } finally {
        await client.end();
    }
}

verificarCoberturaNoMomentoDoCalculo();