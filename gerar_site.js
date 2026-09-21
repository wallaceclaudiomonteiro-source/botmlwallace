const fs = require('fs');
const { Pool } = require('pg');
const { execSync } = require('child_process');
const pool = new Pool({
    connectionString: 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol',
    max: 20
});

// =======================================================================
// 📅 DEFINA AQUI O PERÍODO
const DATA_INICIO = '2026-07-01';
const DATA_FIM = '2026-09-20';

// ⚙️ A SUA TABELA EXATA DE PRIMEIRO/SEGUNDO TEMPO
const TABELA_TEMPOS = 'analise_jogos_ht';
const COLUNA_TEMPO = 'periodo';
// =======================================================================

const cachePerfis = new Map();
const cacheHistoricos = new Map();
const cacheClassificacoes = new Map();
const cacheArtilheiros = new Map();

const PROB_MINIMA = 55;
const LIMITE_JOGOS = 10;

// Lista de TODOS os mercados possíveis mapeados do seu banco (FT, HT e 2T)
const chavesGlobais = [
    'home', 'draw', 'away', 'over05', 'under05', 'over15', 'under15', 'over25', 'under25', 'over35', 'under35',
    'btts_yes', 'btts_no', 'casa_over05', 'casa_over15', 'fora_over05', 'fora_over15',
    'cantos_over15', 'cantos_over25', 'cantos_over35', 'cantos_over45', 'cantos_over55', 'cantos_over65', 'cantos_over75', 'cantos_over85', 'cantos_over95',
    'casa_cantos_over05', 'casa_cantos_over15', 'casa_cantos_over25', 'casa_cantos_over35', 'casa_cantos_over45',
    'fora_cantos_over05', 'fora_cantos_over15', 'fora_cantos_over25', 'fora_cantos_over35',
    'cartoes_over05', 'cartoes_over15', 'cartoes_over25', 'cartoes_over35', 'cartoes_over45',
    'casa_cartoes_over05', 'casa_cartoes_over15', 'casa_cartoes_over25',
    'fora_cartoes_over05', 'fora_cartoes_over15', 'fora_cartoes_over25'
];

