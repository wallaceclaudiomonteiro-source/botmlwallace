const { Client } = require('pg');

const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

// Apenas mercados INDIVIDUAIS (Isolados por escopo CASA ou FORA)
const MERCADOS = [
    // --- MERCADOS INDIVIDUAIS DA CASA ---
    { prob: 'p_home', res: 'res_home', nome: 'Back Casa', escopo: 'CASA' },
    { prob: 'p_casa_over05', res: 'res_casa_over05', nome: 'Casa Gols > 0.5', escopo: 'CASA' },
    { prob: 'p_casa_over15', res: 'res_casa_over15', nome: 'Casa Gols > 1.5', escopo: 'CASA' },
    { prob: 'p_casa_cantos_over35', res: 'res_casa_cantos_over35', nome: 'Casa Cantos > 3.5', escopo: 'CASA' },
    { prob: 'p_casa_cantos_over45', res: 'res_casa_cantos_over45', nome: 'Casa Cantos > 4.5', escopo: 'CASA' },
    { prob: 'p_casa_cartoes_over05', res: 'res_casa_cartoes_over05', nome: 'Casa Cartões > 0.5', escopo: 'CASA' },
    { prob: 'p_casa_cartoes_over15', res: 'res_casa_cartoes_over15', nome: 'Casa Cartões > 1.5', escopo: 'CASA' },
    { prob: 'p_casa_cartoes_over25', res: 'res_casa_cartoes_over25', nome: 'Casa Cartões > 2.5', escopo: 'CASA' },

    // --- MERCADOS INDIVIDUAIS DE FORA ---
    { prob: 'p_away', res: 'res_away', nome: 'Back Fora', escopo: 'FORA' },
    { prob: 'p_fora_over05', res: 'res_fora_over05', nome: 'Fora Gols > 0.5', escopo: 'FORA' },
    { prob: 'p_fora_over15', res: 'res_fora_over15', nome: 'Fora Gols > 1.5', escopo: 'FORA' },
    { prob: 'p_fora_cantos_over25', res: 'res_fora_cantos_over25', nome: 'Fora Cantos > 2.5', escopo: 'FORA' },
    { prob: 'p_fora_cantos_over35', res: 'res_fora_cantos_over35', nome: 'Fora Cantos > 3.5', escopo: 'FORA' },
    { prob: 'p_fora_cantos_over45', res: 'res_fora_cantos_over45', nome: 'Fora Cantos > 4.5', escopo: 'FORA' },
    { prob: 'p_fora_cartoes_over05', res: 'res_fora_cartoes_over05', nome: 'Fora Cartões > 0.5', escopo: 'FORA' },
    { prob: 'p_fora_cartoes_over15', res: 'res_fora_cartoes_over15', nome: 'Fora Cartões > 1.5', escopo: 'FORA' },
    { prob: 'p_fora_cartoes_over25', res: 'res_fora_cartoes_over25', nome: 'Fora Cartões > 2.5', escopo: 'FORA' }
];

// Colunas de estatisticas_geral usadas para calcular a mediana geral do time.
// Ajuste aqui se algum nome de coluna não bater com o seu schema real.
const METRICAS_MEDIANA = [
    { col: 'cartoes_amarelos', label: 'Cartões' },
    { col: 'escanteios', label: 'Escanteios' },
    { col: 'posse_bola', label: 'Posse', sufixo: '%' },
    { col: 'cruzamentos_total', label: 'Cruzamentos' },
    { col: 'faltas', label: 'Faltas' },
    { col: 'xg', label: 'xG' },
    { col: 'xgot', label: 'xGOT' }
];

function fmt(v, sufixo = '') {
    if (v === null || v === undefined) return 'N/D';
    return `${Number(v).toFixed(2)}${sufixo}`;
}

// SELECT reaproveitado nas duas queries de mediana geral (uma por time)
const selectMedianas = METRICAS_MEDIANA
    .map(m => `ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY e.${m.col})::numeric, 2) AS mediana_${m.col}`)
    .join(',\n                   ');

function linhaMedianas(row) {
    return METRICAS_MEDIANA
        .map(m => `${m.label} ${fmt(row[`mediana_${m.col}`], m.sufixo)}`)
        .join(' | ');
}

