const { Client } = require('pg');
const puppeteer = require('puppeteer');
const path = require('path');
const { spawn } = require('child_process'); // 👈 ADICIONE ESTA LINHA
// Caminho para o seu Chrome padrão
const caminhoChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ======================================================
// 🔗 CONEXÃO COM O SEU SERVIDOR POSTGRESQL (VIA TAILSCALE)
const client = new Client({
    connectionString: 'postgresql://postgres:Wallace@22@100.114.225.110:5432/stats_futebol'
});


// ======================================================
// 🗺️ MAPEAMENTO: FLASHSCORE -> COLUNAS DO BANCO
// ======================================================
const METRIC_MAP = {
    "Posse de bola": "posse_bola",
    "Total de finalizações": "finalizacoes",
    "Finalizações no alvo": "finalizacoes_no_gol",
    "Gols esperados (xG)": "xg",
    "xGOT enfrentado": "xga",
    "Passes (Porcentagem)": "passes_porcentagem",
    "Passes (Certos)": "passes_certos",
    "Passes (Total)": "passes_total",
    "Escanteios": "escanteios",
    "Chances claras": "chances_clara",
    "Toques dentro da área adversária": "toques_area_adversaria",
    "Passes em profundidade certos": "passes_profundidade_certos",
    "Faltas": "faltas",
    "Faltas Cobradas": "faltas_cobradas",
    "Laterais Cobrados": "laterais_cobradas",
    "Cartões amarelos": "cartoes_amarelos",
    "Cartões vermelhos": "cartao_vermelho",
    "Impedimentos": "impedimentos",
    "Finalizações para fora": "finalizacoes_para_fora",
    "Finalizações bloqueadas": "finalizacoes_bloqueadas",
    "Finalizações de dentro da área": "finalizacoes_de_dentro_area",
    "Finalizações de fora da área": "finalizacoes_de_fora_area",
    "Bolas na trave": "bolas_na_trave",
    "Defesas do goleiro": "defesas_goleiro",
    "xG das finalizações no alvo (xGOT)": "xgot",
    "Assistências esperadas (xA)": "xa",
    "Gols evitados": "gols_evitados",
    "Rebatidas": "rebatidas",
    "Interceptações": "interceptacoes",
    "Duelos ganhos": "duelos_ganhos",
    "Erros que resultaram em finalização": "erros_resultaram_finalizacao",
    "Erros que resultaram em gol": "erros_resultaram_gol",
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
    "Ataques perigosos": "ataques_perigosos",
    "xG Contra": "xg_contra"
};

// --- Inicialização do Banco de Dados PostgreSQL ---
// --- Inicialização do Banco de Dados PostgreSQL ---
async function iniciarBancoDeDados() {
    try {
        // Tenta conectar. Se já estiver conectado, ele captura o erro, ignora e segue em frente.
        try {
            await client.connect();
            console.log('✅ LOG BD: Banco de dados PostgreSQL (Matriz) conectado!');
        } catch (connErr) {
            if (connErr.message.includes('already been connected')) {
                // Silenciosamente aceita que já está conectado e continua
            } else {
                throw connErr; // Se for erro de senha ou rede, ele acusa normalmente
            }
        }

        await client.query(`
            CREATE TABLE IF NOT EXISTS times (
                id SERIAL PRIMARY KEY,
                nome TEXT NOT NULL,
                flashscore_id TEXT UNIQUE NOT NULL,
                flashscore_slug TEXT NOT NULL,
                pais TEXT,
                coletado INTEGER DEFAULT 0
            )
        `);
        return client;
    } catch (erro) {
        console.error(`❌ ERRO BD: Falha ao inicializar o PostgreSQL: ${erro.message}`);
        throw erro;
    }
}

// --- Inicialização do Navegador ---
async function iniciarNavegador() {
    console.log('🌐 LOG NAVEGADOR: Iniciando Google Chrome padrão...');
    const navegador = await puppeteer.launch({
        headless: false,
        executablePath: caminhoChrome,
        defaultViewport: { width: 1366, height: 768 }
    });
    const pagina = await navegador.newPage();
    return { navegador, pagina };
}

