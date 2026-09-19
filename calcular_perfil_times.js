const { Client } = require('pg');
const {
    otimizarModeloPosse, classificarEstiloPosse,
    otimizarModeloEstilo, indiceEstilo
} = require('./market_model');

const client = new Client({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:Wallace%4022@100.114.225.110:5432/stats_futebol'
});

const JANELA_HISTORICO = '1 year';
const MIN_JOGOS_TREINO = 20;
const DECAIMENTO_TEMPO = 0.005;

const EIXOS = [
    {
        nome: 'construcao',
        canais: [
            { chave: 'passes_porcentagem', pesoOfensivo: 0.5, pesoConcessao: 0.5 },
            { chave: 'passes_terco_final_porcentagem', pesoOfensivo: 0.5, pesoConcessao: 0.5 }
        ]
    },
    {
        nome: 'verticalizacao',
        canais: [
            { chave: 'passes_longos_porcentagem', pesoOfensivo: 0.5, pesoConcessao: 0.5 },
            { chave: 'cruzamentos_total', pesoOfensivo: 0.5, pesoConcessao: 0.5 }
        ]
    },
    {
        nome: 'penetracao',
        canais: [
            { chave: 'toques_area_adversaria', pesoOfensivo: 0.5, pesoConcessao: 0.5 },
            { chave: 'finalizacoes_de_dentro_area', pesoOfensivo: 0.5, pesoConcessao: 0.5 }
        ]
    },
    {
        nome: 'intensidade',
        canais: [
            { chave: 'desarmes_total', pesoOfensivo: 0.4, pesoConcessao: 0.4 },
            { chave: 'duelos_ganhos', pesoOfensivo: 0.3, pesoConcessao: 0.3 },
            { chave: 'faltas', pesoOfensivo: 0.3, pesoConcessao: 0.3 }
        ]
    },
    {
        nome: 'eficiencia',
        canais: [
            { chave: 'xg', pesoOfensivo: 0.5, pesoConcessao: 0.5 },
            { chave: 'chances_clara', pesoOfensivo: 0.3, pesoConcessao: 0.3 },
            { chave: 'xa', pesoOfensivo: 0.2, pesoConcessao: 0.2 }
        ]
    }
];

const TODAS_METRICAS_ESTILO = [...new Set(EIXOS.flatMap(e => e.canais.map(c => c.chave)))];

// ============================================================================
// TABELA DE SAÍDA — CREATE + ALTER (a tabela já existe do run anterior,
// então usamos ADD COLUMN IF NOT EXISTS pras colunas novas de casa/fora;
// as colunas antigas sem mando ficam paradas na tabela, sem uso, você
// pode dropar depois se quiser).
// ============================================================================

async function garantirTabelaPerfil() {
    await client.query(`
        CREATE TABLE IF NOT EXISTS perfil_times (
            id SERIAL PRIMARY KEY,
            flashscore_id_time TEXT NOT NULL,
            id_time INTEGER,
            id_competicao INTEGER NOT NULL,
            nome_time TEXT,
            nome_competicao TEXT,
            jogos_utilizados INTEGER,
            data_referencia DATE,
            atualizado_em TIMESTAMP DEFAULT NOW(),
            UNIQUE(flashscore_id_time, id_competicao)
        )
    `);

    const colunasNovas = [
        'dominancia_posse_casa NUMERIC', 'dominancia_posse_fora NUMERIC',
        'mediana_liga_posse_casa NUMERIC', 'mediana_liga_posse_fora NUMERIC',
        'estilo_posse_casa TEXT', 'estilo_posse_fora TEXT'
    ];

    for (const eixo of EIXOS) {
        colunasNovas.push(
            `ofensiva_${eixo.nome}_casa NUMERIC`,
            `ofensiva_${eixo.nome}_fora NUMERIC`,
            `concessao_${eixo.nome}_casa NUMERIC`,
            `concessao_${eixo.nome}_fora NUMERIC`
        );
    }

    for (const definicao of colunasNovas) {
        const nomeColuna = definicao.split(' ')[0];
        await client.query(`ALTER TABLE perfil_times ADD COLUMN IF NOT EXISTS ${definicao}`).catch(() => {});
        void nomeColuna;
    }
}