async function rodarAnaliseDiaria(dataAlvo) {
    let dataISO = dataAlvo;
    const partes = dataAlvo.split(/[-/]/);
    if (partes[0].length === 2) {
        dataISO = `${partes[2]}-${partes[1]}-${partes[0]}`;
    }

    console.log(`\n======================================================`);
    console.log(`🚀 INICIANDO RADAR TÁTICO INDIVIDUAL PARA: ${dataISO}`);
    console.log(`======================================================\n`);
    
    await client.connect();

    try {
        const queryJogosDia = `
            SELECT 
                c.nome_time_casa, c.nome_time_fora, 
                c.id_time_casa, c.id_time_fora, c.id_competicao,
                pt_casa.estilo_posse_casa AS perfil_casa,
                pt_fora.estilo_posse_fora AS perfil_fora
            FROM calendario c
            LEFT JOIN perfil_times pt_casa 
              ON c.id_time_casa::text = pt_casa.id_time::text AND c.id_competicao::text = pt_casa.id_competicao::text
            LEFT JOIN perfil_times pt_fora 
              ON c.id_time_fora::text = pt_fora.id_time::text AND c.id_competicao::text = pt_fora.id_competicao::text
            WHERE LEFT(c.data_jogo::text, 10) = $1
        `;
        const { rows: jogos } = await client.query(queryJogosDia, [dataISO]);

        if (jogos.length === 0) {
            console.log("Nenhum jogo encontrado no calendário para esta data.");
            return;
        }

        for (const jogo of jogos) {
            if (!jogo.perfil_casa || !jogo.perfil_fora) continue;

            console.log(`\n⚔️  CONFRONTO: ${jogo.nome_time_casa} (${jogo.perfil_casa}) vs ${jogo.nome_time_fora} (${jogo.perfil_fora})`);

            // Separação restrita: Apenas métricas de CASA para o mandante
            const mercadosCasa = MERCADOS.filter(m => m.escopo === 'CASA');
            const lateralValuesCasa = mercadosCasa.map(m => `('${m.nome}', h.${m.res}, h.${m.prob})`).join(',\n                        ');

            // Separação restrita: Apenas métricas de FORA para o visitante
            const mercadosFora = MERCADOS.filter(m => m.escopo === 'FORA');
            const lateralValuesFora = mercadosFora.map(m => `('${m.nome}', h.${m.res}, h.${m.prob})`).join(',\n                        ');

            if (mercadosCasa.length > 0) {
                const queryCasa = `
                    WITH HistoricoCasa AS (
                        SELECT m.mercado, m.resultado, m.probabilidade
                        FROM analises_jogo h
                        JOIN perfil_times adv 
                          ON h.id_time_fora::text = adv.id_time::text AND h.id_competicao::text = adv.id_competicao::text
                        CROSS JOIN LATERAL (
                            VALUES 
                                ${lateralValuesCasa}
                        ) AS m(mercado, resultado, probabilidade)
                        WHERE h.id_time_casa::text = $1
                          AND adv.estilo_posse_fora = $2
                          AND LEFT(h.data_jogo::text, 10) < $3
                          AND m.resultado IN ('GREEN', 'RED')
                          AND m.probabilidade::numeric > 50
                    )
                    SELECT mercado, COUNT(*) as total,
                           SUM(CASE WHEN resultado = 'GREEN' THEN 1 ELSE 0 END) as greens,
                           ROUND(SUM(CASE WHEN resultado = 'GREEN' THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 2) as acerto
                    FROM HistoricoCasa
                    GROUP BY mercado HAVING COUNT(*) >= 3
                    ORDER BY acerto DESC
                `;
                const resCasa = await client.query(queryCasa, [jogo.id_time_casa, jogo.perfil_fora, dataISO]);

                // Mediana geral do time da casa, calculada sobre TODOS os jogos que
                // se enquadram no mesmo confronto de perfil (mesmo filtro de base
                // usado acima, sem depender de um mercado específico).
                const queryMedianasCasa = `
                    SELECT COUNT(*) AS total_jogos,
                           ${selectMedianas}
                    FROM analises_jogo h
                    JOIN perfil_times adv 
                      ON h.id_time_fora::text = adv.id_time::text AND h.id_competicao::text = adv.id_competicao::text
                    JOIN estatisticas_geral e 
                      ON e.flashscore_id_jogo = h.flashscore_id_jogo
                      AND e.id_time::text = $1
                      AND e.eh_casa = 1
                    WHERE h.id_time_casa::text = $1
                      AND adv.estilo_posse_fora = $2
                      AND LEFT(h.data_jogo::text, 10) < $3
                `;
                const medCasa = (await client.query(queryMedianasCasa, [jogo.id_time_casa, jogo.perfil_fora, dataISO])).rows[0];

                if (resCasa.rows.length > 0) {
                    console.log(`   🏠 Desempenho individual do ${jogo.nome_time_casa} (CASA vs ${jogo.perfil_fora}):`);
                    for (const r of resCasa.rows) {
                        const taxa = Number(r.acerto);
                        const icone = taxa >= 75 ? '🎯 EXCELENTE' : (taxa >= 60 ? '✅ BOM' : '❌ FUJA');
                        console.log(`      -> ${r.mercado.padEnd(25)} | Acerto do Modelo: ${taxa.toFixed(1).padStart(5)}% (${r.greens}/${r.total}) | ${icone}`);
                    }
                    if (medCasa && Number(medCasa.total_jogos) > 0) {
                        console.log(`      📊 Medianas gerais (${medCasa.total_jogos} jogos): ${linhaMedianas(medCasa)}`);
                    }
                } else {
                    console.log(`   🏠 Sem histórico individual validado > 50% para ${jogo.nome_time_casa}`);
                }
            }

            if (mercadosFora.length > 0) {
                const queryFora = `
                    WITH HistoricoFora AS (
                        SELECT m.mercado, m.resultado, m.probabilidade
                        FROM analises_jogo h
                        JOIN perfil_times adv 
                          ON h.id_time_casa::text = adv.id_time::text AND h.id_competicao::text = adv.id_competicao::text
                        CROSS JOIN LATERAL (
                            VALUES 
                                ${lateralValuesFora}
                        ) AS m(mercado, resultado, probabilidade)
                        WHERE h.id_time_fora::text = $1
                          AND adv.estilo_posse_casa = $2
                          AND LEFT(h.data_jogo::text, 10) < $3
                          AND m.resultado IN ('GREEN', 'RED')
                          AND m.probabilidade::numeric > 50
                    )
                    SELECT mercado, COUNT(*) as total,
                           SUM(CASE WHEN resultado = 'GREEN' THEN 1 ELSE 0 END) as greens,
                           ROUND(SUM(CASE WHEN resultado = 'GREEN' THEN 1 ELSE 0 END)::numeric / COUNT(*) * 100, 2) as acerto
                    FROM HistoricoFora
                    GROUP BY mercado HAVING COUNT(*) >= 3
                    ORDER BY acerto DESC
                `;
                const resFora = await client.query(queryFora, [jogo.id_time_fora, jogo.perfil_casa, dataISO]);

                // Mediana geral do time visitante, mesmo princípio do lado casa.
                const queryMedianasFora = `
                    SELECT COUNT(*) AS total_jogos,
                           ${selectMedianas}
                    FROM analises_jogo h
                    JOIN perfil_times adv 
                      ON h.id_time_casa::text = adv.id_time::text AND h.id_competicao::text = adv.id_competicao::text
                    JOIN estatisticas_geral e 
                      ON e.flashscore_id_jogo = h.flashscore_id_jogo
                      AND e.id_time::text = $1
                      AND e.eh_casa = 0
                    WHERE h.id_time_fora::text = $1
                      AND adv.estilo_posse_casa = $2
                      AND LEFT(h.data_jogo::text, 10) < $3
                `;
                const medFora = (await client.query(queryMedianasFora, [jogo.id_time_fora, jogo.perfil_casa, dataISO])).rows[0];

                if (resFora.rows.length > 0) {
                    console.log(`   ✈️  Desempenho individual do ${jogo.nome_time_fora} (FORA vs ${jogo.perfil_casa}):`);
                    for (const r of resFora.rows) {
                        const taxa = Number(r.acerto);
                        const icone = taxa >= 75 ? '🎯 EXCELENTE' : (taxa >= 60 ? '✅ BOM' : '❌ FUJA');
                        console.log(`      -> ${r.mercado.padEnd(25)} | Acerto do Modelo: ${taxa.toFixed(1).padStart(5)}% (${r.greens}/${r.total}) | ${icone}`);
                    }
                    if (medFora && Number(medFora.total_jogos) > 0) {
                        console.log(`      📊 Medianas gerais (${medFora.total_jogos} jogos): ${linhaMedianas(medFora)}`);
                    }
                } else {
                    console.log(`   ✈️  Sem histórico individual validado > 50% para ${jogo.nome_time_fora}`);
                }
            }
        }
    } catch (err) {
        console.error("Erro na varredura diária:", err);
    } finally {
        await client.end();
    }
}

rodarAnaliseDiaria('2026-09-14');