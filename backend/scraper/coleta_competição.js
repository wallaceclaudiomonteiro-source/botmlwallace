const { criarClient } = require('../../db');const readline = require('readline');
const puppeteer = require('puppeteer');

// ======================================================
// 🔗 POSTGRESQL
// ======================================================
const client = criarClient('modelo');
 

// ======================================================
// ⏱️ UTIL
// ======================================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ======================================================
// 🚀 MAIN
// ======================================================
(async () => {

    await client.connect();
    console.log("🟢 Conectado no Postgres");

    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    while (true) {

        // ======================================================
        // 🔥 PEGA 5 COMPETIÇÕES NÃO PROCESSADAS
        // ======================================================
        const res = await client.query(`
            SELECT id, nome, pais, url, flashscore_id, flashscore_slug
            FROM competicoes
            WHERE competicao_temporaria = 0
              AND url IS NOT NULL
            ORDER BY id
            LIMIT 5
        `);

        const competicoes = res.rows;

        if (competicoes.length === 0) {
            console.log("🏁 FINALIZADO: todas competições processadas");
            break;
        }

        console.log(`📦 Lote com ${competicoes.length} competições`);

        // ======================================================
        // 🔁 LOOP DAS COMPETIÇÕES
        // ======================================================
        for (const comp of competicoes) {

            try {
                console.log(`➡️ ${comp.nome}`);

                await page.goto(comp.url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });

                await sleep(2500);

                // ======================================================
                // 📅 DATAS (SE EXISTIREM)
                // ======================================================
                const dataInicio = await page.$eval(
                    'span.wcl-start_TGQDT',
                    el => el.innerText.trim()
                ).catch(() => null);

                const dataFim = await page.$eval(
                    'span.wcl-end_OQo3-',
                    el => el.innerText.trim()
                ).catch(() => null);

                // ======================================================
                // 🧩 NOVO: CAPTURA DE TABS (SEM CLIQUE)
                // ======================================================
                const tabs = await page.$$eval(
                    'div[data-testid="wcl-tabs"] a[href*="#/"]',
                    els => els.map(el => {
                        const btn = el.querySelector('button[role="tab"]');
                        const href = el.getAttribute('href');

                        return {
                            nome: btn ? btn.innerText.trim() : null,
                            flash_id: href ? href.replace('#/', '').replace('/', '') : null
                        };
                    }).filter(x => x.nome && x.flash_id)
                ).catch(() => []);

                // ======================================================
                // 🧱 CASO NÃO TENHA TABS
                // ======================================================
                if (!tabs.length) {

                    const html = await page.$eval('body', el => el.innerHTML);

                    await client.query(`
                        INSERT INTO competicoes_temporaria (
                            competicao_id,
                            nome,
                            pais,
                            flashscore_id,
                            flashscore_slug,
                            url,
                            aba_nome,
                            aba_url,
                            data_inicio_texto,
                            data_fim_texto,
                            html_classificacao
                        )
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                    `, [
                        comp.id,
                        comp.nome,
                        comp.pais,
                        comp.flashscore_id,
                        comp.flashscore_slug,
                        comp.url,
                        'Principal',
                        page.url(),
                        dataInicio,
                        dataFim,
                        html
                    ]);

                } else {

                    // ======================================================
                    // 🔁 LOOP DAS ABAS
                    // ======================================================
                    for (const tab of tabs) {

                        try {

                            const urlClassificacao = `${comp.url.replace(/\/$/, '')}#/`;

                            const html = await page.$eval('body', el => el.innerHTML);

                            await client.query(`
                                INSERT INTO competicoes_temporaria (
                                    competicao_id,
                                    nome,
                                    pais,
                                    flashscore_id,
                                    flashscore_slug,
                                    url,
                                    aba_nome,
                                    aba_url,
                                    data_inicio_texto,
                                    data_fim_texto,
                                    html_classificacao
                                )
                                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                            `, [
                                comp.id,
                                comp.nome,
                                comp.pais,
                                comp.flashscore_id,
                                comp.flashscore_slug,
                                comp.url,
                                tab.nome,
                                `${comp.url}#/` + tab.flash_id + `/`,
                                dataInicio,
                                dataFim,
                                html
                            ]);

                        } catch (err) {
                            console.log(`⚠️ erro aba ${tab.nome}`);
                        }
                    }
                }

                // ======================================================
                // ✅ MARCA COMO PROCESSADO
                // ======================================================
                await client.query(`
                    UPDATE competicoes
                    SET competicao_temporaria = 1
                    WHERE id = $1
                `, [comp.id]);

                console.log(`✅ OK ${comp.nome}`);

            } catch (err) {
                console.log(`❌ erro ${comp.nome}:`, err.message);
            }
        }
    }

    await browser.close();
    await client.end();

    console.log("🏁 FINALIZADO GERAL");
})();