const mapaMercados = {
    home: { probCasa: 'p_home', probFora: null, resultado: 'res_home', tipo: 'individual_casa' },
    draw: { probCasa: 'p_draw', probFora: 'p_draw', resultado: 'res_draw', tipo: 'total' },
    away: { probCasa: null, probFora: 'p_away', resultado: 'res_away', tipo: 'individual_fora' },

    over05: { probCasa: 'p_over05', probFora: 'p_over05', resultado: 'res_over05', tipo: 'total' },
    under05: { probCasa: 'p_under05', probFora: 'p_under05', resultado: 'res_under05', tipo: 'total' },
    over15: { probCasa: 'p_over15', probFora: 'p_over15', resultado: 'res_over15', tipo: 'total' },
    under15: { probCasa: 'p_under15', probFora: 'p_under15', resultado: 'res_under15', tipo: 'total' },
    over25: { probCasa: 'p_over25', probFora: 'p_over25', resultado: 'res_over25', tipo: 'total' },
    under25: { probCasa: 'p_under25', probFora: 'p_under25', resultado: 'res_under25', tipo: 'total' },
    over35: { probCasa: 'p_over35', probFora: 'p_over35', resultado: 'res_over35', tipo: 'total' },
    under35: { probCasa: 'p_under35', probFora: 'p_under35', resultado: 'res_under35', tipo: 'total' },

    btts_yes: { probCasa: 'p_btts_yes', probFora: 'p_btts_yes', resultado: 'res_btts_yes', tipo: 'total' },
    btts_no: { probCasa: 'p_btts_no', probFora: 'p_btts_no', resultado: 'res_btts_no', tipo: 'total' },

    casa_over05: { probCasa: 'p_casa_over05', probFora: 'p_fora_over05', resultado: 'res_casa_over05', tipo: 'individual' },
    casa_over15: { probCasa: 'p_casa_over15', probFora: 'p_fora_over15', resultado: 'res_casa_over15', tipo: 'individual' },
    fora_over05: { probCasa: 'p_casa_over05', probFora: 'p_fora_over05', resultado: 'res_fora_over05', tipo: 'individual' },
    fora_over15: { probCasa: 'p_casa_over15', probFora: 'p_fora_over15', resultado: 'res_fora_over15', tipo: 'individual' },

    cantos_over15: { probCasa: 'p_cantos_over15', probFora: 'p_cantos_over15', resultado: 'res_cantos_over15', tipo: 'total' },
    cantos_over25: { probCasa: 'p_cantos_over25', probFora: 'p_cantos_over25', resultado: 'res_cantos_over25', tipo: 'total' },
    cantos_over35: { probCasa: 'p_cantos_over35', probFora: 'p_cantos_over35', resultado: 'res_cantos_over35', tipo: 'total' },
    cantos_over45: { probCasa: 'p_cantos_over45', probFora: 'p_cantos_over45', resultado: 'res_cantos_over45', tipo: 'total' },
    cantos_over55: { probCasa: 'p_cantos_over55', probFora: 'p_cantos_over55', resultado: 'res_cantos_over55', tipo: 'total' },
    cantos_over65: { probCasa: 'p_cantos_over65', probFora: 'p_cantos_over65', resultado: 'res_cantos_over65', tipo: 'total' },
    cantos_over75: { probCasa: 'p_cantos_over75', probFora: 'p_cantos_over75', resultado: 'res_cantos_over75', tipo: 'total' },
    cantos_over85: { probCasa: 'p_cantos_over85', probFora: 'p_cantos_over85', resultado: 'res_cantos_over85', tipo: 'total' },
    cantos_over95: { probCasa: 'p_cantos_over95', probFora: 'p_cantos_over95', resultado: 'res_cantos_over95', tipo: 'total' },

    casa_cantos_over05: { probCasa: 'p_casa_cantos_over05', probFora: 'p_fora_cantos_over05', resultado: 'res_casa_cantos_over05', tipo: 'individual' },
    casa_cantos_over15: { probCasa: 'p_casa_cantos_over15', probFora: 'p_fora_cantos_over15', resultado: 'res_casa_cantos_over15', tipo: 'individual' },
    casa_cantos_over25: { probCasa: 'p_casa_cantos_over25', probFora: 'p_fora_cantos_over25', resultado: 'res_casa_cantos_over25', tipo: 'individual' },
    casa_cantos_over35: { probCasa: 'p_casa_cantos_over35', probFora: 'p_fora_cantos_over35', resultado: 'res_casa_cantos_over35', tipo: 'individual' },
    casa_cantos_over45: { probCasa: 'p_casa_cantos_over45', probFora: 'p_fora_cantos_over45', resultado: 'res_casa_cantos_over45', tipo: 'individual' },

    fora_cantos_over05: { probCasa: 'p_casa_cantos_over05', probFora: 'p_fora_cantos_over05', resultado: 'res_fora_cantos_over05', tipo: 'individual' },
    fora_cantos_over15: { probCasa: 'p_casa_cantos_over15', probFora: 'p_fora_cantos_over15', resultado: 'res_fora_cantos_over15', tipo: 'individual' },
    fora_cantos_over25: { probCasa: 'p_casa_cantos_over25', probFora: 'p_fora_cantos_over25', resultado: 'res_fora_cantos_over25', tipo: 'individual' },
    fora_cantos_over35: { probCasa: 'p_casa_cantos_over35', probFora: 'p_fora_cantos_over35', resultado: 'res_fora_cantos_over35', tipo: 'individual' },

    cartoes_over05: { probCasa: 'p_cartoes_over05', probFora: 'p_cartoes_over05', resultado: 'res_cartoes_over05', tipo: 'total' },
    cartoes_over15: { probCasa: 'p_cartoes_over15', probFora: 'p_cartoes_over15', resultado: 'res_cartoes_over15', tipo: 'total' },
    cartoes_over25: { probCasa: 'p_cartoes_over25', probFora: 'p_cartoes_over25', resultado: 'res_cartoes_over25', tipo: 'total' },
    cartoes_over35: { probCasa: 'p_cartoes_over35', probFora: 'p_cartoes_over35', resultado: 'res_cartoes_over35', tipo: 'total' },
    cartoes_over45: { probCasa: 'p_cartoes_over45', probFora: 'p_cartoes_over45', resultado: 'res_cartoes_over45', tipo: 'total' },

    casa_cartoes_over05: { probCasa: 'p_casa_cartoes_over05', probFora: 'p_fora_cartoes_over05', resultado: 'res_casa_cartoes_over05', tipo: 'individual' },
    casa_cartoes_over15: { probCasa: 'p_casa_cartoes_over15', probFora: 'p_fora_cartoes_over15', resultado: 'res_casa_cartoes_over15', tipo: 'individual' },
    casa_cartoes_over25: { probCasa: 'p_casa_cartoes_over25', probFora: 'p_fora_cartoes_over25', resultado: 'res_casa_cartoes_over25', tipo: 'individual' },

    fora_cartoes_over05: { probCasa: 'p_casa_cartoes_over05', probFora: 'p_fora_cartoes_over05', resultado: 'res_fora_cartoes_over05', tipo: 'individual' },
    fora_cartoes_over15: { probCasa: 'p_casa_cartoes_over15', probFora: 'p_fora_cartoes_over15', resultado: 'res_fora_cartoes_over15', tipo: 'individual' },
    fora_cartoes_over25: { probCasa: 'p_casa_cartoes_over25', probFora: 'p_fora_cartoes_over25', resultado: 'res_fora_cartoes_over25', tipo: 'individual' }
};
const mapEsperados = {
    'total_gols_esperado': 'gols_totais',
    'casa_gols_esperado': 'gols_casa',
    'fora_gols_esperado': 'gols_fora',
    'total_cantos_esperado': 'cantos_totais',
    'casa_cantos_esperado': 'cantos_casa',
    'fora_cantos_esperado': 'cantos_fora',
    'total_cartoes_esperado': 'cartoes_totais',
    'casa_cartoes_esperado': 'cartoes_casa',
    'fora_cartoes_esperado': 'cartoes_fora'
};
async function obterPerfil(idTime) {
    const id = String(idTime);
    if (cachePerfis.has(id)) return cachePerfis.get(id);
    const sql = `SELECT estilo_posse_casa, estilo_posse_fora FROM public.perfil_times WHERE id_time::text = $1 ORDER BY data_referencia DESC NULLS LAST LIMIT 1`;
    const res = await pool.query(sql, [id]);
    const perfil = res.rows[0] || null;
    cachePerfis.set(id, perfil);
    return perfil;
}

