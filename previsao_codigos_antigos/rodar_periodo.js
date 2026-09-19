const { spawn } = require('child_process');

// ======================================================
// CONFIGURAÇÃO
// ======================================================

const DATA_INICIAL = '2025-01-01';
const DATA_FINAL = '2026-09-02';

const CODIGO_ANALISE = 'analise_comportamento_tabela_jogos.js';
const CODIGO_PREVISAO = 'previsoes_mercado_tabela_jogos.js';
const CODIGO_PREVISAO_HT = 'previsao_mercados_ht_tabela_jogos.js';

// ======================================================
// CONVERTER DATA
// ======================================================

function dataParaObjeto(data) {
    const [ano, mes, dia] = data.split('-').map(Number);
    return new Date(Date.UTC(ano, mes - 1, dia));
}

function objetoParaData(data) {
    return data.toISOString().split('T')[0];
}

// ======================================================
// EXECUTAR UM SCRIPT NODE
// ======================================================

function executarScript(script, data) {
    return new Promise((resolve, reject) => {
        console.log('\n======================================================');
        console.log(`EXECUTANDO: ${script}`);
        console.log(`DATA: ${data}`);
        console.log('======================================================');

        const processo = spawn('node', [script, data], {
            stdio: 'inherit',
            shell: false
        });

        processo.on('error', (erro) => {
            console.error(`[ERRO] Falha ao iniciar ${script}:`, erro.message);
            reject(erro);
        });

        processo.on('close', (codigo) => {
            if (codigo === 0) {
                console.log(`[OK] ${script} terminou com sucesso.`);
                resolve();
            } else {
                console.error(`[ERRO] ${script} terminou com código ${codigo}.`);
                reject(new Error(`${script} terminou com código ${codigo}`));
            }
        });
    });
}

// ======================================================
// PROCESSAR UMA DATA
// ======================================================

async function processarData(data) {
    console.log('\n######################################################');
    console.log(`# PROCESSANDO DATA: ${data}`);
    console.log('######################################################');

    // --------------------------------------------------
    // 1. ANÁLISE DE COMPORTAMENTO
    // --------------------------------------------------

    console.log('\n>>> ETAPA 1 - ANÁLISE DE COMPORTAMENTO');
    console.log(`>>> Data: ${data}`);

    executarScript(CODIGO_ANALISE, data);

    // --------------------------------------------------
    // 2. PREVISÕES DE MERCADO
    // --------------------------------------------------

    console.log('\n>>> ETAPA 2 - PREVISÕES DE MERCADO');
    console.log(`>>> Data: ${data}`);

    await executarScript(CODIGO_PREVISAO, data);

    // --------------------------------------------------
    // 3. PREVISÕES DE MERCADO HT
    // --------------------------------------------------

    console.log('\n>>> ETAPA 3 - PREVISÕES DE MERCADO HT');
    console.log(`>>> Data: ${data}`);

 await executarScript(CODIGO_PREVISAO_HT, data); 

    console.log(`\n>>> DATA ${data} FINALIZADA COM SUCESSO.`);
    console.log('######################################################');
}

// ======================================================
// PROCESSAR TODO O PERÍODO
// ======================================================

async function processarPeriodo() {
    const inicio = dataParaObjeto(DATA_INICIAL);
    const fim = dataParaObjeto(DATA_FINAL);
    let dataAtual = inicio;

    while (dataAtual <= fim) {
        const data = objetoParaData(dataAtual);

        try {
            await processarData(data);
        } catch (erro) {
            console.error('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            console.error(`ERRO AO PROCESSAR A DATA ${data}`);
            console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
            console.error(erro.message);
            console.error('\nProcessamento interrompido.');
            process.exit(1);
        }

        dataAtual.setUTCDate(dataAtual.getUTCDate() + 1);
    }

    console.log('\n======================================================');
    console.log('      PERÍODO PROCESSADO COM SUCESSO');
    console.log(`      INÍCIO: ${DATA_INICIAL}`);
    console.log(`      FINAL:  ${DATA_FINAL}`);
    console.log('======================================================');
}

// ======================================================
// INICIAR
// ======================================================

processarPeriodo();