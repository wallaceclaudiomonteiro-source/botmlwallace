let isPremium = false;

const modalJogo = document.getElementById('modal-jogo');
const modalLogin = document.getElementById('modal-login');
const detalhesJogo = document.getElementById('detalhes-jogo');
const listaJogos = document.getElementById('lista-jogos');

const chavesMercados = ['home', 'draw', 'away', 'over05', 'under05', 'over15', 'under15', 'over25', 'under25', 'over35', 'under35', 'btts_yes', 'btts_no', 'casa_over05', 'casa_over15', 'fora_over05', 'fora_over15', 'cantos_over35', 'cantos_over45', 'cantos_over55', 'cantos_over75', 'cantos_over85', 'cantos_over95', 'casa_cantos_over35', 'casa_cantos_over45', 'fora_cantos_over25', 'fora_cantos_over35', 'cartoes_over15', 'cartoes_over25', 'cartoes_over35', 'cartoes_over45', 'casa_cartoes_over15', 'casa_cartoes_over25', 'fora_cartoes_over15', 'fora_cartoes_over25'];
const chavesMercadosFT_ParaContagem = [
    'home', 'draw', 'away', 'over05', 'under05', 'over15', 'under15', 'over25', 'under25', 'over35', 'under35',
    'btts_yes', 'btts_no', 'casa_over05', 'casa_over15', 'fora_over05', 'fora_over15',
    'cantos_over15', 'cantos_over25', 'cantos_over35', 'cantos_over45', 'cantos_over55', 'cantos_over65', 'cantos_over75', 'cantos_over85', 'cantos_over95',
    'casa_cantos_over05', 'casa_cantos_over15', 'casa_cantos_over25', 'casa_cantos_over35', 'casa_cantos_over45',
    'fora_cantos_over05', 'fora_cantos_over15', 'fora_cantos_over25', 'fora_cantos_over35',
    'cartoes_over05', 'cartoes_over15', 'cartoes_over25', 'cartoes_over35', 'cartoes_over45',
    'casa_cartoes_over05', 'casa_cartoes_over15', 'casa_cartoes_over25',
    'fora_cartoes_over05', 'fora_cartoes_over15', 'fora_cartoes_over25'
];
// Substitua as funções iniciar() e carregarJogos() por estas:

async function iniciar() {
    try {
        // Truque Anti-Cache: Obriga o navegador a sempre baixar a lista mais nova
        const antiCache = new Date().getTime();
        const res = await fetch(`dados/datas_disponiveis.json?v=${antiCache}`);
        const datas = await res.json();

        const seletor = document.getElementById('seletor-data');
        seletor.innerHTML = ''; // Limpa antes de preencher

        datas.forEach(data => {
            const option = document.createElement('option');
            option.value = data;
            option.textContent = data.split('-').reverse().join('/');
            seletor.appendChild(option);
        });

        if (datas.length > 0) {
            seletor.value = datas[datas.length - 1];
            seletor.addEventListener('change', (e) => carregarJogos(e.target.value));
            carregarJogos(seletor.value);
        }
    } catch (err) {
        alert("Erro ao carregar a lista de datas do servidor.");
        console.error(err);
    }
}

