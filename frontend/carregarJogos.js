const db = require('./database.js');

const listaJogos = document.getElementById('lista-jogos');
const modal = document.getElementById('modal-jogo');
const detalhesJogo = document.getElementById('detalhes-jogo');
const filtroData = document.getElementById('filtro-data');

if (filtroData && !filtroData.value) {
  filtroData.value = new Date().toISOString().split('T')[0];
}

if (filtroData) {
  filtroData.addEventListener('change', carregarJogos);
}

function fmt(val, isPercentage = true) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';
  const num = Number(val).toFixed(2);
  return isPercentage ? `${num}%` : num;
}

// =======================================================================
// Consulta no banco de dados filtrando por mercado, valor esperado, mando e times
// =======================================================================
async function consultarHistoricoFiltrado(opts) {
  const {
    idTime, nomeTime, mando,
    idCasa, nomeCasa, idFora, nomeFora,
    mercado, colunaEsperado, valorEsperado
  } = opts;

  if (valorEsperado === null || valorEsperado === undefined || isNaN(valorEsperado)) {
    return '';
  }

  try {
    const palpiteExato = Math.round(Number(valorEsperado));
    const limiteMin = palpiteExato - 0.5;
    const limiteMax = palpiteExato + 0.49;

    let sql = `
      SELECT resultado, COUNT(*)::int as total
      FROM diagnostico_mercados
      WHERE mercado = $1
        AND ${colunaEsperado} >= $2
        AND ${colunaEsperado} <= $3
    `;

    let params = [mercado, limiteMin, limiteMax];

    if (idCasa || nomeCasa || idFora || nomeFora) {
      const subConds = [];

      if (idCasa && !isNaN(Number(idCasa)) && Number(idCasa) > 0) {
        params.push(Number(idCasa), nomeCasa || '');
        subConds.push(`((id_time = $${params.length - 1} OR nome_time = $${params.length}) AND mando = 'C')`);
      } else if (nomeCasa) {
        params.push(nomeCasa);
        subConds.push(`(nome_time = $${params.length} AND mando = 'C')`);
      }

      if (idFora && !isNaN(Number(idFora)) && Number(idFora) > 0) {
        params.push(Number(idFora), nomeFora || '');
        subConds.push(`((id_time = $${params.length - 1} OR nome_time = $${params.length}) AND mando = 'F')`);
      } else if (nomeFora) {
        params.push(nomeFora);
        subConds.push(`(nome_time = $${params.length} AND mando = 'F')`);
      }

      if (subConds.length > 0) {
        sql += ` AND (${subConds.join(' OR ')})`;
      }
    }
    else if (idTime || nomeTime) {
      if (idTime && !isNaN(Number(idTime)) && Number(idTime) > 0) {
        params.push(Number(idTime));
        sql += ` AND id_time = $${params.length}`;
      } else if (nomeTime) {
        params.push(nomeTime);
        sql += ` AND nome_time = $${params.length}`;
      }

      if (mando) {
        params.push(mando);
        sql += ` AND mando = $${params.length}`;
      }
    }

    sql += ` GROUP BY resultado`;

    const res = await db.query(sql, params);

    let greens = 0;
    let reds = 0;

    res.rows.forEach(row => {
      if (row.resultado === 'GREEN') greens = Number(row.total);
      if (row.resultado === 'RED') reds = Number(row.total);
    });

    const total = greens + reds;

    if (total === 0) {
      return `<small style="color: #64748b; font-weight: normal; font-size: 11px;">(0 jgs com Exp ~ ${palpiteExato})</small>`;
    }

    const winrate = ((greens / total) * 100).toFixed(0);
    const cor = winrate >= 60 ? '#a6e3a1' : '#f38ba8';

    return `<span style="font-size: 11px; margin-left: 6px;">🟢 ${greens}G | 🔴 ${reds}R <strong style="color: ${cor}">(${winrate}%)</strong> <small style="color: #94a3b8;">[Exp ~ ${palpiteExato}]</small></span>`;
  } catch (err) {
    console.error(`Erro ao consultar histórico (${mercado}):`, err);
    return '';
  }
}

