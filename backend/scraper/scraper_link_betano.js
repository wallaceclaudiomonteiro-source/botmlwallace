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

async function extrairLinksBetano() {
    let browser;

    try {
        await client.connect();
        console.log(`📦 Conectado ao banco de dados.`);
        console.log(`🚀 Iniciando navegador para capturar dados completos da Betano...`);

        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
        });

        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (['font'].includes(req.resourceType()) || url.includes('google-analytics')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        const urlAlvo = 'https://www.betano.bet.br/upcomingcoupon/?sid=FOOT&day=Friday';
        
        console.log(`\n=====================================================`);
        console.log(`🔎 Acessando: ${urlAlvo}`);

        await page.goto(urlAlvo, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log(`\n⚠️  PÁGINA CARREGADA.`);
        console.log(`⚠️  Vá para a janela do Chrome e role a tela até o final (scroll) para carregar todos os jogos.`);
        
        await perguntar('👉 Pressione [ENTER] no terminal quando tiver carregado tudo... ');

        console.log('⚙️  Extraindo dados das partidas (Times, Data, Hora e Link)...');

        const dadosExtraidos = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[data-qa="pre-event"]'));
            let resultados = [];

            anchors.forEach(linkEl => {
                const url = linkEl.href.split('?')[0]; 
                if (url.includes('/outrights/')) return; 

                // 1. EXTRAÇÃO DOS TIMES
                let home = '';
                let away = '';
                const testId = linkEl.getAttribute('data-testid');
                
                if (testId && testId.includes(' - ')) {
                    const partes = testId.split(' - ');
                    home = partes[0].trim();
                    away = partes[1].trim();
                } else {
                    const timesEl = linkEl.querySelectorAll('.tw-truncate');
                    if (timesEl.length >= 2) {
                        home = timesEl[0].textContent.trim();
                        away = timesEl[1].textContent.trim();
                    }
                }

                // 2. EXTRAÇÃO DA DATA E HORA (Nova lógica 100% blindada via Regex)
                let dataJogo = '';
                let horaJogo = '';
                
                const card = linkEl.closest('[data-qa="event-card"]');
                if (card) {
                    // Pega TODOS os spans dentro da caixa da partida
                    const spans = card.querySelectorAll('span');
                    
                    for (const span of spans) {
                        const texto = span.textContent.trim();

                        // Regex: Procura o formato exato de 2 dígitos, barra, 2 dígitos (ex: 25/09)
                        if (/^\d{2}\/\d{2}$/.test(texto)) {
                            dataJogo = texto;
                        }
                        // Regex: Procura o formato exato de 2 dígitos, dois pontos, 2 dígitos (ex: 10:30)
                        else if (/^\d{2}:\d{2}$/.test(texto)) {
                            horaJogo = texto;
                        }
                        // Tratamento para quando está escrito "Hoje"
                        else if (texto.toLowerCase() === 'hoje') {
                            const hoje = new Date();
                            const dia = String(hoje.getDate()).padStart(2, '0');
                            const mes = String(hoje.getMonth() + 1).padStart(2, '0');
                            dataJogo = `${dia}/${mes}`;
                        }
                        // Tratamento para quando está escrito "Amanhã"
                        else if (texto.toLowerCase() === 'amanhã' || texto.toLowerCase() === 'amanha') {
                            const amanha = new Date();
                            amanha.setDate(amanha.getDate() + 1);
                            const dia = String(amanha.getDate()).padStart(2, '0');
                            const mes = String(amanha.getMonth() + 1).padStart(2, '0');
                            dataJogo = `${dia}/${mes}`;
                        }
                    }

                    // Fallback de segurança: Se a Betano mostrar a hora mas ocultar a data pro dia de hoje
                    if (!dataJogo && horaJogo) {
                        const hoje = new Date();
                        const dia = String(hoje.getDate()).padStart(2, '0');
                        const mes = String(hoje.getMonth() + 1).padStart(2, '0');
                        dataJogo = `${dia}/${mes}`;
                    }
                }

                if (home && away) {
                    resultados.push({ home, away, dataJogo, horaJogo, url });
                }
            });

            // Remove duplicatas exatas de URL
            const unicos = [];
            const urlsVistas = new Set();
            for (const item of resultados) {
                if (!urlsVistas.has(item.url)) {
                    urlsVistas.add(item.url);
                    unicos.push(item);
                }
            }

            return unicos;
        });

        if (dadosExtraidos.length === 0) {
            console.log(`⚠️ Nenhum jogo foi encontrado. Certifique-se de que rolou a tela até o fim.`);
        } else {
            console.log(`\n✅ Sucesso! ${dadosExtraidos.length} jogos capturados.`);
            console.log(`💾 Salvando Data, Hora, Times e Link no banco de dados...`);
            
            for (const jogo of dadosExtraidos) {
                await client.query(`
                    INSERT INTO betano_jogos_diarios 
                    (nome_time_casa, nome_time_fora, data_jogo, hora_jogo, link_betano) 
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (link_betano) DO UPDATE SET
                        nome_time_casa = EXCLUDED.nome_time_casa,
                        nome_time_fora = EXCLUDED.nome_time_fora,
                        data_jogo = EXCLUDED.data_jogo,
                        hora_jogo = EXCLUDED.hora_jogo
                `, [jogo.home, jogo.away, jogo.dataJogo, jogo.horaJogo, jogo.url]);
            }
            console.log(`✅ Todos os dados foram gravados na tabela "betano_jogos_diarios" com sucesso!`);
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

extrairLinksBetano();