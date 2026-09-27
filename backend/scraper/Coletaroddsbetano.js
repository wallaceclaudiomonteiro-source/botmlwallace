const { criarClient } = require('../../db');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const client = criarClient('modelo');

// ---------------------------------------------------------------
// CONFIGURAÇÃO DAS ABAS
//  - bt: parâmetro ?bt= da URL (null = link principal, sem parâmetro)
//  - idsPermitidos: filtra pelo market-type-id da Betano (null = pega tudo
//    que estiver com odds visíveis na tela)
// ---------------------------------------------------------------
const PAGINAS = [
    { categoria: 'principal',  bt: null, idsPermitidos: [1, 9, 15] }, // 1x2, Chance Dupla, Ambas Marcam
    { categoria: 'gols',       bt: 1,    idsPermitidos: null },
    { categoria: 'escanteios', bt: 3,    idsPermitidos: null },
    { categoria: 'cartoes',    bt: 4,    idsPermitidos: null },
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const aleatorio = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Monta a URL da aba a partir do link base salvo no banco
function montarUrl(linkBase, bt) {
    const u = new URL(linkBase);
    u.search = '';
    u.hash = '';
    if (bt !== null && bt !== undefined) u.searchParams.set('bt', String(bt));
    return u.toString();
}

async function garantirTabela() {
    await client.query(`
        CREATE TABLE IF NOT EXISTS betano_odds (
            id              SERIAL PRIMARY KEY,
            link_betano     TEXT NOT NULL,
            categoria       TEXT NOT NULL,      -- principal | gols | escanteios | cartoes
            market_type_id  INT,                -- id do tipo de mercado na Betano
            market_id       TEXT,               -- id do mercado naquele jogo
            mercado         TEXT,               -- título do mercado
            selecao         TEXT,               -- ex: "Mais de", "Menos de", "Sim", "1", "X", "2"
            linha           NUMERIC,            -- ex: 2.5 (null quando não tem linha)
            odd             NUMERIC,
            selection_id    TEXT NOT NULL,      -- data-selnid da Betano
            coletado_em     TIMESTAMPTZ DEFAULT NOW(),
            atualizado_em   TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (link_betano, selection_id)
        )
    `);
}

// Espera as odds renderizarem: repete a contagem até estabilizar
async function aguardarEstabilizar(page) {
    let anterior = -1;
    for (let i = 0; i < 8; i++) {
        const atual = await page.$$eval('[data-qa="event-selection"]', els => els.length);
        if (atual > 0 && atual === anterior) return atual;
        anterior = atual;
        await sleep(800);
    }
    return Math.max(anterior, 0);
}

// Extrai todas as seleções (odds) que estão renderizadas na tela
async function extrairSelecoes(page, idsPermitidos) {
    const selecoes = await page.evaluate((idsPermitidos) => {
        const resultado = [];

        document.querySelectorAll('[data-qa="event-selection"]').forEach(sel => {
            // Cada seleção pertence ao mercado (data-marketid) mais próximo
            const marketEl = sel.closest('[data-marketid]');
            if (!marketEl) return;

            const marketId = marketEl.getAttribute('data-marketid');

            // Tipo do mercado: data-qa="market-type-id-XX"
            const headerEl = marketEl.querySelector('[data-qa^="market-type-id-"]');
            const typeId = headerEl
                ? parseInt(headerEl.getAttribute('data-qa').replace('market-type-id-', ''), 10)
                : null;

            if (idsPermitidos && !idsPermitidos.includes(typeId)) return;

            // Título do mercado
            const tituloEl = marketEl.querySelector('.tw-self-center, .table-market-header__text');
            const mercado = (tituloEl ? tituloEl.textContent : (headerEl ? headerEl.textContent : ''))
                .replace(/\s+/g, ' ')
                .trim();

            // aria-label: "Bet on Mais de 2.5 with odds 1.45."
            const label = sel.getAttribute('aria-label') || '';
            const m = label.match(/^Bet on (.+) with odds ([\d.,]+)\.?$/);

            let nomeCompleto = '';
            let odd = null;

            if (m) {
                nomeCompleto = m[1].trim();
                odd = parseFloat(m[2].replace(/\.$/, '').replace(',', '.'));
            } else {
                // Fallback: lê direto do texto do botão
                const nomeEl = sel.querySelector('.s-name');
                const subEl = sel.querySelector('.s-name-sub');
                nomeCompleto = [nomeEl ? nomeEl.textContent : '', subEl ? subEl.textContent : '']
                    .join(' ').replace(/\s+/g, ' ').trim();
                const oddEl = sel.querySelector('.tw-text-sem-color-text-highlight');
                odd = oddEl ? parseFloat(oddEl.textContent.replace(',', '.')) : null;
            }

            if (!nomeCompleto || odd === null || Number.isNaN(odd)) return;

            // Separa "Mais de 2.5" em selecao="Mais de" e linha=2.5
            let selecao = nomeCompleto;
            let linha = null;
            const partes = nomeCompleto.match(/^(.*?)\s+([+-]?\d+(?:\.\d+)?)$/);
            if (partes) {
                selecao = partes[1].trim();
                linha = parseFloat(partes[2]);
            }

            const selectionId = sel.getAttribute('data-selnid')
                || `${marketId}:${nomeCompleto}`;

            resultado.push({ marketId, typeId, mercado, selectionId, selecao, linha, odd });
        });

        return resultado;
    }, idsPermitidos);

    // Remove duplicatas de seleção
    const vistos = new Set();
    return selecoes.filter(s => {
        if (vistos.has(s.selectionId)) return false;
        vistos.add(s.selectionId);
        return true;
    });
}

async function salvarSelecoes(linkBase, categoria, selecoes) {
    if (selecoes.length === 0) return 0;

    await client.query(`
        INSERT INTO betano_odds
            (link_betano, categoria, market_type_id, market_id, mercado, selecao, linha, odd, selection_id)
        SELECT $1::text, $2::text, t.*
        FROM unnest(
            $3::int[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::numeric[], $9::text[]
        ) AS t(market_type_id, market_id, mercado, selecao, linha, odd, selection_id)
        ON CONFLICT (link_betano, selection_id) DO UPDATE SET
            odd           = EXCLUDED.odd,
            mercado       = EXCLUDED.mercado,
            atualizado_em = NOW()
    `, [
        linkBase,
        categoria,
        selecoes.map(s => s.typeId),
        selecoes.map(s => s.marketId),
        selecoes.map(s => s.mercado),
        selecoes.map(s => s.selecao),
        selecoes.map(s => s.linha),
        selecoes.map(s => s.odd),
        selecoes.map(s => s.selectionId),
    ]);

    return selecoes.length;
}

async function coletarOddsBetano() {
    let browser;

    try {
        await client.connect();
        console.log('📦 Conectado ao banco de dados.');
        await garantirTabela();

        // Uso: node coletarOddsBetano.js [limite]   (limite = só os N primeiros jogos, bom p/ teste)
        const limite = parseInt(process.argv[2], 10) || null;

        let { rows: jogos } = await client.query(`
            SELECT nome_time_casa, nome_time_fora, link_betano
            FROM betano_jogos_diarios
            WHERE processado = 0 
            AND link_betano IS NOT NULL
        `);

        if (limite) jogos = jogos.slice(0, limite);

        if (jogos.length === 0) {
            console.log('⚠️ Nenhum link encontrado em betano_jogos_diarios.');
            return;
        }

        console.log(`🚀 ${jogos.length} jogos para coletar (${PAGINAS.length} abas cada).`);

        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
        });

        const page = await browser.newPage();

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            if (['font', 'image', 'media'].includes(req.resourceType()) || url.includes('google-analytics')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        for (let i = 0; i < jogos.length; i++) {
            const jogo = jogos[i];
            console.log(`\n=====================================================`);
            console.log(`⚽ [${i + 1}/${jogos.length}] ${jogo.nome_time_casa} x ${jogo.nome_time_fora}`);

            for (const cfg of PAGINAS) {
                const url = montarUrl(jogo.link_betano, cfg.bt);

                try {
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

                    const qtdTela = await aguardarEstabilizar(page);
                    if (qtdTela === 0) {
                        console.log(`   ⚠️ [${cfg.categoria}] nenhuma odd renderizada (${url})`);
                        continue;
                    }

                    const selecoes = await extrairSelecoes(page, cfg.idsPermitidos);
                    const salvos = await salvarSelecoes(jogo.link_betano, cfg.categoria, selecoes);

                    const mercados = new Set(selecoes.map(s => s.marketId)).size;
                    console.log(`   ✅ [${cfg.categoria}] ${mercados} mercados / ${salvos} odds salvas`);
                } catch (err) {
                    console.error(`   🚨 [${cfg.categoria}] erro em ${url}:`, err.message);
                }

                await sleep(aleatorio(1500, 3000));
            }
        }

        console.log('\n💾 Coleta concluída. Dados na tabela "betano_odds".');

    } catch (err) {
        console.error('🚨 Erro crítico na execução:', err);
    } finally {
        if (browser) await browser.close();
        await client.end();
        console.log('\n🏁 Processo finalizado.');
    }
}

coletarOddsBetano();