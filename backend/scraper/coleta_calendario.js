const puppeteer = require('puppeteer');
const { Client } = require('pg');
const readline = require('readline');
const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
// ==========================================
// 1. Configuração do Banco de Dados
// ==========================================
const client = new Client({
    connectionString: 'postgresql://postgres:Wallace@22@100.114.225.110:5432/stats_futebol'
});
const competicoesDoDia = new Set();
// Função auxiliar para esperar o "Enter" no console
const askQuestion = (query) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
};

// ==========================================
// 2. Lógica de Raspagem de cada Partida
// ==========================================
// ==========================================
// 2. Lógica de Raspagem de cada Partida
// ==========================================
async function coletarDetalhes(urlJogo, pastaBase, index, browser) {
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on('request', req => {
        if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });

    try {
        await page.goto(urlJogo, { waitUntil: 'domcontentloaded' });
        const urlObj = new URL(urlJogo);
        let matchId = urlObj.searchParams.get('mid') || urlJogo.split('/?mid=').pop() || urlJogo.split('/').filter(Boolean).pop();

        await page.waitForSelector('div.duelParticipant__home a.participant__participantName', { visible: true, timeout: 15000 });

        const dados = await page.evaluate(() => {
            let nome_liga = "", rodada = "", flashscore_slug_liga = "";
            let classificacao_liga = "", flashscore_slug_pais_liga = "", pais_liga = "", data_hora = "";

            const items = document.querySelectorAll('li[data-testid="wcl-breadcrumbsItem"]');

            if (items.length > 0) {
                if (items.length >= 2) {
                    pais_liga = items[1].innerText.trim();
                }

                const lastItem = items[items.length - 1];
                const link = lastItem.querySelector('a');

                if (link) {
                    const href = link.getAttribute('href');
                    const parts = href.split('/').filter(Boolean);
                    flashscore_slug_liga = parts[parts.length - 1];
                    if (parts.length >= 2) flashscore_slug_pais_liga = parts[1];
                    classificacao_liga = `https://www.flashscore.com.br${href}classificacao/`;
                }

                const span = lastItem.querySelector('span[data-testid="wcl-scores-overline-03"]');
                if (span) {
                    const texto = span.innerText.trim();
                    const splitIdx = texto.indexOf(' - ');
                    if (splitIdx !== -1) {
                        nome_liga = texto.substring(0, splitIdx).trim();
                        rodada = texto.substring(splitIdx + 3).trim();
                    } else {
                        nome_liga = texto;
                    }
                }
            }

            // Extração de Data e Hora
            const divs = Array.from(document.querySelectorAll('div'));
            const dataElem = divs.find(el => /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(el.innerText?.trim()));
            if (dataElem) data_hora = dataElem.innerText.trim();

            const extrairTime = (seletor) => {
                const elem = document.querySelector(seletor);
                if (!elem) return null;
                return {
                    nome: elem.innerText.trim().replace(/\s*\([^)]*\)/g, '').trim(),
                    flashscore_id: elem.getAttribute('href')?.split('/').filter(Boolean)[2] || ""
                };
            };

            return {
                flashscore_slug_liga,
                nome_liga,
                rodada,
                data_hora,
                classificacao_liga,
                flashscore_slug_pais_liga,
                pais_liga,
                time_casa: extrairTime('div.duelParticipant__home a.participant__participantName'),
                time_visitante: extrairTime('div.duelParticipant__away a.participant__participantName')
            };
        });

        // Split Data e Hora
        let data_jogo = null;
        let hora_jogo = null;

        if (dados.data_hora) {
            const partesData = dados.data_hora.split(' ');
            if (partesData.length >= 2) {
                hora_jogo = partesData[1];
                const dataOriginal = partesData[0];
                if (dataOriginal.includes('.')) {
                    const [dia, mes, ano] = dataOriginal.split('.');
                    if (dia && mes && ano) {
                        data_jogo = `${ano}-${mes}-${dia}`;
                    }
                } else {
                    data_jogo = dataOriginal;
                }
            }
        }

        // =========================================================
        // BUSCA DE IDs INTERNOS NO BANCO DE DADOS
        // =========================================================

        let id_time_casa = null;
        let id_time_fora = null;
        let id_competicao = null;

        // Busca o ID interno do time da casa
        if (dados.time_casa?.flashscore_id) {
            const resCasa = await client.query('SELECT id FROM times WHERE flashscore_id = $1', [dados.time_casa.flashscore_id]);
            if (resCasa.rows.length > 0) id_time_casa = resCasa.rows[0].id;
        }

        // Busca o ID interno do time de fora
        if (dados.time_visitante?.flashscore_id) {
            const resFora = await client.query('SELECT id FROM times WHERE flashscore_id = $1', [dados.time_visitante.flashscore_id]);
            if (resFora.rows.length > 0) id_time_fora = resFora.rows[0].id;
        }

        // Busca o ID interno da competição
        if (dados.flashscore_slug_liga && dados.flashscore_slug_pais_liga) {
            const resComp = await client.query(
                'SELECT id FROM competicoes WHERE flashscore_slug = $1 AND flashscore_slug_pais = $2',
                [dados.flashscore_slug_liga, dados.flashscore_slug_pais_liga]
            );
            if (resComp.rows.length > 0) {
                id_competicao = resComp.rows[0].id;
                competicoesDoDia.add(id_competicao);
            }
        }

        // =========================================================

        const query = `
            INSERT INTO calendario (
                flashscore_id, url, rodada, nome_time_casa, nome_time_fora, flashscore_id_casa,
                flashscore_id_fora, flashscore_slug_liga, nome_competicao,
                classificacao_liga, flashscore_slug_pais_liga, pais_liga, data_jogo, hora_jogo,
                id_time_casa, id_time_fora, id_competicao
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            ON CONFLICT (flashscore_id)
            DO UPDATE SET
                url = EXCLUDED.url,
                rodada = EXCLUDED.rodada,
                nome_time_casa = EXCLUDED.nome_time_casa,
                nome_time_fora = EXCLUDED.nome_time_fora,
                flashscore_id_casa = EXCLUDED.flashscore_id_casa,
                flashscore_id_fora = EXCLUDED.flashscore_id_fora,
                flashscore_slug_liga = EXCLUDED.flashscore_slug_liga,
                nome_competicao = EXCLUDED.nome_competicao,
                classificacao_liga = EXCLUDED.classificacao_liga,
                flashscore_slug_pais_liga = EXCLUDED.flashscore_slug_pais_liga,
                pais_liga = EXCLUDED.pais_liga,
                data_jogo = EXCLUDED.data_jogo,
                hora_jogo = EXCLUDED.hora_jogo,
                id_time_casa = EXCLUDED.id_time_casa,
                id_time_fora = EXCLUDED.id_time_fora,
                id_competicao = EXCLUDED.id_competicao;
        `;

        const values = [
            matchId,
            urlJogo,
            dados.rodada,
            dados.time_casa?.nome || null,
            dados.time_visitante?.nome || null,
            dados.time_casa?.flashscore_id || null,
            dados.time_visitante?.flashscore_id || null,
            dados.flashscore_slug_liga,
            dados.nome_liga,
            dados.classificacao_liga,
            dados.flashscore_slug_pais_liga,
            dados.pais_liga,
            data_jogo,
            hora_jogo,
            id_time_casa,
            id_time_fora,
            id_competicao
        ];

        await client.query(query, values);
        console.log(`[${matchId}] SUCESSO! Dados salvos com vinculação de IDs.`);

    } catch (error) {
        console.error(`[${urlJogo}] Erro:`, error.message);
    } finally {
        await page.close();
    }
}
async function chamarColetarClassificacao() {
    console.log('\n==========================================');
    console.log('📊 Iniciando coletar_classificação.js...');
    console.log('==========================================\n');

    try {
        const caminhoScript = path.join(__dirname, 'coletar_classificação.js');

        const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [caminhoScript],
            {
                cwd: __dirname,
                maxBuffer: 1024 * 1024 * 20
            }
        );

        if (stdout) {
            process.stdout.write(stdout);
        }

        if (stderr) {
            process.stderr.write(stderr);
        }

        console.log('\n==========================================');
        console.log('✅ coletar_classificação.js finalizado.');
        console.log('==========================================\n');

    } catch (error) {
        console.error('\n==========================================');
        console.error('❌ Erro ao executar coletar_classificação.js');
        console.error(error.message);
        console.error('==========================================\n');
    }
}
// ==========================================
// Função Principal
// ==========================================
async function main() {
    console.log("Conectando ao banco de dados...");
    await client.connect();
    console.log("Conectado ao PostgreSQL com sucesso!");
    const pastaBase = path.join(__dirname, 'jogos_flashscore');
    await fs.mkdir(pastaBase, { recursive: true });

    // Abre o navegador de forma visível
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null
    });

    const page = await browser.newPage();
    await page.goto('https://www.flashscore.com.br/');

    console.log("\n" + "=".repeat(50));
    console.log("Navegador aberto! Vá até a página do Flashscore.");
    console.log("Expanda todas as ligas e botões que desejar.");
    await askQuestion("Quando terminar, clique no terminal e pressione [ENTER] para começar a coleta...");
    console.log("=".repeat(50) + "\n");

    console.log("Coletando os links da página principal...");

    // Pega todos os links (Evitando duplicados usando Set)
    const linksJogos = await page.$$eval('div.event__match a.eventRowLink', anchors => {
        return Array.from(new Set(anchors.map(a => a.href)));
    });

    console.log(`Total de jogos encontrados: ${linksJogos.length}`);
    await page.close(); // Fecha a aba principal para economizar RAM

    // Processar de 5 em 5 usando Promise.all
    const LOTE = 5;
    for (let i = 0; i < linksJogos.length; i += LOTE) {
        const batch = linksJogos.slice(i, i + LOTE);
        console.log(`\nProcessando lote de ${batch.length} jogos (${i + 1} a ${Math.min(i + LOTE, linksJogos.length)})...`);

        // Mapeia o lote atual para executar as chamadas em paralelo
        const promises = batch.map((url, idx) =>
            coletarDetalhes(url, pastaBase, i + idx + 1, browser)
        );

        // Aguarda todos os 5 terminarem antes de ir para o próximo lote
        await Promise.all(promises);
    }

    console.log(`\nCompetições encontradas no dia: ${competicoesDoDia.size}`);

    for (const idCompeticao of competicoesDoDia) {
        const result = await client.query(
            `UPDATE competicoes_temporaria
         SET coletado = 1
         WHERE competicao_id = $1
           AND UPPER(TRIM(aba_nome)) IN ('CLASSIFICAÇÃO', 'PRINCIPAL')`,
            [idCompeticao]
        );

        console.log(
            `Competição ${idCompeticao}: ${result.rowCount} registro(s) preparado(s) para classificação/principal.`
        );
    }

    await browser.close();
    await client.end();
    
}

main().catch(console.error);