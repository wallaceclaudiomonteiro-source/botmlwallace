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

// ==========================================
// 🌐 CONFIGURAÇÃO DO PROXY RESIDENCIAL
// Se for rodar hoje sem proxy, deixe o PROXY_SERVER vazio ('').
// Quando comprar o proxy, preencha as aspas abaixo com os dados que a empresa te der.
// ==========================================
const PROXY_SERVER = ''; // Ex: 'http://gate.smartproxy.com:7000'
const PROXY_USER = '';   // Ex: 'usuario123'
const PROXY_PASS = '';   // Ex: 'senha123'
const FUSO_HORARIO = 'Europe/Lisbon'; 
// ==========================================

async function extrairLinksBetano() {
    let browser;

    try {
        await client.connect();
        console.log(`📦 Conectado ao banco de dados.`);
        
        // Configura os argumentos do navegador. Só injeta o proxy se você tiver preenchido lá em cima.
        const argsNavegador = [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--start-maximized',
            '--disable-blink-features=AutomationControlled'
        ];
        
        if (PROXY_SERVER) {
            argsNavegador.push(`--proxy-server=${PROXY_SERVER}`);
            console.log(`🚀 Iniciando navegador MASCARADO com IP estrangeiro...`);
        } else {
            console.log(`🚀 Iniciando navegador com sua conexão LOCAL (Brasil)...`);
        }

        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: argsNavegador
        });

        const page = await browser.newPage();

        // Só tenta autenticar o proxy e mudar o fuso horário se o proxy estiver ativado
        if (PROXY_SERVER && PROXY_USER && PROXY_PASS) {
            await page.authenticate({ username: PROXY_USER, password: PROXY_PASS });
            await page.emulateTimezone(FUSO_HORARIO);
            await page.setExtraHTTPHeaders({ 
                'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7' 
            });
        }

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (['font'].includes(req.resourceType()) || url.includes('google-analytics')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Link configurado especificamente para os jogos de SÁBADO
        const urlAlvo = 'https://www.betano.pt/upcomingcoupon/?sid=FOOT&day=Saturday';
        
        console.log(`\n=====================================================`);
        console.log(`🔎 Acessando: ${urlAlvo}`);

        await page.goto(urlAlvo, { waitUntil: 'networkidle2', timeout: 90000 }); 

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

                // 2. EXTRAÇÃO DA DATA E HORA
                let dataJogo = '';
                let horaJogo = '';
                
                const card = linkEl.closest('[data-qa="event-card"]');
                if (card) {
                    const spans = card.querySelectorAll('span');
                    
                    for (const span of spans) {
                        const texto = span.textContent.trim();

                        if (/^\d{2}\/\d{2}$/.test(texto)) {
                            dataJogo = texto;
                        }
                        else if (/^\d{2}:\d{2}$/.test(texto)) {
                            horaJogo = texto;
                        }
                        else if (texto.toLowerCase() === 'hoje' || texto.toLowerCase() === 'today') {
                            const hoje = new Date();
                            const dia = String(hoje.getDate()).padStart(2, '0');
                            const mes = String(hoje.getMonth() + 1).padStart(2, '0');
                            dataJogo = `${dia}/${mes}`;
                        }
                        else if (texto.toLowerCase() === 'amanhã' || texto.toLowerCase() === 'amanha' || texto.toLowerCase() === 'tomorrow') {
                            const amanha = new Date();
                            amanha.setDate(amanha.getDate() + 1);
                            const dia = String(amanha.getDate()).padStart(2, '0');
                            const mes = String(amanha.getMonth() + 1).padStart(2, '0');
                            dataJogo = `${dia}/${mes}`;
                        }
                    }

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