async function carregarJogos(dataSelecionada) {
    try {
        // Mostra que está carregando enquanto baixa o arquivo levinho do dia
        listaJogos.innerHTML = `<p style="text-align:center;color:#94a3b8;padding:20px;grid-column:1/-1;">Carregando jogos...</p>`;

        // Baixa apenas o dia específico (Truque Anti-Cache)
        const antiCache = new Date().getTime();
        const res = await fetch(`dados/${dataSelecionada}.json?v=${antiCache}`);
        const jogos = await res.json();

        if (!Array.isArray(jogos) || jogos.length === 0) {
            listaJogos.innerHTML = `<p style="text-align:center;color:#94a3b8;padding:20px;grid-column:1/-1;">Nenhum jogo encontrado para esta data.</p>`;
            return;
        }

        listaJogos.innerHTML = '';
        let greensDia = 0, redsDia = 0;

        jogos.forEach(jogo => {
            const m = jogo.mercados || {};
            let gJogo = 0, rJogo = 0, pJogo = 0;

            // Só conta os sinais do FT para o card inicial não ficar poluído
            chavesMercadosFT_ParaContagem.forEach(merc => {
                const hist = m[`hist_${merc}`];
                if (hist && hist.status === 'ok') {
                    const resReal = m[`res_${merc}`];
                    if (resReal === 'GREEN') { greensDia++; gJogo++; }
                    else if (resReal === 'RED') { redsDia++; rJogo++; }
                    else { pJogo++; }
                }
            });

            let badgeSinais = (gJogo + rJogo + pJogo) > 0
                ? `<div style="margin-top: 10px; font-size: 11px; padding: 5px 8px; background: rgba(0,0,0,0.25); border: 1px solid #334155; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;"><span style="color:#94a3b8;">🎯 Sinais FT:</span><span><strong style="color:#a6e3a1">${gJogo}G</strong> &nbsp;|&nbsp; <strong style="color:#f38ba8">${rJogo}R</strong>${pJogo > 0 ? ` &nbsp;|&nbsp; <strong style="color:#94a3b8">${pJogo}⏳</strong>` : ''}</span></div>`
                : `<div style="margin-top: 10px; font-size: 11px; color: #64748b; text-align: center;">Nenhum padrão encontrado no FT</div>`;

            const card = document.createElement('div');
            card.className = 'game-card';
            card.onclick = () => abrirDetalhesJogo(jogo);
            card.innerHTML = `<span class="league-tag">${jogo.pais_liga || jogo.pais || 'Liga'} - ${jogo.nome_competicao || 'Liga'}</span><div class="time-row"><span>${jogo.casa || '-'}</span><span>vs</span><span>${jogo.fora || '-'}</span></div><small>⏰ ${jogo.hora || 'N/A'}</small>${badgeSinais}`;
            listaJogos.appendChild(card);
        });

        // ==========================================
        // PAINEL DE RESUMO DO DIA
        // ==========================================
        let resumoEl = document.getElementById('resumo-dia-painel');
        if (!resumoEl) {
            const seletor = document.getElementById('seletor-data');
            resumoEl = document.createElement('div');
            resumoEl.id = 'resumo-dia-painel';
            resumoEl.style.display = 'inline-flex'; resumoEl.style.alignItems = 'center'; resumoEl.style.marginLeft = '15px'; resumoEl.style.gap = '8px'; resumoEl.style.fontSize = '12px'; resumoEl.style.fontWeight = 'bold';
            seletor.parentNode.insertBefore(resumoEl, seletor.nextSibling);
        }

        const totalFechados = greensDia + redsDia;
        const taxaAcerto = totalFechados > 0 ? Math.round((greensDia / totalFechados) * 100) : 0;
        const corTaxa = taxaAcerto >= 70 ? '#a6e3a1' : (taxaAcerto >= 60 ? '#f9e2af' : '#f38ba8');

        let htmlResumo = `<span style="background: rgba(166, 227, 161, 0.15); color: #a6e3a1; padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(166,227,161,0.3);">🟢 ${greensDia} Greens</span><span style="background: rgba(243, 139, 168, 0.15); color: #f38ba8; padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(243,139,168,0.3);">🔴 ${redsDia} Reds</span>`;

        if (totalFechados > 0) {
            htmlResumo += `<span style="background: rgba(255,255,255,0.05); color: ${corTaxa}; padding: 6px 12px; border-radius: 6px; border: 1px solid ${corTaxa};">📈 ${taxaAcerto}% de acerto</span>`;
        }
        resumoEl.innerHTML = htmlResumo;

    } catch (err) {
        listaJogos.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:#f87171;padding:20px;">Erro: ${err.message}</p>`;
    }
}

