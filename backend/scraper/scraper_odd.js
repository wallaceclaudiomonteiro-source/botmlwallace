const { criarClient } = require('../../db');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const readline = require('readline'); 

puppeteer.use(StealthPlugin());
const client = criarClient('modelo');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});
const perguntar = (query) => new Promise(resolve => rl.question(query, resolve));

const parseOdd = (titleAttr, spanText) => {
    const fechamento = parseFloat(spanText);
    if (!titleAttr || !titleAttr.includes('»')) {
        return { abertura: fechamento, fechamento: fechamento };
    }
    const abertura = parseFloat(titleAttr.split('»')[0].trim());
    return { abertura, fechamento };
};

// 🎯 LISTA COMPLETA DE MERCADOS
const mercados = [
    { id: '1x2', urlSuffix: '/odds/1x2-odds/tempo-regulamentar/?mid=' },
    { id: 'dc', urlSuffix: '/odds/double-chance/tempo-regulamentar/?mid=' },
    { id: 'btts', urlSuffix: '/odds/ambos-marcam/tempo-regulamentar/?mid=' },
    { id: 'ou', urlSuffix: '/odds/acima-abaixo/tempo-regulamentar/?mid=' }
];

async function iniciarScraper() {
    let browser;

    try {
        await client.connect();
        console.log('📦 Conectado ao banco de dados.');

        const { rows: jogos } = await client.query(`
            SELECT flashscore_id, url 
            FROM calendario 
            WHERE odd_coletada = 0
        `);

        if (jogos.length === 0) {
            console.log('✅ Nenhum jogo pendente para coletar odds.');
            rl.close();
            return;
        }

        console.log(`🚀 Iniciando coleta para ${jogos.length} jogos (Lote de ${mercados.length} mercados por jogo)...`);

        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
        });

        const page = await browser.newPage();
        let primeiraExecucao = true;

        for (const jogo of jogos) {
            const { flashscore_id, url } = jogo;
            
            console.log(`\n=====================================================`);
            console.log(`⚽ JOGO: ${flashscore_id}`);
            
            // Objeto que vai acumular as odds de todos os mercados deste jogo
            let dbData = { flashscore_id };
            let mercadosSalvosNoJogo = 0;

            for (const mercado of mercados) {
                const targetUrl = url.replace('/?mid=', mercado.urlSuffix);
                console.log(` ↳ 🔎 Buscando mercado [${mercado.id.toUpperCase()}]...`);

                try {
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

                    // Pausa manual apenas na primeira aba da rotina inteira
                    if (primeiraExecucao) {
                        console.log(`\n⚠️  PRIMEIRA EXECUÇÃO: Vá para a janela do Chrome.`);
                        console.log(`⚠️  Feche os avisos (18+, cookies) e verifique a tabela.`);
                        await perguntar('👉 Pressione [ENTER] no terminal para ativar o PILOTO AUTOMÁTICO... ');
                        primeiraExecucao = false; 
                    }
                    
                    await page.waitForSelector('.ui-table__row', { timeout: 8000 });

                    // Coleta todas as linhas válidas do mercado atual
                    const oddsData = await page.evaluate(() => {
                        const rows = document.querySelectorAll('.ui-table__row');
                        let results = [];
                        
                        for (const row of rows) {
                            // Captura a linha de total (Ex: 1.5, 2.5) para o mercado Acima/Abaixo
                            const totalEl = row.querySelector('span[data-testid="wcl-oddsValue"]');
                            const total = totalEl ? totalEl.innerText.trim() : null;
                            
                            const oddElements = Array.from(row.querySelectorAll('a.oddsCell__odd'));
                            if (oddElements.length === 0) continue;
                            
                            let rowOdds = [];
                            let hasEmpty = false;
                            
                            for (const el of oddElements) {
                                const title = el.getAttribute('title') || '';
                                const text = el.querySelector('span')?.innerText || '';
                                
                                if (!text || text.trim() === '-') {
                                    hasEmpty = true; break;
                                }
                                rowOdds.push({ title, text });
                            }
                            
                            // Se a linha tiver as cotações preenchidas, guarda no resultado
                            if (!hasEmpty && (rowOdds.length === 2 || rowOdds.length === 3)) {
                                results.push({ total, odds: rowOdds });
                            }
                        }
                        return results;
                    });

                    if (!oddsData || oddsData.length === 0) {
                        throw new Error(`Sem cotações disponíveis.`);
                    }

                    // ASSOCIA OS DADOS AO OBJETO DO BANCO
                    if (mercado.id === '1x2') {
                        const row = oddsData[0].odds;
                        if (row.length === 3) {
                            const home = parseOdd(row[0].title, row[0].text);
                            const draw = parseOdd(row[1].title, row[1].text);
                            const away = parseOdd(row[2].title, row[2].text);
                            Object.assign(dbData, {
                                home_abertura: home.abertura, home_fechamento: home.fechamento,
                                draw_abertura: draw.abertura, draw_fechamento: draw.fechamento,
                                away_abertura: away.abertura, away_fechamento: away.fechamento
                            });
                        }
                    } else if (mercado.id === 'dc') {
                        const row = oddsData[0].odds;
                        if (row.length === 3) {
                            const dc1x = parseOdd(row[0].title, row[0].text);
                            const dc12 = parseOdd(row[1].title, row[1].text);
                            const dcx2 = parseOdd(row[2].title, row[2].text);
                            Object.assign(dbData, {
                                dc_1x_abertura: dc1x.abertura, dc_1x_fechamento: dc1x.fechamento,
                                dc_12_abertura: dc12.abertura, dc_12_fechamento: dc12.fechamento,
                                dc_x2_abertura: dcx2.abertura, dc_x2_fechamento: dcx2.fechamento
                            });
                        }
                    } else if (mercado.id === 'btts') {
                        const row = oddsData[0].odds;
                        if (row.length === 2) {
                            const sim = parseOdd(row[0].title, row[0].text);
                            const nao = parseOdd(row[1].title, row[1].text);
                            Object.assign(dbData, {
                                btts_sim_abertura: sim.abertura, btts_sim_fechamento: sim.fechamento,
                                btts_nao_abertura: nao.abertura, btts_nao_fechamento: nao.fechamento
                            });
                        }
                    } else if (mercado.id === 'ou') {
                        // Busca a primeira casa de apostas que tenha a linha 1.5
                        const row15 = oddsData.find(r => r.total === '1.5');
                        if (row15 && row15.odds.length === 2) {
                            const over = parseOdd(row15.odds[0].title, row15.odds[0].text);
                            const under = parseOdd(row15.odds[1].title, row15.odds[1].text);
                            Object.assign(dbData, {
                                over_15_abertura: over.abertura, over_15_fechamento: over.fechamento,
                                under_15_abertura: under.abertura, under_15_fechamento: under.fechamento
                            });
                        }
                        // Busca a primeira casa de apostas que tenha a linha 2.5
                        const row25 = oddsData.find(r => r.total === '2.5');
                        if (row25 && row25.odds.length === 2) {
                            const over = parseOdd(row25.odds[0].title, row25.odds[0].text);
                            const under = parseOdd(row25.odds[1].title, row25.odds[1].text);
                            Object.assign(dbData, {
                                over_25_abertura: over.abertura, over_25_fechamento: over.fechamento,
                                under_25_abertura: under.abertura, under_25_fechamento: under.fechamento
                            });
                        }
                    }

                    console.log(`    ✅ ${mercado.id.toUpperCase()} guardado na memória.`);
                    mercadosSalvosNoJogo++;

                } catch (error) {
                    console.log(`    ⚠️  Falha ao coletar ${mercado.id.toUpperCase()}: ${error.message}`);
                }
            } 

            // INSERÇÃO FINAL NO BANCO DE DADOS (Apenas uma vez por jogo)
            if (Object.keys(dbData).length > 1) { // Verifica se há mais dados além do flashscore_id
                const columns = Object.keys(dbData);
                const values = Object.values(dbData);
                const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
                
                // Constrói o ON CONFLICT dinamicamente (ignora o id)
                const setClause = columns
                    .filter(col => col !== 'flashscore_id')
                    .map(col => `${col} = EXCLUDED.${col}`)
                    .join(', ');

                await client.query(`
                    INSERT INTO odds_partidas (${columns.join(', ')}) 
                    VALUES (${placeholders})
                    ON CONFLICT (flashscore_id) DO UPDATE SET 
                    ${setClause}
                `, values);

                await client.query('UPDATE calendario SET odd_coletada = 1 WHERE flashscore_id = $1', [flashscore_id]);
                console.log(`🟢 Status do Jogo atualizado: SUCESSO (${mercadosSalvosNoJogo}/${mercados.length} mercados salvos)`);
            } else {
                await client.query('UPDATE calendario SET odd_coletada = 2 WHERE flashscore_id = $1', [flashscore_id]);
                console.log(`🔴 Status do Jogo atualizado: ERRO (Nenhum mercado válido encontrado)`);
            }
        } 

    } catch (err) {
        console.error('🚨 Erro crítico na execução:', err);
    } finally {
        if (browser) await browser.close();
        await client.end();
        rl.close(); 
        console.log('\n🏁 Processo finalizado.');
    }
}

iniciarScraper();