function pausa(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ==========================================
// --- FILTRO INTELIGENTE DE LINKS REPETIDOS ---
// ==========================================
// ==========================================
// --- FILTRO INTELIGENTE DE LINKS REPETIDOS ---
// ==========================================
async function filtrarLinksNovos(client, arrayDeLinks) {
    if (!arrayDeLinks || arrayDeLinks.length === 0) return [];

    console.log(`\n🧠 LOG FILTRO: Analisando ${arrayDeLinks.length} links para evitar trabalho duplicado...`);

    // 1. Extrai o ID do jogo usando a sua lógica do 'mid='
    const linksComIds = arrayDeLinks.map(link => {
        let id = null;

        // Prioridade 1: Tenta achar o ID pelo "mid=" (Formato da página do time)
        if (link.includes('mid=')) {
            // Pega o que vem depois do "mid=" e recorta exatamente 8 caracteres
            id = link.split('mid=')[1].substring(0, 8);
        }
        // Prioridade 2: Se não tiver mid=, tenta o formato /jogo/ID/ 
        else {
            const matchRegex = link.match(/\/(?:jogo|match)\/([a-zA-Z0-9]{8})/);
            if (matchRegex) id = matchRegex[1];
        }

        return { link, id };
    }).filter(item => item.id !== null);

    if (linksComIds.length === 0) {
        console.log(`⚠️ LOG FILTRO: Não foi possível extrair os IDs dos links. O robô vai processar todos por segurança.`);
        return arrayDeLinks;
    }

    // 2. Consulta o banco de dados
    const idsExtraidos = linksComIds.map(item => item.id);
    const placeholders = idsExtraidos.map((_, i) => `$${i + 1}`).join(',');
    const query = `SELECT flashscore_id FROM jogos WHERE flashscore_id IN (${placeholders})
       UNION

    SELECT flashscore_id
    FROM jogos_sem_estatisticas
    WHERE flashscore_id IN (${placeholders})`;

    try {
        const res = await client.query(query, idsExtraidos);

        const idsNoBanco = new Set(res.rows.map(row => row.flashscore_id));

        // 3. Filtra mantendo APENAS os inéditos
        const linksNovos = linksComIds
            .filter(item => !idsNoBanco.has(item.id))
            .map(item => item.link);

        console.log(`🧠 LOG FILTRO: Dos ${arrayDeLinks.length} links, ${idsNoBanco.size} já estão no banco.`);
        console.log(`🧠 LOG FILTRO: Restaram ${linksNovos.length} JOGOS INÉDITOS para processar.`);

        return linksNovos;
    } catch (erro) {
        console.error(`❌ Erro no filtro inteligente: ${erro.message}`);
        return arrayDeLinks;
    }
}


async function coletaViaCalendario(db, navegador) {
    console.log('\n🔍 LOG FASE 1: Buscando jogos prontos para coleta na tabela calendario...');

    try {
        const resCalendario = await client.query(`
            SELECT flashscore_id, url 
            FROM calendario 
            WHERE status_coletado = 0 
              AND jogo_adiado = 0 
              AND data_jogo::DATE <= CURRENT_DATE
            ORDER BY data_jogo ASC, hora_jogo ASC
            LIMIT 50 
            FOR UPDATE SKIP LOCKED
        `);

        if (resCalendario.rows.length === 0) {
            console.log('⚠️ LOG FASE 1: Nenhum jogo pendente encontrado no calendário.');
            return false;
        }

        const flashscoreIdsLote = resCalendario.rows.map(r => r.flashscore_id);
        let arrayDeLinks = resCalendario.rows.map(row => row.url).filter(url => url !== null);
        console.log(`🎯 LOG FASE 1: Foram resgatados ${arrayDeLinks.length} links direto do calendário.`);

        arrayDeLinks = await filtrarLinksNovos(db, arrayDeLinks);

        if (arrayDeLinks.length === 0) {
            console.log(`✅ LOG FASE 1: Os jogos deste lote já estão no banco principal. Atualizando calendário...`);
            await client.query(`UPDATE calendario SET status_coletado = 1 WHERE flashscore_id = ANY($1::text[])`, [flashscoreIdsLote]);
            return true;
        }

        try {
            // Raspa os detalhes do lote inteiro de uma vez
            const dadosCompletos = await processarJogosEmLotes(arrayDeLinks, navegador);

            const dadosValidos = {};
            let jogosComAnomalia = [];

            // Separa quem é jogo bom de quem está cancelado/adiado (placar nulo)
            for (const fsId in dadosCompletos) {
                const jogo = dadosCompletos[fsId];

                if (jogo.casa.placar === null || jogo.fora.placar === null) {
                    const motivo = jogo.status_partida || 'Adiado/Cancelado';
                    console.log(`⚠️ LOG TRAVA: Jogo ${jogo.casa.nome} x ${jogo.fora.nome} (${fsId}) detectado como: ${motivo}. Movendo para o calendário...`);
                    jogosComAnomalia.push({ id: fsId, motivo: motivo });
                } else {
                    dadosValidos[fsId] = jogo;
                }
            }

            // 1. PROCESSA APENAS OS JOGOS BONS (Fluxo Completo)
            if (Object.keys(dadosValidos).length > 0) {
                await inserirJogos(db, dadosValidos);
                await inserirEventosESumario(db, dadosValidos);

                const pastasProntas = await prepararEstatisticas(db);
                await coletarEstatisticas(db, pastasProntas, navegador);

                // Dá baixa de concluído apenas nos válidos
                const idsValidos = Object.keys(dadosValidos);
                await client.query(`UPDATE calendario SET status_coletado = 1 WHERE flashscore_id = ANY($1::text[])`, [idsValidos]);
            }

            // 2. TRATA OS RUINS (Atualiza o calendário com o motivo e bloqueia novas buscas)
            if (jogosComAnomalia.length > 0) {
                for (const anomalia of jogosComAnomalia) {
                    await client.query(
                        `UPDATE calendario SET jogo_adiado = 1, status_partida = $1 WHERE flashscore_id = $2`,
                        [anomalia.motivo, anomalia.id]
                    );
                }
                console.log(`🚩 LOG: ${jogosComAnomalia.length} jogos marcados como adiados/cancelados no calendário.`);
            }

            console.log(`\n✅ LOG: Lote do calendário processado com sucesso!`);
            return true;

        } catch (erroFases) {
            console.error(`❌ ERRO NO PROCESSAMENTO DO LOTE (Calendário):`, erroFases.message);
            if (flashscoreIdsLote.length > 0) {
                await client.query(`UPDATE calendario SET status_coletado = 1 WHERE flashscore_id = ANY($1::text[])`, [flashscoreIdsLote]);
            }
            return true;
        }

    } catch (erro) {
        console.error('❌ ERRO BD (Calendário):', erro.message);
        throw erro;
    }
}
async function scrapStatsFromPage(page, label) {
    try {
        await page.waitForSelector('[data-testid="wcl-statistics"]', { timeout: 12000 });
        const data = await page.evaluate(() => {
            const extractFsId = (selector) => {
                const link = document.querySelector(selector);
                if (!link || !link.href) return null;
                const partes = link.href.split('/').filter(p => p !== "");
                return partes[partes.length - 1];
            };
            const homeFsId = extractFsId('.duelParticipant__home .participant__participantName a');
            const awayFsId = extractFsId('.duelParticipant__away .participant__participantName a');
            const homeStats = {};
            const awayStats = {};
            const parsePercentage = (raw) => parseFloat(raw.replace('%', '')) || 0;
            const parseFraction = (raw) => {
                const match = raw.match(/(\d+)\/(\d+)/);
                return match ? { success: parseInt(match[1]), total: parseInt(match[2]) } : null;
            };
            const parseSimpleValue = (raw) => parseFloat(raw.trim().replace(',', '.')) || 0;

            const rows = document.querySelectorAll('[data-testid="wcl-statistics"]');
            rows.forEach(row => {
                const categoryEl = row.querySelector('[data-testid="wcl-scores-simple-text-01"]');
                if (!categoryEl) return;
                const statName = categoryEl.textContent.trim();

                const labelRow = row.querySelector('.wcl-labelRow_42JBQ');
                if (!labelRow) return;

                const allValueEls = Array.from(labelRow.querySelectorAll('.wcl-value_Ywp3J'));
                const awayValueEl = labelRow.querySelector('.wcl-awayValue_smmfR .wcl-value_Ywp3J');
                const homeValueEl = allValueEls.find(el => el !== awayValueEl);
                if (!homeValueEl || !awayValueEl) return;

                const processValue = (el, targetObj) => {
                    // detecta formato fração pelo span dedicado, não pela posição do texto
                    // (a ordem porcentagem/fração varia entre casa e fora)
                    const fracSpan = el.querySelector('[data-testid="wcl-scores-caption-05"]');
                    if (fracSpan) {
                        const fracText = fracSpan.textContent.trim();
                        const percentText = el.textContent.replace(fracSpan.textContent, '').trim();
                        const f = parseFraction(fracText);
                        targetObj[`${statName} (Porcentagem)`] = parsePercentage(percentText);
                        targetObj[`${statName} (Certos)`] = f ? f.success : 0;
                        targetObj[`${statName} (Total)`] = f ? f.total : 0;
                    } else {
                        const text = el.textContent.trim();
                        if (text.includes('%')) {
                            targetObj[statName] = parsePercentage(text);
                        } else {
                            targetObj[statName] = parseSimpleValue(text);
                        }
                    }
                };
                processValue(homeValueEl, homeStats);
                processValue(awayValueEl, awayStats);
            });
            return { homeFsId, awayFsId, homeStats, awayStats };
        });
        if (data && data.homeStats && Object.keys(data.homeStats).length > 0) {
            console.log(`📈 [COLETA: ${label}] capturada com sucesso.`);
        }
        return data;
    } catch (err) {
        console.log(`⚠️  [INFO] Sem dados de estatísticas para a aba: ${label}`);
        return null;
    }
}

async function processarJogosEmLotes(links, navegador) {
    const TAMANHO_LOTE = 5;
    const todasAsPastas = {};
    console.log(`\n🚀 LOG FASE 2: Iniciando processamento de ${links.length} links em lotes de ${TAMANHO_LOTE}...`);
    for (let i = 0; i < links.length; i += TAMANHO_LOTE) {
        const loteDeLinks = links.slice(i, i + TAMANHO_LOTE);
        console.log(`\n📦 Processando Lote ${Math.floor(i / TAMANHO_LOTE) + 1} (Links de ${i + 1} a ${i + loteDeLinks.length})`);
        const resultadosDoLote = await Promise.all(
            loteDeLinks.map(link => rasparDetalhesDoJogo(link, navegador))
        );
        for (const resultado of resultadosDoLote) {
            if (resultado && resultado.flashscore_id) {
                todasAsPastas[resultado.flashscore_id] = resultado.dados;
            }
        }
        console.log(`⏳ Lote processado. Pequena pausa antes do próximo...`);
        await pausa(2, 4);
    }
    console.log(`\n✅ LOG FASE 2: Extração finalizada! Dados armazenados:`);
    return todasAsPastas;
}

async function rasparDetalhesDoJogo(linkBase, navegador) {
    let paginaJogo;
    try {
        paginaJogo = await navegador.newPage();
        const idJogo = linkBase.includes('?mid=') ? linkBase.split('?mid=').pop() : null;
        await paginaJogo.goto(linkBase, { waitUntil: 'domcontentloaded', timeout: 45000 }); await paginaJogo.waitForSelector('.duelParticipant', { timeout: 15000 });
        await new Promise(r => setTimeout(r, 1500));
        const dadosResumo = await paginaJogo.evaluate(() => {
            const extrairFsId = (seletor) => {
                const link = document.querySelector(seletor);
                if (!link || !link.href) return null;
                const partes = link.href.split('/').filter(p => p !== "");
                return partes[partes.length - 1];
            };
            const extrairIdJogador = (elementoAnchor) => {
                if (!elementoAnchor || !elementoAnchor.href) return null;
                const partes = elementoAnchor.href.split('/').filter(p => p !== "");
                return partes[partes.length - 1];
            };
            const limparNome = (nome) => {
                if (!nome) return null;
                return nome.replace(/\s*\([A-Za-z]{3}\)\s*$/, '').trim();
            };
            let competicao = "";
            let rodada = "";
            let pais = "";
            let slug_liga = "";
            let slug_pais = "";

            const items = document.querySelectorAll('li[data-testid="wcl-breadcrumbsItem"]');

            if (items.length >= 3) {
                // 1. Extrai o País (Índice 1)
                const spanPais = items[1].querySelector('span[data-testid="wcl-scores-overline-03"]');
                pais = spanPais ? spanPais.textContent.trim() : "";

                // 2. Extrai a Competição e a Rodada (Índice 2)
                const itemLiga = items[2];
                const linkLiga = itemLiga.querySelector('a');
                const spanLiga = itemLiga.querySelector('span[data-testid="wcl-scores-overline-03"]');

                if (spanLiga) {
                    const texto = spanLiga.textContent.trim();
                    const splitIdx = texto.indexOf(' - ');

                    if (splitIdx !== -1) {
                        competicao = texto.substring(0, splitIdx).trim();
                        rodada = texto.substring(splitIdx + 3).trim();
                    } else {
                        competicao = texto;
                    }
                }

                // 3. Extrai os Slugs direto do link
                if (linkLiga) {
                    const href = linkLiga.getAttribute('href');
                    const parts = href.split('/').filter(Boolean);
                    if (parts.length >= 3) {
                        slug_pais = parts[1];
                        slug_liga = parts[2];
                    }
                }
            }
            const dataHoraCrua = document.querySelector('.duelParticipant__startTime')?.textContent || '';
            const partesDataHora = dataHoraCrua.split(' ');
            let dataJogo = partesDataHora[0] || '';
            const horaJogo = partesDataHora[1] || '';
            if (dataJogo.includes('.')) {
                const p = dataJogo.split('.');
                if (p.length === 3) dataJogo = `${p[2]}-${p[1]}-${p[0]}`;
            }
            const nomeCasa = limparNome(document.querySelector('.duelParticipant__home .participant__participantName')?.textContent);
            const nomeFora = limparNome(document.querySelector('.duelParticipant__away .participant__participantName')?.textContent);
            const idCasa = extrairFsId('.duelParticipant__home .participant__participantName a');
            const idFora = extrairFsId('.duelParticipant__away .participant__participantName a');
            let placarCasa = null;
            let placarFora = null;
            const scoreWrapper = document.querySelector('.detailScore__wrapper');
            if (scoreWrapper) {
                const spansComTexto = Array.from(scoreWrapper.querySelectorAll('span'))
                    .map(s => s.textContent.trim())
                    .filter(texto => texto !== '' && texto !== '-');
                if (spansComTexto.length >= 2) {
                    placarCasa = spansComTexto[0];
                    placarFora = spansComTexto[1];
                }
            }
            let statusPartida = null;
            if (placarCasa === null || placarFora === null) {
                const statusEl = document.querySelector('.fixedHeaderDuel__detailStatus');
                if (statusEl) {
                    statusPartida = statusEl.textContent.trim();
                }
            }
            const incidentesCasa = [];
            const incidentesFora = [];
            const linhasIncidentes = document.querySelectorAll('.smv__participantRow');
            linhasIncidentes.forEach(linha => {
                const eDaCasa = linha.classList.contains('smv__homeParticipant');
                const tempo = linha.querySelector('.smv__timeBox')?.textContent.trim() || '';
                const descricao = linha.querySelector('.smv__subIncident')?.textContent.trim() || null;
                let tipo = 'desconhecido';
                if (linha.querySelector('.incidents-goal-soccer') || linha.querySelector('[data-testid="wcl-icon-incidents-goal-soccer"]')) tipo = 'gol';
                else if (linha.querySelector('.yellowCard-ico') || linha.querySelector('[data-testid="wcl-icon-incidents-yellow-card"]')) tipo = 'cartao_amarelo';
                else if (linha.querySelector('.redCard-ico') || linha.querySelector('[data-testid="wcl-icon-incidents-red-card"]')) tipo = 'cartao_vermelho';
                else if (linha.querySelector('[data-testid="wcl-icon-incidents-red-card-second"]')) tipo = 'cartao_vermelho';
                else if (linha.querySelector('[data-testid="wcl-icon-incidents-substitution"]')) tipo = 'substituicao';
                const elJogadorPrincipal = linha.querySelector('a.smv__playerName');
                const nomePrincipal = elJogadorPrincipal?.textContent.trim() || null;
                const idPrincipal = extrairIdJogador(elJogadorPrincipal);
                let nomeSecundario = null;
                let idSecundario = null;
                if (tipo === 'gol') {
                    const elAssist = linha.querySelector('.smv__assist a');
                    if (elAssist) {
                        nomeSecundario = elAssist.textContent.trim();
                        idSecundario = extrairIdJogador(elAssist);
                    }
                } else if (tipo === 'substituicao') {
                    const elSubOut = linha.querySelector('.smv__subDown');
                    if (elSubOut) {
                        nomeSecundario = elSubOut.textContent.trim();
                        idSecundario = extrairIdJogador(elSubOut);
                    }
                }
                const incidente = {
                    tempo,
                    tipo,
                    descricao_evento: descricao,
                    jogador_principal: { nome: nomePrincipal, id: idPrincipal },
                    jogador_secundario: (nomeSecundario || idSecundario) ? { nome: nomeSecundario, id: idSecundario } : null
                };
                if (eDaCasa) incidentesCasa.push(incidente);
                else incidentesFora.push(incidente);
            });
            return {
                comum: { dataJogo, horaJogo, competicao, rodada, slug_liga, slug_pais, pais, statusPartida },
                casa: { nome: nomeCasa, id: idCasa, placar: placarCasa, incidentes: incidentesCasa },
                fora: { nome: nomeFora, id: idFora, placar: placarFora, incidentes: incidentesFora }
            };
        });
        const pastaDoJogo = {
            flashscore_id: idJogo,
            link_estatisticas: linkBase,
            dados: {
                link_no_banco: linkBase,
                flashscore_slug_liga: dadosResumo.comum.slug_liga,
                flashscore_slug_pais_liga: dadosResumo.comum.slug_pais,
                pais_liga: dadosResumo.comum.pais,
                status_partida: dadosResumo.comum.statusPartida, // <-- Guarda no pacotão final
                casa: {
                    flashscore_id: dadosResumo.casa.id,
                    nome: dadosResumo.casa.nome,
                    placar: dadosResumo.casa.placar,
                    data_jogo: dadosResumo.comum.dataJogo,
                    hora_jogo: dadosResumo.comum.horaJogo,
                    competicao: dadosResumo.comum.competicao,
                    rodada: dadosResumo.comum.rodada,
                    incidentes: dadosResumo.casa.incidentes,
                    estatisticas: {}
                },
                fora: {
                    flashscore_id: dadosResumo.fora.id,
                    nome: dadosResumo.fora.nome,
                    placar: dadosResumo.fora.placar,
                    data_jogo: dadosResumo.comum.dataJogo,
                    hora_jogo: dadosResumo.comum.horaJogo,
                    competicao: dadosResumo.comum.competicao,
                    rodada: dadosResumo.comum.rodada,
                    incidentes: dadosResumo.fora.incidentes,
                    estatisticas: {}
                }
            }
        };
        return pastaDoJogo;
    } catch (erro) {
        console.error(`❌ Erro ao raspar o jogo ${linkBase}: ${erro.message}`);
        return null;
    } finally {
        if (paginaJogo) {
            await paginaJogo.close().catch(e => { });
        }
    }
}

// ==========================================
// --- FASE 3: INSERÇÃO NO BANCO DE DADOS (POSTGRESQL) ---
// ==========================================
async function inserirJogos(db, dadosCompletos) {
    console.log(`\n💾 LOG FASE 3: Iniciando inserção de jogos na tabela 'jogos'...`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS jogos (
            id SERIAL PRIMARY KEY,
            flashscore_id TEXT NOT NULL UNIQUE,
            data_jogo TEXT NOT NULL,
            hora_jogo TEXT,
            id_competicao INTEGER,
            rodada TEXT, 
            id_time_casa INTEGER,
            id_time_fora INTEGER,
            placar_casa INTEGER,
            placar_fora INTEGER,
            temporada TEXT, 
            estatisticas_coletadas INTEGER DEFAULT 0, 
            periodo_coletado INTEGER DEFAULT 0, 
            link_estatisticas TEXT, 
            jogo_salvo INTEGER DEFAULT 0, 
            nome_competicao TEXT, 
            nome_time_casa TEXT, 
            nome_time_fora TEXT, 
            atualizado_casa_fora INTEGER DEFAULT 0, 
            flashscore_id_time_casa TEXT, 
            flashscore_id_time_fora TEXT, 
            flashscore_id_competicao VARCHAR(20) NULL, 
            status_liga_processada BOOLEAN DEFAULT FALSE, 
            flashscore_slug_liga VARCHAR(50) NULL,
            flashscore_slug_pais_liga VARCHAR(50) NULL, 
            pais_liga VARCHAR(100) NULL
        )
    `);

    const buscarOuInserirTime = async (flashscoreId, nomeTime) => {
        if (!flashscoreId) return null;
        const res = await client.query(`SELECT id FROM times WHERE flashscore_id = $1`, [flashscoreId]);
        if (res.rows.length > 0) return res.rows[0].id;

        const slugProvisorio = nomeTime ? nomeTime.toLowerCase().replace(/\s+/g, '-') : 'sem-slug';
        try {
            const insertRes = await client.query(`
                INSERT INTO times (nome, flashscore_id, flashscore_slug, pais, coletado) 
                VALUES ($1, $2, $3, $4, $5) RETURNING id
            `, [nomeTime, flashscoreId, slugProvisorio, null, 0]);
            console.log(`➕ Novo time cadastrado no susto: ${nomeTime} (ID Interno: ${insertRes.rows[0].id})`);
            return insertRes.rows[0].id;
        } catch (err) {
            console.error(`⚠️ Erro ao criar time novo (${nomeTime}):`, err.message);
            return null;
        }
    };

    const chavesJogos = Object.keys(dadosCompletos);
    let inseridos = 0;

    for (const idJogo of chavesJogos) {
        const jogo = dadosCompletos[idJogo];

        await client.query(`DELETE FROM eventos_jogo WHERE flashscore_id_jogo = $1`, [idJogo]);
        await client.query(`DELETE FROM sumario WHERE flashscore_id_jogo = $1`, [idJogo]);

        const idInternoCasa = await buscarOuInserirTime(jogo.casa.flashscore_id, jogo.casa.nome);
        const idInternoFora = await buscarOuInserirTime(jogo.fora.flashscore_id, jogo.fora.nome);

        const placarCasa = jogo.casa.placar ? parseInt(jogo.casa.placar) : null;
        const placarFora = jogo.fora.placar ? parseInt(jogo.fora.placar) : null;

        let idCompeticao = null;
        if (jogo.flashscore_slug_liga && jogo.flashscore_slug_pais_liga) {
            const resComp = await client.query(
                `SELECT id FROM competicoes WHERE flashscore_slug = $1 AND flashscore_slug_pais = $2 LIMIT 1`,
                [jogo.flashscore_slug_liga, jogo.flashscore_slug_pais_liga]
            );
            if (resComp.rows.length > 0) {
                idCompeticao = resComp.rows[0].id;
            }
        }

        const queryInsert = `
            INSERT INTO jogos (
                flashscore_id, data_jogo, hora_jogo, id_competicao, rodada, 
                id_time_casa, id_time_fora, placar_casa, placar_fora, temporada, 
                estatisticas_coletadas, periodo_coletado, link_estatisticas, jogo_salvo, 
                nome_competicao, nome_time_casa, nome_time_fora, atualizado_casa_fora, 
                flashscore_id_time_casa, flashscore_id_time_fora, flashscore_id_competicao, 
                status_liga_processada, flashscore_slug_liga, flashscore_slug_pais_liga, pais_liga
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
            ) ON CONFLICT (flashscore_id) DO NOTHING
        `;

        const valores = [
            idJogo,
            jogo.casa.data_jogo || null,
            jogo.casa.hora_jogo || null,
            idCompeticao,
            jogo.casa.rodada || null,
            idInternoCasa,
            idInternoFora,
            placarCasa,
            placarFora,
            null,
            +false, // estatisticas_coletadas vira 0
            +false, // periodo_coletado vira 0
            jogo.link_no_banco,
            +true,  // jogo_salvo vira 1
            jogo.casa.competicao || null,
            jogo.casa.nome || null,
            jogo.fora.nome || null,
            +false, // atualizado_casa_fora vira 0
            jogo.casa.flashscore_id || null,
            jogo.fora.flashscore_id || null,
            null,
            +false, // status_liga_processada vira 0
            jogo.flashscore_slug_liga || null,
            jogo.flashscore_slug_pais_liga || null,
            jogo.pais_liga || null
        ];

        try {
            const result = await client.query(queryInsert, valores);
            if (result.rowCount > 0) inseridos++;
            console.log(`⚽ [NOVO JOGO] ID: ${idJogo} | ${jogo.casa.nome} (${placarCasa ?? '?'}) x (${placarFora ?? '?'}) ${jogo.fora.nome} | Competição: ${jogo.casa.competicao || 'N/A'}`);

            await client.query(`UPDATE jogos SET jogo_salvo = 1 WHERE flashscore_id = $1`, [idJogo]);
        } catch (e) {
            console.error(`⚠️ Falha ao inserir o jogo ${idJogo}: ${e.message}`);
        }
    }
    console.log(`✅ LOG FASE 3: Processo concluído. ${inseridos} jogos novos salvos.`);
}

// ==========================================
// --- FASE 4: INSERÇÃO DE SUMÁRIO E EVENTOS (POSTGRESQL) ---
// ==========================================
async function inserirEventosESumario(db, dadosCompletos) {
    console.log(`\n📊 LOG FASE 4: Iniciando processamento do Sumário e Eventos...`);

    await client.query(`
        CREATE TABLE IF NOT EXISTS sumario (
            id SERIAL PRIMARY KEY,
            flashscore_id_jogo TEXT UNIQUE,
            nome_time_casa TEXT,
            nome_time_fora TEXT,
            gol_1tempo_casa INTEGER DEFAULT 0, gol_1tempo_fora INTEGER DEFAULT 0,
            gol_2tempo_casa INTEGER DEFAULT 0, gol_2tempo_fora INTEGER DEFAULT 0,
            cartao_1tempo_casa INTEGER DEFAULT 0, cartao_1tempo_fora INTEGER DEFAULT 0,
            cartao_2tempo_casa INTEGER DEFAULT 0, cartao_2tempo_fora INTEGER DEFAULT 0,
            gol_0_15 INTEGER DEFAULT 0, gol_16_30 INTEGER DEFAULT 0, gol_31_45 INTEGER DEFAULT 0,
            gol_46_60 INTEGER DEFAULT 0, gol_61_75 INTEGER DEFAULT 0, gol_76_90 INTEGER DEFAULT 0,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS eventos_jogo (
            id SERIAL PRIMARY KEY,
            flashscore_id_jogo TEXT NOT NULL,
            minuto INTEGER, minuto_extra INTEGER DEFAULT 0,
            periodo TEXT, ordem_evento INTEGER, tipo_evento TEXT, time TEXT,
            nome_jogador TEXT, flashscore_id_jogador TEXT,
            nome_assistencia TEXT, flashscore_id_assistencia TEXT,
            jogador_entrou TEXT, jogador_saiu TEXT, descricao_evento TEXT,
            criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    let sumariosInseridos = 0;
    let eventosInseridos = 0;

    for (const idJogo of Object.keys(dadosCompletos)) {
        const jogo = dadosCompletos[idJogo];
        let contadores = {
            g1t_c: 0, g1t_f: 0, g2t_c: 0, g2t_f: 0,
            c1t_c: 0, c1t_f: 0, c2t_c: 0, c2t_f: 0,
            g0_15: 0, g16_30: 0, g31_45: 0, g46_60: 0, g61_75: 0, g76_90: 0
        };

        let todosIncidentes = [];

        const processarArrayIncidentes = (array, timeLabel) => {
            array.forEach(inc => {
                let minuto = 0; let minutoExtra = 0;
                let tempoLimpo = inc.tempo.replace("'", "");
                if (tempoLimpo.includes('+')) {
                    const partes = tempoLimpo.split('+');
                    minuto = parseInt(partes[0]) || 0;
                    minutoExtra = parseInt(partes[1]) || 0;
                } else {
                    minuto = parseInt(tempoLimpo) || 0;
                }
                let periodo = minuto <= 45 ? '1T' : '2T';
                todosIncidentes.push({ ...inc, time: timeLabel, minuto, minutoExtra, periodo });
            });
        };

        processarArrayIncidentes(jogo.casa.incidentes, 'casa');
        processarArrayIncidentes(jogo.fora.incidentes, 'fora');

        todosIncidentes.sort((a, b) => {
            if (a.minuto !== b.minuto) return a.minuto - b.minuto;
            return a.minutoExtra - b.minutoExtra;
        });

        let ordem = 1;
        for (const inc of todosIncidentes) {
            if (inc.tipo === 'gol') {
                if (inc.time === 'casa' && inc.periodo === '1T') contadores.g1t_c++;
                if (inc.time === 'fora' && inc.periodo === '1T') contadores.g1t_f++;
                if (inc.time === 'casa' && inc.periodo === '2T') contadores.g2t_c++;
                if (inc.time === 'fora' && inc.periodo === '2T') contadores.g2t_f++;

                if (inc.minuto >= 0 && inc.minuto <= 15) contadores.g0_15++;
                else if (inc.minuto >= 16 && inc.minuto <= 30) contadores.g16_30++;
                else if (inc.minuto >= 31 && inc.minuto <= 45) contadores.g31_45++;
                else if (inc.minuto >= 46 && inc.minuto <= 60) contadores.g46_60++;
                else if (inc.minuto >= 61 && inc.minuto <= 75) contadores.g61_75++;
                else if (inc.minuto >= 76) contadores.g76_90++;
            }

            if (inc.tipo.includes('cartao')) {
                if (inc.time === 'casa' && inc.periodo === '1T') contadores.c1t_c++;
                if (inc.time === 'fora' && inc.periodo === '1T') contadores.c1t_f++;
                if (inc.time === 'casa' && inc.periodo === '2T') contadores.c2t_c++;
                if (inc.time === 'fora' && inc.periodo === '2T') contadores.c2t_f++;
            }

            let nome_jog = inc.jogador_principal?.nome || null;
            let id_jog = inc.jogador_principal?.id || null;
            let nome_ass = null; let id_ass = null;
            let jog_entrou = null; let jog_saiu = null;

            if (inc.tipo === 'gol') {
                nome_ass = inc.jogador_secundario?.nome || null;
                id_ass = inc.jogador_secundario?.id || null;
            } else if (inc.tipo === 'substituicao') {
                jog_entrou = inc.jogador_principal?.nome || null;
                jog_saiu = inc.jogador_secundario?.nome || null;
            }

            const qEvento = `
                INSERT INTO eventos_jogo (
                    flashscore_id_jogo, minuto, minuto_extra, periodo, ordem_evento, tipo_evento, time,
                    nome_jogador, flashscore_id_jogador, nome_assistencia, flashscore_id_assistencia,
                    jogador_entrou, jogador_saiu, descricao_evento
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            `;
            const vEvento = [
                idJogo, inc.minuto, inc.minutoExtra, inc.periodo, ordem, inc.tipo, inc.time,
                nome_jog, id_jog, nome_ass, id_ass, jog_entrou, jog_saiu, inc.descricao_evento
            ];

            try {
                await client.query(qEvento, vEvento);
                eventosInseridos++;
            } catch (e) { console.log(`Erro ao inserir evento:`, e.message); }

            ordem++;
        }

        const qSumario = `
            INSERT INTO sumario (
                flashscore_id_jogo, nome_time_casa, nome_time_fora,
                gol_1tempo_casa, gol_1tempo_fora, gol_2tempo_casa, gol_2tempo_fora,
                cartao_1tempo_casa, cartao_1tempo_fora, cartao_2tempo_casa, cartao_2tempo_fora,
                gol_0_15, gol_16_30, gol_31_45, gol_46_60, gol_61_75, gol_76_90
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) 
            ON CONFLICT (flashscore_id_jogo) DO NOTHING
        `;
        const vSumario = [
            idJogo, jogo.casa.nome, jogo.fora.nome,
            contadores.g1t_c, contadores.g1t_f, contadores.g2t_c, contadores.g2t_f,
            contadores.c1t_c, contadores.c1t_f, contadores.c2t_c, contadores.c2t_f,
            contadores.g0_15, contadores.g16_30, contadores.g31_45, contadores.g46_60, contadores.g61_75, contadores.g76_90
        ];

        try {
            const resSum = await client.query(qSumario, vSumario);
            if (resSum.rowCount > 0) sumariosInseridos++;
        } catch (e) { console.log(`Erro sumario:`, e.message); }
    }
    console.log(`✅ LOG FASE 4: Processo concluído. ${sumariosInseridos} sumários e ${eventosInseridos} eventos inseridos.`);
}

// ==========================================
// --- FASE 5: TRIAGEM E PREPARO DE ESTATÍSTICAS ---
// ==========================================
async function prepararEstatisticas(db) {
    console.log(`\n📊 LOG FASE 5: Iniciando triagem de jogos para estatísticas...`);

    // AJUSTE CIRÚRGICO: Sequestra os jogos marcando como 4 e pula os que já estiverem trancados
    const resJogos = await client.query(`
        UPDATE jogos 
        SET estatisticas_coletadas = 4 
        WHERE id IN (
            SELECT id FROM jogos 
            WHERE estatisticas_coletadas = 0 AND jogo_salvo = 1 
            ORDER BY id ASC 
            LIMIT 700
            FOR UPDATE SKIP LOCKED
        ) RETURNING *
    `);
    const jogosPendentes = resJogos.rows || [];

    if (jogosPendentes.length === 0) {
        console.log('✅ LOG FASE 5: Nenhum jogo pendente para coletar estatísticas.');
        return {};
    }

    console.log(`🔍 LOG FASE 5: Encontrados ${jogosPendentes.length} jogos pendentes. Analisando competições...`);

    let jogosMovidos = 0;
    const arrayDePastas = {};

    for (const jogo of jogosPendentes) {
        let temEstats = 1; // Assume que tem por padrão

        try {
            // Verifica se a tabela competicoes existe e pega o status
            const resComp = await client.query(`SELECT tem_estatisticas FROM competicoes WHERE id = $1 LIMIT 1`, [jogo.id_competicao]);
            if (resComp.rows.length > 0) temEstats = resComp.rows[0].tem_estatisticas;
        } catch (e) { } // Se a tabela não existir, ignora e assume que tem estatística.

        if (temEstats === 0) {
            const queryDescarte = `
                INSERT INTO jogos_sem_estatisticas (
                    flashscore_id, data_jogo, hora_jogo, id_competicao, 
                    id_time_casa, id_time_fora, placar_casa, placar_fora, 
                    temporada, estatisticas_coletadas, periodo_coletado, link_estatisticas, 
                    jogo_salvo, nome_competicao, nome_time_casa, nome_time_fora, 
                    atualizado_casa_fora, flashscore_id_time_casa, flashscore_id_time_fora, 
                    flashscore_id_competicao, status_liga_processada, flashscore_slug_liga, rodada
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
                ) ON CONFLICT (flashscore_id) DO NOTHING
            `;

            const valoresDescarte = [
                jogo.flashscore_id,
                jogo.data_jogo,
                jogo.hora_jogo,
                jogo.id_competicao,
                jogo.id_time_casa,
                jogo.id_time_fora,
                jogo.placar_casa,
                jogo.placar_fora,
                jogo.temporada,
                +jogo.estatisticas_coletadas, // Vira 0 ou 1
                +jogo.periodo_coletado,       // Vira 0 ou 1
                jogo.link_estatisticas,
                +jogo.jogo_salvo,             // Vira 0 ou 1
                jogo.nome_competicao,
                jogo.nome_time_casa,
                jogo.nome_time_fora,
                +jogo.atualizado_casa_fora,   // Vira 0 ou 1
                jogo.flashscore_id_time_casa,
                jogo.flashscore_id_time_fora,
                jogo.flashscore_id_competicao,
                +jogo.status_liga_processada, // O VILÃO: Aqui ele vira número e o banco aceita!
                jogo.flashscore_slug_liga,
                jogo.rodada
            ];

            try {
                await client.query(queryDescarte, valoresDescarte);
                await client.query(`DELETE FROM jogos WHERE id = $1`, [jogo.id]);
                jogosMovidos++;
            } catch (erroDescarte) {
                console.error(`❌ Erro ao mover jogo ${jogo.flashscore_id}:`, erroDescarte.message);
            }
        } else {
            const partesLink = jogo.link_estatisticas.split('?mid=');
            const urlBase = partesLink[0];
            const idMid = partesLink[1];

            const links_coleta = {
                total: `${urlBase}resumo/estatisticas/total/?mid=${idMid}`,
                primeiro_tempo: `${urlBase}resumo/estatisticas/1o-tempo/?mid=${idMid}`,
                segundo_tempo: `${urlBase}resumo/estatisticas/2o-tempo/?mid=${idMid}`
            };

            arrayDePastas[jogo.flashscore_id] = {
                links_coleta: links_coleta,
                [jogo.flashscore_id_time_casa]: {
                    tipo_mando: 'casa', id_interno_time: jogo.id_time_casa,
                    flashscore_id_time: jogo.flashscore_id_time_casa, placar: jogo.placar_casa
                },
                [jogo.flashscore_id_time_fora]: {
                    tipo_mando: 'fora', id_interno_time: jogo.id_time_fora,
                    flashscore_id_time: jogo.flashscore_id_time_fora, placar: jogo.placar_fora
                }
            };
        }
    }

    console.log(`🗑️ LOG FASE 5: ${jogosMovidos} jogos movidos para 'jogos_sem_estatisticas' e deletados da tabela principal.`);
    console.log(`📁 LOG FASE 5: ${Object.keys(arrayDePastas).length} pastas de jogos criadas e prontas para extração.`);
    return arrayDePastas;
}

// ==========================================
// --- FASE 6: COLETA DE ESTATÍSTICAS EM LOTES ---
// ==========================================
async function coletarEstatisticas(db, pastas, navegador) {
    const idsJogos = Object.keys(pastas);
    if (idsJogos.length === 0) return;

    const TAMANHO_LOTE = 4;
    console.log(`\n🚀 LOG FASE 6: Iniciando coleta de estatísticas para ${idsJogos.length} jogos...`);

    for (let i = 0; i < idsJogos.length; i += TAMANHO_LOTE) {
        const loteAtual = idsJogos.slice(i, i + TAMANHO_LOTE);

        await Promise.all(loteAtual.map(async (idJogo) => {
            const pastaJogo = pastas[idJogo];
            let paginaStats;
            try {
                paginaStats = await navegador.newPage();

                // --- 1. ACESSA A ABA TOTAL ---
                console.log(`📡 [${idJogo}] Acessando Total...`);
                await paginaStats.goto(pastaJogo.links_coleta.total, { waitUntil: 'domcontentloaded', timeout: 50000 }); const statsTotal = await scrapStatsFromPage(paginaStats, "TOTAL");

                // 🛡️ AJUSTE: SE NÃO TIVER ESTATÍSTICAS, MOVE PARA 'SEM_ESTATISTICAS' IGUAL À FASE 5
                if (!statsTotal || !statsTotal.homeStats || Object.keys(statsTotal.homeStats).length === 0) {
                    console.log(`🗑️  [${idJogo}] Jogo sem dados reais. Movendo para descarte final...`);

                    // A. Busca o registro completo no banco para ter as 23 colunas
                    const resBanco = await client.query(`SELECT * FROM jogos WHERE flashscore_id = $1`, [idJogo]);
                    const jogo = resBanco.rows[0];

                    if (jogo) {
                        const queryDescarte = `
                        INSERT INTO jogos_sem_estatisticas (
                            flashscore_id, data_jogo, hora_jogo, id_competicao, 
                            id_time_casa, id_time_fora, placar_casa, placar_fora, 
                            temporada, estatisticas_coletadas, periodo_coletado, link_estatisticas, 
                            jogo_salvo, nome_competicao, nome_time_casa, nome_time_fora, 
                            atualizado_casa_fora, flashscore_id_time_casa, flashscore_id_time_fora, 
                            flashscore_id_competicao, status_liga_processada, flashscore_slug_liga, rodada
                        ) VALUES (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
                        ) ON CONFLICT (flashscore_id) DO NOTHING
                    `;

                        // B. Mapeamento com o truque do "+" para evitar erro de "false" (Integer)
                        const valoresDescarte = [
                            jogo.flashscore_id, jogo.data_jogo, jogo.hora_jogo, jogo.id_competicao,
                            jogo.id_time_casa, jogo.id_time_fora, jogo.placar_casa, jogo.placar_fora,
                            jogo.temporada,
                            +jogo.estatisticas_coletadas, // Garante 0 ou 1
                            +jogo.periodo_coletado,       // Garante 0 ou 1
                            jogo.link_estatisticas,
                            +jogo.jogo_salvo,             // Garante 0 ou 1
                            jogo.nome_competicao, jogo.nome_time_casa, jogo.nome_time_fora,
                            +jogo.atualizado_casa_fora,   // Garante 0 ou 1
                            jogo.flashscore_id_time_casa, jogo.flashscore_id_time_fora,
                            jogo.flashscore_id_competicao,
                            +jogo.status_liga_processada, // 👈 CORREÇÃO: Converte "false" p/ 0
                            jogo.flashscore_slug_liga, jogo.rodada
                        ];

                        try {
                            await client.query(queryDescarte, valoresDescarte);
                            await client.query(`DELETE FROM jogos WHERE flashscore_id = $1`, [idJogo]);
                            console.log(`✔️  [${idJogo}] Removido da fila com sucesso.`);
                        } catch (err) {
                            console.error(`❌ Erro ao processar descarte de ${idJogo}:`, err.message);
                        }
                    }
                    return; // Encerra aqui e pula para o próximo jogo do lote
                }

                // --- 2. SÓ CONTINUA SE O JOGO TIVER ESTATÍSTICAS ---
                console.log(`📡 [${idJogo}] Acessando 1º Tempo...`);
                await paginaStats.goto(pastaJogo.links_coleta.primeiro_tempo, { waitUntil: 'domcontentloaded', timeout: 35000 }); const stats1T = await scrapStatsFromPage(paginaStats, "1T");

                console.log(`📡 [${idJogo}] Acessando 2º Tempo...`);
                await paginaStats.goto(pastaJogo.links_coleta.segundo_tempo, { waitUntil: 'domcontentloaded', timeout: 35000 }); const stats2T = await scrapStatsFromPage(paginaStats, "2T");

                const idCasa = Object.keys(pastaJogo).find(k => pastaJogo[k].tipo_mando === 'casa');
                const idFora = Object.keys(pastaJogo).find(k => pastaJogo[k].tipo_mando === 'fora');

                // Preenchimento dos objetos para salvar no banco depois
                pastaJogo[idCasa].stats_total = statsTotal.homeStats || {};
                pastaJogo[idFora].stats_total = statsTotal.awayStats || {};

                if (stats1T) {
                    pastaJogo[idCasa].stats_1t = stats1T.homeStats || {};
                    pastaJogo[idFora].stats_1t = stats1T.awayStats || {};
                }
                if (stats2T) {
                    pastaJogo[idCasa].stats_2t = stats2T.homeStats || {};
                    pastaJogo[idFora].stats_2t = stats2T.awayStats || {};
                }

                console.log(`✅ [${idJogo}] Coleta finalizada com sucesso!`);
            } catch (erroAba) {
                console.error(`❌ [${idJogo}] Erro ao raspar abas: ${erroAba.message}`);
            } finally {
                if (paginaStats) await paginaStats.close().catch(() => { });
            }
        }));

        console.log(`💾 Inserindo dados do lote no banco de dados...`);
        await inserirEstatisticasLote(db, pastas, loteAtual);
        await pausa(3, 5);
    }
    console.log(`\n🏁 LOG FASE 6: Coleta de estatísticas totalmente concluída!`);
}

// ==========================================
// --- FASE 6.1: INSERÇÃO DAS ESTATÍSTICAS NO BANCO (POSTGRESQL) ---
// ==========================================
async function inserirEstatisticasLote(db, pastas, loteAtual) {
    const chavesMetricas = Object.keys(METRIC_MAP);
    const colunasBanco = Object.values(METRIC_MAP);
    const numColunas = colunasBanco.length;

    // Constrói dinamicamente os parâmetros ($1, $2, $3...) para o PostgreSQL
    const placeholdersGeral = Array.from({ length: 9 + numColunas }, (_, i) => `$${i + 1}`).join(', ');
    const sqlGeral = `
        INSERT INTO estatisticas_geral (
            id_jogo, id_time, flashscore_id_jogo, flashscore_id_time_casa, flashscore_id_time_fora, 
            nome_time, eh_casa, gols_marcados, gols_sofridos, ${colunasBanco.join(', ')}
        ) VALUES (${placeholdersGeral})
    `;

    const placeholdersPeriodo = Array.from({ length: 10 + numColunas }, (_, i) => `$${i + 1}`).join(', ');
    const sqlPeriodo = `
        INSERT INTO estatisticas_por_periodo (
            periodo, id_jogo, flashscore_id_jogo, id_time, flashscore_id_time_casa, flashscore_id_time_fora, 
            nome_time, eh_casa, gols_marcados, gols_sofridos, ${colunasBanco.join(', ')}
        ) VALUES (${placeholdersPeriodo})
    `;

    for (const flashscoreIdJogo of loteAtual) {
        const pastaJogo = pastas[flashscoreIdJogo];
        if (!pastaJogo) continue;

        const resOrigem = await client.query(`SELECT id, nome_time_casa, nome_time_fora FROM jogos WHERE flashscore_id = $1`, [flashscoreIdJogo]);
        const dadosOrigem = resOrigem.rows[0];

        if (!dadosOrigem) {
            console.error(`⚠️ Jogo ${flashscoreIdJogo} não encontrado na tabela 'jogos' para puxar o ID Interno.`);
            continue;
        }

        const idJogoInterno = dadosOrigem.id;
        const chavesTimes = Object.keys(pastaJogo).filter(k => k !== 'links_coleta');
        const idCasa = chavesTimes.find(k => pastaJogo[k].tipo_mando === 'casa');
        const idFora = chavesTimes.find(k => pastaJogo[k].tipo_mando === 'fora');

        const objCasa = pastaJogo[idCasa];
        const objFora = pastaJogo[idFora];
        // =================================================================
        // --- INÍCIO DA INJEÇÃO PRECISA DO xG CONTRA CRUZADO ---
        // Cruzamento Total
        if (objCasa.stats_total && objFora.stats_total) {
            objCasa.stats_total["xG Contra"] = objFora.stats_total["Gols esperados (xG)"] !== undefined ? objFora.stats_total["Gols esperados (xG)"] : null;
            objFora.stats_total["xG Contra"] = objCasa.stats_total["Gols esperados (xG)"] !== undefined ? objCasa.stats_total["Gols esperados (xG)"] : null;
        }
        // Cruzamento 1º Tempo
        if (objCasa.stats_1t && objFora.stats_1t) {
            objCasa.stats_1t["xG Contra"] = objFora.stats_1t["Gols esperados (xG)"] !== undefined ? objFora.stats_1t["Gols esperados (xG)"] : null;
            objFora.stats_1t["xG Contra"] = objCasa.stats_1t["Gols esperados (xG)"] !== undefined ? objCasa.stats_1t["Gols esperados (xG)"] : null;
        }
        // Cruzamento 2º Tempo
        if (objCasa.stats_2t && objFora.stats_2t) {
            objCasa.stats_2t["xG Contra"] = objFora.stats_2t["Gols esperados (xG)"] !== undefined ? objFora.stats_2t["Gols esperados (xG)"] : null;
            objFora.stats_2t["xG Contra"] = objCasa.stats_2t["Gols esperados (xG)"] !== undefined ? objCasa.stats_2t["Gols esperados (xG)"] : null;
        }
        const extrairValoresMetricas = (statsObj) => {
            return chavesMetricas.map(chave => {
                return (statsObj && statsObj[chave] !== undefined) ? statsObj[chave] : null;
            });
        };

        try {
            // ESTATÍSTICAS GERAIS (Total)
            if (objCasa.stats_total && Object.keys(objCasa.stats_total).length > 0) {
                await client.query(`DELETE FROM estatisticas_geral WHERE flashscore_id_jogo = $1 AND id_time = $2`, [flashscoreIdJogo, objCasa.id_interno_time]);
                const valoresCasaGeral = [
                    idJogoInterno, objCasa.id_interno_time, flashscoreIdJogo, objCasa.flashscore_id_time, objFora.flashscore_id_time,
                    dadosOrigem.nome_time_casa, 1, objCasa.placar, objFora.placar, ...extrairValoresMetricas(objCasa.stats_total)
                ];
                await client.query(sqlGeral, valoresCasaGeral);

                await client.query(`DELETE FROM estatisticas_geral WHERE flashscore_id_jogo = $1 AND id_time = $2`, [flashscoreIdJogo, objFora.id_interno_time]);
                const valoresForaGeral = [
                    idJogoInterno, objFora.id_interno_time, flashscoreIdJogo, objCasa.flashscore_id_time, objFora.flashscore_id_time,
                    dadosOrigem.nome_time_fora, 0, objFora.placar, objCasa.placar, ...extrairValoresMetricas(objFora.stats_total)
                ];
                await client.query(sqlGeral, valoresForaGeral);
            }

            // 1º TEMPO
            if (objCasa.stats_1t && Object.keys(objCasa.stats_1t).length > 0) {
                await client.query(`DELETE FROM estatisticas_por_periodo WHERE flashscore_id_jogo = $1 AND id_time = $2 AND periodo = '1_tempo'`, [flashscoreIdJogo, objCasa.id_interno_time]);
                const valoresCasa1T = [
                    '1_tempo', idJogoInterno, flashscoreIdJogo, objCasa.id_interno_time, objCasa.flashscore_id_time, objFora.flashscore_id_time,
                    dadosOrigem.nome_time_casa, 1, null, null, ...extrairValoresMetricas(objCasa.stats_1t)
                ];
                await client.query(sqlPeriodo, valoresCasa1T);

                await client.query(`DELETE FROM estatisticas_por_periodo WHERE flashscore_id_jogo = $1 AND id_time = $2 AND periodo = '1_tempo'`, [flashscoreIdJogo, objFora.id_interno_time]);
                const valoresFora1T = [
                    '1_tempo', idJogoInterno, flashscoreIdJogo, objFora.id_interno_time, objCasa.flashscore_id_time, objFora.flashscore_id_time,
                    dadosOrigem.nome_time_fora, 0, null, null, ...extrairValoresMetricas(objFora.stats_1t)
                ];
                await client.query(sqlPeriodo, valoresFora1T);
            }

            // 2º TEMPO
            if (objCasa.stats_2t && Object.keys(objCasa.stats_2t).length > 0) {
                await client.query(`DELETE FROM estatisticas_por_periodo WHERE flashscore_id_jogo = $1 AND id_time = $2 AND periodo = '2_tempo'`, [flashscoreIdJogo, objCasa.id_interno_time]);
                const valoresCasa2T = [
                    '2_tempo', idJogoInterno, flashscoreIdJogo, objCasa.id_interno_time, objCasa.flashscore_id_time, objFora.flashscore_id_time,
                    dadosOrigem.nome_time_casa, 1, null, null, ...extrairValoresMetricas(objCasa.stats_2t)
                ];
                await client.query(sqlPeriodo, valoresCasa2T);

                await client.query(`DELETE FROM estatisticas_por_periodo WHERE flashscore_id_jogo = $1 AND id_time = $2 AND periodo = '2_tempo'`, [flashscoreIdJogo, objFora.id_interno_time]);
                const valoresFora2T = [
                    '2_tempo', idJogoInterno, flashscoreIdJogo, objFora.id_interno_time, objCasa.flashscore_id_time, objFora.flashscore_id_time,
                    dadosOrigem.nome_time_fora, 0, null, null, ...extrairValoresMetricas(objFora.stats_2t)
                ];
                await client.query(sqlPeriodo, valoresFora2T);
            }

            await client.query(`UPDATE jogos SET estatisticas_coletadas = 1 WHERE id = $1`, [idJogoInterno]);
            console.log(`✔️  [${flashscoreIdJogo}] Salvo com sucesso no banco (Total, 1T e 2T). Status atualizado.`);

        } catch (erroDB) {
            console.error(`❌ Erro ao inserir dados do jogo ${flashscoreIdJogo} no BD:`, erroDB.message);
        }
    }
}

// --- Função Principal ---
async function principal() {
    let db;
    let navegador;
    try {
        db = await iniciarBancoDeDados();
        const setupNavegador = await iniciarNavegador();
        navegador = setupNavegador.navegador;
        // A página inicial aberta fica lá só para manter a janela do Chrome ativa
        const paginaDeFundo = setupNavegador.pagina;

        let temMaisTimes = true;

        while (temMaisTimes) {
            console.log('\n🔄 --- INICIANDO NOVO CICLO DE COLETA ---');
            // 🌟 MUDANÇA: Passamos 'navegador' ao invés de 'pagina'
            temMaisTimes = await coletaViaCalendario(db, navegador);
            if (temMaisTimes) {
                console.log('\n⏳ LOG: Aguardando 5 segundos para o próximo time da fila...');
                await pausa(5, 5); // Dei uma ajustada na pausa para dar fôlego ao robô
            } else {
                console.log('\n🏁 LOG: Todos os times com status 5 foram processados!');
            }
        }

        // ==========================================================
        // 🏁 BLOCO DE RESGATE (JOGOS ÓRFÃOS)
        // ==========================================================
        console.log('\n🧹 LOG: Verificando se restaram estatísticas de jogos pendentes (status 0)...');

        let pendentes = true;
        while (pendentes) {
            const pastasPendentes = await prepararEstatisticas(db);
            if (Object.keys(pastasPendentes).length > 0) {
                // USAMOS O NAVEGADOR QUE JÁ ESTÁ ABERTO
                await coletarEstatisticas(db, pastasPendentes, navegador);
            } else {
                pendentes = false;
                console.log('✅ LOG: Todos os jogos pendentes foram processados!');
            }
        }
        // ==========================================================

        // 🌐 AGORA SIM: Fecha o navegador só depois de processar TUDO
        if (navegador) {
            console.log('\n🌐 LOG NAVEGADOR: Fechando Chrome de times e jogos para liberar memória...');
            await navegador.close();
            navegador = null;
        }

        // ==========================================================
        // 🚀 AQUI ELE CHAMA O CÓDIGO DE JOGADORES POR FORA
        // ==========================================================
        console.log('\n⚡ INICIANDO O SCRAPER DE ESTATÍSTICAS DE JOGADORES...');
        await new Promise((resolve, reject) => {
            // ATENÇÃO: Confirme se o nome do seu arquivo salvo é esse mesmo
            const processoJogadores = spawn('node', ['coletarestatisticasjogador.js'], { stdio: 'inherit' });

            processoJogadores.on('close', (code) => {
                console.log(`\n✅ O scraper de jogadores finalizou (Código: ${code})`);
                resolve();
            });

            processoJogadores.on('error', (err) => {
                console.error(`❌ Erro ao tentar chamar o scraper de jogadores:`, err);
                reject(err);
            });
        });

    } catch (erroGeral) {
        console.error('❌ ERRO CRÍTICO NO MOTOR PRINCIPAL:', erroGeral);
    } finally {
        if (navegador) {
            await navegador.close().catch(() => { });
        }
        if (client) {
            console.log('💾 LOG BD: Fechando conexão com PostgreSQL...');
            await client.end();
        }
        console.log('--- OPERAÇÃO GERAL FINALIZADA COM SUCESSO ---');
    }
}

principal();