async function buscarArtilheiros(idCompeticao) {
    const id = String(idCompeticao);
    if (cacheArtilheiros.has(id)) return cacheArtilheiros.get(id);
    const sql = `SELECT posicao, nome_jogador, nome_time, gols, assistencias, id_time, flashscore_id_time FROM classificacao_artilheiros_2026 WHERE id_competicao::text = $1 ORDER BY posicao ASC LIMIT 20`;
    try {
        const res = await pool.query(sql, [id]);
        cacheArtilheiros.set(id, res.rows);
        return res.rows;
    } catch (e) { return []; }
}

async function buscarClassificacaoCompleta(idCompeticao, tipo) {
    const chave = `${idCompeticao}_${tipo}`;
    if (cacheClassificacoes.has(chave)) return cacheClassificacoes.get(chave);
    const sql = `SELECT posicao_final AS posicao, nome_time, pontos, jogos, vitorias, empates, derrotas, gols_pro, gols_contra, saldo_gols, id_time, flashscore_id_time FROM classificacao_geral_2026 WHERE id_competicao::text = $1::text AND upper(classificacao_tipo) = $2 ORDER BY posicao_final ASC`;
    try {
        const res = await pool.query(sql, [String(idCompeticao), String(tipo).toUpperCase()]);
        cacheClassificacoes.set(chave, res.rows);
        return res.rows;
    } catch (e) { return []; }
}

