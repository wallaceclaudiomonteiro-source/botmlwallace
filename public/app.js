// ==========================================
// 1. CONFIGURAÇÃO DO SUPABASE
// ==========================================
// Corrigido: Removido o /rest/v1/ do final do URL
const SUPABASE_URL = 'https://ecefcscibdyvgozwenmf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_300B_hoFIgaNp62KWvBAcQ_MBP-E9nj';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let usuarioLogado = null;
let perfilUsuario = null;
let isPremium = false;

// Elementos DOM
const modalJogo = document.getElementById('modal-jogo');
const detalhesJogo = document.getElementById('detalhes-jogo');
const listaJogos = document.getElementById('lista-jogos');
const PROB_MINIMA_PREVISAO = 55;

// ==========================================
// 2. MONITOR DE SESSÃO DO UTILIZADOR
// ==========================================
supabase.auth.onAuthStateChange(async (event, session) => {
    if (session) {
        usuarioLogado = session.user;
        await carregarPerfil();
        isPremium = perfilUsuario && (perfilUsuario.status === 'vip' || perfilUsuario.status === 'teste');
        fecharModalAuth();
        atualizarInterfaceUsuario(true);
        
        // Recarrega os jogos se já houver uma data selecionada
        const seletor = document.getElementById('seletor-data');
        if (seletor && seletor.value) carregarJogos(seletor.value);
    } else {
        usuarioLogado = null;
        perfilUsuario = null;
        isPremium = false;
        atualizarInterfaceUsuario(false);
        // Limpa os dados VIP do ecrã se o utilizador sair da conta
        if (event === 'SIGNED_OUT') location.reload();
    }
});

// ==========================================
// 3. FUNÇÕES DE AUTENTICAÇÃO E PERFIL
// ==========================================
async function carregarPerfil() {
    if (!usuarioLogado) return;
    const { data, error } = await supabase.from('perfis').select('*').eq('id', usuarioLogado.id).single();
    if (data) perfilUsuario = data;
}

async function fazerLogin() {
    const email = document.getElementById('email-login').value;
    const senha = document.getElementById('senha-login').value;
    const erroMsg = document.getElementById('auth-msg-erro');

    if (!email || !senha) return erroMsg.innerText = 'Preencha todos os campos.';

    erroMsg.innerText = 'A iniciar sessão...';
    erroMsg.style.color = 'white';

    const { data, error } = await supabase.auth.signInWithPassword({ email, password: senha });
    if (error) {
        erroMsg.style.color = '#ff4444';
        erroMsg.innerText = 'Erro: E-mail ou senha incorretos.';
    }
}

async function fazerCadastro() {
    const nome = document.getElementById('nome-cad').value;
    const email = document.getElementById('email-cad').value;
    const senha = document.getElementById('senha-cad').value;
    const nasc = document.getElementById('nasc-cad').value;
    const time = document.getElementById('time-cad').value;
    const erroMsg = document.getElementById('auth-msg-erro');
    
    erroMsg.style.color = '#ff4444';

    if (!nome || !email || !senha || !nasc) return erroMsg.innerText = 'Preencha os campos obrigatórios.';

    const idade = new Date().getFullYear() - new Date(nasc).getFullYear();
    if (idade < 18) return erroMsg.innerText = 'É necessário ter 18 anos ou mais.';

    erroMsg.style.color = 'white';
    erroMsg.innerText = 'A criar conta...';
    
    const { data, error } = await supabase.auth.signUp({ email, password: senha });
    if (error) return erroMsg.innerText = 'Erro: ' + error.message;

    if (data.user) {
        await supabase.from('perfis').insert([{
            id: data.user.id,
            email: email,
            nome_completo: nome,
            data_nascimento: nasc,
            time_coracao: time,
            status: 'teste'
        }]);
    }
}

async function fazerLogout() {
    await supabase.auth.signOut();
}

// ==========================================
// 4. FUNÇÕES DE INTERFACE (UI) DO LOGIN
// ==========================================
function atualizarInterfaceUsuario(logado) {
    const btnLogin = document.getElementById('btn-abrir-login');
    const infoUsuario = document.getElementById('info-usuario');
    const nomeLogado = document.getElementById('nome-usuario-logado');
    const badgeVip = document.getElementById('status-vip-badge');
    
    if (logado && perfilUsuario) {
        if (btnLogin) btnLogin.style.display = 'none';
        if (infoUsuario) infoUsuario.style.display = 'flex';
        if (nomeLogado) {
            const primeiroNome = perfilUsuario.nome_completo ? perfilUsuario.nome_completo.split(' ')[0] : 'VIP';
            nomeLogado.innerText = `Olá, ${primeiroNome}`;
        }
        if (badgeVip) badgeVip.innerText = String(perfilUsuario.status).toUpperCase();
    } else {
        if (btnLogin) btnLogin.style.display = 'block';
        if (infoUsuario) infoUsuario.style.display = 'none';
    }
}

