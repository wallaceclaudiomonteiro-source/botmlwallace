// db_gols.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.resolve(__dirname, 'stats.db');

/**
 * Função 1: pega jogos do calendário para uma data específica
 */
function pegaJogosDoDia(dataEscolhida) {
  const db = new sqlite3.Database(dbPath);
  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        flashscore_id,
        data_jogo,
        hora_jogo,
        id_time_casa,
        id_time_fora,
        nome_time_casa,
        nome_time_fora,
        flashscore_id_casa,
        flashscore_id_fora,
        flashscore_id_competicao
      FROM calendario
      WHERE data_jogo = ?
    `;
    db.all(query, [dataEscolhida], (err, rows) => {
      if (err) {
        db.close();
        reject(err);
        return;
      }

      const jogos = rows.map(row => ({
        flashscore_id: row.flashscore_id,
        data_jogo: row.data_jogo,
        hora_jogo: row.hora_jogo,
        competicao: row.flashscore_id_competicao,
        casa: {
          flashscore_id_time: row.flashscore_id_casa,
          id_time: row.id_time_casa,
          nome_time: row.nome_time_casa,
          data_jogo: row.data_jogo,
          hora_jogo: row.hora_jogo
        },
        fora: {
          flashscore_id_time: row.flashscore_id_fora,
          id_time: row.id_time_fora,
          nome_time: row.nome_time_fora,
          data_jogo: row.data_jogo,
          hora_jogo: row.hora_jogo
        }
      }));

      db.close();
      resolve(jogos);
    });
  });
}

/**
 * Helper: classifica posição em faixa (top, meio, bottom) de forma automática (30/40/30)
 */
function faixaTabela(posicao, totalTimes) {
  if (!posicao || !totalTimes) return "meio";

  // Define 30% para o Topo e 30% para o Fundo (mínimo de 3 times)
  const corte = Math.max(3, Math.ceil(totalTimes * 0.3));

  if (posicao <= corte) return "top";
  if (posicao > totalTimes - corte) return "bottom";
  return "meio";
}
// Altere a assinatura para aceitar o segundo parâmetro
/**
 * Função 2: pega últimos jogos com TRAVA TEMPORAL (Corrigida)
 */
function pegaUltimosJogos(jogosCalendario, dataReferencia) {
  const db = new sqlite3.Database(dbPath);
  const MAX_POR_FAIXA = 5;
  const MAX_RECENTES = 5;

  return new Promise((resolve, reject) => {
    const promises = [];

    jogosCalendario.forEach(jogo => {
      promises.push(new Promise((res, rej) => {
        // 1️⃣ Pega a classificação da temporada
        const classQuery = `SELECT flashscore_id_time, posicao_final FROM classificacao WHERE temporada = ?`;

        db.all(classQuery, [jogo.temporada], (err, tabela) => {
          if (err) return rej(err);

          // Se não houver tabela, define valores padrão para não quebrar
          const totalTimesNaLiga = tabela ? tabela.length : 20;
          const casaClass = tabela ? tabela.find(t => t.flashscore_id_time === jogo.casa.flashscore_id_time) : null;
          const foraClass = tabela ? tabela.find(t => t.flashscore_id_time === jogo.fora.flashscore_id_time) : null;

          // Identifica o nível do adversário
          const nivelQueACasaEnfrenta = faixaTabela(foraClass?.posicao_final, totalTimesNaLiga);
          const nivelQueOForaEnfrenta = faixaTabela(casaClass?.posicao_final, totalTimesNaLiga);

          // 🎯 Filtra IDs para a Query (Garante que advCasaIds e advForaIds existam aqui dentro)
          const advCasaIds = tabela
            ? tabela.filter(t => faixaTabela(t.posicao_final, totalTimesNaLiga) === nivelQueACasaEnfrenta).map(t => t.flashscore_id_time)
            : [];

          const advForaIds = tabela
            ? tabela.filter(t => faixaTabela(t.posicao_final, totalTimesNaLiga) === nivelQueOForaEnfrenta).map(t => t.flashscore_id_time)
            : [];

          // Prepara os Placeholders (?) para o SQL
          const placeholdersCasa = advCasaIds.length > 0 ? advCasaIds.map(() => '?').join(',') : "''";
          const placeholdersFora = advForaIds.length > 0 ? advForaIds.map(() => '?').join(',') : "''";

          // 🔎 QUERIES COM A TRAVA DE DATA (data_jogo < ?)
          const queryFaixaCasa = `
            SELECT * FROM jogos 
            WHERE flashscore_id_time_casa = ? 
              AND flashscore_id_time_fora IN (${placeholdersCasa})
              AND data_jogo < ? 
            ORDER BY data_jogo DESC LIMIT 10`;

          const queryFaixaFora = `
            SELECT * FROM jogos 
            WHERE flashscore_id_time_fora = ? 
              AND flashscore_id_time_casa IN (${placeholdersFora})
              AND data_jogo < ? 
            ORDER BY data_jogo DESC LIMIT 10`;

          db.all(queryFaixaCasa, [jogo.casa.flashscore_id_time, ...advCasaIds, dataReferencia], (e1, faixaCasaJogos) => {
            if (e1) return rej(e1);
            db.all(queryFaixaFora, [jogo.fora.flashscore_id_time, ...advForaIds, dataReferencia], (e2, faixaForaJogos) => {
              if (e2) return rej(e2);
              
              // BUSCA ÚLTIMOS JOGOS GERAIS (Com a trava de data também)
              const queryRecentes = `
                SELECT * FROM jogos 
                WHERE (flashscore_id_time_casa = ? OR flashscore_id_time_fora = ?) 
                  AND data_jogo < ? 
                ORDER BY data_jogo DESC LIMIT 15`;

              db.all(queryRecentes, [jogo.casa.flashscore_id_time, jogo.casa.flashscore_id_time, dataReferencia], (e3, ultCasa) => {
                if (e3) return rej(e3);
                db.all(queryRecentes, [jogo.fora.flashscore_id_time, jogo.fora.flashscore_id_time, dataReferencia], (e4, ultFora) => {
                  if (e4) return rej(e4);
                  
                  jogo.casa.ultimos_jogos = montarFinal(faixaCasaJogos || [], ultCasa || [], MAX_POR_FAIXA, MAX_RECENTES);
                  jogo.fora.ultimos_jogos = montarFinal(faixaForaJogos || [], ultFora || [], MAX_POR_FAIXA, MAX_RECENTES);
                  
                  res();
                });
              });
            });
          });
        });
      }));
    });

    Promise.all(promises)
      .then(() => { db.close(); resolve(jogosCalendario); })
      .catch(err => { db.close(); reject(err); });
  });
}
// Função auxiliar para juntar Perfil + Recentes sem repetir jogos
function montarFinal(jogosFaixa, jogosRecentes, maxFaixa, maxRec) {
  const usados = new Set();
  const final = [];
  jogosFaixa.forEach(j => { if (final.length < maxFaixa) { final.push(j); usados.add(j.flashscore_id); } });
  jogosRecentes.forEach(j => { if (final.length < (maxFaixa + maxRec) && !usados.has(j.flashscore_id)) { final.push(j); } });
  return final;
}

/**
 * Função 3: identifica estatísticas na tabela estatisticas_times
 */
function identificaEstatisticas(jogosCalendario) {
  const db = new sqlite3.Database(dbPath);

  const metricasIndispensaveis = [
    'gols_marcados', 'gols_sofridos', 'xg', 'xga',
    'finalizacoes_no_gol', 'finalizacoes_contra', 'finalizacoes_no_gol_contra',
    'chances_clara', 'chances_clara_contra'
  ];

  const metricasEssenciais = [
    'finalizacoes', 'finalizacoes_para_fora', 'finalizacoes_de_dentro_area', 'finalizacoes_de_fora_area',
    'bolas_na_trave', 'toques_area_adversaria', 'passes_profundidade_certos', 'posse_bola',
    'xgot', 'xa', 'defesas_goleiro', 'gols_evitados', 'xg_contra', 'xgot_contra', 'xa_contra'
  ];

  const metricasComplementares = [
    'passes_porcentagem', 'passes_certos', 'passes_total', 'cruzamentos_certos', 'cruzamentos_total',
    'desarmes_certos', 'interceptacoes', 'duelos_ganhos', 'rebatidas', 'impedimentos', 'laterais_cobradas',
    'faltas_cobradas', 'cartoes_amarelos', 'cartao_vermelho',
    'passes_certos_contra', 'passes_total_contra', 'cruzamentos_certos_contra', 'cruzamentos_total_contra',
    'desarmes_certos_contra', 'interceptacoes_contra'
  ];

  return new Promise((resolve, reject) => {
    const promises = [];

    jogosCalendario.forEach(jogo => {
      ['casa', 'fora'].forEach(lado => {
        const time = jogo[lado];
        if (!time.ultimos_jogos || !Array.isArray(time.ultimos_jogos)) return;

        time.ultimos_jogos.forEach(ult => {
          const query = `
            SELECT *
            FROM estatisticas_times
            WHERE flashscore_id = ?
              AND id_time = ?;
          `;

          promises.push(
            new Promise((res, rej) => {
              db.all(query, [ult.flashscore_id, time.id_time], (err, rows) => {
                if (err) {
                  rej(err);
                  return;
                }

                ult.estatisticas = rows.map(r => ({
                  flashscore_id: ult.flashscore_id,
                  data_jogo: ult.data_jogo,
                  hora_jogo: ult.hora_jogo,
                  id_time: time.id_time,
                  nome_time: time.nome_time,
                  tipo: lado,
                  ...metricasIndispensaveis.reduce((acc, m) => {
                    acc[m] = r[m];
                    return acc;
                  }, {}),
                  ...metricasEssenciais.reduce((acc, m) => {
                    acc[m] = r[m];
                    return acc;
                  }, {}),
                  ...metricasComplementares.reduce((acc, m) => {
                    acc[m] = r[m];
                    return acc;
                  }, {})
                }));

                res();
              });
            })
          );
        });
      });
    });

    Promise.all(promises)
      .then(() => {
        db.close();
        resolve(jogosCalendario);
      })
      .catch(err => {
        db.close();
        reject(err);
      });
  });
}

/**
 * Helper: validação com tolerância para gols
 */
function jogoValidoComTolerancia(j) {
  const paresEssenciais = [
    ['gols_marcados', 'gols_sofridos'],
    ['finalizacoes_no_gol', 'finalizacoes_contra'],
    ['xg', 'xga']
  ];

  const ausentes = paresEssenciais.filter(([aFavor, contra]) => {
    const valA = j[aFavor] ?? 0;
    const valC = j[contra] ?? 0;
    return (valA === 0 || valA === null) && (valC === 0 || valC === null);
  });

  return ausentes.length <= 4;
}

/**
 * Função 4: seleciona jogos válidos (mínimo 5 por lado)
 */
function selecionaJogosValidos(jogosCalendario) {
  const resultadoFinal = [];

  jogosCalendario.forEach(jogo => {
    const novoJogo = {
      flashscore_id: jogo.flashscore_id,
      data_jogo: jogo.data_jogo,
      hora_jogo: jogo.hora_jogo,
      competicao: jogo.competicao,
      casa: { ...jogo.casa, jogos_filtrados: [] },
      fora: { ...jogo.fora, jogos_filtrados: [] }
    };

    ['casa', 'fora'].forEach(lado => {
      const time = jogo[lado];
      const ultimos = Array.isArray(time?.ultimos_jogos) ? time.ultimos_jogos : [];
      const jogosValidos = [];

      ultimos.forEach(ult => {
        const stats = Array.isArray(ult.estatisticas) ? ult.estatisticas : [];

        stats.forEach(est => {
          // 🔎 MÉTRICAS CRÍTICAS PARA GOL
          const metricasCriticas = [
            'gols_marcados',
            'gols_sofridos',
            'xg',
            est.xga !== undefined ? 'xga' : 'xg_contra',
            'finalizacoes_no_gol',
            'finalizacoes_no_gol_contra'
          ];

          let faltantes = 0;

          metricasCriticas.forEach(m => {
            const val = est[m];
            if (val === null || val === undefined || val === 0) {
              faltantes++;
            }
          });

          // ✅ aceita no máximo 1 métrica zerada/faltante
          const valido = faltantes <= 1;

          if (valido) {
            jogosValidos.push({
              flashscore_id: est.flashscore_id,
              data_jogo: est.data_jogo,
              hora_jogo: est.hora_jogo,
              id_time: time.id_time,
              nome_time: time.nome_time,
              tipo: lado,
              metricas: est
            });
          }
        });
      });

      if (jogosValidos.length < 5) {
        novoJogo[lado].jogos_filtrados = [];
      } else {
        novoJogo[lado].jogos_filtrados = jogosValidos;
      }
    });

    resultadoFinal.push(novoJogo);
  });

  return resultadoFinal;
}


module.exports = {
  pegaJogosDoDia,
  pegaUltimosJogos,
  identificaEstatisticas,
  selecionaJogosValidos
};