function abrirLogin() { modalLogin.classList.remove('hidden'); }
function fecharLogin() { modalLogin.classList.add('hidden'); }
function mudarAbaLogin(aba) {
    document.getElementById('area-entrar').style.display = aba === 'entrar' ? 'block' : 'none';
    document.getElementById('area-criar').style.display = aba === 'criar' ? 'block' : 'none';
    document.getElementById('tab-entrar').classList.toggle('active', aba === 'entrar');
    document.getElementById('tab-criar').classList.toggle('active', aba === 'criar');
}
function fazerLogin() {
    const senha = document.getElementById('input-senha').value;
    if (['vip123', 'wallace2026'].includes(senha)) {
        isPremium = true;
        document.getElementById('btn-abrir-login').style.display = 'none';
        document.getElementById('status-logado').style.display = 'flex';
        fecharLogin(); if (!modalJogo.classList.contains('hidden')) fecharModalJogo();
    } else alert("Senha incorreta.");
}
function sairConta() {
    isPremium = false;
    document.getElementById('input-senha').value = '';
    document.getElementById('btn-abrir-login').style.display = 'block';
    document.getElementById('status-logado').style.display = 'none';
    if (!modalJogo.classList.contains('hidden')) fecharModalJogo();
}
function fecharModalJogo() { modalJogo.classList.add('hidden'); }
const esc = valor => valor === null || valor === undefined || valor === '' ? 'N/A' : valor;
function formatarHistorico(hist) {
    if (!hist || typeof hist === 'string' || hist.status !== 'ok') return '';
    let cor = hist.winrate >= 70 ? '#a6e3a1' : (hist.winrate >= 60 ? '#f9e2af' : '#f38ba8');
    return `<br><span style="font-size:11px;white-space:nowrap;margin-top:2px;display:inline-block;">🟢 <strong style="color:#a6e3a1;">${hist.greens}G</strong> &nbsp;|&nbsp; 🔴 <strong style="color:#f38ba8;">${hist.reds}R</strong> &nbsp;|&nbsp; 📈 <strong style="color:${cor};">${hist.winrate}%</strong></span>`;
}