function abrirModalAuth() {
    const modal = document.getElementById('modal-auth');
    if (modal) {
        modal.style.display = 'flex';
        alternarFormAuth('login');
    }
}

function fecharModalAuth() {
    const modal = document.getElementById('modal-auth');
    if (modal) modal.style.display = 'none';
    const erroMsg = document.getElementById('auth-msg-erro');
    if (erroMsg) erroMsg.innerText = '';
}

function alternarFormAuth(modo) {
    document.getElementById('auth-msg-erro').innerText = '';
    if (modo === 'cadastro') {
        document.getElementById('form-login').style.display = 'none';
        document.getElementById('form-cadastro').style.display = 'flex';
        document.getElementById('auth-titulo').innerText = 'Criar Conta';
    } else {
        document.getElementById('form-cadastro').style.display = 'none';
        document.getElementById('form-login').style.display = 'flex';
        document.getElementById('auth-titulo').innerText = 'Entrar no VIP';
    }
}

// ==========================================
// 5. LÓGICA PRINCIPAL DO SITE (JOGOS E ODDS)
// ==========================================
function resultadosDoJogo(mercados) {
    let g = 0, r = 0, p = 0;
    Object.keys(mercados).forEach(key => {
        if (!key.startsWith('p_')) return; 
        const merc = key.slice(2);
        const prob = Number(mercados[key]);
        if (isNaN(prob) || prob < PROB_MINIMA_PREVISAO) return;

        const res = mercados[`res_${merc}`];
        if (res === 'GREEN') g++;
        else if (res === 'RED') r++;
        else p++;
    });
    return { g, r, p };
}

async function iniciar() {
    try {
        const antiCache = new Date().getTime();
        const res = await fetch(`dados/datas_disponiveis.json?v=${antiCache}`);
        if (!res.ok) throw new Error("Ficheiro de datas não encontrado");
        const datas = await res.json();

        const seletor = document.getElementById('seletor-data');
        if (!seletor) return;
        
        seletor.innerHTML = ''; 
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
        if (listaJogos) listaJogos.innerHTML = `<p style="text-align:center;color:#f87171;">Aguardando geração de dados...</p>`;
    }
}

async function carregarJogos(dataSelecionada) {
    try {
        listaJogos.innerHTML = `<p style="text-align:center;color:#94a3b8;padding:20px;grid-column:1/-1;">A carregar jogos...</p>`;

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
            const { g: gJogo, r: rJogo, p: pJogo } = resultadosDoJogo(jogo.mercados || {});
            greensDia += gJogo;
            redsDia += rJogo;

            let badgeSinais = (gJogo + rJogo + pJogo) > 0
                ? `<div style="margin-top: 10px; font-size: 11px; padding: 5px 8px; background: rgba(0,0,0,0.25); border: 1px solid #334155; border-radius: 6px; display: flex; justify-content: space-between; align-items: center;"><span style="color:#94a3b8;">🎯 Previsões FT:</span><span><strong style="color:#a6e3a1">${gJogo}G</strong> &nbsp;|&nbsp; <strong style="color:#f38ba8">${rJogo}R</strong>${pJogo > 0 ? ` &nbsp;|&nbsp; <strong style="color:#94a3b8">${pJogo}⏳</strong>` : ''}</span></div>`
                : `<div style="margin-top: 10px; font-size: 11px; color: #64748b; text-align: center;">Sem previsões acima de ${PROB_MINIMA_PREVISAO}% no FT</div>`;

            const card = document.createElement('div');
            card.className = 'game-card';
            card.onclick = () => abrirDetalhesJogo(jogo);
            card.innerHTML = `<span class="league-tag">${jogo.pais_liga || jogo.pais || 'Liga'} - ${jogo.nome_competicao || 'Liga'}</span><div class="time-row"><span>${jogo.casa || '-'}</span><span>vs</span><span>${jogo.fora || '-'}</span></div><small>⏰ ${jogo.hora || 'N/A'}</small>${badgeSinais}`;
            listaJogos.appendChild(card);
        });

        // Painel de Resumo do Dia
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
        listaJogos.innerHTML = `<p style="grid-column:1/-1;text-align:center;color:#f87171;padding:20px;">Erro ao carregar dados.</p>`;
    }
}