async function buscarHistoricoComPerfil(idTime, ehCasa, perfilAdversario, dataJogo, flashscoreIdJogo, periodo) {
    const chave = [String(idTime), ehCasa ? 'CASA' : 'FORA', String(perfilAdversario), String(dataJogo), String(flashscoreIdJogo || ''), periodo].join('|');
    if (cacheHistoricos.has(chave)) return cacheHistoricos.get(chave);

    const tabelaAlvo = periodo === 'FT' ? 'public.analises_jogo' : `public.${TABELA_TEMPOS}`;
    let filtroTempo = '';
    if (periodo === 'HT') filtroTempo = `AND aj.${COLUNA_TEMPO} = '1T'`;
    if (periodo === 'ST') filtroTempo = `AND aj.${COLUNA_TEMPO} = '2T'`;

    let sql = ehCasa ?
        `SELECT aj.* FROM ${tabelaAlvo} aj WHERE aj.id_time_casa::text = $1 AND aj.data_jogo < $2::date AND (aj.flashscore_id_jogo IS NULL OR aj.flashscore_id_jogo <> $3) AND $4 = (SELECT pt.estilo_posse_fora FROM public.perfil_times pt WHERE pt.id_time::text = aj.id_time_fora::text ORDER BY pt.data_referencia DESC NULLS LAST LIMIT 1) ${filtroTempo} ORDER BY aj.data_jogo DESC, aj.hora_jogo DESC NULLS LAST, aj.flashscore_id_jogo DESC` :
        `SELECT aj.* FROM ${tabelaAlvo} aj WHERE aj.id_time_fora::text = $1 AND aj.data_jogo < $2::date AND (aj.flashscore_id_jogo IS NULL OR aj.flashscore_id_jogo <> $3) AND $4 = (SELECT pt.estilo_posse_casa FROM public.perfil_times pt WHERE pt.id_time::text = aj.id_time_casa::text ORDER BY pt.data_referencia DESC NULLS LAST LIMIT 1) ${filtroTempo} ORDER BY aj.data_jogo DESC, aj.hora_jogo DESC NULLS LAST, aj.flashscore_id_jogo DESC`;

    try {
        const res = await pool.query(sql, [String(idTime), dataJogo, String(flashscoreIdJogo || ''), perfilAdversario]);
        cacheHistoricos.set(chave, res.rows);
        return res.rows;
    } catch (err) { return []; }
}

async function buscarUltimos10Validos(idTime, ehCasa, perfilAdversario, config, dataJogo, flashscoreIdJogo, periodo) {
    const historico = await buscarHistoricoComPerfil(idTime, ehCasa, perfilAdversario, dataJogo, flashscoreIdJogo, periodo);
    const validos = [];
    for (const jogo of historico) {
        const coluna = ehCasa ? config.probCasa : config.probFora;
        if (!coluna || jogo[coluna] === null || jogo[coluna] === undefined) continue;
        const probHistorica = Number(jogo[coluna]);
        if (probHistorica <= PROB_MINIMA) continue;

        const resultado = jogo[config.resultado];
        if (resultado !== 'GREEN' && resultado !== 'RED') continue;

        validos.push({ flashscore_id_jogo: jogo.flashscore_id_jogo, probabilidade: probHistorica, resultado });
        if (validos.length >= LIMITE_JOGOS) break;
    }
    return validos;
}

async function consultarHistoricoFiltrado(opts, periodo) {
    const { idCasa, idFora, mercado, valorEsperado, dataJogo, flashscoreIdJogo } = opts;
    if (valorEsperado === null || valorEsperado === undefined || isNaN(valorEsperado)) return { status: 'indisponivel' };
    const probAtual = Number(valorEsperado);
    if (probAtual < PROB_MINIMA) return { status: 'abaixo' };

    const config = mapaMercados[mercado];
    if (!config) return { status: 'erro' };

    try {
        const [perfilCasa, perfilFora] = await Promise.all([obterPerfil(idCasa), obterPerfil(idFora)]);
        if (!perfilCasa?.estilo_posse_casa || !perfilFora?.estilo_posse_fora) return { status: 'sem_perfil' };

        const ehCasa = mercado.startsWith('casa_') || mercado === 'home';
        const ehFora = mercado.startsWith('fora_') || mercado === 'away';
        let jogos = [];

        if (config.tipo === 'total' || (!ehCasa && !ehFora)) {
            const [hCasa, hFora] = await Promise.all([
                buscarUltimos10Validos(idCasa, true, perfilFora.estilo_posse_fora, config, dataJogo, flashscoreIdJogo, periodo),
                buscarUltimos10Validos(idFora, false, perfilCasa.estilo_posse_casa, config, dataJogo, flashscoreIdJogo, periodo)
            ]);
            const unicos = new Map();
            [...hCasa, ...hFora].forEach(j => unicos.set(j.flashscore_id_jogo, j));
            jogos = Array.from(unicos.values());
        } else if (ehCasa) {
            jogos = await buscarUltimos10Validos(idCasa, true, perfilFora.estilo_posse_fora, config, dataJogo, flashscoreIdJogo, periodo);
        } else {
            jogos = await buscarUltimos10Validos(idFora, false, perfilCasa.estilo_posse_casa, config, dataJogo, flashscoreIdJogo, periodo);
        }

        let greens = 0, reds = 0;
        jogos.forEach(j => j.resultado === 'GREEN' ? greens++ : reds++);
        const total = greens + reds;

        if (total === 0) return { status: 'sem_historico', greens: 0, reds: 0, total: 0, winrate: 0 };
        return { status: 'ok', greens, reds, total, winrate: Number(((greens / total) * 100).toFixed(0)) };
    } catch (err) { return { status: 'erro' }; }
}

