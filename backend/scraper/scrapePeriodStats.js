// Função sleep para aguardar entre x e y segundos
function sleep(min, max) {
    const time = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
    return new Promise(resolve => setTimeout(resolve, time));
}

async function scrapePeriodStats(page, game, db) {
    const flashscoreId = game.flashscore_id || game.flashscoreId;
    const { homeTeamSlug, awayTeamSlug, homeTeamFlashscoreId, awayTeamFlashscoreId } = game;

    const periods = [
        {
            name: '1_tempo',
            url: `https://www.flashscore.com.br/jogo/futebol/${homeTeamSlug}-${homeTeamFlashscoreId}/${awayTeamSlug}-${awayTeamFlashscoreId}/resumo/estatisticas/1o-tempo/?mid=${flashscoreId}`
        },
        {
            name: '2_tempo',
            url: `https://www.flashscore.com.br/jogo/futebol/${homeTeamSlug}-${homeTeamFlashscoreId}/${awayTeamSlug}-${awayTeamFlashscoreId}/resumo/estatisticas/2o-tempo/?mid=${flashscoreId}`
        }
    ];

    // ... (sua lógica de verificação alreadyCollected se mantém igual) ...

    for (const period of periods) {
        console.log(`LOG SCRAPER: Acessando ${period.name} do jogo ${flashscoreId}...`);
        
        try {
            await page.goto(period.url, { waitUntil: 'networkidle2', timeout: 30000 });
            // Espera o container principal aparecer usando data-testid
            await page.waitForSelector('[data-testid="wcl-statistics"]', { timeout: 10000 });
            await sleep(2, 4);

            const stats = await page.evaluate(() => {
                const homeStats = {};
                const awayStats = {};

                const parsePercentage = (raw) => parseFloat(raw.replace('%', '')) || 0;
                const parseFraction = (raw) => {
                    const match = raw.match(/(\d+)\/(\d+)/);
                    return match ? { success: parseInt(match[1]), total: parseInt(match[2]) } : null;
                };
                const parseSimpleValue = (raw) => parseFloat(raw.trim().replace(',', '.')) || 0;

                // Seleciona as linhas usando data-testid em vez de classes dinâmicas
                const rows = document.querySelectorAll('[data-testid="wcl-statistics"]');

                rows.forEach(row => {
                    const categoryEl = row.querySelector('[data-testid="wcl-statistics-category"]');
                    if (!categoryEl) return;
                    const statName = categoryEl.textContent.trim();

                    // Buscamos os valores baseados no testid e na classe de posição (que é mais estável)
                    const homeValueEl = row.querySelector('[data-testid="wcl-statistics-value"].wcl-homeValue_3Q-7P');
                    const awayValueEl = row.querySelector('[data-testid="wcl-statistics-value"].wcl-awayValue_Y-QR1');

                    if (homeValueEl && awayValueEl) {
                        const processValue = (el, targetObj) => {
                            const textContent = el.textContent.trim();
                            const spans = Array.from(el.querySelectorAll('span'));

                            if (textContent.includes('/')) {
                                const fraction = parseFraction(textContent);
                                targetObj[`${statName} (Porcentagem)`] = parsePercentage(spans[0]?.textContent || "0");
                                targetObj[`${statName} (Certos)`] = fraction?.success || 0;
                                targetObj[`${statName} (Total)`] = fraction?.total || 0;
                            } else if (textContent.includes('%')) {
                                targetObj[statName] = parsePercentage(textContent);
                            } else {
                                targetObj[statName] = parseSimpleValue(textContent);
                            }
                        };

                        processValue(homeValueEl, homeStats);
                        processValue(awayValueEl, awayStats);
                    }
                });

                return { home: homeStats, away: awayStats };
            });

            if (Object.keys(stats.home).length > 0) {
                await insertPeriodStats(db, game.id, game.homeTeamId, period.name, stats.home);
                await insertPeriodStats(db, game.id, game.awayTeamId, period.name, stats.away);
            }

        } catch (error) {
            console.warn(`AVISO: Sem dados para ${period.name} no jogo ${flashscoreId}.`);
        }
    }
    // ... (restante da função UPDATE periodo_coletado) ...
}
// --- FUNÇÃO ADICIONADA ---
async function insertPeriodStats(db, idJogo, idTime, periodo, metrics) {
    const scraperToDB = {
        "Posse de bola": "posse_bola",
        "Total de finalizações": "finalizacoes",
        "Finalizações no alvo": "finalizacoes_no_gol",
        "Finalizações para fora": "finalizacoes_para_fora",
        "Finalizações bloqueadas": "finalizacoes_bloqueadas",
        "Finalizações de dentro da área": "finalizacoes_de_dentro_area",
        "Finalizações de fora da área": "finalizacoes_de_fora_area",
        "Bolas na trave": "bolas_na_trave",
        "xG das finalizações no alvo (xGOT)": "xgot",
        "Assistências esperadas (xA)": "xa",
        "Gols esperados (xG)": "xg",
        "xGOT enfrentado": "xga",
        "Chances claras": "chances_clara",
        "Toques dentro da área adversária": "toques_area_adversaria",
        "Passes em profundidade certos": "passes_profundidade_certos",
        "Laterais Cobrados": "laterais_cobradas",
        "Faltas Cobradas": "faltas_cobradas",
        "Faltas": "faltas",
        "Cartões amarelos": "cartoes_amarelos",
        "Escanteios": "escanteios",
        "Impedimentos": "impedimentos",
        "Interceptações": "interceptacoes",
        "Rebatidas": "rebatidas",
        "Duelos ganhos": "duelos_ganhos",
        "Erros que resultaram em finalização": "erros_resultaram_finalizacao",
        "Erros que resultaram em gol": "erros_resultaram_gol",
        "Defesas do goleiro": "defesas_goleiro",
        "Gols evitados": "gols_evitados",
        "Passes (Porcentagem)": "passes_porcentagem",
        "Passes (Certos)": "passes_certos",
        "Passes (Total)": "passes_total",
        "Passes longos (Porcentagem)": "passes_longos_porcentagem",
        "Passes longos (Certos)": "passes_longos_certos",
        "Passes longos (Total)": "passes_longos_total",
        "Passes no terço final (Porcentagem)": "passes_terco_final_porcentagem",
        "Passes no terço final (Certos)": "passes_terco_final_certos",
        "Passes no terço final (Total)": "passes_terco_final_total",
        "Cruzamentos (Porcentagem)": "cruzamentos_porcentagem",
        "Cruzamentos (Certos)": "cruzamentos_certos",
        "Cruzamentos (Total)": "cruzamentos_total",
        "Desarmes (Porcentagem)": "desarmes_porcentagem",
        "Desarmes (Certos)": "desarmes_certos",
        "Desarmes (Total)": "desarmes_total",
        "Cartões vermelhos": "cartao_vermelho",
    };

    const dbColumns = ["id_jogo", "id_time", "periodo"];
    const values = [idJogo, idTime, periodo];

    for (const scraperName in scraperToDB) {
        dbColumns.push(scraperToDB[scraperName]);
        values.push(metrics[scraperName] !== undefined ? metrics[scraperName] : null);
    }

    const placeholders = dbColumns.map(() => '?').join(', ');
    const sql = `INSERT OR IGNORE INTO estatisticas_por_periodo (${dbColumns.join(', ')}) VALUES (${placeholders})`;

    await new Promise((resolve, reject) => {
        db.run(sql, values, function (err) {
            if (err) return reject(err);
            resolve();
        });
    });
}

module.exports = {
    scrapePeriodStats,
    insertPeriodStats,
};