async function salvarPerfilTime(linha) {
    const eixoValor = (nome, ladoMando, campo) => linha.eixos?.[nome]?.[ladoMando]?.[campo] ?? null;

    await client.query(`
        INSERT INTO perfil_times (
            flashscore_id_time, id_time, id_competicao, nome_time, nome_competicao, jogos_utilizados,
            dominancia_posse_casa, dominancia_posse_fora,
            mediana_liga_posse_casa, mediana_liga_posse_fora,
            estilo_posse_casa, estilo_posse_fora,
            ofensiva_construcao_casa, ofensiva_construcao_fora, concessao_construcao_casa, concessao_construcao_fora,
            ofensiva_verticalizacao_casa, ofensiva_verticalizacao_fora, concessao_verticalizacao_casa, concessao_verticalizacao_fora,
            ofensiva_penetracao_casa, ofensiva_penetracao_fora, concessao_penetracao_casa, concessao_penetracao_fora,
            ofensiva_intensidade_casa, ofensiva_intensidade_fora, concessao_intensidade_casa, concessao_intensidade_fora,
            ofensiva_eficiencia_casa, ofensiva_eficiencia_fora, concessao_eficiencia_casa, concessao_eficiencia_fora,
            data_referencia, atualizado_em
        ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8,
            $9, $10,
            $11, $12,
            $13, $14, $15, $16,
            $17, $18, $19, $20,
            $21, $22, $23, $24,
            $25, $26, $27, $28,
            $29, $30, $31, $32,
            $33, NOW()
        )
        ON CONFLICT (flashscore_id_time, id_competicao) DO UPDATE SET
            id_time = EXCLUDED.id_time,
            nome_time = EXCLUDED.nome_time,
            nome_competicao = EXCLUDED.nome_competicao,
            jogos_utilizados = EXCLUDED.jogos_utilizados,
            dominancia_posse_casa = EXCLUDED.dominancia_posse_casa,
            dominancia_posse_fora = EXCLUDED.dominancia_posse_fora,
            mediana_liga_posse_casa = EXCLUDED.mediana_liga_posse_casa,
            mediana_liga_posse_fora = EXCLUDED.mediana_liga_posse_fora,
            estilo_posse_casa = EXCLUDED.estilo_posse_casa,
            estilo_posse_fora = EXCLUDED.estilo_posse_fora,
            ofensiva_construcao_casa = EXCLUDED.ofensiva_construcao_casa,
            ofensiva_construcao_fora = EXCLUDED.ofensiva_construcao_fora,
            concessao_construcao_casa = EXCLUDED.concessao_construcao_casa,
            concessao_construcao_fora = EXCLUDED.concessao_construcao_fora,
            ofensiva_verticalizacao_casa = EXCLUDED.ofensiva_verticalizacao_casa,
            ofensiva_verticalizacao_fora = EXCLUDED.ofensiva_verticalizacao_fora,
            concessao_verticalizacao_casa = EXCLUDED.concessao_verticalizacao_casa,
            concessao_verticalizacao_fora = EXCLUDED.concessao_verticalizacao_fora,
            ofensiva_penetracao_casa = EXCLUDED.ofensiva_penetracao_casa,
            ofensiva_penetracao_fora = EXCLUDED.ofensiva_penetracao_fora,
            concessao_penetracao_casa = EXCLUDED.concessao_penetracao_casa,
            concessao_penetracao_fora = EXCLUDED.concessao_penetracao_fora,
            ofensiva_intensidade_casa = EXCLUDED.ofensiva_intensidade_casa,
            ofensiva_intensidade_fora = EXCLUDED.ofensiva_intensidade_fora,
            concessao_intensidade_casa = EXCLUDED.concessao_intensidade_casa,
            concessao_intensidade_fora = EXCLUDED.concessao_intensidade_fora,
            ofensiva_eficiencia_casa = EXCLUDED.ofensiva_eficiencia_casa,
            ofensiva_eficiencia_fora = EXCLUDED.ofensiva_eficiencia_fora,
            concessao_eficiencia_casa = EXCLUDED.concessao_eficiencia_casa,
            concessao_eficiencia_fora = EXCLUDED.concessao_eficiencia_fora,
            data_referencia = EXCLUDED.data_referencia,
            atualizado_em = NOW()
    `, [
        linha.flashscoreIdTime, linha.idTime, linha.idCompeticao, linha.nomeTime, linha.nomeCompeticao, linha.jogosUtilizados,
        linha.posse?.casa?.dominancia ?? null, linha.posse?.fora?.dominancia ?? null,
        linha.posse?.casa?.medianaLiga ?? null, linha.posse?.fora?.medianaLiga ?? null,
        linha.posse?.casa?.estilo ?? null, linha.posse?.fora?.estilo ?? null,
        eixoValor('construcao', 'casa', 'ofensiva'), eixoValor('construcao', 'fora', 'ofensiva'),
        eixoValor('construcao', 'casa', 'concessao'), eixoValor('construcao', 'fora', 'concessao'),
        eixoValor('verticalizacao', 'casa', 'ofensiva'), eixoValor('verticalizacao', 'fora', 'ofensiva'),
        eixoValor('verticalizacao', 'casa', 'concessao'), eixoValor('verticalizacao', 'fora', 'concessao'),
        eixoValor('penetracao', 'casa', 'ofensiva'), eixoValor('penetracao', 'fora', 'ofensiva'),
        eixoValor('penetracao', 'casa', 'concessao'), eixoValor('penetracao', 'fora', 'concessao'),
        eixoValor('intensidade', 'casa', 'ofensiva'), eixoValor('intensidade', 'fora', 'ofensiva'),
        eixoValor('intensidade', 'casa', 'concessao'), eixoValor('intensidade', 'fora', 'concessao'),
        eixoValor('eficiencia', 'casa', 'ofensiva'), eixoValor('eficiencia', 'fora', 'ofensiva'),
        eixoValor('eficiencia', 'casa', 'concessao'), eixoValor('eficiencia', 'fora', 'concessao'),
        linha.dataReferencia
    ]);
}