async function gerarClassificacao(idCompeticao, idCasa, idFora) {
    const [geral, casa, fora] = await Promise.all([
        buscarClassificacaoCompleta(idCompeticao, 'GERAL'),
        buscarClassificacaoCompleta(idCompeticao, 'CASA'),
        buscarClassificacaoCompleta(idCompeticao, 'FORA')
    ]);
    const classCasa = geral.find(t => String(t.id_time) === String(idCasa) || String(t.flashscore_id_time) === String(idCasa)) || {};
    const classFora = geral.find(t => String(t.id_time) === String(idFora) || String(t.flashscore_id_time) === String(idFora)) || {};
    return { casa: classCasa, fora: classFora, tabela: { GERAL: geral, CASA: casa, FORA: fora } };
}

async function varrerMercadosDaLinha(linhaBanco, prefixo, periodoStr, filtroMatch, mercadosRef) {
    // 1. Extrai os Totais Esperados dinamicamente
    for (const [colBanco, colJson] of Object.entries(mapEsperados)) {
        if (linhaBanco[colBanco] !== undefined && linhaBanco[colBanco] !== null) {
            mercadosRef[`${prefixo}exp_${colJson}`] = Number(linhaBanco[colBanco]).toFixed(2);
        }
    }

    // 2. Extrai as Probabilidades Históricas e Resultados
    for (const merc of chavesGlobais) {
        const coluna = `p_${merc}`;
        if (linhaBanco[coluna] !== undefined && linhaBanco[coluna] !== null) {
            mercadosRef[`${prefixo}${coluna}`] = linhaBanco[coluna];
            mercadosRef[`${prefixo}hist_${merc}`] = await consultarHistoricoFiltrado({ ...filtroMatch, mercado: merc, valorEsperado: linhaBanco[coluna] }, periodoStr);

            const config = mapaMercados[merc];
            if (config && linhaBanco[config.resultado] !== undefined) {
                mercadosRef[`${prefixo}res_${merc}`] = linhaBanco[config.resultado];
            }
        }
    }
}

