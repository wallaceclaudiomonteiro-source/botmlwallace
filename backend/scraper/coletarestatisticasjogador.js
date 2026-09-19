const { Pool } = require('pg');
const puppeteer = require('puppeteer');

// ======================================================
// 🔗 CONEXÃO POSTGRESQL
// ======================================================
const pool = new Pool({
    connectionString: 'postgresql://postgres:Wallace@22@100.114.225.110:5432/stats_futebol',
    max: 10,
    idleTimeoutMillis: 30000
});

const caminhoChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ======================================================
// 🛠️ AUXILIARES DE TRATAMENTO
// ======================================================
const extrairFracao = (texto) => {
    if (!texto || texto === '0' || texto === '-') return { c: 0, t: 0, p: 0 };
    const matchCompleto = String(texto).match(/(\d+)\/(\d+)\s*\((\d+)%\)/);
    if (matchCompleto) return { c: parseInt(matchCompleto), t: parseInt(matchCompleto), p: parseInt(matchCompleto) };
    const matchSimples = String(texto).match(/(\d+)\/(\d+)/);
    if (matchSimples) return { c: parseInt(matchSimples), t: parseInt(matchSimples), p: 0 };
    const apenasNumero = String(texto).match(/^(\d+)$/);
    if (apenasNumero) return { c: parseInt(apenasNumero), t: parseInt(apenasNumero), p: 100 };
    return { c: 0, t: 0, p: 0 };
};

const limpaMinutos = (val) => parseInt(String(val).replace(/[^0-9]/g, '')) || 0;
const pegaDecimal = (val) => parseFloat(String(val).replace(',', '.')) || 0;
const pegaNumero = (val) => parseInt(val) || 0;

// ======================================================
// 🛠️ FUNÇÃO 1: PREPARAR FILA (COM LOGS DE MONTAGEM)
// ======================================================
async function prepararestatisticasjogador() {
    const client = await pool.connect();
    try {
        const res = await client.query(`
            SELECT flashscore_id, link_estatisticas, nome_time_casa, nome_time_fora 
            FROM jogos 
            WHERE estatisticas_jogador = 0 
            LIMIT 5
        `);

        if (res.rows.length === 0) return [];
        const arrayJogos = [];

        for (const jogo of res.rows) {
            const id = jogo.flashscore_id;

            // LOG 1: O que veio do banco
            console.log(`\n[PREPARAÇÃO] 📋 Jogo ${id}: Link base do banco: ${jogo.link_estatisticas}`);

            if (!jogo.link_estatisticas) {
                await client.query('UPDATE jogos SET estatisticas_jogador = 99 WHERE flashscore_id = $1', [id]);
                continue;
            }

            const urlObj = new URL(String(jogo.link_estatisticas).trim(), 'https://www.flashscore.com.br');
            if (!urlObj.pathname.endsWith('/')) urlObj.pathname += '/';
            urlObj.pathname += 'resumo/estatisticas-jogadores/';

            const urlFinalBase = urlObj.toString();

            // LOG 2: URL Base de estatísticas montada
            console.log(`[PREPARAÇÃO] 🔗 URL de Estatísticas montada: ${urlFinalBase}`);

            await client.query('UPDATE jogos SET estatisticas_jogador = 4 WHERE flashscore_id = $1', [id]);
            arrayJogos.push({
                flashscore_id: id,
                link: urlFinalBase,
                confronto: `${jogo.nome_time_casa} x ${jogo.nome_time_fora}`
            });
        }
        return arrayJogos;
    } finally { client.release(); }
}