// O MOTOR QUE GERA OS MERCADOS PARA O PERÍODO CLICADO (FT, HT ou ST)
function gerarHTMLMercados(mercados, prefixo) {
    const m = (nome, chave) => {
        const valor = mercados[`${prefixo}p_${chave}`];
        if (valor === undefined || valor === null) return '';
        const hist = mercados[`${prefixo}hist_${chave}`];
        const opacidade = (hist && hist.status === 'ok') ? '1' : '0.45';
        return `<div class="prob-bar" style="opacity: ${opacidade};"><span>${nome} ${formatarHistorico(hist)}</span><strong>${esc(valor)}%</strong></div>`;
    };

    // Design moderno em caixinhas (Grid)
    const renderEsperadosGrid = () => {
        const golsT = mercados[`${prefixo}exp_gols_totais`];
        const cantosT = mercados[`${prefixo}exp_cantos_totais`];
        const cartoesT = mercados[`${prefixo}exp_cartoes_totais`];

        // Se não tiver nenhum dado esperado, retorna vazio
        if (!golsT && !cantosT && !cartoesT) return '';

        let html = `<div class="market-group">
            <h3 style="margin-bottom: 12px;">🎯 Totais Esperados</h3>
            <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 5px;">`;

        if (golsT) {
            html += `<div style="background: rgba(255,255,255,0.05); padding: 10px 12px; border-radius: 8px; flex: 1; min-width: 140px; border: 1px solid rgba(255,255,255,0.1);">
                <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 6px; font-weight: bold;">⚽ Gols (Total: ${golsT})</div>
                <div style="font-size: 13px; color: #fff; margin-bottom: 2px;">🏠 Casa: ${mercados[`${prefixo}exp_gols_casa`] || '-'}</div>
                <div style="font-size: 13px; color: #fff;">✈️ Fora: ${mercados[`${prefixo}exp_gols_fora`] || '-'}</div>
            </div>`;
        }

        if (cantosT) {
            html += `<div style="background: rgba(255,255,255,0.05); padding: 10px 12px; border-radius: 8px; flex: 1; min-width: 140px; border: 1px solid rgba(255,255,255,0.1);">
                <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 6px; font-weight: bold;">🚩 Cantos (Total: ${cantosT})</div>
                <div style="font-size: 13px; color: #fff; margin-bottom: 2px;">🏠 Casa: ${mercados[`${prefixo}exp_cantos_casa`] || '-'}</div>
                <div style="font-size: 13px; color: #fff;">✈️ Fora: ${mercados[`${prefixo}exp_cantos_fora`] || '-'}</div>
            </div>`;
        }

        if (cartoesT) {
            html += `<div style="background: rgba(255,255,255,0.05); padding: 10px 12px; border-radius: 8px; flex: 1; min-width: 140px; border: 1px solid rgba(255,255,255,0.1);">
                <div style="font-size: 12px; color: #cbd5e1; margin-bottom: 6px; font-weight: bold;">🟨 Cartões (Total: ${cartoesT})</div>
                <div style="font-size: 13px; color: #fff; margin-bottom: 2px;">🏠 Casa: ${mercados[`${prefixo}exp_cartoes_casa`] || '-'}</div>
                <div style="font-size: 13px; color: #fff;">✈️ Fora: ${mercados[`${prefixo}exp_cartoes_fora`] || '-'}</div>
            </div>`;
        }

        html += `</div></div>`;
        return html;
    };

    if (mercados[`${prefixo}p_home`] === undefined) return `<div style="text-align:center; padding:30px; color:#94a3b8;">Dados não disponíveis para este período na base de dados.</div>`;

    const premiumClass = isPremium ? "" : "locked-content";
    const avisoVIP = isPremium ? "" : `<div class="locked-warning" onclick="fecharModalJogo(); abrirLogin();">🔒 Acesso VIP Exigido<br><span style="font-size:12px; font-weight:normal; color:#fff">Faça login para desbloquear</span></div>`;

    return `
        <!-- CAIXINHAS MODERNAS NO TOPO DA TELA -->
        ${renderEsperadosGrid()}
        
        <div class="market-group">
            <h3>⚽ Match Odds (1X2)</h3>
            ${m('Casa', 'home')} ${m('Empate', 'draw')} ${m('Fora', 'away')}
        </div>
        <div class="market-group">
            <h3>⚽ Gols Básicos</h3>
            ${m('Over 0.5', 'over05')} ${m('Over 1.5', 'over15')} ${m('Over 2.5', 'over25')}
            ${m('Under 1.5', 'under15')} ${m('Under 2.5', 'under25')}
        </div>
        
        <div class="locked-container">
            ${avisoVIP}
            <div class="${premiumClass}">
                <div class="market-group">
                    <h3>💎 Ambas Marcam</h3>
                    ${m('Ambas - Sim', 'btts_yes')} ${m('Ambas - Não', 'btts_no')}
                </div>
                <div class="market-group">
                    <h3>💎 Gols por Equipe</h3>
                    ${m('Casa Over 0.5', 'casa_over05')} ${m('Casa Over 1.5', 'casa_over15')}
                    ${m('Fora Over 0.5', 'fora_over05')} ${m('Fora Over 1.5', 'fora_over15')}
                </div>
                <div class="market-group">
                    <h3>💎 Escanteios</h3>
                    ${m('Cantos Over 3.5', 'cantos_over35')} ${m('Cantos Over 4.5', 'cantos_over45')} ${m('Cantos Over 5.5', 'cantos_over55')}
                    ${m('Cantos Over 7.5', 'cantos_over75')} ${m('Cantos Over 8.5', 'cantos_over85')} ${m('Cantos Over 9.5', 'cantos_over95')}
                    ${m('Casa Cantos Over 3.5', 'casa_cantos_over35')} ${m('Casa Cantos Over 4.5', 'casa_cantos_over45')}
                    ${m('Fora Cantos Over 2.5', 'fora_cantos_over25')} ${m('Fora Cantos Over 3.5', 'fora_cantos_over35')}
                </div>
                <div class="market-group">
                    <h3>🟨 Cartões</h3>
                    ${m('Cartões Over 1.5', 'cartoes_over15')} ${m('Cartões Over 2.5', 'cartoes_over25')}
                    ${m('Cartões Over 3.5', 'cartoes_over35')} ${m('Cartões Over 4.5', 'cartoes_over45')}
                    ${m('Casa Cartões Over 1.5', 'casa_cartoes_over15')} ${m('Casa Cartões Over 2.5', 'casa_cartoes_over25')}
                    ${m('Fora Cartões Over 1.5', 'fora_cartoes_over15')} ${m('Fora Cartões Over 2.5', 'fora_cartoes_over25')}
                </div>
            </div>
        </div>
    `;
}
function nomeMercado(chave) {
    const fixos = { home: 'Casa (1)', draw: 'Empate', away: 'Fora (2)', btts_yes: 'Ambas - Sim', btts_no: 'Ambas - Não' };
    if (fixos[chave]) return fixos[chave];

    let c = chave, quem = '', tipo = '';
    if (c.startsWith('casa_')) { quem = 'Casa '; c = c.slice(5); }
    else if (c.startsWith('fora_')) { quem = 'Fora '; c = c.slice(5); }

    if (c.startsWith('cantos_')) { tipo = 'Cantos '; c = c.slice(7); }
    else if (c.startsWith('cartoes_')) { tipo = 'Cartões '; c = c.slice(8); }

    const m = c.match(/^(over|under)(\d)(\d)$/);
    const linha = m ? `${m[1] === 'over' ? 'Over' : 'Under'} ${m[2]}.${m[3]}` : c;
    return `${quem}${tipo}${linha}`;
}