// =======================================================================
// Consulta compacta da classificação dos times envolvidos (NOVO)
// =======================================================================
async function buscarClassificacaoTimes(idCompeticao, idCasa, idFora) {
  try {
    const sql = `
      SELECT 
        id_time, 
        posicao_final AS posicao, 
        pontos, 
        jogos, 
        vitorias, 
        empates, 
        derrotas,
        gols_pro,
        gols_contra
      FROM classificacao_geral_2026
      WHERE id_competicao = $1 AND id_time IN ($2, $3)
    `;
    const res = await db.query(sql, [Number(idCompeticao), Number(idCasa), Number(idFora)]);
    return res.rows;
  } catch (err) {
    console.error('Erro ao buscar classificação:', err);
    return [];
  }
}

async function carregarJogos() {
  try {
    let res;
    // Se você estiver usando o filtro de data (do primeiro código enviado)
    if (filtroData && filtroData.value) {
      const dataSelecionada = filtroData.value;
      res = await db.query(
        "SELECT * FROM analises_jogo WHERE data_jogo::text = $1 ORDER BY hora_jogo ASC",
        [dataSelecionada]
      );
    } else {
      // Caso base (do segundo código enviado)
      res = await db.query("SELECT * FROM analises_jogo ORDER BY hora_jogo ASC");
    }

    const jogos = res.rows;
    listaJogos.innerHTML = '';

    if (jogos.length === 0) {
      listaJogos.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: #94a3b8; padding: 20px;">Nenhum jogo encontrado.</p>`;
      return;
    }

    jogos.forEach(jogo => {
      const card = document.createElement('div');

      card.className = 'game-card';
      card.onclick = () => abrirDetalhesJogo(jogo);

      card.innerHTML = `
        <span class="league-tag">${jogo.pais_liga || ''} - ${jogo.nome_competicao || ''}</span>
        <div class="time-row">
          <span>${jogo.nome_time_casa}</span>
          <span>vs</span>
          <span>${jogo.nome_time_fora}</span>
        </div>
        <small>⏰ ${jogo.hora_jogo || 'N/A'}</small>
      `;

      listaJogos.appendChild(card);
    });
  } catch (err) {
    console.error("Erro ao buscar jogos em analises_jogo:", err);
    listaJogos.innerHTML = `<p style="color: #f38ba8;">Erro ao conectar com o banco de dados: ${err.message}</p>`;
  }
}