// ======================================================
// 🕷️ FUNÇÃO 2: COLETAR (COM LOGS DE NAVEGAÇÃO)
// ======================================================
async function coletaestatisticasjogador(jogo, browser) {
    const page = await browser.newPage();

    // Bloqueia imagens para a página carregar mais rápido e não estourar a conexão
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
    });

    try {
        console.log(`\n🚀 [INICIANDO] ${jogo.confronto} (${jogo.flashscore_id})`);

        // ======================================================
        // 🧩 MONTAGEM INTELIGENTE DA URL
        // ======================================================
        const urlObj = new URL(jogo.link, 'https://www.flashscore.com.br');

        let basePath = urlObj.pathname;
        if (!basePath.endsWith('/')) basePath += '/';
        if (!basePath.includes('resumo/estatisticas-jogadores')) {
            basePath += 'resumo/estatisticas-jogadores/';
        }

        const origem = urlObj.origin;
        const parametros = urlObj.search;

        const abas = [
            { nome: 'Principais', path: 'principais/' },
            { nome: 'Finalizações', path: 'finalizacoes/' },
            { nome: 'Ataque', path: 'ataque/' },
            { nome: 'Passes', path: 'passes/' },
            { nome: 'Defesa', path: 'defesa/' },
            { nome: 'Goleiro', path: 'goleiro/' },
            { nome: 'Gerais', path: 'gerais/' }
        ];

        let jogadoresGlobais = {};

        // ======================================================
        // 🔄 LOOP PELAS URLs (COM 3 TENTATIVAS PARA CADA UMA)
        // ======================================================
        for (const aba of abas) {
            const urlFinalAba = `${origem}${basePath}${aba.path}${parametros}`.trim();

            let sucessoAba = false;
            let tentativaAba = 0; // Contador de tentativas para esta aba específica

            // 🎯 INÍCIO DAS 3 TENTATIVAS POR URL
            while (tentativaAba < 3 && !sucessoAba) {
                try {
                    tentativaAba++;
                    // LOG LIMPO: A URL ENORME FOI REMOVIDA DAQUI
                    console.log(`🌐 [NAVEGAÇÃO] ID: ${jogo.flashscore_id} | Aba: ${aba.nome} | Tentativa: ${tentativaAba}/3`);

                    // Vai para a página. Usando domcontentloaded para ser mais rápido
                    await page.goto(urlFinalAba, { waitUntil: 'domcontentloaded', timeout: 45000 });

                    // Se for a primeira aba, verifica se o jogo tem estatísticas
                    if (aba.nome === 'Principais') {
                        await page.waitForSelector('button[data-testid="wcl-tab"]', { timeout: 15000 });
                        const temBotao = await page.evaluate(() =>
                            Array.from(document.querySelectorAll('button[data-testid="wcl-tab"]'))
                                .some(b => b.textContent?.trim() === 'Estatísticas de jogador')
                        );
                        if (!temBotao) throw new Error('SEM_ESTATISTICAS');
                    }

                    // Aguarda a tabela aparecer
                    await page.waitForSelector('tbody[data-testid="wcl-tableBody"]', { timeout: 15000 });

                    // Extração de dados da página
                    const dadosAba = await page.evaluate(() => {
                        const container = document.querySelector('div[data-analytics-context]:not([style*="display: none"])') || document.querySelector('div[data-analytics-context]');
                        const tabela = container?.querySelector('table');
                        if (!tabela) return [];

                        const colMap = {};
                        tabela.querySelectorAll('thead th').forEach((th, idx) => {
                            const alias = th.getAttribute('data-analytics-alias');
                            if (alias) colMap[alias] = idx + 1;
                        });

                        const linhas = [];
                        tabela.querySelectorAll('tbody tr.wcl-tableBodyRow_jf-Rp').forEach(tr => {
                            const idPlayer = tr.querySelector('figure')?.getAttribute('data-analytics-player-id');
                            if (!idPlayer) return;

                            const stats = {};
                            for (let alias in colMap) {
                                const td = tr.querySelector(`td:nth-child(${colMap[alias]})`);
                                const val = td ? td.textContent.trim() : "0";
                                stats[alias] = (val === '-' || !val) ? "0" : val;
                            }
                            linhas.push({
                                id: idPlayer,
                                nome: tr.querySelector('[class*="playerName"]')?.textContent?.trim(),
                                pos: tr.querySelector('span[class*="position"]')?.textContent?.trim() || tr.querySelector('figcaption span:last-child')?.textContent?.trim() || '',
                                stats
                            });
                        });
                        return linhas;
                    });

                    // Merge no objeto de jogadores
                    dadosAba.forEach(p => {
                        if (!jogadoresGlobais[p.id]) {
                            jogadoresGlobais[p.id] = { nome: p.nome, posicao: p.pos, stats: {} };
                        }
                        jogadoresGlobais[p.id].stats = { ...jogadoresGlobais[p.id].stats, ...p.stats };
                    });

                    // Se chegou até aqui sem cair no catch, marca como sucesso e quebra o While
                    sucessoAba = true;
                    console.log(`   ✅ Aba ${aba.nome} carregada com sucesso!`);

                } catch (e) {
                    // Trata os erros das 3 tentativas
                    if (e.message === 'SEM_ESTATISTICAS') throw e; // Passa o erro para frente (Status 2)

                    console.log(`   ❌ Falha na tentativa ${tentativaAba}/3 da aba ${aba.nome}. Motivo: ${e.message}`);

                    if (tentativaAba === 3) {
                        console.log(`   ⚠️ Desistindo definitivamente da aba ${aba.nome} após 3 falhas.`);
                        // Se a primeira aba falhou 3 vezes por falta de internet, aborta o jogo inteiro (Status 0)
                        if (aba.nome === 'Principais') {
                            throw new Error('FALHA_CONEXAO_PRINCIPAL');
                        }
                    } else {
                        console.log(`   🔄 Aguardando 4 segundos antes de tentar a URL novamente...`);
                        await new Promise(r => setTimeout(r, 4000));
                    }
                }
            }
        } // FIM DO LOOP DAS ABAS

        // ======================================================
        // FUNÇÕES DE TRATAMENTO DE DADOS E SALVAMENTO NO BANCO
        // ======================================================

        // 🎯 AQUI: ALTERADO PARA PEGAR O TEXTO COMPLETO E JOGAR NA VARIÁVEL 'C'
        const extrairFracao = (texto) => {
            if (!texto || texto === '0' || texto === '-') return { c: '0', t: 0, p: 0 };
            return { c: String(texto).trim(), t: 0, p: 0 };
        };

        const limpaMinutos = (val) => val ? (parseInt(String(val).replace(/[^0-9]/g, '')) || 0) : 0;
        const pegaDecimal = (val) => parseFloat(String(val).replace(',', '.')) || 0;
        const pegaNumero = (val) => parseInt(val) || 0;

        console.log(`💾 [BANCO] Gravando dados para ${jogo.confronto}...`);
        for (let id in jogadoresGlobais) {
            const j = jogadoresGlobais[id];
            const st = j.stats;

            const p = extrairFracao(st['PASSES_ACCURATE']);
            const pTF = extrairFracao(st['PASSES_FINAL_THIRD_ACCURATE']);
            const pL = extrairFracao(st['LONG_BALLS_ACCURATE']);
            const cr = extrairFracao(st['CROSSES_ACCURATE']);
            const dr = extrairFracao(st['DRIBBLES_WON']);
            const du = extrairFracao(st['DUELS_TOTAL']);
            const duA = extrairFracao(st['DUELS_AERIAL_WON']);
            const duC = extrairFracao(st['DUELS_GROUND_WON']);
            const des = extrairFracao(st['TACKLES_WON']);

            await pool.query(`
                INSERT INTO estatisticas_jogadores_partida (
                    flashscore_id_jogo, flashscore_id_jogador, nome_jogador, posicao, minutos_jogados,
                    nota, gols, gols_contra, assistencias, cartoes_amarelos, cartoes_vermelhos,
                    total_finalizacoes, finalizacoes_no_alvo, finalizacoes_para_fora, finalizacoes_bloqueadas,
                    finalizacoes_dentro_area, finalizacoes_fora_area, finalizacoes_cabeca,
                    gols_esperados_xg, xgot_finalizacoes_alvo, grandes_chances_perdidas,
                    toques_na_bola, toques_area_adversaria, grandes_chances_criadas, assistencias_esperadas_xa,
                    passes_certos, passes_totais, passes_percentual,
                    passes_terco_final_certos, passes_terco_final_totais, passes_terco_final_percentual,
                    passes_longos_certos, passes_longos_totais, passes_longos_percentual,
                    cruzamentos_certos, cruzamentos_totais, cruzamentos_percentual,
                    dribles_certos, dribles_totais, dribles_percentual,
                    duelos_ganhos, duelos_totais, duelos_percentual,
                    duelos_aereos_ganhos, duelos_aereos_totais, duelos_aereos_percentual,
                    duelos_chao_ganhos, duelos_chao_totais, duelos_chao_percentual,
                    desarmes_certos, desarmes_totais, desarmes_percentual,
                    faltas_cometidas, faltas_sofridas, impedimentos, interceptacoes, rebatidas,
                    erros_resultaram_finalizacao, erros_resultaram_gol,
                    defesas_goleiro, gols_sofridos, gols_evitados, xgot_enfrentado,
                    saidas_soco, reposicoes_maos, saidas_area
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                    $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
                    $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59, $60,
                    $61, $62, $63, $64, $65, $66
                ) ON CONFLICT (flashscore_id_jogo, flashscore_id_jogador) DO UPDATE SET
                    nota = EXCLUDED.nota, minutos_jogados = EXCLUDED.minutos_jogados, toques_na_bola = EXCLUDED.toques_na_bola
            `, [
                jogo.flashscore_id, id, j.nome, j.posicao, limpaMinutos(st['MATCH_MINUTES_PLAYED']),
                pegaDecimal(st['FS_RATING']), pegaNumero(st['GOALS']), pegaNumero(st['GOALS_OWN']), pegaNumero(st['ASSISTS_GOAL']), pegaNumero(st['CARDS_YELLOW']), pegaNumero(st['CARDS_RED']),
                pegaNumero(st['SHOTS_TOTAL']), pegaNumero(st['SHOTS_ON_TARGET']), pegaNumero(st['SHOTS_OFF_TARGET']), pegaNumero(st['SHOTS_BLOCKED']),
                pegaNumero(st['SHOTS_BOX_IN']), pegaNumero(st['SHOTS_BOX_OUT']), pegaNumero(st['SHOTS_HEAD']),
                pegaDecimal(st['EXPECTED_GOALS']), pegaDecimal(st['EXPECTED_GOALS_ON_TARGET']), pegaNumero(st['BIG_CHANCES_MISSED']),
                pegaNumero(st['TOUCHES_TOTAL']), pegaNumero(st['TOUCHES_BOX_OPPOSITE']), pegaNumero(st['BIG_CHANCES_CREATED']), pegaDecimal(st['EXPECTED_ASSISTS']),
                p.c, p.t, p.p, pTF.c, pTF.t, pTF.p, pL.c, pL.t, pL.p, cr.c, cr.t, cr.p,
                dr.c, dr.t, dr.p, du.c, du.t, du.p, duA.c, duA.t, duA.p, duC.c, duC.t, duC.p, des.c, des.t, des.p,
                pegaNumero(st['FOULS_COMMITTED']), pegaNumero(st['FOULS_SUFFERED']), pegaNumero(st['OFFSIDES']), pegaNumero(st['INTERCEPTIONS']), pegaNumero(st['CLEARANCES']),
                pegaNumero(st['ERRORS_LEAD_TO_SHOT']), pegaNumero(st['ERRORS_LEAD_TO_GOAL']),
                pegaNumero(st['SAVES_TOTAL']), pegaNumero(st['GOALS_CONCEDED']), pegaDecimal(st['GOALS_PREVENTED']), pegaDecimal(st['EXPECTED_GOALS_ON_TARGET_FACED']),
                pegaNumero(st['PUNCHES_TOTAL']), pegaNumero(st['KEEPER_THROWS_TOTAL']), pegaNumero(st['KEEPER_SWEEPER_TOTAL'])
            ]);
        }

        await pool.query('UPDATE jogos SET estatisticas_jogador = 1 WHERE flashscore_id = $1', [jogo.flashscore_id]);
        console.log(`✅ [SUCESSO] Jogo finalizado.`);

    } catch (err) {
        if (err.message === 'SEM_ESTATISTICAS') {
            await pool.query('UPDATE jogos SET estatisticas_jogador = 2 WHERE flashscore_id = $1', [jogo.flashscore_id]);
            console.log(`🚫 [STATUS 2] Abortado (Sem aba de estatísticas).`);
        } else {
            console.error(`💥 Erro Crítico de Conexão:`, err.message);
            await pool.query('UPDATE jogos SET estatisticas_jogador = 0 WHERE flashscore_id = $1', [jogo.flashscore_id]);
        }
    } finally {
        await page.close();
    }
}
// ======================================================
// 🏁 INICIAR
// ======================================================
async function iniciar() {
    console.log("🖥️ Scraper Iniciado com Mapeamento Dinâmico...");
    const browser = await puppeteer.launch({
        executablePath: caminhoChrome,
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    while (true) {
        const fila = await prepararestatisticasjogador();
        if (fila.length === 0) {
            console.log("📭 Fila vazia. Aguardando...");
            await new Promise(r => setTimeout(r, 60000));
            continue;
        }
        // Processa o lote de 5 jogos em paralelo
        await Promise.all(fila.map(jogo => coletaestatisticasjogador(jogo, browser)));
    }
}

iniciar();