// ============================================================================
// LIGA PRINCIPAL POR TIME (mantido do seu código)
// ============================================================================

async function buscarCompeticaoPrincipalTimes() {
    const { rows } = await client.query(`SELECT flashscore_id, competicao_disputada FROM times WHERE competicao_disputada IS NOT NULL`);
    const mapa = new Map();

    for (const row of rows) {
        try {
            let arr = row.competicao_disputada;
            if (typeof arr === 'string') arr = JSON.parse(arr);

            if (Array.isArray(arr) && arr.length > 0) {
                const ids = arr.map(Number).filter(id => !isNaN(id));
                const validos = ids.filter(id => id !== 1104);

                if (validos.length > 0) {
                    mapa.set(row.flashscore_id, Math.min(...validos));
                } else if (ids.length > 0) {
                    mapa.set(row.flashscore_id, Math.min(...ids));
                }
            }
        } catch (e) {
            // ignora time com array mal formatado
        }
    }

    console.log(`[OK] Liga principal identificada para ${mapa.size} times.`);
    return mapa;
}

async function buscarCompeticoesAtivas(dataReferencia) {
    const { rows } = await client.query(`
        SELECT DISTINCT id_competicao
        FROM jogos
        WHERE data_jogo::date >= $1::date - INTERVAL '${JANELA_HISTORICO}'
          AND data_jogo::date < $1::date
          AND placar_casa IS NOT NULL
          AND placar_fora IS NOT NULL
          AND id_competicao IS NOT NULL
        ORDER BY id_competicao
    `, [dataReferencia]);

    return rows.map(r => r.id_competicao);
}

async function buscarReferenciaLigaEstilo(idCompeticao) {
    const { rows } = await client.query(`
        SELECT metrica, casa_mediana, fora_mediana
        FROM grid_metricas_competicoes
        WHERE id_competicao = $1 AND metrica = ANY($2)
    `, [idCompeticao, TODAS_METRICAS_ESTILO]);

    const referenciaLiga = {};
    for (const row of rows) referenciaLiga[row.metrica] = { casa: Number(row.casa_mediana), fora: Number(row.fora_mediana) };
    return referenciaLiga;
}