function gerarHTMLResultados(mercados) {
    const periodos = [
        { prefixo: '', titulo: 'Jogo (FT)' },
        { prefixo: 'ht_', titulo: '1º Tempo (HT)' },
        { prefixo: 'st_', titulo: '2º Tempo (2T)' }
    ];
    let html = '';

    periodos.forEach(({ prefixo, titulo }) => {
        const inicio = `${prefixo}hist_`;
        let g = 0, r = 0, p = 0, linhas = '';

        Object.keys(mercados).forEach(key => {
            if (!key.startsWith(inicio)) return;
            const hist = mercados[key];
            if (!hist || hist.status !== 'ok') return;

            const merc = key.slice(inicio.length);
            const res = mercados[`${prefixo}res_${merc}`];
            const prob = mercados[`${prefixo}p_${merc}`];

            let icone = '⏳', cor = '#94a3b8';
            if (res === 'GREEN') { icone = '🟢'; cor = '#a6e3a1'; g++; }
            else if (res === 'RED') { icone = '🔴'; cor = '#f38ba8'; r++; }
            else p++;

            linhas += `<div class="prob-bar"><span>${nomeMercado(merc)}<small style="color:#64748b;">Prob: ${esc(prob)}%</small></span><strong style="color:${cor};">${icone} ${res || 'Pendente'}</strong></div>`;
        });

        if (!linhas) return;
        html += `<div class="market-group">
            <h3>${titulo} &nbsp;•&nbsp; <span style="color:#a6e3a1;">${g}G</span> | <span style="color:#f38ba8;">${r}R</span>${p > 0 ? ` | <span style="color:#94a3b8;">${p}⏳</span>` : ''}</h3>
            ${linhas}
        </div>`;
    });

    if (!html) return `<div style="text-align:center; padding:30px; color:#94a3b8;">Nenhum sinal encontrado neste jogo.</div>`;

    if (isPremium) return html;
    return `<div class="locked-container">
        <div class="locked-warning" onclick="fecharModalJogo(); abrirLogin();">🔒 Acesso VIP Exigido<br><span style="font-size:12px; font-weight:normal; color:#fff">Faça login para desbloquear</span></div>
        <div class="locked-content">${html}</div>
    </div>`;
}
async function abrirDetalhesJogo(jogo) {
    try {
        const classCasa = jogo.classificacao?.casa || {};
        const classFora = jogo.classificacao?.fora || {};

        // Gerando o HTML de cada Aba de Tempo
        const htmlFT = gerarHTMLMercados(jogo.mercados || {}, '');
        const htmlHT = gerarHTMLMercados(jogo.mercados || {}, 'ht_');
        const htmlST = gerarHTMLMercados(jogo.mercados || {}, 'st_');

        // TABELA CLASSIFICAÇÃO
        let linhasTabela = '';
        if (jogo.classificacao?.tabela?.GERAL?.length > 0) {
            jogo.classificacao.tabela.GERAL.forEach(time => {
                let d = (String(time.id_time) === String(jogo.id_time_casa) || String(time.flashscore_id_time) === String(jogo.id_time_casa)) ? 'highlight-casa' : ((String(time.id_time) === String(jogo.id_time_fora) || String(time.flashscore_id_time) === String(jogo.id_time_fora)) ? 'highlight-fora' : '');
                linhasTabela += `<tr class="${d}"><td>${time.posicao}º</td><td class="text-left">${time.nome_time}</td><td><strong>${time.pontos}</strong></td><td>${time.jogos}</td><td>${time.vitorias}</td><td>${time.empates}</td><td>${time.derrotas}</td></tr>`;
            });
        } else linhasTabela = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:15px;">Tabela indisponível.</td></tr>`;

        // TABELA ARTILHEIROS
        let htmlArtilheiros = '';
        if (jogo.artilheiros?.length > 0) {
            jogo.artilheiros.forEach(art => {
                let d = (String(art.id_time) === String(jogo.id_time_casa) || String(art.flashscore_id_time) === String(jogo.id_time_casa)) ? 'highlight-casa' : ((String(art.id_time) === String(jogo.id_time_fora) || String(art.flashscore_id_time) === String(jogo.id_time_fora)) ? 'highlight-fora' : '');
                htmlArtilheiros += `<tr class="${d}"><td>${art.posicao}º</td><td class="text-left"><strong>${art.nome_jogador}</strong><br><small style="color:#94a3b8;">${art.nome_time}</small></td><td><strong>${art.gols}</strong></td><td>${art.assistencias || 0}</td></tr>`;
            });
        } else htmlArtilheiros = `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:15px;">Nenhum artilheiro registrado.</td></tr>`;

        detalhesJogo.innerHTML = `
            <h2>${jogo.casa || '-'} x ${jogo.fora || '-'}</h2>
            <p><small>${jogo.pais_liga || jogo.pais || 'Liga'} - ${jogo.nome_competicao || 'Liga'} | ⏰ ${jogo.hora || 'N/A'}</small></p>

            <div class="tabs-header">
                <button id="btn-tab-mercados" class="tab-btn active" onclick="mudarAbaPrincipal('mercados')">📊 Mercados</button>
                <button id="btn-tab-classificacao" class="tab-btn" onclick="mudarAbaPrincipal('classificacao')">🏆 Classificação</button>
                <button id="btn-tab-artilheiros" class="tab-btn" onclick="mudarAbaPrincipal('artilheiros')">⚽ Artilheiros</button>
                <button id="btn-tab-resultados" class="tab-btn" onclick="mudarAbaPrincipal('resultados')">✅ Resultados</button>
             </div>

            <div id="aba-mercados">
                <div class="market-group" style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 15px;">
                    <div style="flex: 1; text-align: center; border-right: 1px solid #334155; padding-right: 8px;">
                        <strong style="color: #60a5fa; font-size: 13px;">🏠 ${jogo.casa}</strong><br>
                        <div style="margin-top: 4px;">Pos: <b>${classCasa.posicao || '-'}º</b> | Pts: <b>${classCasa.pontos || '-'}</b> | J: ${classCasa.jogos || '-'}</div>
                    </div>
                    <div style="flex: 1; text-align: center; padding-left: 8px;">
                        <strong style="color: #f87171; font-size: 13px;">✈️ ${jogo.fora}</strong><br>
                        <div style="margin-top: 4px;">Pos: <b>${classFora.posicao || '-'}º</b> | Pts: <b>${classFora.pontos || '-'}</b> | J: ${classFora.jogos || '-'}</div>
                    </div>
                </div>

                <!-- SUB-ABAS DOS TEMPOS -->
                <div style="display:flex; justify-content:center; gap:10px; margin-bottom:15px;">
                    <button id="btn-tempo-ft" onclick="mudarTempo('ft')" style="padding: 6px 12px; background: #3b82f6; border: none; border-radius: 4px; color: white; font-weight: bold; cursor: pointer;">Jogo (FT)</button>
                    <button id="btn-tempo-ht" onclick="mudarTempo('ht')" style="padding: 6px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; color: #94a3b8; font-weight: bold; cursor: pointer;">1º Tempo (HT)</button>
                    <button id="btn-tempo-st" onclick="mudarTempo('st')" style="padding: 6px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 4px; color: #94a3b8; font-weight: bold; cursor: pointer;">2º Tempo (2T)</button>
                </div>

                <div id="mercados-ft" style="display:block;">${htmlFT}</div>
                <div id="mercados-ht" style="display:none;">${htmlHT}</div>
                <div id="mercados-st" style="display:none;">${htmlST}</div>
            </div>

            <div id="aba-classificacao" style="display: none;">
                <table class="tabela-class"><thead><tr><th width="5%">#</th><th class="text-left" width="45%">Equipe</th><th width="8%">Pts</th><th width="7%">J</th><th width="7%">V</th><th width="7%">E</th><th width="7%">D</th></tr></thead><tbody>${linhasTabela}</tbody></table>
            </div>

            <div id="aba-artilheiros" style="display: none;">
                <table class="tabela-class"><thead><tr><th width="10%">#</th><th class="text-left" width="60%">Jogador</th><th width="15%">Gols</th><th width="15%">Ast</th></tr></thead><tbody>${htmlArtilheiros}</tbody></table>
            </div>
           
            <div id="aba-resultados" style="display: none;">
             ${gerarHTMLResultados(jogo.mercados || {})}
            </div>
        `;

        modalJogo.classList.remove('hidden');

        window.mudarAbaPrincipal = function (aba) {
            ['mercados', 'classificacao', 'artilheiros', 'resultados'].forEach(a => {
                document.getElementById(`aba-${a}`).style.display = a === aba ? 'block' : 'none';
                document.getElementById(`btn-tab-${a}`).classList.toggle('active', a === aba);
            });
        };

        window.mudarTempo = function (tempo) {
            ['ft', 'ht', 'st'].forEach(t => {
                document.getElementById(`mercados-${t}`).style.display = t === tempo ? 'block' : 'none';
                const btn = document.getElementById(`btn-tempo-${t}`);
                if (t === tempo) {
                    btn.style.background = '#3b82f6'; btn.style.color = 'white'; btn.style.border = 'none';
                } else {
                    btn.style.background = '#1e293b'; btn.style.color = '#94a3b8'; btn.style.border = '1px solid #334155';
                }
            });
        };

    } catch (err) { alert("Erro ao carregar detalhes."); }
}
window.onload = iniciar;