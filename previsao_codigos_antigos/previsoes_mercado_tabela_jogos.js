const { criarPool } = require('../db');
const math = require('mathjs');
const pool = criarPool('modelo', { 
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// ==========================================
// 1. FUNÇÕES MATEMÁTICAS BASE
// ==========================================
function poisson(lambda, k) {
    let factorial = 1;
    for (let i = 1; i <= k; i++) factorial *= i;
    return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
}

function fatorial(n) {
    if (n <= 1) return 1;
    let resultado = 1;
    for (let i = 2; i <= n; i++) resultado *= i;
    return resultado;
}

function bivariatePoisson(homeGoals, awayGoals, lambdaHome, lambdaAway, lambdaShared) {
    let soma = 0;
    const maxK = Math.min(homeGoals, awayGoals);
    for (let k = 0; k <= maxK; k++) {
        const termo = Math.exp(-(lambdaHome + lambdaAway + lambdaShared)) * Math.pow(lambdaHome, homeGoals - k) / fatorial(homeGoals - k) * Math.pow(lambdaAway, awayGoals - k) / fatorial(awayGoals - k) * Math.pow(lambdaShared, k) / fatorial(k);
        soma += termo;
    }
    return soma;
}

function dixonColesCorrection(homeGoals, awayGoals, lambdaHome, lambdaAway, rho = -0.1) {
    if (homeGoals === 0 && awayGoals === 0) return 1 - (lambdaHome * lambdaAway * rho);
    if (homeGoals === 0 && awayGoals === 1) return 1 + (lambdaHome * rho);
    if (homeGoals === 1 && awayGoals === 0) return 1 + (lambdaAway * rho);
    if (homeGoals === 1 && awayGoals === 1) return 1 - rho;
    return 1;
}

function negativeBinomial(k, r, p) {
    const coef = math.gamma(r + k) / (math.factorial(k) * math.gamma(r));
    return coef * Math.pow(p, r) * Math.pow(1 - p, k);
}

function probOverNegativeBinomial(mean, line, r = 4.2) {
    const meanSeguro = Math.max(0.0001, Number(mean) || 0.0001);
    const rSeguro = Math.max(0.25, Number(r) || 4.2);
    const p = rSeguro / (rSeguro + meanSeguro);
    let probUnder = 0;
    for (let k = 0; k <= Math.floor(line); k++) {
        probUnder += negativeBinomial(k, rSeguro, p);
    }
    return 1 - probUnder;
} const R_CANTOS_PADRAO = 4.2;
const CACHE_R_CANTOS = new Map();

async function estimarRCantosCompeticao(idCompeticao, dataAlvo) {
    const chave = `${idCompeticao}|${dataAlvo}`;
    if (CACHE_R_CANTOS.has(chave)) { return CACHE_R_CANTOS.get(chave); }

    try {
        const query = `
            SELECT e.flashscore_id_jogo, SUM(e.escanteios) as total_escanteios
            FROM estatisticas_geral e
            JOIN jogos j ON j.flashscore_id = e.flashscore_id_jogo
            WHERE j.id_competicao = $1 
              AND j.data_jogo < $2::date 
              AND e.escanteios IS NOT NULL
            GROUP BY e.flashscore_id_jogo
        `;

        const { rows } = await pool.query(query, [idCompeticao, dataAlvo]);
        const valores = rows.map(row => Number(row.total_escanteios)).filter(Number.isFinite);

        if (valores.length < 20) {
            CACHE_R_CANTOS.set(chave, R_CANTOS_PADRAO);
            return R_CANTOS_PADRAO;
        }

        const media = valores.reduce((soma, valor) => soma + valor, 0) / valores.length;
        const variancia = valores.reduce((soma, valor) => soma + Math.pow(valor - media, 2), 0) / valores.length;

        if (media <= 0 || variancia <= media) {
            CACHE_R_CANTOS.set(chave, R_CANTOS_PADRAO);
            return R_CANTOS_PADRAO;
        }

        const rEstimado = Math.max(0.25, Math.min(50, (media * media) / (variancia - media)));
        CACHE_R_CANTOS.set(chave, rEstimado);
        return rEstimado;
    } catch (error) {
        CACHE_R_CANTOS.set(chave, R_CANTOS_PADRAO);
        return R_CANTOS_PADRAO;
    }
}

function zeroInflatedPoisson(lambda, k, pi) {
    if (k === 0) { return pi + ((1 - pi) * Math.exp(-lambda)); }
    return (1 - pi) * poisson(lambda, k);
}

function probOverZeroInflated(mean, line) {
    const probZeroInflado = 0.05;
    // CORREÇÃO: no ZIP, a média real é (1-pi)*lambda, não lambda. Sem este ajuste,
    // a probabilidade gerada correspondia a uma média ~5% menor que o "mean" recebido.
    const lambda = mean / (1 - probZeroInflado);
    let probUnder = 0;
    for (let k = 0; k <= Math.floor(line); k++) { probUnder += zeroInflatedPoisson(lambda, k, probZeroInflado); }
    return 1 - probUnder;
}

function cruzarForcas(producao, concessao) {
    if (producao === 0 || concessao === 0) { return (producao + concessao) / 2; }
    return Math.sqrt(producao * concessao);
}

// ==========================================
// CALIBRADOR DE LIGA
// ==========================================
function fatorCalibracaoLiga(valorTime, mediaLiga, suavizacao = 0.25) {
    if (!mediaLiga || mediaLiga <= 0 || !valorTime || valorTime <= 0) { return 1.0; }
    // CORREÇÃO: a versão anterior amplificava o desvio da média da liga em vez de
    // encolhê-lo (efeito quadrático ao multiplicar o fator de volta por valorTime).
    // Agora o alvo é calculado encolhendo o desvio em direção à média, limitado a
    // no máximo +-35% do valor bruto, e só então convertido em fator multiplicativo.
    const alvo = mediaLiga + suavizacao * (valorTime - mediaLiga);
    const alvoLimitado = Math.max(valorTime * 0.65, Math.min(valorTime * 1.35, alvo));
    return alvoLimitado / valorTime;
}

const percentual = (val) => val !== null && val !== undefined && val !== '' ? (parseFloat(val) * 100).toFixed(2) : 0;
const BTTS_HISTORICO_MIN_JOGOS = 6;
const BTTS_HISTORICO_PRIOR_JOGOS = 20;

function aplicarCalibracaoBTTS(previsoes, historico) {
    if (!historico || historico.jogosValidos < BTTS_HISTORICO_MIN_JOGOS) return;

    const pModelo = Number(previsoes?.gols?.geral?.p_btts_yes);
    const pHistorico = historico.bttsSim / historico.jogosValidos;
    const pesoHistorico = historico.jogosValidos /
        (historico.jogosValidos + BTTS_HISTORICO_PRIOR_JOGOS);

    if (!Number.isFinite(pModelo) || !Number.isFinite(pHistorico)) return;

    const pAjustado = (pModelo * (1 - pesoHistorico)) + (pHistorico * pesoHistorico);
    previsoes.gols.geral.p_btts_yes = pAjustado;
    previsoes.gols.geral.p_btts_no = 1 - pAjustado;
}

async function buscarHistoricoBTTS(flashscoreIdCasa, flashscoreIdFora, dataAlvo) {
    const dataNormalizada = String(dataAlvo).trim().replace(/[\r\n"']/g, '');
    const queryComportamento = `
        SELECT flashscore_id_time, tipo_analise, jogos_usados
        FROM analise_comportamento_times
        WHERE flashscore_id_time IN ($1, $2)
          AND data_jogo::text LIKE $3 || '%'
          AND periodo = 'GE'
          AND tipo_analise IN ('ATAQUE_DEFESA_TIME', 'ATAQUE_DEFESA_CONTRA')
    `;
    const { rows } = await pool.query(queryComportamento, [
        flashscoreIdCasa, flashscoreIdFora, dataNormalizada
    ]);

    function extrairIds(valor) {
        let jogos = valor;
        if (typeof jogos === 'string') {
            try {
                jogos = JSON.parse(jogos);
            } catch (error) {
                return [];
            }
        }
        if (!Array.isArray(jogos)) return [];

        return jogos.map(jogo => {
            if (typeof jogo === 'string' || typeof jogo === 'number') return String(jogo);
            return jogo.flashscore_id || jogo.flashscore_id_jogo || jogo.id_jogo || jogo.id || null;
        }).filter(Boolean).map(String);
    }

    const ids = [];
    for (const timeId of [flashscoreIdCasa, flashscoreIdFora]) {
        for (const tipo of ['ATAQUE_DEFESA_TIME', 'ATAQUE_DEFESA_CONTRA']) {
            const linha = rows.find(row =>
                String(row.flashscore_id_time) === String(timeId) &&
                row.tipo_analise === tipo
            );
            ids.push(...extrairIds(linha?.jogos_usados).slice(0, 5));
        }
    }

    const idsUnicos = [...new Set(ids)];
    if (idsUnicos.length < BTTS_HISTORICO_MIN_JOGOS) {
        return { bttsSim: 0, jogosValidos: 0 };
    }

    const { rows: jogos } = await pool.query(`
        SELECT placar_casa, placar_fora
        FROM jogos
        WHERE flashscore_id = ANY($1::text[])
          AND placar_casa IS NOT NULL
          AND placar_fora IS NOT NULL
    `, [idsUnicos]);

    const validos = jogos.filter(jogo =>
        Number.isFinite(Number(jogo.placar_casa)) &&
        Number.isFinite(Number(jogo.placar_fora))
    );

    return {
        bttsSim: validos.filter(jogo =>
            Number(jogo.placar_casa) > 0 && Number(jogo.placar_fora) > 0
        ).length,
        jogosValidos: validos.length
    };
}

// ============================================================
// ESTIMA LAMBDA SHARED COM JOGOS HISTÓRICOS
// ============================================================
async function estimarLambdaShared(flashscoreIdCasa, flashscoreIdFora, dataAlvo) {
    try {
        const dataNormalizada = String(dataAlvo).trim().replace(/[\r\n"']/g, '');
        console.log(`\n==========================================`);
        console.log(`[LAMBDA SHARED] Confronto: ${flashscoreIdCasa} x ${flashscoreIdFora}`);
        console.log(`[LAMBDA SHARED] Data: ${dataNormalizada}`);

        const queryComportamento = `
            SELECT flashscore_id_time, tipo_analise, jogos_usados
            FROM analise_comportamento_times
            WHERE flashscore_id_time IN ($1, $2) AND data_jogo::text LIKE $3 || '%' AND periodo = 'GE' AND tipo_analise IN ('ATAQUE_DEFESA_TIME', 'ATAQUE_DEFESA_CONTRA')
        `;
        const { rows: linhasComportamento } = await pool.query(queryComportamento, [flashscoreIdCasa, flashscoreIdFora, dataNormalizada]);

        if (!linhasComportamento || linhasComportamento.length === 0) {
            console.log(`[LAMBDA SHARED] Nenhuma análise de comportamento encontrada. Usando 0.`);
            return 0;
        }

        const linhasNecessarias = [
            { time: flashscoreIdCasa, tipo: 'ATAQUE_DEFESA_TIME', nome: 'CASA ATAQUE_DEFESA_TIME' },
            { time: flashscoreIdCasa, tipo: 'ATAQUE_DEFESA_CONTRA', nome: 'CASA ATAQUE_DEFESA_CONTRA' },
            { time: flashscoreIdFora, tipo: 'ATAQUE_DEFESA_TIME', nome: 'FORA ATAQUE_DEFESA_TIME' },
            { time: flashscoreIdFora, tipo: 'ATAQUE_DEFESA_CONTRA', nome: 'FORA ATAQUE_DEFESA_CONTRA' }
        ];

        const todosJogosIds = [];

        function extrairJogosUsados(valor) {
            if (!valor) return [];
            if (Array.isArray(valor)) return valor;
            if (typeof valor === 'string') {
                try {
                    const parsed = JSON.parse(valor);
                    if (Array.isArray(parsed)) return parsed;
                    return [];
                } catch (error) {
                    console.log(`[LAMBDA SHARED] Não foi possível interpretar jogos_usados:`, valor);
                    return [];
                }
            }
            return [];
        }

        for (const linhaNecessaria of linhasNecessarias) {
            const linha = linhasComportamento.find(item => String(item.flashscore_id_time) === String(linhaNecessaria.time) && item.tipo_analise === linhaNecessaria.tipo);
            if (!linha) {
                console.log(`[LAMBDA SHARED] Linha não encontrada: ${linhaNecessaria.nome}`);
                continue;
            }
            let jogosUsados = extrairJogosUsados(linha.jogos_usados);
            if (!jogosUsados || jogosUsados.length === 0) {
                console.log(`[LAMBDA SHARED] Nenhum jogo em: ${linhaNecessaria.nome}`);
                continue;
            }

            jogosUsados = jogosUsados.map(jogo => {
                if (typeof jogo === 'string' || typeof jogo === 'number') { return { id: String(jogo), data: null }; }
                return { id: jogo.flashscore_id || jogo.flashscore_id_jogo || jogo.id_jogo || jogo.id || null, data: jogo.data_jogo || jogo.data || null };
            }).filter(jogo => jogo.id);

            jogosUsados.sort((a, b) => {
                const dataA = a.data ? new Date(a.data).getTime() : 0;
                const dataB = b.data ? new Date(b.data).getTime() : 0;
                return dataB - dataA;
            });

            const ultimosCinco = jogosUsados.slice(0, 5);
            console.log(`[LAMBDA SHARED] ${linhaNecessaria.nome}: ${ultimosCinco.length} jogos selecionados`);
            todosJogosIds.push(...ultimosCinco.map(jogo => String(jogo.id)));
        }

        const jogosIdsUnicos = [...new Set(todosJogosIds)];
        console.log(`[LAMBDA SHARED] Total de referências: ${todosJogosIds.length}`);
        console.log(`[LAMBDA SHARED] Jogos únicos após remover duplicados: ${jogosIdsUnicos.length}`);

        const MIN_JOGOS_LAMBDA_SHARED = 6;
        if (jogosIdsUnicos.length < MIN_JOGOS_LAMBDA_SHARED) {
            console.log(`[LAMBDA SHARED] Apenas ${jogosIdsUnicos.length} jogos únicos. Mínimo necessário: ${MIN_JOGOS_LAMBDA_SHARED}. Usando 0.`);
            return 0;
        }

        const queryJogos = `
            SELECT flashscore_id, l_home, l_away, placar_casa, placar_fora, data_jogo
            FROM jogos
            WHERE flashscore_id = ANY($1::text[]) AND l_home IS NOT NULL AND l_away IS NOT NULL AND placar_casa IS NOT NULL AND placar_fora IS NOT NULL AND l_home > 0 AND l_away > 0
            ORDER BY data_jogo DESC
        `;
        const { rows: jogosHistoricos } = await pool.query(queryJogos, [jogosIdsUnicos]);

        if (!jogosHistoricos || jogosHistoricos.length < MIN_JOGOS_LAMBDA_SHARED) {
            console.log(`[LAMBDA SHARED] Apenas ${jogosHistoricos ? jogosHistoricos.length : 0} jogos válidos com lambda e placar. Usando 0.`);
            return 0;
        }
        console.log(`[LAMBDA SHARED] Jogos históricos válidos: ${jogosHistoricos.length}`);

        let menorLambda = Infinity;
        for (const jogo of jogosHistoricos) {
            const lambdaHome = Number(jogo.l_home);
            const lambdaAway = Number(jogo.l_away);
            if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway) || lambdaHome <= 0 || lambdaAway <= 0) { continue; }
            menorLambda = Math.min(menorLambda, lambdaHome, lambdaAway);
        }

        if (!Number.isFinite(menorLambda) || menorLambda <= 0) {
            console.log(`[LAMBDA SHARED] Histórico inválido. Usando 0.`);
            return 0;
        }

        const limiteMaximo = Math.min(0.50, menorLambda * 0.95);
        if (!Number.isFinite(limiteMaximo) || limiteMaximo <= 0) {
            console.log(`[LAMBDA SHARED] Limite inválido. Usando 0.`);
            return 0;
        }

        let melhorLambda = 0;
        let melhorLogLikelihood = -Infinity;
        const passos = 100;

        for (let i = 0; i <= passos; i++) {
            const lambdaShared = limiteMaximo * (i / passos);
            let logLikelihood = 0;
            let jogosValidos = 0;

            for (const jogo of jogosHistoricos) {
                const lambdaHome = Number(jogo.l_home);
                const lambdaAway = Number(jogo.l_away);
                const golsCasa = Number(jogo.placar_casa);
                const golsFora = Number(jogo.placar_fora);

                if (!Number.isFinite(lambdaHome) || !Number.isFinite(lambdaAway) || !Number.isFinite(golsCasa) || !Number.isFinite(golsFora)) { continue; }

                const lambda1 = lambdaHome - lambdaShared;
                const lambda2 = lambdaAway - lambdaShared;
                if (lambda1 <= 0 || lambda2 <= 0) { continue; }

                const prob = bivariatePoisson(golsCasa, golsFora, lambda1, lambda2, lambdaShared);
                if (prob > 0 && Number.isFinite(prob)) {
                    logLikelihood += Math.log(prob);
                    jogosValidos++;
                }
            }

            if (jogosValidos >= MIN_JOGOS_LAMBDA_SHARED && logLikelihood > melhorLogLikelihood) {
                melhorLogLikelihood = logLikelihood;
                melhorLambda = lambdaShared;
            }
        }

        if (!Number.isFinite(melhorLambda)) { melhorLambda = 0; }

        console.log(`==========================================`);
        console.log(`CALIBRAÇÃO DO LAMBDA SHARED`);
        console.log(`Casa: ${flashscoreIdCasa}`);
        console.log(`Fora: ${flashscoreIdFora}`);
        console.log(`Jogos únicos selecionados: ${jogosIdsUnicos.length}`);
        console.log(`Jogos históricos válidos: ${jogosHistoricos.length}`);
        console.log(`Menor lambda encontrado: ${menorLambda.toFixed(4)}`);
        console.log(`Limite máximo testado: ${limiteMaximo.toFixed(4)}`);
        console.log(`Melhor lambdaShared: ${melhorLambda.toFixed(4)}`);
        console.log(`Log-Likelihood: ${melhorLogLikelihood.toFixed(4)}`);
        console.log(`==========================================\n`);

        return melhorLambda;
    } catch (error) {
        console.error(`[LAMBDA SHARED] Erro ao estimar lambdaShared:`, error);
        return 0;
    }
}

// ============================================================
// ESTIMA ESCANTEIOS HISTÓRICOS (PROJEÇÃO CALIBRADA)
// ============================================================
function calcularMediana(valores) {
    const numeros = valores
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);

    if (numeros.length === 0) return null;

    const meio = Math.floor(numeros.length / 2);

    if (numeros.length % 2 === 0) {
        return (numeros[meio - 1] + numeros[meio]) / 2;
    }

    return numeros[meio];
}

async function buscarEscanteiosHistoricos(flashscoreIdCasa, flashscoreIdFora, dataAlvo) {
    try {
        const dataNormalizada = String(dataAlvo).trim().replace(/[\r\n"']/g, '');
        const MIN_JOGOS = 6;
        const MAX_JOGOS = 10;

        const queryComportamento = `
            SELECT flashscore_id_time, tipo_analise, casa_fora, jogos_usados
            FROM analise_comportamento_times
            WHERE flashscore_id_time IN ($1, $2)
              AND data_jogo::text LIKE $3 || '%'
              AND periodo = 'GE'
             AND tipo_analise IN ('ATAQUE_DEFESA_TIME', 'ATAQUE_DEFESA_CONTRA')
        `;

        const { rows: linhas } = await pool.query(queryComportamento, [
            flashscoreIdCasa,
            flashscoreIdFora,
            dataNormalizada
        ]);

        if (!linhas || linhas.length === 0) {
            console.log(
                `[CANTOS DEBUG] Nenhuma linha de comportamento encontrada para os times ${flashscoreIdCasa} e ${flashscoreIdFora} na data ${dataNormalizada}.`
            );
            return null;
        }

        function extrairJogosUsados(valor) {
            if (!valor) return [];

            if (Array.isArray(valor)) return valor;

            if (typeof valor === 'string') {
                try {
                    const parsed = JSON.parse(valor);
                    return Array.isArray(parsed) ? parsed : [];
                } catch (error) {
                    return [];
                }
            }

            return [];
        }

        function obterBloco(timeId, tipo) {
            const linha = linhas.find(
                item =>
                    String(item.flashscore_id_time) === String(timeId) &&
                    item.tipo_analise === tipo
            );

            if (!linha) return null;

            let jogos = extrairJogosUsados(linha.jogos_usados)
                .map(jogo => {
                    if (typeof jogo === 'string' || typeof jogo === 'number') {
                        return {
                            id: String(jogo),
                            data: null
                        };
                    }

                    return {
                        id:
                            jogo.flashscore_id ||
                            jogo.flashscore_id_jogo ||
                            jogo.id_jogo ||
                            jogo.id ||
                            null,
                        data: jogo.data_jogo || jogo.data || null
                    };
                })
                .filter(jogo => jogo.id);

            jogos.sort((a, b) => {
                const dataA = a.data ? new Date(a.data).getTime() : 0;
                const dataB = b.data ? new Date(b.data).getTime() : 0;
                return dataB - dataA;
            });

            return {
                tipo,
                casa_fora: String(linha.casa_fora || '').toUpperCase(),
                jogos: jogos.slice(0, MAX_JOGOS)
            };
        }

        const blocos = {
            casa_producao: obterBloco(flashscoreIdCasa, 'ATAQUE_DEFESA_TIME'),
            casa_sofrimento: obterBloco(flashscoreIdCasa, 'ATAQUE_DEFESA_CONTRA'),
            fora_producao: obterBloco(flashscoreIdFora, 'ATAQUE_DEFESA_TIME'),
            fora_sofrimento: obterBloco(flashscoreIdFora, 'ATAQUE_DEFESA_CONTRA')
        };

        for (const [nome, bloco] of Object.entries(blocos)) {
            if (!bloco || bloco.jogos.length < MIN_JOGOS) {
                console.log(
                    `[CANTOS DEBUG] Bloco ${nome} insuficiente (possui ${bloco ? bloco.jogos.length : 0} jogos, mínimo exigido: ${MIN_JOGOS}).`
                );
                return null;
            }
        }

        const todosIds = [
            ...new Set(
                Object.values(blocos).flatMap(bloco =>
                    bloco.jogos.map(jogo => String(jogo.id))
                )
            )
        ];

        const queryEstatisticas = `
            SELECT flashscore_id_jogo, eh_casa, MAX(escanteios) AS escanteios
            FROM estatisticas_geral
            WHERE flashscore_id_jogo = ANY($1::text[])
              AND eh_casa IN (0, 1)
              AND escanteios IS NOT NULL
            GROUP BY flashscore_id_jogo, eh_casa
        `;

        const { rows: estatisticas } = await pool.query(queryEstatisticas, [
            todosIds
        ]);

        const mapaEscanteios = new Map();

        for (const row of estatisticas) {
            mapaEscanteios.set(
                `${String(row.flashscore_id_jogo)}_${Number(row.eh_casa)}`,
                Number(row.escanteios)
            );
        }

        function calcularMedianaBloco(bloco, nomeBloco) {
            const valoresEscanteios = [];
            const ehCasaTime = bloco.casa_fora === 'C';

            let ehCasaEstatistica;

            if (bloco.tipo === 'ATAQUE_DEFESA_TIME') {
                ehCasaEstatistica = ehCasaTime ? 1 : 0;
            } else if (bloco.tipo === 'ATAQUE_DEFESA_CONTRA') {
                ehCasaEstatistica = ehCasaTime ? 0 : 1;
            }

            for (const jogo of bloco.jogos) {
                const escanteios = mapaEscanteios.get(
                    `${String(jogo.id)}_${ehCasaEstatistica}`
                );

                if (
                    Number.isFinite(escanteios) &&
                    escanteios >= 0
                ) {
                    valoresEscanteios.push(escanteios);
                }
            }

            const mediana = calcularMediana(valoresEscanteios);

            console.log(
                `[CANTOS DEBUG] ${nomeBloco} | Mando=${bloco.casa_fora} | Jogos Válidos=${valoresEscanteios.length}/${bloco.jogos.length} | Valores=[${valoresEscanteios.join(', ')}] | Mediana=${mediana !== null ? mediana.toFixed(2) : 'N/A'}`
            );

            if (
                valoresEscanteios.length < MIN_JOGOS ||
                mediana === null
            ) {
                return null;
            }

            return mediana;
        }

        const mediana_casa_produzidos = calcularMedianaBloco(
            blocos.casa_producao,
            'Casa Produzidos'
        );

        const mediana_casa_concedidos = calcularMedianaBloco(
            blocos.casa_sofrimento,
            'Casa Concedidos'
        );

        const mediana_fora_produzidos = calcularMedianaBloco(
            blocos.fora_producao,
            'Fora Produzidos'
        );

        const mediana_fora_concedidos = calcularMedianaBloco(
            blocos.fora_sofrimento,
            'Fora Concedidos'
        );

        if (
            mediana_casa_produzidos === null ||
            mediana_casa_concedidos === null ||
            mediana_fora_produzidos === null ||
            mediana_fora_concedidos === null
        ) {
            console.log(
                `[CANTOS DEBUG] Um ou mais blocos falharam no filtro mínimo de jogos válidos para este confronto.`
            );
            return null;
        }

        const lambda_casa_hist = cruzarForcas(
            mediana_casa_produzidos,
            mediana_fora_concedidos
        );

        const lambda_fora_hist = cruzarForcas(
            mediana_fora_produzidos,
            mediana_casa_concedidos
        );

        console.log(
            `[CANTOS SUCESSO] Mandante (Mediana Prod: ${mediana_casa_produzidos.toFixed(2)} x Mediana Conc: ${mediana_fora_concedidos.toFixed(2)}) -> λ Casa = ${lambda_casa_hist.toFixed(2)}`
        );

        console.log(
            `[CANTOS SUCESSO] Visitante (Mediana Prod: ${mediana_fora_produzidos.toFixed(2)} x Mediana Conc: ${mediana_casa_concedidos.toFixed(2)}) -> λ Fora = ${lambda_fora_hist.toFixed(2)}`
        );

        return {
            lambda_casa_hist,
            lambda_fora_hist,
            peso_historico: 0.30,

            // Mantém as medianas disponíveis para diagnóstico
            mediana_casa_produzidos,
            mediana_casa_concedidos,
            mediana_fora_produzidos,
            mediana_fora_concedidos
        };

    } catch (error) {
        console.error(`[CANTOS ERRO FATAL]`, error.message);
        return null;
    }
}

// ==========================================
// BLOCO 1X2 (ATUALIZADO E SINCRONIZADO)
// ==========================================
function calcularMercado1x2(ataqueCasa, defesaFora, ataqueFora, defesaCasa, mediasLiga, lambdaShared) {
    // 1. Usa a MESMA base de gols esperados (sem o Math.sqrt)
    const lambdaHome = calcularExpectedGoals(ataqueCasa, defesaFora, mediasLiga);
    const lambdaAway = calcularExpectedGoals(ataqueFora, defesaCasa, mediasLiga);

    // 2. Aplica o MESMO lambda_shared histórico que você construiu
    const shared = Math.min(Math.max(0, Number(lambdaShared) || 0), lambdaHome * 0.95, lambdaAway * 0.95);
    const lambda1 = Math.max(0, lambdaHome - shared);
    const lambda2 = Math.max(0, lambdaAway - shared);

    let p_home = 0;
    let p_draw = 0;
    let p_away = 0;

    for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
            // 3. Distribui usando Bivariate Poisson pura (sem double-dipping)
            const prob = bivariatePoisson(h, a, lambda1, lambda2, shared);

            if (h > a) p_home += prob;
            else if (h === a) p_draw += prob;
            else p_away += prob;
        }
    }

    const total = p_home + p_draw + p_away;

    return {
        p_home: total > 0 ? p_home / total : 0,
        p_draw: total > 0 ? p_draw / total : 0,
        p_away: total > 0 ? p_away / total : 0
    };
}

// ==========================================
// BUSCA MÉDIAS DA LIGA
// ==========================================
async function buscarMediasLiga(idCompeticao) {
    const query = `
        SELECT
            metrica,
            casa_mediana,
            fora_mediana
        FROM grid_metricas_competicoes
        WHERE id_competicao = $1
    `;

    const { rows } = await pool.query(query, [idCompeticao]);

    const mediasLiga = {};

    for (const row of rows) {
        const medianaCasa = Number(row.casa_mediana);
        const medianaFora = Number(row.fora_mediana);

        if (
            Number.isFinite(medianaCasa) &&
            medianaCasa > 0 &&
            Number.isFinite(medianaFora) &&
            medianaFora > 0
        ) {
            mediasLiga[row.metrica] =
                (medianaCasa + medianaFora) / 2;
        } else if (
            Number.isFinite(medianaCasa) &&
            medianaCasa > 0
        ) {
            mediasLiga[row.metrica] = medianaCasa;
        } else if (
            Number.isFinite(medianaFora) &&
            medianaFora > 0
        ) {
            mediasLiga[row.metrica] = medianaFora;
        } else {
            mediasLiga[row.metrica] = 0;
        }
    }

    return mediasLiga;
}

// ==========================================
// BLOCO DE GOLS
// ==========================================
function calcularRatingAtaque(dados, mediasLiga) {
    const xg = Number(dados?.xg_mediana_wma) || 0;
    const xgot = Number(dados?.xgot_mediana_wma) || 0;
    const mediaLigaXg = Number(mediasLiga?.xg) || 0;
    const mediaLigaXgot = Number(mediasLiga?.xgot) || 0;

    const ratingXg = mediaLigaXg > 0 ? xg / mediaLigaXg : 0;
    const ratingXgot = mediaLigaXgot > 0 ? xgot / mediaLigaXgot : 0;

    if (ratingXg > 0 && ratingXgot > 0) {
        return (ratingXg * 0.75) + (ratingXgot * 0.25);
    }

    return ratingXg || ratingXgot || 0;
}

function calcularRatingVulnerabilidade(dados, mediasLiga) {
    const xgContra = Number(dados?.xg_mediana_wma) || 0;
    const xgotContra = Number(dados?.xgot_mediana_wma) || 0;
    const mediaLigaXg = Number(mediasLiga?.xg) || 0;
    const mediaLigaXgot = Number(mediasLiga?.xgot) || 0;

    const ratingXgContra = mediaLigaXg > 0 ? xgContra / mediaLigaXg : 0;
    const ratingXgotContra = mediaLigaXgot > 0 ? xgotContra / mediaLigaXgot : 0;

    if (ratingXgContra > 0 && ratingXgotContra > 0) {
        return (ratingXgContra * 0.75) + (ratingXgotContra * 0.25);
    }

    return ratingXgContra || ratingXgotContra || 0;
}

function calcularRatingAtaqueAlternativo(dados, mediasLiga) {
    const finalizacoes = Number(dados?.finalizacoes_mediana_wma);
    const finalizacoesNoAlvo = Number(dados?.finalizacoes_no_gol_mediana_wma);
    const golsMarcados = Number(dados?.gols_marcados_mediana_wma);

    const medianaLigaFinalizacoes = Number(mediasLiga?.finalizacoes);
    const medianaLigaFinalizacoesNoAlvo = Number(mediasLiga?.finalizacoes_no_gol);
    const medianaLigaGolsMarcados = Number(mediasLiga?.gols_marcados);

    let rating = 0;

    if (
        Number.isFinite(finalizacoesNoAlvo) &&
        Number.isFinite(medianaLigaFinalizacoesNoAlvo) &&
        medianaLigaFinalizacoesNoAlvo > 0
    ) {
        rating += (finalizacoesNoAlvo / medianaLigaFinalizacoesNoAlvo) * 0.50;
    }

    if (
        Number.isFinite(golsMarcados) &&
        Number.isFinite(medianaLigaGolsMarcados) &&
        medianaLigaGolsMarcados > 0
    ) {
        rating += (golsMarcados / medianaLigaGolsMarcados) * 0.35;
    }

    if (
        Number.isFinite(finalizacoes) &&
        Number.isFinite(medianaLigaFinalizacoes) &&
        medianaLigaFinalizacoes > 0
    ) {
        rating += (finalizacoes / medianaLigaFinalizacoes) * 0.15;
    }

    return rating;
}
function calcularRatingVulnerabilidadeAlternativo(dados, mediasLiga) {
    // O bloco CONTRA contém as métricas produzidas pelos adversários
    // históricos. Assim, esses valores são o que o time analisado sofreu.
    const finalizacoesSofridas = Number(dados?.finalizacoes_mediana_wma);
    const finalizacoesNoAlvoSofridas = Number(dados?.finalizacoes_no_gol_mediana_wma);
    const golsSofridos = Number(dados?.gols_marcados_mediana_wma);

    const medianaLigaFinalizacoes =
        Number(mediasLiga?.finalizacoes);

    const medianaLigaFinalizacoesNoAlvo =
        Number(mediasLiga?.finalizacoes_no_gol);

    const medianaLigaGolsSofridos =
        Number(mediasLiga?.gols_sofridos);

    let rating = 0;

    if (
        Number.isFinite(finalizacoesNoAlvoSofridas) &&
        Number.isFinite(medianaLigaFinalizacoesNoAlvo) &&
        medianaLigaFinalizacoesNoAlvo > 0
    ) {
        rating +=
            (finalizacoesNoAlvoSofridas / medianaLigaFinalizacoesNoAlvo) * 0.50;
    }

    if (
        Number.isFinite(golsSofridos) &&
        Number.isFinite(medianaLigaGolsSofridos) &&
        medianaLigaGolsSofridos > 0
    ) {
        rating +=
            (golsSofridos / medianaLigaGolsSofridos) * 0.35;
    }

    if (
        Number.isFinite(finalizacoesSofridas) &&
        Number.isFinite(medianaLigaFinalizacoes) &&
        medianaLigaFinalizacoes > 0
    ) {
        rating +=
            (finalizacoesSofridas / medianaLigaFinalizacoes) * 0.15;
    }

    return rating;
}
function calcularExpectedGoals(producaoAtacante, vulnerabilidadeDefensor, mediasLiga) {
    const xgAtacante = Number(producaoAtacante?.xg_mediana_wma) || 0;
    const xgotAtacante = Number(producaoAtacante?.xgot_mediana_wma) || 0;

    const xgDefensorContra = Number(vulnerabilidadeDefensor?.xg_mediana_wma) || 0;
    const xgotDefensorContra = Number(vulnerabilidadeDefensor?.xgot_mediana_wma) || 0;

    // ============================================================
    // MOTOR PRINCIPAL
    // TIME = produção ofensiva
    // CONTRA = vulnerabilidade defensiva
    // ============================================================
    if (
        xgAtacante > 0 &&
        xgotAtacante > 0 &&
        xgDefensorContra > 0 &&
        xgotDefensorContra > 0
    ) {
        const ratingAtaque = calcularRatingAtaque(
            producaoAtacante,
            mediasLiga
        );

        const ratingVulnerabilidade = calcularRatingVulnerabilidade(
            vulnerabilidadeDefensor,
            mediasLiga
        );

        const mediaGolsLiga = Number(mediasLiga?.xg) || 0;

        if (
            mediaGolsLiga <= 0 ||
            ratingAtaque <= 0 ||
            ratingVulnerabilidade <= 0
        ) {
            return 0;
        }

        return mediaGolsLiga * ratingAtaque * ratingVulnerabilidade;
    }

    // ============================================================
    // FALLBACK
    // TIME = produção
    // CONTRA = sofrimento
    // ============================================================
    const ratingAtaqueAlternativo = calcularRatingAtaqueAlternativo(
        producaoAtacante,
        mediasLiga
    );

    const ratingVulnerabilidadeAlternativo =
        calcularRatingVulnerabilidadeAlternativo(
            vulnerabilidadeDefensor,
            mediasLiga
        );

    const medianaGolsLiga =
        Number(mediasLiga?.gols_marcados) || 0;

    if (
        medianaGolsLiga <= 0 ||
        ratingAtaqueAlternativo <= 0 ||
        ratingVulnerabilidadeAlternativo <= 0
    ) {
        return 0;
    }

    return (
        medianaGolsLiga *
        ratingAtaqueAlternativo *
        ratingVulnerabilidadeAlternativo
    );
}

function calcularMercadoGols(ataqueCasa, defesaFora, ataqueFora, defesaCasa, mediasLiga, lambdaShared) {
    const lambdaHome = calcularExpectedGoals(ataqueCasa, defesaFora, mediasLiga);
    const lambdaAway = calcularExpectedGoals(ataqueFora, defesaCasa, mediasLiga);
    const shared = Math.min(Math.max(0, Number(lambdaShared) || 0), lambdaHome * 0.95, lambdaAway * 0.95);

    const lambda1 = Math.max(0, lambdaHome - shared);
    const lambda2 = Math.max(0, lambdaAway - shared);

    let p_over15 = 0, p_under15 = 0, p_over25 = 0, p_under25 = 0, p_over35 = 0, p_under35 = 0, p_btts_yes = 0, p_btts_no = 0;

    for (let h = 0; h <= 10; h++) {
        for (let a = 0; a <= 10; a++) {
            // CORREÇÃO: Mantido apenas o Bivariate Poisson (que usa o lambda_shared
            // que você calcula historicamente de forma excelente).
            // Removida a linha do dixonColesCorrection que duplicava a punição.
            let prob = bivariatePoisson(h, a, lambda1, lambda2, shared);

            const totalGols = h + a;
            if (totalGols > 1.5) p_over15 += prob; else p_under15 += prob;
            if (totalGols > 2.5) p_over25 += prob; else p_under25 += prob;
            if (totalGols > 3.5) p_over35 += prob; else p_under35 += prob;
            if (h > 0 && a > 0) p_btts_yes += prob; else p_btts_no += prob;
        }
    }

    const total = p_over15 + p_under15;

    if (total > 0) {
        p_over15 /= total;
        p_under15 /= total;
        p_over25 /= total;
        p_under25 /= total;
        p_over35 /= total;
        p_under35 /= total;
        p_btts_yes /= total;
        p_btts_no /= total;
    }

    function probOverTime(lambda, line) {
        let probUnder = 0;
        for (let k = 0; k <= Math.floor(line); k++) probUnder += poisson(lambda, k);
        return 1 - probUnder;
    }

    return {
        total_esperado: lambdaHome + lambdaAway,
        esperado_casa: lambdaHome,
        esperado_fora: lambdaAway,
        lambda_home: lambdaHome,
        lambda_away: lambdaAway,
        lambda_shared: shared,
        geral: { p_over15, p_under15, p_over25, p_under25, p_over35, p_under35, p_btts_yes, p_btts_no },
        times: {
            casa: { o05: probOverTime(lambdaHome, 0.5), o15: probOverTime(lambdaHome, 1.5) },
            fora: { o05: probOverTime(lambdaAway, 0.5), o15: probOverTime(lambdaAway, 1.5) }
        }
    };
}
// ==========================================
// BLOCO DE ESCANTEIOS (100% BASEADO NO HISTÓRICO)
// ==========================================
function calcularMercadoEscanteios(historicoEscanteios, rCantos) {
    if (
        !historicoEscanteios ||
        !Number.isFinite(Number(historicoEscanteios.lambda_casa_hist)) ||
        !Number.isFinite(Number(historicoEscanteios.lambda_fora_hist))
    ) {
        return {
            total_esperado: 0,
            esperado_casa: 0,  // ADICIONADO AQUI
            esperado_fora: 0,  // ADICIONADO AQUI
            geral: { o75: 0, u75: 0, o85: 0, u85: 0, o95: 0, u95: 0 },
            times: {
                casa: { o35: 0, o45: 0 },
                fora: { o25: 0, o35: 0, o45: 0 }
            },
            r_cantos: R_CANTOS_PADRAO
        };
    }

    const xCantosMandante = Number(historicoEscanteios.lambda_casa_hist);
    const xCantosVisitante = Number(historicoEscanteios.lambda_fora_hist);
    const xCTotal = xCantosMandante + xCantosVisitante;

    const r = Number(rCantos) > 0 ? Number(rCantos) : R_CANTOS_PADRAO;

    const o75 = probOverNegativeBinomial(xCTotal, 7.5, r);
    const o85 = probOverNegativeBinomial(xCTotal, 8.5, r);
    const o95 = probOverNegativeBinomial(xCTotal, 9.5, r);

    return {
        total_esperado: xCTotal,
        esperado_casa: xCantosMandante,   // ADICIONADO AQUI
        esperado_fora: xCantosVisitante,  // ADICIONADO AQUI
        geral: {
            o75, u75: 1 - o75,
            o85, u85: 1 - o85,
            o95, u95: 1 - o95
        },
        times: {
            casa: {
                o35: probOverNegativeBinomial(xCantosMandante, 3.5, r),
                o45: probOverNegativeBinomial(xCantosMandante, 4.5, r)
            },
            fora: {
                o25: probOverNegativeBinomial(xCantosVisitante, 2.5, r),
                o35: probOverNegativeBinomial(xCantosVisitante, 3.5, r),
                o45: probOverNegativeBinomial(xCantosVisitante, 4.5, r)
            }
        },
        r_cantos: r
    };
}
// ==========================================
// BLOCO DE CARTÕES
// ==========================================
function calcularExpectedCards(
    comportamentoTime,
    comportamentoAdversarioContra,
    mediasLiga
) {
    const cartoesTime =
        Number(comportamentoTime?.cartoes_amarelos_mediana_wma) || 0;

    const faltasTime =
        Number(comportamentoTime?.faltas_mediana_wma) || 0;

    const desarmesTime =
        Number(comportamentoTime?.desarmes_total_mediana_wma) || 0;

    const desarmesCertosTime =
        Number(comportamentoTime?.desarmes_certos_mediana_wma) || 0;

    const cartoesAdversario =
        Number(comportamentoAdversarioContra?.cartoes_amarelos_mediana_wma) || 0;

    const faltasAdversario =
        Number(comportamentoAdversarioContra?.faltas_mediana_wma) || 0;

    const desarmesAdversario =
        Number(comportamentoAdversarioContra?.desarmes_total_mediana_wma) || 0;

    const desarmesCertosAdversario =
        Number(comportamentoAdversarioContra?.desarmes_certos_mediana_wma) || 0;

    const agressividadeTime = Math.max(
        0,
        faltasTime +
        (desarmesTime - desarmesCertosTime)
    );

    const agressividadeAdversario = Math.max(
        0,
        faltasAdversario +
        (desarmesAdversario - desarmesCertosAdversario)
    );

    const mediaFaltasLiga =
        Number(mediasLiga?.faltas) > 0
            ? Number(mediasLiga.faltas)
            : 17;

    const mediaCartoesLiga =
        Number(mediasLiga?.cartoes_amarelos) > 0
            ? Number(mediasLiga.cartoes_amarelos)
            : 2;

    const indiceAgressividadeTime =
        agressividadeTime > 0
            ? agressividadeTime / mediaFaltasLiga
            : 1;

    const indiceAgressividadeAdversario =
        agressividadeAdversario > 0
            ? agressividadeAdversario / mediaFaltasLiga
            : 1;

    const baseTime =
        cartoesTime > 0
            ? cartoesTime
            : mediaCartoesLiga;

    const baseAdversario =
        cartoesAdversario > 0
            ? cartoesAdversario
            : mediaCartoesLiga;

    /*
     * O cartão esperado do time nasce:
     *
     * 1. do comportamento disciplinar do próprio TIME;
     * 2. da intensidade do adversário em CONTRA;
     */
    const projecaoTime =
        (baseTime * 0.50) +
        (baseTime * indiceAgressividadeTime * 0.20) +
        (baseAdversario * indiceAgressividadeAdversario * 0.30);

    const fatorLiga =
        fatorCalibracaoLiga(
            projecaoTime,
            mediaCartoesLiga,
            0.20
        );

    return projecaoTime * fatorLiga;
}

function calcularMercadoCartoes(
    ataqueCasa,
    defesaFora,
    ataqueFora,
    defesaCasa,
    mediasLiga
) {
    /*
     * NOVA SEMÂNTICA
     *
     * Casa:
     *   TIME Casa     = comportamento próprio da Casa
     *   CONTRA Fora   = comportamento do adversário em seus jogos
     *
     * Fora:
     *   TIME Fora     = comportamento próprio do Fora
     *   CONTRA Casa   = comportamento do adversário em seus jogos
     */

    const xCardsMandante = calcularExpectedCards(
        ataqueCasa,
        defesaFora,
        mediasLiga
    );

    const xCardsVisitante = calcularExpectedCards(
        ataqueFora,
        defesaCasa,
        mediasLiga
    );

    const xCardsTotal =
        xCardsMandante + xCardsVisitante;

    const o25 =
        probOverZeroInflated(xCardsTotal, 2.5);

    const o35 =
        probOverZeroInflated(xCardsTotal, 3.5);

    const o45 =
        probOverZeroInflated(xCardsTotal, 4.5);

    const c_o25 =
        probOverZeroInflated(xCardsMandante, 2.5);

    const f_o25 =
        probOverZeroInflated(xCardsVisitante, 2.5);

    return {
        total_esperado: xCardsTotal,
        esperado_casa: xCardsMandante,
        esperado_fora: xCardsVisitante,
        geral: {
            o25,
            u25: 1 - o25,
            o35,
            u35: 1 - o35,
            o45,
            u45: 1 - o45
        },
        times: {
            casa: {
                o05: probOverZeroInflated(xCardsMandante, 0.5),
                o15: probOverZeroInflated(xCardsMandante, 1.5),
                o25: c_o25,
                u25: 1 - c_o25
            },
            fora: {
                o05: probOverZeroInflated(xCardsVisitante, 0.5),
                o15: probOverZeroInflated(xCardsVisitante, 1.5),
                o25: f_o25,
                u25: 1 - f_o25
            }
        }
    };
}


// ==========================================
// ORQUESTRADOR DE MATCHUP (ATUALIZADO)
// ==========================================
function analisarConfrontoCompleto(
    ataqueCasa,
    defesaFora,
    ataqueFora,
    defesaCasa,
    mediasLiga,
    lambdaShared,
    historicoEscanteios,
    rCantos
) {
    return {
        match_odds: calcularMercado1x2(
            ataqueCasa,
            defesaFora,
            ataqueFora,
            defesaCasa,
            mediasLiga,
            lambdaShared
        ),

        gols: calcularMercadoGols(
            ataqueCasa,
            defesaFora,
            ataqueFora,
            defesaCasa,
            mediasLiga,
            lambdaShared
        ),

        cantos: calcularMercadoEscanteios(
            historicoEscanteios,
            rCantos
        ),

        cartoes: calcularMercadoCartoes(
            ataqueCasa,
            defesaFora,
            ataqueFora,
            defesaCasa,
            mediasLiga
        )
    };
}

// ==========================================
// PARSE DOS DADOS
// ==========================================
function parseTeamData(row) {
    if (!row) return null;
    const parsedRow = { ...row };
    const camposNumericos = [
        'xg_mediana_wma', 'xgot_mediana_wma',
        'gols_marcados_mediana_wma', 'gols_sofridos_mediana_wma', // <-- NOVAS MÉTRICAS
        'finalizacoes_bloqueadas_mediana_wma', 'finalizacoes_mediana_wma',
        'finalizacoes_no_gol_mediana_wma', 'cruzamentos_total_mediana_wma', 'toques_area_adversaria_mediana_wma',
        'defesas_goleiro_mediana_wma', 'rebatidas_mediana_wma', 'escanteios_mediana_wma', 'faltas_mediana_wma', 'desarmes_total_mediana_wma',
        'desarmes_certos_mediana_wma', 'passes_terco_final_certos_mediana_wma', 'cartoes_amarelos_mediana_wma', 'chances_clara_mediana_wma'
    ];
    camposNumericos.forEach(campo => { parsedRow[campo] = parsedRow[campo] ? parseFloat(parsedRow[campo]) : 0; });
    return parsedRow;
}

// ==========================================
// BUSCA ESTATÍSTICAS DO MATCHUP
// ==========================================
async function buscarEstatisticasMatchup(flashscoreId, dataJogo, tipoAnalise) {
    const dataNormalizada = String(dataJogo).trim().replace(/\r/g, '').replace(/\n/g, '');
    console.log(`[MATCHUP] Time: ${flashscoreId} | Data recebida: ${JSON.stringify(dataJogo)} | Data normalizada: ${JSON.stringify(dataNormalizada)} | Tipo: ${tipoAnalise}`);
    const query = `
        SELECT *
        FROM analise_comportamento_times
        WHERE flashscore_id_time = $1 AND data_jogo::text LIKE $2 || '%' AND tipo_analise = $3 AND periodo = 'GE'
        LIMIT 1;
    `;
    const { rows } = await pool.query(query, [flashscoreId, dataNormalizada, tipoAnalise]);
    return parseTeamData(rows[0]);
}

async function rodarAnalisesPorData(dataAlvo) {
    const dataLimpa = String(dataAlvo).trim().replace(/[\r\n"']/g, '');
    if (!dataLimpa || dataLimpa.length < 8) {
        console.warn(`[AVISO] Linha vazia ou inválida ignorada (Valor recebido: ${JSON.stringify(dataAlvo)})`);
        return;
    }
    console.log(`Iniciando população na tabela analises_jogo para a data: ${dataLimpa}...`);

    try {
        const queryJogos = `
            SELECT *
            FROM jogos
            WHERE data_jogo::text LIKE $1 || '%';
        `;
        const jogos = await pool.query(queryJogos, [dataLimpa]);
        if (jogos.rows.length === 0) {
            console.log(`Nenhum jogo encontrado para a data ${dataLimpa}.`);
            return;
        }

        for (const jogo of jogos.rows) {
            const lambdaShared = await estimarLambdaShared(jogo.flashscore_id_time_casa, jogo.flashscore_id_time_fora, dataLimpa);
            const historicoEscanteios = await buscarEscanteiosHistoricos(jogo.flashscore_id_time_casa, jogo.flashscore_id_time_fora, dataLimpa);
            const rCantos = await estimarRCantosCompeticao(jogo.id_competicao, dataLimpa);
            const ataqueCasa = await buscarEstatisticasMatchup(
                jogo.flashscore_id_time_casa,
                dataLimpa,
                'ATAQUE_DEFESA_TIME'
            );

            const defesaCasa = await buscarEstatisticasMatchup(
                jogo.flashscore_id_time_casa,
                dataLimpa,
                'ATAQUE_DEFESA_CONTRA'
            );

            const ataqueFora = await buscarEstatisticasMatchup(
                jogo.flashscore_id_time_fora,
                dataLimpa,
                'ATAQUE_DEFESA_TIME'
            );

            const defesaFora = await buscarEstatisticasMatchup(
                jogo.flashscore_id_time_fora,
                dataLimpa,
                'ATAQUE_DEFESA_CONTRA'
            );
            if (!ataqueCasa || !defesaCasa || !ataqueFora || !defesaFora) {
                console.log(`[AVISO] Dados de comportamento incompletos para ${jogo.nome_time_casa} x ${jogo.nome_time_fora}. Jogo ignorado.`);
                continue;
            }

            const mediasLiga = await buscarMediasLiga(jogo.id_competicao);
            const previsoes = analisarConfrontoCompleto(ataqueCasa, defesaFora, ataqueFora, defesaCasa, mediasLiga, lambdaShared, historicoEscanteios, rCantos);
            const historicoBTTS = await buscarHistoricoBTTS(
                jogo.flashscore_id_time_casa,
                jogo.flashscore_id_time_fora,
                dataLimpa
            );
            aplicarCalibracaoBTTS(previsoes, historicoBTTS);

            const mediaGolsLiga = mediasLiga.xg ? parseFloat(mediasLiga.xg * 2).toFixed(2) : null;
            const mediaCantosLiga = mediasLiga.escanteios ? parseFloat(mediasLiga.escanteios * 2).toFixed(2) : null;
            const mediaCartoesLiga = mediasLiga.cartoes_amarelos ? parseFloat(mediasLiga.cartoes_amarelos * 2).toFixed(2) : null;
            const horaLimpa = jogo.hora_jogo ? String(jogo.hora_jogo).trim().replace(/[\r\n"']/g, '') : null;

            const params = [
                jogo.flashscore_id, dataLimpa, horaLimpa, jogo.id_time_casa, jogo.id_time_fora,
                jogo.nome_time_casa, jogo.nome_time_fora, jogo.id_competicao, jogo.nome_competicao, jogo.pais_liga,
                jogo.rodada, mediaGolsLiga, mediaCantosLiga, mediaCartoesLiga,
                percentual(previsoes.match_odds.p_home), percentual(previsoes.match_odds.p_draw), percentual(previsoes.match_odds.p_away),

                // --- ADICIONADO AQUI: GOLS (Total, Casa, Fora) ---
                previsoes.gols.total_esperado.toFixed(2), previsoes.gols.esperado_casa.toFixed(2), previsoes.gols.esperado_fora.toFixed(2),

                percentual(previsoes.gols.geral.p_over15), percentual(previsoes.gols.geral.p_under15), percentual(previsoes.gols.geral.p_over25), percentual(previsoes.gols.geral.p_under25), percentual(previsoes.gols.geral.p_over35), percentual(previsoes.gols.geral.p_under35), percentual(previsoes.gols.geral.p_btts_yes), percentual(previsoes.gols.geral.p_btts_no),
                percentual(previsoes.gols.times.casa.o05), percentual(previsoes.gols.times.casa.o15), percentual(previsoes.gols.times.fora.o05), percentual(previsoes.gols.times.fora.o15),

                previsoes.cantos.total_esperado.toFixed(2),
                // --- ADICIONADO AQUI: CANTOS (Casa, Fora) ---
                previsoes.cantos.esperado_casa.toFixed(2), previsoes.cantos.esperado_fora.toFixed(2),

                percentual(previsoes.cantos.geral.o75), percentual(previsoes.cantos.geral.u75), percentual(previsoes.cantos.geral.o85), percentual(previsoes.cantos.geral.u85), percentual(previsoes.cantos.geral.o95), percentual(previsoes.cantos.geral.u95),
                percentual(previsoes.cantos.times.casa.o35), percentual(previsoes.cantos.times.casa.o45), percentual(previsoes.cantos.times.fora.o25), percentual(previsoes.cantos.times.fora.o35), percentual(previsoes.cantos.times.fora.o45),

                previsoes.cartoes.total_esperado.toFixed(2),
                // --- ADICIONADO AQUI: CARTÕES (Casa, Fora) ---
                previsoes.cartoes.esperado_casa.toFixed(2), previsoes.cartoes.esperado_fora.toFixed(2),

                percentual(previsoes.cartoes.geral.o25), percentual(previsoes.cartoes.geral.u25), percentual(previsoes.cartoes.geral.o35), percentual(previsoes.cartoes.geral.u35), percentual(previsoes.cartoes.geral.o45), percentual(previsoes.cartoes.geral.u45),
                percentual(previsoes.cartoes.times.casa.o05), percentual(previsoes.cartoes.times.casa.o15), percentual(previsoes.cartoes.times.casa.o25), percentual(previsoes.cartoes.times.casa.u25),
                percentual(previsoes.cartoes.times.fora.o05), percentual(previsoes.cartoes.times.fora.o15), percentual(previsoes.cartoes.times.fora.o25), percentual(previsoes.cartoes.times.fora.u25)
            ];

            // --- ADICIONADO AQUI: Colunas novas na Query e do $57 ao $63 ---
            const queryInsert = `
                INSERT INTO analises_jogo (
                    flashscore_id_jogo, data_jogo, hora_jogo, id_time_casa, id_time_fora, nome_time_casa, nome_time_fora, id_competicao, nome_competicao, pais_liga, rodada, media_gols_liga, media_cantos_liga, media_cartoes_liga,
                    p_home, p_draw, p_away, 
                    total_gols_esperado, casa_gols_esperado, fora_gols_esperado, /* ADICIONADO AQUI */
                    p_over15, p_under15, p_over25, p_under25, p_over35, p_under35, p_btts_yes, p_btts_no, p_casa_over05, p_casa_over15, p_fora_over05, p_fora_over15,
                    total_cantos_esperado, casa_cantos_esperado, fora_cantos_esperado, /* ADICIONADO AQUI */
                    p_cantos_over75, p_cantos_under75, p_cantos_over85, p_cantos_under85, p_cantos_over95, p_cantos_under95, p_casa_cantos_over35, p_casa_cantos_over45, p_fora_cantos_over25, p_fora_cantos_over35, p_fora_cantos_over45,
                    total_cartoes_esperado, casa_cartoes_esperado, fora_cartoes_esperado, /* ADICIONADO AQUI */
                    p_cartoes_over25, p_cartoes_under25, p_cartoes_over35, p_cartoes_under35, p_cartoes_over45, p_cartoes_under45, p_casa_cartoes_over05, p_casa_cartoes_over15, p_casa_cartoes_over25, p_casa_cartoes_under25, p_fora_cartoes_over05, p_fora_cartoes_over15, p_fora_cartoes_over25, p_fora_cartoes_under25
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44, $45, $46, $47, $48, $49, $50, $51, $52, $53, $54, $55, $56, $57, $58, $59, $60, $61, $62, $63
                );
            `;

            await pool.query(queryInsert, params);
            console.log(`[OK] ${jogo.nome_time_casa} x ${jogo.nome_time_fora} | lambdaShared: ${Number(lambdaShared).toFixed(4)}`);
        }

    } catch (error) {
        console.error(`[ERRO CRÍTICO] Falha ao processar dados para ${dataLimpa}:`, error);
    }
}


const DATA_ALVO = process.argv[2];

if (!DATA_ALVO) {
    console.error('Data não informada. Exemplo: node previsao.js 2026-08-17');
    process.exit(1);
}

rodarAnalisesPorData(DATA_ALVO);