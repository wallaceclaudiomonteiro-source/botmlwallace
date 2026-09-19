const puppeteer = require('puppeteer');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol',
    max: 20,
    idleTimeoutMillis: 30000,
});

const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function atualizarElencos() {
    const client = await pool.connect();
    let browser;

    try {
        console.log('Buscando times liberados para coleta (elenco_coletado = 5)...');

        const timesResult = await client.query(`
            SELECT 
                id AS time_id, 
                nome AS nome_time, 
                flashscore_id AS flashscore_id_time, 
                url 
            FROM times
            WHERE url IS NOT NULL 
            AND elenco_coletado = 5
            ORDER BY id ASC
        `);

        const times = timesResult.rows;

        if (times.length === 0) {
            console.log('Nenhum time com elenco_coletado = 5 encontrado.');
            return;
        }

        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        for (const time of times) {
            if (!time.url || typeof time.url !== 'string') continue;

            const nomeDoTime = time.nome_time || 'Nome_Desconhecido';
            const baseUrl = time.url.endsWith('/') ? time.url : `${time.url}/`;
            const urlElenco = `${baseUrl}elenco/`;

            console.log(`\n=========================================`);
            console.log(`Acessando o elenco de: ${nomeDoTime}`);
            console.log(`URL: ${urlElenco}`);

            try {
                await page.goto(urlElenco, { waitUntil: 'networkidle2' });

                try {
                    console.log('Aguardando o botão "Total" ser carregado no HTML...');
                    await page.waitForSelector('#overall-all', { timeout: 5000 });

                    await page.evaluate(() => {
                        const botaoTotal = document.querySelector('#overall-all');
                        if (botaoTotal) {
                            botaoTotal.click();
                        }
                    });

                    console.log('Botão "Total" acionado via JS! Aguardando o carregamento dos dados...');
                    await esperar(3000);
                } catch (e) {
                    console.log(`Botão "Total" não encontrado no HTML para ${nomeDoTime}. Extraindo dados disponíveis...`);
                }

                console.log('Extraindo dados do elenco...');
                const dadosElenco = await page.evaluate((dadosDoTime) => {
                    const jogadores = [];
                    const tabelasDePosicao = document.querySelectorAll('.lineupTable--soccer');

                    tabelasDePosicao.forEach(tabela => {
                        if (tabela.offsetParent === null) return;

                        const posicao = tabela.querySelector('.lineupTable__title')?.innerText.trim() || 'Desconhecido';
                        const linhas = tabela.querySelectorAll('.lineupTable__row');

                        linhas.forEach(linha => {
                            if (linha.offsetParent === null) return;

                            const extrairNumero = (seletor) => {
                                const texto = linha.querySelector(seletor)?.innerText.trim();
                                return parseInt(texto, 10) || 0;
                            };

                            const camisa = extrairNumero('.lineupTable__cell--jersey');
                            const pais = linha.querySelector('.lineupTable__cell--flag')?.getAttribute('title') || 'Desconhecido';

                            const elementoNome = linha.querySelector('.lineupTable__cell--name');
                            const nome_jogador = elementoNome?.innerText.trim() || 'Sem Nome';

                            const linkJogador = elementoNome?.getAttribute('href') || '';
                            const partesLink = linkJogador.split('/').filter(Boolean);
                            const jogador_id = partesLink.length > 0 ? partesLink[partesLink.length - 1] : 'sem_id';

                            const iconeLesao = linha.querySelector('.lineupTable__cell--absence');
                            const lesao = iconeLesao ? 1 : 0;

                            const idade = extrairNumero('.lineupTable__cell--age');
                            const partidas = extrairNumero('.lineupTable__cell--matchesPlayed');
                            const minuto = extrairNumero('.lineupTable__cell--minutesPlayed');
                            const gols = extrairNumero('.lineupTable__cell--goal');
                            const assistencias = extrairNumero('.lineupTable__cell--assist');
                            const cartao_amarelo = extrairNumero('.lineupTable__cell--yellowCard');
                            const cartao_vermelho = extrairNumero('.lineupTable__cell--redCard');

                            jogadores.push([
                                jogador_id,
                                dadosDoTime.time_id,
                                dadosDoTime.nome_time,
                                dadosDoTime.flashscore_id_time,
                                posicao,
                                camisa,
                                pais,
                                nome_jogador,
                                lesao,
                                idade,
                                partidas,
                                minuto,
                                gols,
                                assistencias,
                                cartao_amarelo,
                                cartao_vermelho
                            ]);
                        });
                    });

                    return jogadores;
                }, time);

                console.log(`Foram encontrados ${dadosElenco.length} jogadores/técnico visíveis no ${nomeDoTime}. Fazendo upsert no banco...`);

                if (dadosElenco.length > 0) {
                    await client.query('BEGIN');

                    const upsertQuery = `
                        INSERT INTO elenco (
                            jogador_id, time_id, nome_time, flashscore_id_time, posicao, 
                            camisa, pais, nome_jogador, lesao, idade, 
                            partidas, minuto, gols, assistencias, cartao_amarelo, cartao_vermelho
                        ) VALUES (
                            $1, $2, $3, $4, $5, 
                            $6, $7, $8, $9, $10, 
                            $11, $12, $13, $14, $15, $16
                        )
                        ON CONFLICT (jogador_id) DO UPDATE SET
                            time_id            = EXCLUDED.time_id,
                            nome_time          = EXCLUDED.nome_time,
                            flashscore_id_time = EXCLUDED.flashscore_id_time,
                            posicao            = EXCLUDED.posicao,
                            camisa             = EXCLUDED.camisa,
                            pais               = EXCLUDED.pais,
                            nome_jogador       = EXCLUDED.nome_jogador,
                            lesao              = EXCLUDED.lesao,
                            idade              = EXCLUDED.idade,
                            partidas           = EXCLUDED.partidas,
                            minuto             = EXCLUDED.minuto,
                            gols               = EXCLUDED.gols,
                            assistencias       = EXCLUDED.assistencias,
                            cartao_amarelo     = EXCLUDED.cartao_amarelo,
                            cartao_vermelho    = EXCLUDED.cartao_vermelho
                    `;

                    for (const jogador of dadosElenco) {
                        await client.query(upsertQuery, jogador);
                    }

                    await client.query('COMMIT');

                    await client.query('UPDATE times SET elenco_coletado = 1 WHERE id = $1', [time.time_id]);
                    console.log(`Elenco do ${nomeDoTime} salvo com sucesso! Status atualizado para 1.`);

                } else {
                    console.log(`Nenhum jogador encontrado para o ${nomeDoTime}. Atualizando status para 2.`);
                    await client.query('UPDATE times SET elenco_coletado = 2 WHERE id = $1', [time.time_id]);
                }

            } catch (erroDoTime) {
                console.error(`Erro ao processar o time ${nomeDoTime}:`, erroDoTime.message);

                try { await client.query('ROLLBACK'); } catch (e) { }

                await client.query('UPDATE times SET elenco_coletado = 2 WHERE id = $1', [time.time_id]);
                console.log(`Status do time ${nomeDoTime} atualizado para 2 devido a falha.`);
            }
        }

    } catch (erroGeral) {
        console.error('Erro fatal na inicialização ou conexão do banco:', erroGeral);
    } finally {
        if (browser) await browser.close();
        client.release();
        pool.end();
        console.log('Processo finalizado.');
    }
}

atualizarElencos();