async function buscarHistoricoCompeticao(idCompeticao, dataReferencia) {
    const colunasMetricas = ['posse_bola', ...TODAS_METRICAS_ESTILO].map(m => `sg.${m}`).join(', ');

    const { rows } = await client.query(`
        SELECT
            j.flashscore_id,
            j.flashscore_id_time_casa, j.flashscore_id_time_fora,
            j.id_time_casa, j.id_time_fora,
            j.nome_time_casa, j.nome_time_fora, j.nome_competicao,
            sg.eh_casa, ${colunasMetricas},
            EXP(-${DECAIMENTO_TEMPO} * ($2::date - j.data_jogo::date)) AS peso_tempo
        FROM jogos j
        INNER JOIN estatisticas_geral sg ON sg.flashscore_id_jogo = j.flashscore_id
        WHERE j.id_competicao = $1
          AND j.data_jogo::date >= $2::date - INTERVAL '${JANELA_HISTORICO}'
          AND j.data_jogo::date < $2::date
          AND j.placar_casa IS NOT NULL
          AND j.placar_fora IS NOT NULL
        ORDER BY j.data_jogo::date ASC
    `, [idCompeticao, dataReferencia]);

    const mapaJogos = new Map();
    const nomesTimes = new Map();
    const idsTimes = new Map();

    for (const linha of rows) {
        const chave = String(linha.flashscore_id);
        const casaFlashscoreId = String(linha.flashscore_id_time_casa);
        const foraFlashscoreId = String(linha.flashscore_id_time_fora);

        if (!mapaJogos.has(chave)) {
            const jogo = {
                casa_id: casaFlashscoreId,
                fora_id: foraFlashscoreId,
                peso_tempo: Number(linha.peso_tempo) || 1,
                posse_casa: null, posse_fora: null
            };
            for (const m of TODAS_METRICAS_ESTILO) {
                jogo[`${m}_casa`] = null;
                jogo[`${m}_fora`] = null;
            }
            mapaJogos.set(chave, jogo);
        }

        nomesTimes.set(casaFlashscoreId, linha.nome_time_casa);
        nomesTimes.set(foraFlashscoreId, linha.nome_time_fora);

        if (linha.id_time_casa) idsTimes.set(casaFlashscoreId, Number(linha.id_time_casa));
        if (linha.id_time_fora) idsTimes.set(foraFlashscoreId, Number(linha.id_time_fora));

        const jogo = mapaJogos.get(chave);
        const lado = Number(linha.eh_casa) === 1 ? 'casa' : (Number(linha.eh_casa) === 0 ? 'fora' : null);
        if (!lado) continue;

        jogo[`posse_${lado}`] = linha.posse_bola !== null ? Number(linha.posse_bola) : null;
        for (const m of TODAS_METRICAS_ESTILO) {
            const valor = linha[m];
            jogo[`${m}_${lado}`] = valor !== null ? Number(valor) : null;
        }
    }

    const jogosValidos = Array.from(mapaJogos.values()).filter(j => j.casa_id && j.fora_id);
    const nomeCompeticao = rows.length > 0 ? rows[0].nome_competicao : null;

    return { jogosValidos, nomesTimes, idsTimes, nomeCompeticao };
}

// ============================================================================
// CÁLCULO DO PERFIL DE UMA COMPETIÇÃO — POSSE E ESTILOS SEPARADOS POR MANDO
// ============================================================================

async function calcularPerfilCompeticao(idCompeticao, dataReferencia) {
    const { jogosValidos, nomesTimes, idsTimes, nomeCompeticao } = await buscarHistoricoCompeticao(idCompeticao, dataReferencia);

    if (jogosValidos.length < MIN_JOGOS_TREINO) {
        console.log(`[PULAR] Competição ${idCompeticao}: histórico insuficiente (${jogosValidos.length} jogos, mínimo ${MIN_JOGOS_TREINO})`);
        return [];
    }

    const jogosComPosse = jogosValidos.filter(j => Number.isFinite(j.posse_casa) && Number.isFinite(j.posse_fora));
    let parametrosPosse = null;

    if (jogosComPosse.length >= MIN_JOGOS_TREINO) {
        parametrosPosse = await otimizarModeloPosse(jogosComPosse, 1500, 0.01, { regularizacao: 0.02, gradienteMax: 3 });
        console.log(`[OK] Competição ${idCompeticao}: dominância de posse (casa/fora) ajustada com ${jogosComPosse.length} jogos`);
    }

    const referenciaLigaEstilo = await buscarReferenciaLigaEstilo(idCompeticao);
    const parametrosPorEixo = {};

    for (const eixo of EIXOS) {
        const faltantes = eixo.canais
            .map(c => c.chave)
            .filter(chave => !referenciaLigaEstilo[chave] || !Number.isFinite(referenciaLigaEstilo[chave].casa) || !Number.isFinite(referenciaLigaEstilo[chave].fora));

        if (faltantes.length > 0) {
            console.log(`[PULAR EIXO ${eixo.nome}] Competição ${idCompeticao}: métricas incompletas [${faltantes.join(', ')}]`);
            continue;
        }

        const referenciaLigaEixo = {};
        for (const c of eixo.canais) referenciaLigaEixo[c.chave] = referenciaLigaEstilo[c.chave];

        parametrosPorEixo[eixo.nome] = await otimizarModeloEstilo(jogosValidos, eixo.canais, 1500, 0.003, {
            referenciaLiga: referenciaLigaEixo,
            regularizacao: 0.02,
            gradienteMax: 5
        });
    }

    const times = new Set();
    for (const j of jogosValidos) { times.add(j.casa_id); times.add(j.fora_id); }

    const linhas = [];

    for (const flashscoreIdTime of times) {
        let posse = null;
        if (parametrosPosse) posse = classificarEstiloPosse(parametrosPosse, flashscoreIdTime);

        const eixosDoTime = {};
        for (const eixo of EIXOS) {
            if (!parametrosPorEixo[eixo.nome]) continue;
            eixosDoTime[eixo.nome] = indiceEstilo(parametrosPorEixo[eixo.nome], flashscoreIdTime);
        }

        linhas.push({
            flashscoreIdTime,
            idTime: idsTimes.get(flashscoreIdTime) ?? null,
            idCompeticao,
            nomeTime: nomesTimes.get(flashscoreIdTime) || null,
            nomeCompeticao,
            jogosUtilizados: jogosValidos.length,
            posse,
            eixos: eixosDoTime,
            dataReferencia
        });
    }

    return linhas;
}

