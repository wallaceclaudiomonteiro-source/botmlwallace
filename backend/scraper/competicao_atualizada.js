const { criarPool } = require('../../db');
const puppeteer = require('puppeteer');

const pool = criarPool('modelo', { max: 20 });

async function processarEmLotes() {
    console.log('🚀 Iniciando processamento focado APENAS na "NULL"...');

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--disable-images', '--no-sandbox']
    });

    let temMaisJogos = true;

    while (temMaisJogos) {
        const client = await pool.connect();

        // 1. MUDANÇA NO SELECT: Busca apenas NULL
        const res = await client.query(`
    SELECT flashscore_id, link_estatisticas, nome_competicao
    FROM jogos
    WHERE flashscore_slug_liga = 'bfl'
      AND (competicao_atualizada != 1 OR competicao_atualizada IS NULL)
    LIMIT 10
`);

        const jogos = res.rows;
        client.release();

        if (jogos.length === 0) {
            console.log('🏁 Todos os jogos da "NULL" foram processados e normalizados!');
            temMaisJogos = false;
            break;
        }

        console.log(`\n--- Processando lote de ${jogos.length} jogos ---`);

        for (const jogo of jogos) {
            console.log(`\n🔍 ID: ${jogo.flashscore_id} | 🏦 NO BANCO ESTÁ: "${jogo.nome_competicao}"`);

            try {
                const dados = await coletarDadosDoLink(jogo.link_estatisticas, browser);

                if (!dados) {
                    throw new Error("Seletor não encontrado ou dados vazios");
                }

                console.log(`🌐 LIDO NO SITE: "${dados.nome_liga}" (País: ${dados.pais_liga})`);

                // 2. MUDANÇA NO UPDATE: Aplicando INITCAP(LOWER()) diretamente nas variáveis $1 e $4
                await pool.query(`
                    UPDATE jogos 
                    SET 
                        nome_competicao = INITCAP(LOWER($1)),
                        flashscore_slug_liga = $2,
                        flashscore_slug_pais_liga = $3,
                        pais_liga = INITCAP(LOWER($4)),
                        competicao_atualizada = 1
                    WHERE flashscore_id = $5
                `, [dados.nome_liga, dados.flashscore_slug_liga, dados.flashscore_slug_pais_liga, dados.pais_liga, jogo.flashscore_id]);

                console.log(`✅ Sucesso: Jogo ${jogo.flashscore_id} atualizado e texto normalizado!`);

            } catch (err) {
                console.error(`❌ Erro no jogo ${jogo.flashscore_id}: ${err.message}`);
                await pool.query(`UPDATE jogos SET competicao_atualizada = -1 WHERE flashscore_id = $1`, [jogo.flashscore_id]);
            }
        }
    }

    await browser.close();
}

async function coletarDadosDoLink(url, browser) {
    const page = await browser.newPage();
    try {
        // 'domcontentloaded' garante que o HTML está pronto, o waitForSelector faz o resto
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

        // O script para de esperar aqui EXATAMENTE quando o elemento aparece
        await page.waitForSelector('li[data-testid="wcl-breadcrumbsItem"]', { timeout: 10000 });

        return await page.evaluate(() => {
            const items = document.querySelectorAll('li[data-testid="wcl-breadcrumbsItem"]');
            if (items.length < 3) return null;

            let nome_liga = "", flashscore_slug_liga = "", flashscore_slug_pais_liga = "", pais_liga = "";

            const spanPais = items[1].querySelector('span[data-testid="wcl-scores-overline-03"]');
            pais_liga = spanPais ? spanPais.innerText.trim() : "";

            const itemLiga = items[2];
            const linkLiga = itemLiga.querySelector('a');
            const spanLiga = itemLiga.querySelector('span[data-testid="wcl-scores-overline-03"]');

            if (spanLiga) {
                const texto = spanLiga.innerText.trim();
                const splitIdx = texto.indexOf(' - ');
                nome_liga = splitIdx !== -1 ? texto.substring(0, splitIdx).trim() : texto;
            }

            if (linkLiga) {
                const href = linkLiga.getAttribute('href');
                const parts = href.split('/').filter(Boolean);
                if (parts.length >= 3) {
                    flashscore_slug_pais_liga = parts[1];
                    flashscore_slug_liga = parts[2];
                }
            }

            return { nome_liga, flashscore_slug_liga, flashscore_slug_pais_liga, pais_liga };
        });
    } catch (err) {
        return null;
    } finally {
        await page.close();
    }
}

processarEmLotes();