async function abrirDetalhesJogo(jogo) {
  const expGolsTotais = jogo.total_gols_esperado;
  const expGolsCasa = jogo.casa_gols_esperado;
  const expGolsFora = jogo.fora_gols_esperado;

  const expCantosTotais = jogo.total_cantos_esperado;
  const expCantosCasa = jogo.casa_cantos_esperado;
  const expCantosFora = jogo.fora_cantos_esperado;

  const expCartoesTotais = jogo.total_cartoes_esperado;
  const expCartoesCasa = jogo.casa_cartoes_esperado;
  const expCartoesFora = jogo.fora_cartoes_esperado;

  const filtroMatch = {
    idCasa: jogo.id_time_casa,
    nomeCasa: jogo.nome_time_casa,
    idFora: jogo.id_time_fora,
    nomeFora: jogo.nome_time_fora
  };

  const [
    classificacao, // (NOVO)
    hOver15, hUnder15,
    hOver25, hUnder25,
    hOver35, hUnder35,
    hBttsYes, hBttsNo,

    hCasaGols05, hCasaGols15,
    hForaGols05, hForaGols15,

    hCantos75, hCantosUnder75,
    hCantos85, hCantosUnder85,
    hCantos95, hCantosUnder95,

    hCasaCantos35, hCasaCantos45,
    hForaCantos25, hForaCantos35, hForaCantos45,

    hCartoes25, hCartoesUnder25,
    hCartoes35, hCartoesUnder35,
    hCartoes45, hCartoesUnder45,

    hCasaCartoes05, hCasaCartoes15, hCasaCartoes25,
    hForaCartoes05, hForaCartoes15, hForaCartoes25
  ] = await Promise.all([
    // (NOVO) Busca a classificação junto com o resto
    buscarClassificacaoTimes(jogo.id_competicao, jogo.id_time_casa, jogo.id_time_fora),

    // GOLS TOTAIS
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'over15', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'under15', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),

    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'over25', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'under25', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),

    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'over35', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'under35', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),

    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'btts_yes', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'btts_no', colunaEsperado: 'total_gols_esperado', valorEsperado: expGolsTotais }),

    // GOLS POR EQUIPE
    consultarHistoricoFiltrado({ idTime: jogo.id_time_casa, nomeTime: jogo.nome_time_casa, mando: 'C', mercado: 'casa_over05', colunaEsperado: 'casa_gols_esperado', valorEsperado: expGolsCasa }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_casa, nomeTime: jogo.nome_time_casa, mando: 'C', mercado: 'casa_over15', colunaEsperado: 'casa_gols_esperado', valorEsperado: expGolsCasa }),

    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_over05', colunaEsperado: 'fora_gols_esperado', valorEsperado: expGolsFora }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_over15', colunaEsperado: 'fora_gols_esperado', valorEsperado: expGolsFora }),

    // CANTOS TOTAIS
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cantos_over75', colunaEsperado: 'total_cantos_esperado', valorEsperado: expCantosTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cantos_under75', colunaEsperado: 'total_cantos_esperado', valorEsperado: expCantosTotais }),

    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cantos_over85', colunaEsperado: 'total_cantos_esperado', valorEsperado: expCantosTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cantos_under85', colunaEsperado: 'total_cantos_esperado', valorEsperado: expCantosTotais }),

    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cantos_over95', colunaEsperado: 'total_cantos_esperado', valorEsperado: expCantosTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cantos_under95', colunaEsperado: 'total_cantos_esperado', valorEsperado: expCantosTotais }),

    // CANTOS POR EQUIPE
    consultarHistoricoFiltrado({ idTime: jogo.id_time_casa, nomeTime: jogo.nome_time_casa, mando: 'C', mercado: 'casa_cantos_over35', colunaEsperado: 'casa_cantos_esperado', valorEsperado: expCantosCasa }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_casa, nomeTime: jogo.nome_time_casa, mando: 'C', mercado: 'casa_cantos_over45', colunaEsperado: 'casa_cantos_esperado', valorEsperado: expCantosCasa }),

    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_cantos_over25', colunaEsperado: 'fora_cantos_esperado', valorEsperado: expCantosFora }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_cantos_over35', colunaEsperado: 'fora_cantos_esperado', valorEsperado: expCantosFora }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_cantos_over45', colunaEsperado: 'fora_cantos_esperado', valorEsperado: expCantosFora }),

    // CARTÕES TOTAIS
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cartoes_over25', colunaEsperado: 'total_cartoes_esperado', valorEsperado: expCartoesTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cartoes_under25', colunaEsperado: 'total_cartoes_esperado', valorEsperado: expCartoesTotais }),

    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cartoes_over35', colunaEsperado: 'total_cartoes_esperado', valorEsperado: expCartoesTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cartoes_under35', colunaEsperado: 'total_cartoes_esperado', valorEsperado: expCartoesTotais }),

    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cartoes_over45', colunaEsperado: 'total_cartoes_esperado', valorEsperado: expCartoesTotais }),
    consultarHistoricoFiltrado({ ...filtroMatch, mercado: 'cartoes_under45', colunaEsperado: 'total_cartoes_esperado', valorEsperado: expCartoesTotais }),

    // CARTÕES POR EQUIPE
    consultarHistoricoFiltrado({ idTime: jogo.id_time_casa, nomeTime: jogo.nome_time_casa, mando: 'C', mercado: 'casa_cartoes_over05', colunaEsperado: 'casa_cartoes_esperado', valorEsperado: expCartoesCasa }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_casa, nomeTime: jogo.nome_time_casa, mando: 'C', mercado: 'casa_cartoes_over15', colunaEsperado: 'casa_cartoes_esperado', valorEsperado: expCartoesCasa }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_casa, nomeTime: jogo.nome_time_casa, mando: 'C', mercado: 'casa_cartoes_over25', colunaEsperado: 'casa_cartoes_esperado', valorEsperado: expCartoesCasa }),

    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_cartoes_over05', colunaEsperado: 'fora_cartoes_esperado', valorEsperado: expCartoesFora }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_cartoes_over15', colunaEsperado: 'fora_cartoes_esperado', valorEsperado: expCartoesFora }),
    consultarHistoricoFiltrado({ idTime: jogo.id_time_fora, nomeTime: jogo.nome_time_fora, mando: 'F', mercado: 'fora_cartoes_over25', colunaEsperado: 'fora_cartoes_esperado', valorEsperado: expCartoesFora })
  ]);

  // ==========================================
  // RENDERIZAÇÃO COMPACTA DA CLASSIFICAÇÃO (NOVO)
  // ==========================================
  let htmlClassificacao = '';
  if (classificacao && classificacao.length > 0) {
    const classCasa = classificacao.find(c => c.id_time === jogo.id_time_casa);
    const classFora = classificacao.find(c => c.id_time === jogo.id_time_fora);

    htmlClassificacao = `
      <div class="market-group" style="display: flex; justify-content: space-between; background: #1e293b; padding: 12px; border-radius: 8px; margin-bottom: 15px; font-size: 12px; border: 1px solid #334155;">
        <div style="flex: 1; text-align: center; border-right: 1px solid #334155; padding-right: 8px;">
          <strong style="color: #60a5fa; font-size: 13px;">🏠 ${jogo.nome_time_casa}</strong><br>
          ${classCasa ? `
            <div style="margin-top: 4px;">Pos: <b>${classCasa.posicao}º</b> | Pts: <b>${classCasa.pontos}</b> | J: ${classCasa.jogos}</div>
            <div style="color: #94a3b8; margin-top: 2px;">V-E-D: ${classCasa.vitorias}-${classCasa.empates}-${classCasa.derrotas}</div>
            <div style="color: #94a3b8; font-size: 11px;">Gols: ${classCasa.gols_pro} Pró / ${classCasa.gols_contra} Contra</div>
          ` : '<div style="color: #64748b; margin-top: 8px;">Sem dados na liga</div>'}
        </div>
        
        <div style="flex: 1; text-align: center; padding-left: 8px;">
          <strong style="color: #f87171; font-size: 13px;">✈️ ${jogo.nome_time_fora}</strong><br>
          ${classFora ? `
            <div style="margin-top: 4px;">Pos: <b>${classFora.posicao}º</b> | Pts: <b>${classFora.pontos}</b> | J: ${classFora.jogos}</div>
            <div style="color: #94a3b8; margin-top: 2px;">V-E-D: ${classFora.vitorias}-${classFora.empates}-${classFora.derrotas}</div>
            <div style="color: #94a3b8; font-size: 11px;">Gols: ${classFora.gols_pro} Pró / ${classFora.gols_contra} Contra</div>
          ` : '<div style="color: #64748b; margin-top: 8px;">Sem dados na liga</div>'}
        </div>
      </div>
    `;
  }

  // Montagem do HTML final (INJETADO)
  detalhesJogo.innerHTML = `
    <h2>${jogo.nome_time_casa} x ${jogo.nome_time_fora}</h2>
    <p><small>${jogo.pais_liga || ''} - ${jogo.nome_competicao || ''} | ⏰ ${jogo.hora_jogo || 'N/A'} | Rodada: ${jogo.rodada || 'N/A'}</small></p>

    <!-- NOVA LINHA DA CLASSIFICAÇÃO -->
    ${htmlClassificacao}

    <div class="market-group">
      <h3>📊 Expectativas Calculadas</h3>
      <div class="prob-bar"><span>Total Gols Esperado</span><strong>${fmt(expGolsTotais, false)}</strong></div>
      <div class="prob-bar"><span>Gols Casa / Fora Esperados</span><strong>${fmt(expGolsCasa, false)} / ${fmt(expGolsFora, false)}</strong></div>
      <div class="prob-bar"><span>Total Cantos Esperado</span><strong>${fmt(expCantosTotais, false)}</strong></div>
      <div class="prob-bar"><span>Cantos Casa / Fora Esperados</span><strong>${fmt(expCantosCasa, false)} / ${fmt(expCantosFora, false)}</strong></div>
      <div class="prob-bar"><span>Total Cartões Esperado</span><strong>${fmt(expCartoesTotais, false)}</strong></div>
      <div class="prob-bar"><span>Cartões Casa / Fora Esperados</span><strong>${fmt(expCartoesCasa, false)} / ${fmt(expCartoesFora, false)}</strong></div>
    </div>

    <div class="market-group">
      <h3>⚽ Match Odds (1X2)</h3>
      <div class="prob-bar"><span>Casa (${jogo.nome_time_casa})</span><strong>${fmt(jogo.p_home)}</strong></div>
      <div class="prob-bar"><span>Empate</span><strong>${fmt(jogo.p_draw)}</strong></div>
      <div class="prob-bar"><span>Fora (${jogo.nome_time_fora})</span><strong>${fmt(jogo.p_away)}</strong></div>
    </div>

    <div class="market-group">
      <h3>⚽ Gols Totais & BTTS</h3>
      <div class="prob-bar"><span>Over 1.5 ${hOver15}</span><strong>${fmt(jogo.p_over15)}</strong></div>
      <div class="prob-bar"><span>Under 1.5 ${hUnder15}</span><strong>${fmt(jogo.p_under15)}</strong></div>
      <div class="prob-bar"><span>Over 2.5 ${hOver25}</span><strong>${fmt(jogo.p_over25)}</strong></div>
      <div class="prob-bar"><span>Under 2.5 ${hUnder25}</span><strong>${fmt(jogo.p_under25)}</strong></div>
      <div class="prob-bar"><span>Over 3.5 ${hOver35}</span><strong>${fmt(jogo.p_over35)}</strong></div>
      <div class="prob-bar"><span>Under 3.5 ${hUnder35}</span><strong>${fmt(jogo.p_under35)}</strong></div>
      <div class="prob-bar"><span>Ambas Marcam - Sim ${hBttsYes}</span><strong>${fmt(jogo.p_btts_yes)}</strong></div>
      <div class="prob-bar"><span>Ambas Marcam - Não ${hBttsNo}</span><strong>${fmt(jogo.p_btts_no)}</strong></div>
    </div>

    <div class="market-group">
      <h3>🏠 Gols Por Equipe (Com Mando C/F)</h3>
      <div class="prob-bar"><span>${jogo.nome_time_casa} Over 0.5 ${hCasaGols05}</span><strong>${fmt(jogo.p_casa_over05)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_casa} Over 1.5 ${hCasaGols15}</span><strong>${fmt(jogo.p_casa_over15)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Over 0.5 ${hForaGols05}</span><strong>${fmt(jogo.p_fora_over05)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Over 1.5 ${hForaGols15}</span><strong>${fmt(jogo.p_fora_over15)}</strong></div>
    </div>

    <div class="market-group">
      <h3>🚩 Escanteios Totais</h3>
      <div class="prob-bar"><span>Over 7.5 ${hCantos75}</span><strong>${fmt(jogo.p_cantos_over75)}</strong></div>
      <div class="prob-bar"><span>Under 7.5 ${hCantosUnder75}</span><strong>${fmt(jogo.p_cantos_under75)}</strong></div>
      <div class="prob-bar"><span>Over 8.5 ${hCantos85}</span><strong>${fmt(jogo.p_cantos_over85)}</strong></div>
      <div class="prob-bar"><span>Under 8.5 ${hCantosUnder85}</span><strong>${fmt(jogo.p_cantos_under85)}</strong></div>
      <div class="prob-bar"><span>Over 9.5 ${hCantos95}</span><strong>${fmt(jogo.p_cantos_over95)}</strong></div>
      <div class="prob-bar"><span>Under 9.5 ${hCantosUnder95}</span><strong>${fmt(jogo.p_cantos_under95)}</strong></div>
    </div>

    <div class="market-group">
      <h3>🚩 Escanteios Por Equipe</h3>
      <div class="prob-bar"><span>${jogo.nome_time_casa} Cantos Over 3.5 ${hCasaCantos35}</span><strong>${fmt(jogo.p_casa_cantos_over35)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_casa} Cantos Over 4.5 ${hCasaCantos45}</span><strong>${fmt(jogo.p_casa_cantos_over45)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Cantos Over 2.5 ${hForaCantos25}</span><strong>${fmt(jogo.p_fora_cantos_over25)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Cantos Over 3.5 ${hForaCantos35}</span><strong>${fmt(jogo.p_fora_cantos_over35)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Cantos Over 4.5 ${hForaCantos45}</span><strong>${fmt(jogo.p_fora_cantos_over45)}</strong></div>
    </div>

    <div class="market-group">
      <h3>🟨 Cartões Totais</h3>
      <div class="prob-bar"><span>Over 2.5 ${hCartoes25}</span><strong>${fmt(jogo.p_cartoes_over25)}</strong></div>
      <div class="prob-bar"><span>Under 2.5 ${hCartoesUnder25}</span><strong>${fmt(jogo.p_cartoes_under25)}</strong></div>
      <div class="prob-bar"><span>Over 3.5 ${hCartoes35}</span><strong>${fmt(jogo.p_cartoes_over35)}</strong></div>
      <div class="prob-bar"><span>Under 3.5 ${hCartoesUnder35}</span><strong>${fmt(jogo.p_cartoes_under35)}</strong></div>
      <div class="prob-bar"><span>Over 4.5 ${hCartoes45}</span><strong>${fmt(jogo.p_cartoes_over45)}</strong></div>
      <div class="prob-bar"><span>Under 4.5 ${hCartoesUnder45}</span><strong>${fmt(jogo.p_cartoes_under45)}</strong></div>
    </div>

    <div class="market-group">
      <h3>🟨 Cartões Por Equipe</h3>
      <div class="prob-bar"><span>${jogo.nome_time_casa} Cartões Over 0.5 ${hCasaCartoes05}</span><strong>${fmt(jogo.p_casa_cartoes_over05)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_casa} Cartões Over 1.5 ${hCasaCartoes15}</span><strong>${fmt(jogo.p_casa_cartoes_over15)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_casa} Cartões Over 2.5 ${hCasaCartoes25}</span><strong>${fmt(jogo.p_casa_cartoes_over25)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Cartões Over 0.5 ${hForaCartoes05}</span><strong>${fmt(jogo.p_fora_cartoes_over05)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Cartões Over 1.5 ${hForaCartoes15}</span><strong>${fmt(jogo.p_fora_cartoes_over15)}</strong></div>
      <div class="prob-bar"><span>${jogo.nome_time_fora} Cartões Over 2.5 ${hForaCartoes25}</span><strong>${fmt(jogo.p_fora_cartoes_over25)}</strong></div>
    </div>
  `;

  modal.classList.remove('hidden');
}

function fecharModal() {
  modal.classList.add('hidden');
}

carregarJogos();