async function processarJogo(jogoFT, indice, total) {
    process.stdout.write(`\r   -> Jogo ${indice} de ${total}: ${jogoFT.nome_time_casa} x ${jogoFT.nome_time_fora}`);

    const classificacao = await gerarClassificacao(jogoFT.id_competicao, jogoFT.id_time_casa, jogoFT.id_time_fora);
    const artilheiros = await buscarArtilheiros(jogoFT.id_competicao);
    const filtroMatch = { idCasa: jogoFT.id_time_casa, idFora: jogoFT.id_time_fora, dataJogo: jogoFT.data_jogo, flashscoreIdJogo: jogoFT.flashscore_id_jogo };

    // Inicia vazio, a nova função vai preencher com FT, HT e 2T!
    const mercados = {};

    // PROCESSA FT
    await varrerMercadosDaLinha(jogoFT, '', 'FT', filtroMatch, mercados);

    // PROCESSA HT (1T) e ST (2T)
    try {
        const sqlTempos = `SELECT * FROM public.${TABELA_TEMPOS} WHERE flashscore_id_jogo = $1`;
        const resTempos = await pool.query(sqlTempos, [jogoFT.flashscore_id_jogo]);

        const jogoHT = resTempos.rows.find(r => r[COLUNA_TEMPO] === '1T');
        if (jogoHT) await varrerMercadosDaLinha(jogoHT, 'ht_', 'HT', filtroMatch, mercados);

        const jogoST = resTempos.rows.find(r => r[COLUNA_TEMPO] === '2T');
        if (jogoST) await varrerMercadosDaLinha(jogoST, 'st_', 'ST', filtroMatch, mercados);

    } catch (err) { /* Ignora caso a tabela esteja vazia */ }

    return {
        id: jogoFT.flashscore_id_jogo, flashscore_id_jogo: jogoFT.flashscore_id_jogo,
        id_time_casa: jogoFT.id_time_casa, id_time_fora: jogoFT.id_time_fora,
        nome_time_casa: jogoFT.nome_time_casa, nome_time_fora: jogoFT.nome_time_fora,
        casa: jogoFT.nome_time_casa, fora: jogoFT.nome_time_fora,
        id_competicao: jogoFT.id_competicao,
        data_jogo: jogoFT.data_jogo, hora_jogo: jogoFT.hora_jogo, hora: jogoFT.hora_jogo,
        pais_liga: jogoFT.pais || jogoFT.pais_liga || jogoFT.pais_competicao || 'Desconhecido',
        nome_competicao: jogoFT.nome_competicao || 'Liga', rodada: jogoFT.rodada || '-',
        classificacao, artilheiros, mercados
    };
}
function enviarParaNuvem() {
    console.log('\n🚀 Iniciando envio automático para a nuvem (GitHub + Cloudflare)...');
    try {
        // 1. Adiciona os arquivos modificados (basicamente o dados.js)
        console.log(' -> Adicionando arquivos...');
        execSync('git add .', { stdio: 'inherit' });

        // 2. Faz o commit com a data e hora atuais
        const dataHora = new Date().toLocaleString('pt-BR');
        console.log(` -> Salvando versão (${dataHora})...`);

        // Verifica se há algo para commitar antes de tentar
        const status = execSync('git status --porcelain').toString();
        if (status.trim() === '') {
            console.log(' ⚠️ Nenhuma alteração detectada nos dados. Nada a enviar.');
            return;
        }

        execSync(`git commit -m "Atualização automática de dados: ${dataHora}"`, { stdio: 'inherit' });

        // 3. Envia para o GitHub (o Cloudflare detectará e atualizará o site)
        console.log(' -> Publicando no servidor...');
        execSync('git push', { stdio: 'inherit' });

        console.log('✅ Site atualizado com sucesso! O Cloudflare já está processando os novos dados.');
    } catch (error) {
        console.error('\n❌ Erro ao tentar enviar para a nuvem:', error.message);
    }
}
async function rodarGerador() {
    try {
        console.log('\n==============================================');
        console.log('   GERADOR COMPLETO: ARQUIVOS DIÁRIOS (API)');
        console.log('==============================================');

        await pool.query('SELECT 1');
        
        // Cria a pasta de dados se não existir
        if (!fs.existsSync('./public/dados')) {
            fs.mkdirSync('./public/dados', { recursive: true });
        }

        let datasSalvas = [];
        const arquivoDatas = './public/dados/datas_disponiveis.json';

        // Puxa as datas que já existem para não sobreescrever a lista
        if (fs.existsSync(arquivoDatas)) {
            try {
                datasSalvas = JSON.parse(fs.readFileSync(arquivoDatas, 'utf-8'));
            } catch(e) {}
        }

        console.log(`\n🔎 Buscando jogos entre ${DATA_INICIO} e ${DATA_FIM}...`);
        const resDatas = await pool.query(`SELECT DISTINCT DATE(data_jogo) AS data_valida FROM public.analises_jogo WHERE DATE(data_jogo) >= $1 AND DATE(data_jogo) <= $2 ORDER BY data_valida ASC`, [DATA_INICIO, DATA_FIM]);

        for (const row of resDatas.rows) {
            const data = row.data_valida.toISOString().split('T')[0];
            console.log(`\n📅 Processando o dia: ${data}`);
            
            const res = await pool.query(`SELECT * FROM public.analises_jogo WHERE DATE(data_jogo) = $1 ORDER BY hora_jogo ASC NULLS LAST`, [data]);
            
            let jogosDoDia = [];
            for (let i = 0; i < res.rows.length; i++) {
                jogosDoDia.push(await processarJogo(res.rows[i], i + 1, res.rows.length));
            }
            
            // 1. Salva o arquivo LEVE do dia específico!
            fs.writeFileSync(`./public/dados/${data}.json`, JSON.stringify(jogosDoDia), 'utf8');
            
            // 2. Adiciona a data na lista do Menu se for nova
            if (!datasSalvas.includes(data)) {
                datasSalvas.push(data);
            }
        }

        // Ordena a lista de datas e salva para o site montar o menu
        datasSalvas.sort();
        fs.writeFileSync(arquivoDatas, JSON.stringify(datasSalvas), 'utf8');
        
        // Deleta o arquivo gigante antigo para limpar espaço no seu PC e GitHub
        if (fs.existsSync('./public/dados.js')) {
            fs.unlinkSync('./public/dados.js');
            console.log('🧹 Arquivo gigante dados.js removido com sucesso!');
        }

        console.log(`\n✅ Concluído! JSONs separados foram gerados com sucesso na pasta /dados.`);
        enviarParaNuvem();
    } catch (err) {
        console.error('\n❌ ERRO:', err);
    } finally {
        await pool.end();
    }
}
rodarGerador();