// ============================================================================
// EXECUÇÃO PRINCIPAL — COM ÂNCORA DE LIGA PRINCIPAL (mantido do seu código)
// ============================================================================

async function calcularPerfilTodasCompeticoes(dataReferencia) {
    console.log(`\n--- CALCULANDO PERFIL DE TIMES (casa/fora) — referência: ${dataReferencia} ---\n`);

    await client.connect();

    try {
        await garantirTabelaPerfil();

        const competicoes = await buscarCompeticoesAtivas(dataReferencia);
        console.log(`Competições ativas na janela de 1 ano: ${competicoes.length}\n`);

        const mapaPrincipal = await buscarCompeticaoPrincipalTimes();
        const perfisGerados = [];

        for (const idCompeticao of competicoes) {
            const linhas = await calcularPerfilCompeticao(idCompeticao, dataReferencia);
            perfisGerados.push(...linhas);
        }

        console.log(`\n--- PÓS-PROCESSAMENTO: APLICANDO LIGA PRINCIPAL (menor ID) ---`);

        const perfisPorTime = new Map();
        for (const linha of perfisGerados) {
            if (!perfisPorTime.has(linha.flashscoreIdTime)) perfisPorTime.set(linha.flashscoreIdTime, new Map());
            perfisPorTime.get(linha.flashscoreIdTime).set(linha.idCompeticao, linha);
        }

        const perfisParaSalvar = [];

        for (const [flashscoreId, mapasCompeticoes] of perfisPorTime.entries()) {
            const idPrincipal = mapaPrincipal.get(flashscoreId);
            let perfilVerdadeiro = mapasCompeticoes.get(idPrincipal);

            if (!perfilVerdadeiro) {
                const idsJogados = Array.from(mapasCompeticoes.keys()).filter(id => id !== 1104);
                const menorIdJogado = idsJogados.length > 0 ? Math.min(...idsJogados) : Array.from(mapasCompeticoes.keys())[0];
                perfilVerdadeiro = mapasCompeticoes.get(menorIdJogado);
            }

            for (const [idCompeticao, linhaOriginal] of mapasCompeticoes.entries()) {
                perfisParaSalvar.push({
                    ...perfilVerdadeiro,
                    idCompeticao,
                    nomeCompeticao: linhaOriginal.nomeCompeticao,
                    jogosUtilizados: linhaOriginal.jogosUtilizados
                });
            }
        }

        let totalTimesSalvos = 0;
        for (const linha of perfisParaSalvar) {
            await salvarPerfilTime(linha);
            totalTimesSalvos++;
        }

        console.log(`\n🎉 Perfis (casa/fora) ancorados pela liga principal e salvos para ${totalTimesSalvos} cruzamentos time/competição.`);

    } catch (err) {
        console.error('[ERRO FATAL]', err);
    } finally {
        await client.end();
    }
}

const dataReferenciaEscolhida = '2026-09-10';
calcularPerfilTodasCompeticoes(dataReferenciaEscolhida);