function fecharModalJogo() { 
    if(modalJogo) modalJogo.classList.add('hidden'); 
}

const esc = valor => valor === null || valor === undefined || valor === '' ? 'N/A' : valor;

function formatarHistorico(hist) {
    if (!hist || typeof hist === 'string' || hist.status !== 'ok') return '';
    let cor = hist.winrate >= 70 ? '#a6e3a1' : (hist.winrate >= 60 ? '#f9e2af' : '#f38ba8');
    return `<br><span style="font-size:11px;white-space:nowrap;margin-top:2px;display:inline-block;">🟢 <strong style="color:#a6e3a1;">${hist.greens}G</strong> &nbsp;|&nbsp; 🔴 <strong style="color:#f38ba8;">${hist.reds}R</strong> &nbsp;|&nbsp; 📈 <strong style="color:${cor};">${hist.winrate}%</strong></span>`;
}

// ==========================================
// 6. GERAÇÃO DE HTML DOS MERCADOS E JOGO
// ==========================================
function gerarHTMLMercados(mercados, prefixo) {
    const isVIPMarket = prefixo === 'ht_' || prefixo === 'st_';
    
    // Mostra explicitamente que é preciso ser VIP se o utilizador não for premium
    if (isVIPMarket && !isPremium) {
        return `
        <div style="text-align:center; padding:40px 20px; background: rgba(0,0,0,0.3); border-radius: 8px; border: 1px solid #334155;">
            <div style="font-size: 30px; margin-bottom: 10px;">🔒</div>
            <h3 style="color: #f9e2af; margin-bottom: 5px;">Exclusivo VIP</h3>
            <p style="color: #94a3b8; font-size: 13px; margin-bottom: 15px;">Os mercados de ${prefixo === 'ht_' ? '1º Tempo' : '2º Tempo'} são reservados a assinantes.</p>
            <button onclick="fecharModalJogo(); abrirModalAuth();" style="padding: 8px 16px; background: #00ff88; color: black; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">Fazer Login / Assinar</button>
        </div>`;
    }

    if (mercados[`${prefixo}p_home`] === undefined) return `<div style="text-align:center; padding:30px; color:#94a3b8;">Aguardando dados ou dados indisponíveis.</div>`;

    const m = (nome, chave) => {
        const valor = mercados[`${prefixo}p_${chave}`];
        if (valor === undefined || valor === null) return '';
        const hist = mercados[`${prefixo}hist_${chave}`];
        const opacidade = (hist && hist.status === 'ok') ? '1' : '0.45';
        return `<div class="prob-bar" style="opacity: ${opacidade};"><span>${nome} ${formatarHistorico(hist)}</span><strong>${esc(valor)}%</strong></div>`;
    };

    const renderEsperadosGrid = () => {
        const golsT = mercados[`${prefixo}exp_gols_totais`];
        const cantosT = mercados[`${prefixo}exp_cantos_totais`];
        const cartoesT = mercados[`${prefixo}exp_cartoes_totais`];

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

    const premiumClass = isPremium ? "" : "locked-content";
    const avisoVIP = isPremium ? "" : `<div class="locked-warning" onclick="fecharModalJogo(); abrirModalAuth();">🔒 Acesso VIP Exigido<br><span style="font-size:12px; font-weight:normal; color:#fff">Faça login para desbloquear</span></div>`;

    return `
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
        let g = 0, r = 0, p = 0, linhas = '';

        Object.keys(mercados).forEach(key => {
            if (!key.startsWith(`${prefixo}p_`)) return;
            const merc = key.slice(`${prefixo}p_`.length);
            const probNum = Number(mercados[key]);
            if (isNaN(probNum) || probNum < PROB_MINIMA_PREVISAO) return;

            const res = mercados[`${prefixo}res_${merc}`];
            let icone = '⏳', cor = '#94a3b8', texto = 'Pendente';
            if (res === 'GREEN') { icone = '🟢'; cor = '#a6e3a1'; texto = 'GREEN'; g++; }
            else if (res === 'RED') { icone = '🔴'; cor = '#f38ba8'; texto = 'RED'; r++; }
            else p++;

            linhas += `<div class="prob-bar"><span>${nomeMercado(merc)}<small style="color:#64748b;">Prob: ${esc(mercados[key])}%</small></span><strong style="color:${cor};">${icone} ${texto}</strong></div>`;
        });

        if (!linhas) return;
        html += `<div class="market-group">
            <h3>${titulo} &nbsp;•&nbsp; <span style="color:#a6e3a1;">${g}G</span> | <span style="color:#f38ba8;">${r}R</span>${p > 0 ? ` | <span style="color:#94a3b8;">${p}⏳</span>` : ''}</h3>
            ${linhas}
        </div>`;
    });

    if (!html) return `<div style="text-align:center; padding:30px; color:#94a3b8;">Nenhuma previsão acima de ${PROB_MINIMA_PREVISAO}% neste jogo.</div>`;

    if (isPremium) return html;
    return `<div class="locked-container">
        <div class="locked-warning" onclick="fecharModalJogo(); abrirModalAuth();">🔒 Acesso VIP Exigido<br><span style="font-size:12px; font-weight:normal; color:#fff">Faça login para desbloquear</span></div>
        <div class="locked-content">${html}</div>
    </div>`;
}

async function abrirDetalhesJogo(jogo) {
    try {
        const classCasa = jogo.classificacao?.casa || {};
        const classFora = jogo.classificacao?.fora || {};

        const htmlFT = gerarHTMLMercados(jogo.mercados || {}, '');
        const htmlHT = gerarHTMLMercados(jogo.mercados || {}, 'ht_');
        const htmlST = gerarHTMLMercados(jogo.mercados || {}, 'st_');

        let linhasTabela = '';
        if (jogo.classificacao?.tabela?.GERAL?.length > 0) {
            jogo.classificacao.tabela.GERAL.forEach(time => {
                let d = (String(time.id_time) === String(jogo.id_time_casa) || String(time.flashscore_id_time) === String(jogo.id_time_casa)) ? 'highlight-casa' : ((String(time.id_time) === String(jogo.id_time_fora) || String(time.flashscore_id_time) === String(jogo.id_time_fora)) ? 'highlight-fora' : '');
                linhasTabela += `<tr class="${d}"><td>${time.posicao}º</td><td class="text-left">${time.nome_time}</td><td><strong>${time.pontos}</strong></td><td>${time.jogos}</td><td>${time.vitorias}</td><td>${time.empates}</td><td>${time.derrotas}</td></tr>`;
            });
        } else linhasTabela = `<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:15px;">Tabela indisponível.</td></tr>`;

        let htmlArtilheiros = '';
        if (jogo.artilheiros?.length > 0) {
            jogo.artilheiros.forEach(art => {
                let d = (String(art.id_time) === String(jogo.id_time_casa) || String(art.flashscore_id_time) === String(jogo.id_time_casa)) ? 'highlight-casa' : ((String(art.id_time) === String(jogo.id_time_fora) || String(art.flashscore_id_time) === String(jogo.id_time_fora)) ? 'highlight-fora' : '');
                htmlArtilheiros += `<tr class="${d}"><td>${art.posicao}º</td><td class="text-left"><strong>${art.nome_jogador}</strong><br><small style="color:#94a3b8;">${art.nome_time}</small></td><td><strong>${art.gols}</strong></td><td>${art.assistencias || 0}</td></tr>`;
            });
        } else htmlArtilheiros = `<tr><td colspan="4" style="text-align:center;color:#94a3b8;padding:15px;">Nenhum artilheiro registado.</td></tr>`;

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
                <table class="tabela-class"><thead><tr><th width="5%">#</th><th class="text-left" width="45%">Equipa</th><th width="8%">Pts</th><th width="7%">J</th><th width="7%">V</th><th width="7%">E</th><th width="7%">D</th></tr></thead><tbody>${linhasTabela}</tbody></table>
            </div>

            <div id="aba-artilheiros" style="display: none;">
                <table class="tabela-class"><thead><tr><th width="10%">#</th><th class="text-left" width="60%">Jogador</th><th width="15%">Gols</th><th width="15%">Ast</th></tr></thead><tbody>${htmlArtilheiros}</tbody></table>
            </div>
           
            <div id="aba-resultados" style="display: none;">
             ${gerarHTMLResultados(jogo.mercados || {})}
            </div>
        `;

        if (modalJogo) modalJogo.classList.remove('hidden');

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

    } catch (err) { alert("Erro ao carregar os detalhes do jogo."); }
}

window.onload = iniciar;