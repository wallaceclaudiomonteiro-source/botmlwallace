const db = require('./database.js');

const listaJogos = document.getElementById('lista-jogos');
const modal = document.getElementById('modal-jogo');
const detalhesJogo = document.getElementById('detalhes-jogo');
const filtroData = document.getElementById('filtro-data');

if (filtroData && !filtroData.value) {
  filtroData.value = new Date().toISOString().split('T')[0];
}

if (filtroData) filtroData.addEventListener('change', carregarJogos);


// =======================================================================
// FORMATAÇÃO
// =======================================================================

function fmt(val, isPercentage = true) {
  if (val === null || val === undefined || isNaN(val)) return 'N/A';

  const num = Number(val).toFixed(2);

  return isPercentage ? `${num}%` : num;
}



async function consultarHistoricoFiltrado(opts) {
  // A assinatura permanece intocada, não vai mais quebrar sua tela
  const { idCasa, idFora, mercado, valorEsperado, dataJogo, flashscoreIdJogo } = opts;
  const PROB_MINIMA = 55;
  const LIMITE_JOGOS = 10;

  if (valorEsperado === null || valorEsperado === undefined || isNaN(valorEsperado)) {
    return `<span style="display:inline-block;margin-left:8px;font-size:11px;color:#64748b;">⚪ Exp. indisponível</span>`;
  }

  const probAtual = Number(valorEsperado);

  if (probAtual < PROB_MINIMA) {
    return `<span style="display:inline-block;margin-left:8px;font-size:11px;color:#64748b;">⚪ Mercado abaixo de 55%</span>`;
  }

  try {
    const mapaMercados = {
      home: { probCasa: 'p_home', probFora: null, resultado: 'res_home', tipo: 'individual_casa' },
      draw: { probCasa: 'p_draw', probFora: 'p_draw', resultado: 'res_draw', tipo: 'total' },
      away: { probCasa: null, probFora: 'p_away', resultado: 'res_away', tipo: 'individual_fora' },
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
      cantos_over75: { probCasa: 'p_cantos_over75', probFora: 'p_cantos_over75', resultado: 'res_cantos_over75', tipo: 'total' },
      cantos_under75: { probCasa: 'p_cantos_under75', probFora: 'p_cantos_under75', resultado: 'res_cantos_under75', tipo: 'total' },
      cantos_over85: { probCasa: 'p_cantos_over85', probFora: 'p_cantos_over85', resultado: 'res_cantos_over85', tipo: 'total' },
      cantos_under85: { probCasa: 'p_cantos_under85', probFora: 'p_cantos_under85', resultado: 'res_cantos_under85', tipo: 'total' },
      cantos_over95: { probCasa: 'p_cantos_over95', probFora: 'p_cantos_over95', resultado: 'res_cantos_over95', tipo: 'total' },
      cantos_under95: { probCasa: 'p_cantos_under95', probFora: 'p_cantos_under95', resultado: 'res_cantos_under95', tipo: 'total' },
      casa_cantos_over35: { probCasa: 'p_casa_cantos_over35', probFora: 'p_fora_cantos_over35', resultado: 'res_casa_cantos_over35', tipo: 'individual' },
      casa_cantos_over45: { probCasa: 'p_casa_cantos_over45', probFora: 'p_fora_cantos_over45', resultado: 'res_casa_cantos_over45', tipo: 'individual' },
      fora_cantos_over25: { probCasa: 'p_casa_cantos_over25', probFora: 'p_fora_cantos_over25', resultado: 'res_fora_cantos_over25', tipo: 'individual' },
      fora_cantos_over35: { probCasa: 'p_casa_cantos_over35', probFora: 'p_fora_cantos_over35', resultado: 'res_fora_cantos_over35', tipo: 'individual' },
      fora_cantos_over45: { probCasa: 'p_casa_cantos_over45', probFora: 'p_fora_cantos_over45', resultado: 'res_fora_cantos_over45', tipo: 'individual' },
      cartoes_over25: { probCasa: 'p_cartoes_over25', probFora: 'p_cartoes_over25', resultado: 'res_cartoes_over25', tipo: 'total' },
      cartoes_under25: { probCasa: 'p_cartoes_under25', probFora: 'p_cartoes_under25', resultado: 'res_cartoes_under25', tipo: 'total' },
      cartoes_over35: { probCasa: 'p_cartoes_over35', probFora: 'p_cartoes_over35', resultado: 'res_cartoes_over35', tipo: 'total' },
      cartoes_under35: { probCasa: 'p_cartoes_under35', probFora: 'p_cartoes_under35', resultado: 'res_cartoes_under35', tipo: 'total' },
      cartoes_over45: { probCasa: 'p_cartoes_over45', probFora: 'p_cartoes_over45', resultado: 'res_cartoes_over45', tipo: 'total' },
      cartoes_under45: { probCasa: 'p_cartoes_under45', probFora: 'p_cartoes_under45', resultado: 'res_cartoes_under45', tipo: 'total' },
      casa_cartoes_over05: { probCasa: 'p_casa_cartoes_over05', probFora: 'p_fora_cartoes_over05', resultado: 'res_casa_cartoes_over05', tipo: 'individual' },
      casa_cartoes_over15: { probCasa: 'p_casa_cartoes_over15', probFora: 'p_fora_cartoes_over15', resultado: 'res_casa_cartoes_over15', tipo: 'individual' },
      casa_cartoes_over25: { probCasa: 'p_casa_cartoes_over25', probFora: 'p_fora_cartoes_over25', resultado: 'res_casa_cartoes_over25', tipo: 'individual' },
      fora_cartoes_over05: { probCasa: 'p_casa_cartoes_over05', probFora: 'p_fora_cartoes_over05', resultado: 'res_fora_cartoes_over05', tipo: 'individual' },
      fora_cartoes_over15: { probCasa: 'p_casa_cartoes_over15', probFora: 'p_fora_cartoes_over15', resultado: 'res_fora_cartoes_over15', tipo: 'individual' },
      fora_cartoes_over25: { probCasa: 'p_casa_cartoes_over25', probFora: 'p_fora_cartoes_over25', resultado: 'res_fora_cartoes_over25', tipo: 'individual' }
    };

    const config = mapaMercados[mercado];

    if (!config) {
      throw new Error(`Mercado não mapeado: ${mercado}`);
    }

    const ehCasaIndividual = mercado.startsWith('casa_') || mercado === 'home';
    const ehForaIndividual = mercado.startsWith('fora_') || mercado === 'away';

    // 1. PRIMEIRO PASSO: Descobrir internamente os perfis dos times do jogo atual
    async function obterPerfilTime(idTime) {
      const sql = `
        SELECT estilo_posse_casa, estilo_posse_fora 
        FROM public.perfil_times 
        WHERE id_time::text = $1 
        ORDER BY data_referencia DESC NULLS LAST 
        LIMIT 1
      `;
      const res = await db.query(sql, [String(idTime)]);
      return res.rows[0] || null;
    }

    const perfilObjCasa = await obterPerfilTime(idCasa);
    const perfilObjFora = await obterPerfilTime(idFora);

    const perfilAtualCasa = perfilObjCasa?.estilo_posse_casa;
    const perfilAtualFora = perfilObjFora?.estilo_posse_fora;

    if (!perfilAtualCasa || !perfilAtualFora) {
      return `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;margin:4px 0 4px 8px;line-height:1.35;"><span style="font-size:11px;color:#94a3b8;">⚪ <strong style="color:#cbd5e1;">Sem perfil definido no banco</strong></span></span>`;
    }

    // 2. SEGUNDO PASSO: Buscar o histórico cruzando os perfis que acabamos de descobrir
    async function buscarHistoricoComPerfil(idTime, ehCasa) {
      let sql;
      let valores;

      // Subquery usada para pegar apenas o último perfil válido do adversário e evitar duplicação de linhas
      if (ehCasa) {
        // Histórico do MANDANTE atuando em casa, contra visitantes com o MESMO PERFIL do visitante atual
        sql = `
          SELECT aj.*
          FROM public.analises_jogo aj
          WHERE aj.id_time_casa::text = $1
            AND aj.data_jogo < $2::date
            AND (aj.flashscore_id_jogo IS NULL OR aj.flashscore_id_jogo <> $3)
            AND $4 = (
                SELECT estilo_posse_fora 
                FROM public.perfil_times 
                WHERE id_time::text = aj.id_time_fora::text 
                ORDER BY data_referencia DESC NULLS LAST 
                LIMIT 1
            )
          ORDER BY aj.data_jogo DESC, aj.hora_jogo DESC NULLS LAST, aj.flashscore_id_jogo DESC
        `;
        valores = [String(idTime), dataJogo, String(flashscoreIdJogo || ''), perfilAtualFora];
      } else {
        // Histórico do VISITANTE atuando fora, contra mandantes com o MESMO PERFIL do mandante atual
        sql = `
          SELECT aj.*
          FROM public.analises_jogo aj
          WHERE aj.id_time_fora::text = $1
            AND aj.data_jogo < $2::date
            AND (aj.flashscore_id_jogo IS NULL OR aj.flashscore_id_jogo <> $3)
            AND $4 = (
                SELECT estilo_posse_casa 
                FROM public.perfil_times 
                WHERE id_time::text = aj.id_time_casa::text 
                ORDER BY data_referencia DESC NULLS LAST 
                LIMIT 1
            )
          ORDER BY aj.data_jogo DESC, aj.hora_jogo DESC NULLS LAST, aj.flashscore_id_jogo DESC
        `;
        valores = [String(idTime), dataJogo, String(flashscoreIdJogo || ''), perfilAtualCasa];
      }

      const res = await db.query(sql, valores);
      return res.rows;
    }

    function obterProbabilidadeHistorica(jogo, ehCasa) {
      // Como a busca já isola se foi em casa ou fora, basta pegar a coluna certa
      const coluna = ehCasa ? config.probCasa : config.probFora;
      if (!coluna) return null;

      const valor = Number(jogo[coluna]);
      return Number.isFinite(valor) ? valor : null;
    }

    async function buscarUltimos10Validos(idTime, ehCasa) {
      const historico = await buscarHistoricoComPerfil(idTime, ehCasa);
      const validos = [];

      for (const jogo of historico) {
        const probHistorica = obterProbabilidadeHistorica(jogo, ehCasa);

        if (probHistorica === null || probHistorica <= PROB_MINIMA) {
          continue;
        }

        const resultado = jogo[config.resultado];

        if (resultado !== 'GREEN' && resultado !== 'RED') {
          continue;
        }

        validos.push({
          flashscore_id_jogo: jogo.flashscore_id_jogo,
          data_jogo: jogo.data_jogo,
          id_time: idTime,
          probabilidade: probHistorica,
          resultado
        });

        if (validos.length >= LIMITE_JOGOS) {
          break;
        }
      }

      return validos;
    }

    let jogosConsiderados = [];

    // O direcionamento agora é simples: chama a busca informando se é cenário "Casa" ou "Fora"
    if (config.tipo === 'total') {
      const [historicoCasa, historicoFora] = await Promise.all([
        buscarUltimos10Validos(idCasa, true),
        buscarUltimos10Validos(idFora, false)
      ]);

      const unicos = new Map();
      for (const jogo of [...historicoCasa, ...historicoFora]) {
        const chave = `${jogo.flashscore_id_jogo}_${jogo.id_time}`;
        if (!unicos.has(chave)) {
          unicos.set(chave, jogo);
        }
      }
      jogosConsiderados = Array.from(unicos.values());
    } else if (ehCasaIndividual) {
      jogosConsiderados = await buscarUltimos10Validos(idCasa, true);
    } else if (ehForaIndividual) {
      jogosConsiderados = await buscarUltimos10Validos(idFora, false);
    } else {
      const [historicoCasa, historicoFora] = await Promise.all([
        buscarUltimos10Validos(idCasa, true),
        buscarUltimos10Validos(idFora, false)
      ]);
      jogosConsiderados = [...historicoCasa, ...historicoFora];
    }

    let greens = 0;
    let reds = 0;

    for (const jogo of jogosConsiderados) {
      if (jogo.resultado === 'GREEN') {
        greens++;
      } else if (jogo.resultado === 'RED') {
        reds++;
      }
    }

    const total = greens + reds;

    if (total === 0) {
      return `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;margin:4px 0 4px 8px;line-height:1.35;"><span style="font-size:11px;color:#94a3b8;">⚪ <strong style="color:#cbd5e1;">Sem histórico cruzado > 55%</strong></span><span style="font-size:10px;color:#64748b;margin-left:18px;">Prob. atual: <strong style="color:#cbd5e1;">${probAtual.toFixed(2)}%</strong></span></span>`;
    }

    const winrate = ((greens / total) * 100).toFixed(0);

    let cor = '#f38ba8';
    if (Number(winrate) >= 70) {
      cor = '#a6e3a1';
    } else if (Number(winrate) >= 60) {
      cor = '#f9e2af';
    }

    return `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;margin:4px 0 4px 8px;line-height:1.35;"><span style="font-size:12px;white-space:nowrap;">🟢 <strong style="color:#a6e3a1;">${greens}G</strong> &nbsp;|&nbsp; 🔴 <strong style="color:#f38ba8;">${reds}R</strong> &nbsp;|&nbsp; 📈 <strong style="color:${cor};">${winrate}%</strong></span><span style="font-size:10px;color:#64748b;margin-left:18px;">${total} jogos | Histórico: <strong style="color:#94a3b8;">&gt;55%</strong></span></span>`;
  } catch (err) {
    console.error(`Erro ao consultar histórico (${mercado}):`, err);
    return `<span style="display:inline-block;margin-left:8px;font-size:11px;color:#f38ba8;">⚠ Erro ao consultar histórico: ${err.message}</span>`;
  }
}
// =======================================================================
// CLASSIFICAÇÃO DOS DOIS TIMES
// =======================================================================

async function buscarClassificacaoTimes(
  idCompeticao,
  idCasa,
  idFora
) {

  try {

    const sql = `
      SELECT
        id_time,
        flashscore_id_time,
        posicao_final AS posicao,
        pontos,
        jogos,
        vitorias,
        empates,
        derrotas,
        gols_pro,
        gols_contra
      FROM classificacao_geral_2026
      WHERE id_competicao::text = $1::text
        AND upper(classificacao_tipo) = 'GERAL'
        AND (
          id_time::text IN ($2::text, $3::text)
          OR
          flashscore_id_time IN ($2::text, $3::text)
        )
    `;


    const res = await db.query(
      sql,
      [
        String(idCompeticao),
        String(idCasa),
        String(idFora)
      ]
    );


    return res.rows;

  } catch (err) {

    console.error(
      'Erro ao buscar classificação:',
      err
    );

    return [];
  }
}


// =======================================================================
// CONTROLE DE ABAS
// =======================================================================

window.mudarAbaModal = function (aba) {

  document.getElementById(
    'aba-mercados'
  ).style.display =
    aba === 'mercados'
      ? 'block'
      : 'none';


  document.getElementById(
    'aba-classificacao'
  ).style.display =
    aba === 'classificacao'
      ? 'block'
      : 'none';


  document.getElementById(
    'btn-tab-mercados'
  ).classList.toggle(
    'active',
    aba === 'mercados'
  );


  document.getElementById(
    'btn-tab-classificacao'
  ).classList.toggle(
    'active',
    aba === 'classificacao'
  );
};


// =======================================================================
// TABELA DE CLASSIFICAÇÃO COMPLETA
// =======================================================================

window.carregarTabelaCompleta = async function (
  idCompeticao,
  tipo,
  idCasa,
  idFora
) {

  document
    .querySelectorAll('.sub-tab-btn')
    .forEach(btn =>
      btn.classList.remove('active')
    );


  const btn =
    document.getElementById(
      `btn-sub-${tipo.toLowerCase()}`
    );

  if (btn) {
    btn.classList.add('active');
  }


  const container =
    document.getElementById(
      'container-tabela-classificacao'
    );


  container.innerHTML = `
    <p style="
      text-align: center;
      color: #94a3b8;
      padding: 30px;
    ">
      Buscando classificação...
    </p>
  `;


  try {

    const sql = `
      SELECT
        posicao_final AS posicao,
        nome_time,
        pontos,
        jogos,
        vitorias,
        empates,
        derrotas,
        gols_pro,
        gols_contra,
        saldo_gols,
        id_time,
        flashscore_id_time
      FROM classificacao_geral_2026
      WHERE id_competicao::text = $1::text
        AND upper(classificacao_tipo) = $2
      ORDER BY posicao_final ASC
    `;


    const res = await db.query(
      sql,
      [
        String(idCompeticao),
        tipo.toUpperCase()
      ]
    );


    const dados = res.rows;


    if (dados.length === 0) {

      container.innerHTML = `
        <p style="
          text-align: center;
          color: #f87171;
          padding: 20px;
        ">
          Nenhuma classificação encontrada
          para este filtro.
        </p>
      `;

      return;
    }


    let htmlTabela = `
      <table class="tabela-class">

        <thead>

          <tr>
            <th width="5%">#</th>
            <th class="text-left" width="45%">Equipe</th>
            <th width="8%">Pts</th>
            <th width="7%">J</th>
            <th width="7%">V</th>
            <th width="7%">E</th>
            <th width="7%">D</th>
            <th width="7%">GP</th>
            <th width="7%">GC</th>
          </tr>

        </thead>

        <tbody>
    `;


    dados.forEach(time => {

      let trClass = '';

      const matchIdText =
        String(time.id_time);

      const matchFsId =
        String(time.flashscore_id_time);


      if (
        matchIdText === String(idCasa) ||
        matchFsId === String(idCasa)
      ) {

        trClass =
          'highlight highlight-casa';

      } else if (
        matchIdText === String(idFora) ||
        matchFsId === String(idFora)
      ) {

        trClass =
          'highlight highlight-fora';
      }


      htmlTabela += `
        <tr class="${trClass}">

          <td>
            ${time.posicao}º
          </td>

          <td class="text-left">
            ${time.nome_time}
          </td>

          <td>
            <strong>
              ${time.pontos}
            </strong>
          </td>

          <td>${time.jogos}</td>
          <td>${time.vitorias}</td>
          <td>${time.empates}</td>
          <td>${time.derrotas}</td>
          <td>${time.gols_pro}</td>
          <td>${time.gols_contra}</td>

        </tr>
      `;
    });


    htmlTabela += `
        </tbody>
      </table>
    `;


    container.innerHTML =
      htmlTabela;


  } catch (err) {

    console.error(
      'Erro ao carregar tabela completa:',
      err
    );


    container.innerHTML = `
      <p style="
        text-align: center;
        color: #f38ba8;
      ">
        Erro ao processar tabela.
      </p>
    `;
  }
};


// =======================================================================
// CARREGAR JOGOS
// =======================================================================

async function carregarJogos() {

  try {

    let res;


    if (
      filtroData &&
      filtroData.value
    ) {

      const dataSelecionada =
        filtroData.value;


      res = await db.query(
        `
          SELECT *
          FROM analises_jogo
          WHERE data_jogo::text = $1
          ORDER BY hora_jogo ASC
        `,
        [dataSelecionada]
      );

    } else {

      res = await db.query(
        `
          SELECT *
          FROM analises_jogo
          ORDER BY hora_jogo ASC
        `
      );
    }


    const jogos = res.rows;


    listaJogos.innerHTML = '';


    if (jogos.length === 0) {

      listaJogos.innerHTML = `
        <p style="
          grid-column: 1/-1;
          text-align: center;
          color: #94a3b8;
          padding: 20px;
        ">
          Nenhum jogo encontrado.
        </p>
      `;

      return;
    }


    jogos.forEach(jogo => {

      const card =
        document.createElement('div');


      card.className =
        'game-card';


      card.onclick =
        () => abrirDetalhesJogo(jogo);


      card.innerHTML = `

        <span class="league-tag">
          ${jogo.pais_liga || ''}
          -
          ${jogo.nome_competicao || ''}
        </span>

        <div class="time-row">

          <span>
            ${jogo.nome_time_casa}
          </span>

          <span>
            vs
          </span>

          <span>
            ${jogo.nome_time_fora}
          </span>

        </div>

        <small>
          ⏰ ${jogo.hora_jogo || 'N/A'}
        </small>
      `;


      listaJogos.appendChild(card);
    });


  } catch (err) {

    console.error(
      'Erro ao buscar jogos em analises_jogo:',
      err
    );


    listaJogos.innerHTML = `
      <p style="color: #f38ba8;">
        Erro ao conectar com o banco de dados:
        ${err.message}
      </p>
    `;
  }
}


// =======================================================================
// ABRIR DETALHES DO JOGO
// =======================================================================

async function abrirDetalhesJogo(jogo) {

  // =====================================================================
  // EXPECTATIVAS
  // =====================================================================

  const expGolsTotais =
    jogo.total_gols_esperado;

  const expGolsCasa =
    jogo.casa_gols_esperado;

  const expGolsFora =
    jogo.fora_gols_esperado;

  const expCantosTotais =
    jogo.total_cantos_esperado;

  const expCantosCasa =
    jogo.casa_cantos_esperado;

  const expCantosFora =
    jogo.fora_cantos_esperado;

  const expCartoesTotais =
    jogo.total_cartoes_esperado;

  const expCartoesCasa =
    jogo.casa_cartoes_esperado;

  const expCartoesFora =
    jogo.fora_cartoes_esperado;


  // =====================================================================
  // HISTÓRICO
  //
  // Agora a função recebe os DOIS TIMES.
  //
  // Não existe filtro de competição.
  // Não existe filtro de força.
  //
  // A amostra será:
  //
  // ATALANTA + BOLOGNA
  //
  // =====================================================================

  const filtroMatch = {
    idCasa: jogo.id_time_casa,
    nomeCasa: jogo.nome_time_casa,
    idFora: jogo.id_time_fora,
    nomeFora: jogo.nome_time_fora,
    dataJogo: jogo.data_jogo,         // <-- ADICIONADO
    idCompeticao: jogo.id_competicao  // <-- ADICIONADO
  };


  // =====================================================================
  // COLUNA DA PROBABILIDADE
  // =====================================================================

  const colProb =
    'probabilidade';


  // =====================================================================
  // CONSULTAS
  // =====================================================================

  const [

    classificacao,

    // ---------------------------------------------------------------
    // 1X2
    // ---------------------------------------------------------------

    hHome,
    hDraw,
    hAway,


    // ---------------------------------------------------------------
    // GOLS TOTAIS / BTTS
    // ---------------------------------------------------------------

    hOver15,
    hUnder15,
    hOver25,
    hUnder25,
    hOver35,
    hUnder35,
    hBttsYes,
    hBttsNo,


    // ---------------------------------------------------------------
    // GOLS CASA / FORA
    // ---------------------------------------------------------------

    hCasaGols05,
    hCasaGols15,
    hForaGols05,
    hForaGols15,


    // ---------------------------------------------------------------
    // ESCANTEIOS TOTAIS
    // ---------------------------------------------------------------

    hCantos75,
    hCantosUnder75,
    hCantos85,
    hCantosUnder85,
    hCantos95,
    hCantosUnder95,


    // ---------------------------------------------------------------
    // ESCANTEIOS POR EQUIPE
    // ---------------------------------------------------------------

    hCasaCantos35,
    hCasaCantos45,
    hForaCantos25,
    hForaCantos35,
    hForaCantos45,


    // ---------------------------------------------------------------
    // CARTÕES TOTAIS
    // ---------------------------------------------------------------

    hCartoes25,
    hCartoesUnder25,
    hCartoes35,
    hCartoesUnder35,
    hCartoes45,
    hCartoesUnder45,


    // ---------------------------------------------------------------
    // CARTÕES POR EQUIPE
    // ---------------------------------------------------------------

    hCasaCartoes05,
    hCasaCartoes15,
    hCasaCartoes25,
    hForaCartoes05,
    hForaCartoes15,
    hForaCartoes25

  ] = await Promise.all([


    // =================================================================
    // CLASSIFICAÇÃO
    // =================================================================

    buscarClassificacaoTimes(
      jogo.id_competicao,
      jogo.id_time_casa,
      jogo.id_time_fora
    ),


    // =================================================================
    // 1X2
    //
    // IMPORTANTE:
    //
    // Agora também entra no histórico.
    // =================================================================

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'home',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_home
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'draw',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_draw
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'away',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_away
    }),


    // =================================================================
    // GOLS TOTAIS / BTTS
    // =================================================================

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'over15',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_over15
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'under15',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_under15
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'over25',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_over25
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'under25',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_under25
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'over35',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_over35
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'under35',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_under35
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'btts_yes',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_btts_yes
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'btts_no',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_btts_no
    }),


    // =================================================================
    // GOLS POR EQUIPE
    // =================================================================

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'casa_over05',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_casa_over05
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'casa_over15',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_casa_over15
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_over05',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_over05
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_over15',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_over15
    }),


    // =================================================================
    // ESCANTEIOS TOTAIS
    // =================================================================

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cantos_over75',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cantos_over75
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cantos_under75',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cantos_under75
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cantos_over85',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cantos_over85
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cantos_under85',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cantos_under85
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cantos_over95',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cantos_over95
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cantos_under95',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cantos_under95
    }),


    // =================================================================
    // ESCANTEIOS POR EQUIPE
    // =================================================================

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'casa_cantos_over35',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_casa_cantos_over35
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'casa_cantos_over45',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_casa_cantos_over45
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_cantos_over25',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_cantos_over25
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_cantos_over35',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_cantos_over35
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_cantos_over45',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_cantos_over45
    }),


    // =================================================================
    // CARTÕES TOTAIS
    // =================================================================

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cartoes_over25',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cartoes_over25
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cartoes_under25',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cartoes_under25
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cartoes_over35',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cartoes_over35
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cartoes_under35',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cartoes_under35
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cartoes_over45',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cartoes_over45
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'cartoes_under45',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_cartoes_under45
    }),


    // =================================================================
    // CARTÕES POR EQUIPE
    // =================================================================

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'casa_cartoes_over05',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_casa_cartoes_over05
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'casa_cartoes_over15',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_casa_cartoes_over15
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'casa_cartoes_over25',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_casa_cartoes_over25
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_cartoes_over05',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_cartoes_over05
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_cartoes_over15',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_cartoes_over15
    }),

    consultarHistoricoFiltrado({
      ...filtroMatch,
      mercado: 'fora_cartoes_over25',
      colunaEsperado: colProb,
      valorEsperado: jogo.p_fora_cartoes_over25
    })

  ]);


  // =====================================================================
  // CLASSIFICAÇÃO
  // =====================================================================

  let htmlClassificacao = '';


  if (
    classificacao &&
    classificacao.length > 0
  ) {

    const classCasa =
      classificacao.find(c =>
        String(c.id_time) ===
        String(jogo.id_time_casa) ||
        String(c.flashscore_id_time) ===
        String(jogo.id_time_casa)
      );


    const classFora =
      classificacao.find(c =>
        String(c.id_time) ===
        String(jogo.id_time_fora) ||
        String(c.flashscore_id_time) ===
        String(jogo.id_time_fora)
      );


    htmlClassificacao = `

      <div
        class="market-group"
        style="
          display: flex;
          justify-content: space-between;
          background: #1e293b;
          padding: 12px;
          border-radius: 8px;
          margin-bottom: 15px;
          font-size: 12px;
          border: 1px solid #334155;
        "
      >

        <div
          style="
            flex: 1;
            text-align: center;
            border-right: 1px solid #334155;
            padding-right: 8px;
          "
        >

          <strong
            style="
              color: #60a5fa;
              font-size: 13px;
            "
          >
            🏠 ${jogo.nome_time_casa}
          </strong>

          <br>

          ${classCasa

        ? `
                <div style="margin-top: 4px;">
                  Pos:
                  <b>${classCasa.posicao}º</b>
                  |
                  Pts:
                  <b>${classCasa.pontos}</b>
                  |
                  J:
                  ${classCasa.jogos}
                </div>

                <div
                  style="
                    color: #94a3b8;
                    margin-top: 2px;
                  "
                >
                  V-E-D:
                  ${classCasa.vitorias}-
                  ${classCasa.empates}-
                  ${classCasa.derrotas}
                </div>

                <div
                  style="
                    color: #94a3b8;
                    font-size: 11px;
                  "
                >
                  Gols:
                  ${classCasa.gols_pro}
                  Pró /
                  ${classCasa.gols_contra}
                  Contra
                </div>
              `

        : `
                <div
                  style="
                    color: #64748b;
                    margin-top: 8px;
                  "
                >
                  Sem dados na liga
                </div>
              `
      }

        </div>


        <div
          style="
            flex: 1;
            text-align: center;
            padding-left: 8px;
          "
        >

          <strong
            style="
              color: #f87171;
              font-size: 13px;
            "
          >
            ✈️ ${jogo.nome_time_fora}
          </strong>

          <br>

          ${classFora

        ? `
                <div style="margin-top: 4px;">
                  Pos:
                  <b>${classFora.posicao}º</b>
                  |
                  Pts:
                  <b>${classFora.pontos}</b>
                  |
                  J:
                  ${classFora.jogos}
                </div>

                <div
                  style="
                    color: #94a3b8;
                    margin-top: 2px;
                  "
                >
                  V-E-D:
                  ${classFora.vitorias}-
                  ${classFora.empates}-
                  ${classFora.derrotas}
                </div>

                <div
                  style="
                    color: #94a3b8;
                    font-size: 11px;
                  "
                >
                  Gols:
                  ${classFora.gols_pro}
                  Pró /
                  ${classFora.gols_contra}
                  Contra
                </div>
              `

        : `
                <div
                  style="
                    color: #64748b;
                    margin-top: 8px;
                  "
                >
                  Sem dados na liga
                </div>
              `
      }

        </div>

      </div>

    `;
  }


  // =====================================================================
  // HTML
  // =====================================================================

  detalhesJogo.innerHTML = `

    <style>

      .tabs-header {
        display: flex;
        gap: 10px;
        margin-bottom: 15px;
        border-bottom: 1px solid #334155;
        padding-bottom: 10px;
      }

      .tab-btn {
        background: transparent;
        color: #94a3b8;
        border: none;
        font-size: 14px;
        cursor: pointer;
        padding: 6px 12px;
        border-radius: 4px;
        transition: 0.2s;
      }

      .tab-btn:hover {
        background: #334155;
        color: #fff;
      }

      .tab-btn.active {
        background: #3b82f6;
        color: #fff;
        font-weight: bold;
      }

      .sub-tabs {
        display: flex;
        gap: 8px;
        margin-bottom: 15px;
        justify-content: center;
      }

      .sub-tab-btn {
        background: #1e293b;
        color: #cbd5e1;
        border: 1px solid #334155;
        padding: 6px 18px;
        border-radius: 20px;
        cursor: pointer;
        font-size: 12px;
        transition: 0.2s;
      }

      .sub-tab-btn:hover {
        background: #334155;
      }

      .sub-tab-btn.active {
        background: #3b82f6;
        border-color: #3b82f6;
        color: white;
      }

      .tabela-class {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        text-align: center;
      }

      .tabela-class th {
        background: #1e293b;
        padding: 10px 5px;
        color: #94a3b8;
        font-weight: normal;
        border-bottom: 1px solid #334155;
      }

      .tabela-class td {
        padding: 10px 5px;
        border-bottom: 1px solid #1e293b;
        color: #e2e8f0;
      }

      .tabela-class tr:hover {
        background: #1e293b;
      }

      .tabela-class tr.highlight-casa {
        background: rgba(96, 165, 250, 0.15);
        font-weight: bold;
      }

      .tabela-class tr.highlight-casa td {
        color: #60a5fa;
      }

      .tabela-class tr.highlight-fora {
        background: rgba(248, 113, 113, 0.15);
        font-weight: bold;
      }

      .tabela-class tr.highlight-fora td {
        color: #f87171;
      }

      .text-left {
        text-align: left !important;
      }

    </style>


    <h2>
      ${jogo.nome_time_casa}
      x
      ${jogo.nome_time_fora}
    </h2>


    <p>
      <small>
        ${jogo.pais_liga || ''}
        -
        ${jogo.nome_competicao || ''}
        |
        ⏰ ${jogo.hora_jogo || 'N/A'}
        |
        Rodada: ${jogo.rodada || 'N/A'}
      </small>
    </p>


    <div class="tabs-header">

      <button
        id="btn-tab-mercados"
        class="tab-btn active"
        onclick="mudarAbaModal('mercados')"
      >
        📊 Mercados
      </button>


      <button
        id="btn-tab-classificacao"
        class="tab-btn"
        onclick="
          mudarAbaModal('classificacao');
          carregarTabelaCompleta(
            '${jogo.id_competicao}',
            'GERAL',
            '${jogo.id_time_casa}',
            '${jogo.id_time_fora}'
          )
        "
      >
        🏆 Classificação Completa
      </button>

    </div>


    <div id="aba-mercados">

      ${htmlClassificacao}


      <!-- ========================================================= -->
      <!-- EXPECTATIVAS -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          📊 Expectativas Calculadas
        </h3>


        <div class="prob-bar">
          <span>
            Total Gols Esperado
          </span>

          <strong>
            ${fmt(expGolsTotais, false)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Gols Casa / Fora Esperados
          </span>

          <strong>
            ${fmt(expGolsCasa, false)}
            /
            ${fmt(expGolsFora, false)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Total Cantos Esperado
          </span>

          <strong>
            ${fmt(expCantosTotais, false)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Cantos Casa / Fora Esperados
          </span>

          <strong>
            ${fmt(expCantosCasa, false)}
            /
            ${fmt(expCantosFora, false)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Total Cartões Esperado
          </span>

          <strong>
            ${fmt(expCartoesTotais, false)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Cartões Casa / Fora Esperados
          </span>

          <strong>
            ${fmt(expCartoesCasa, false)}
            /
            ${fmt(expCartoesFora, false)}
          </strong>
        </div>

      </div>


      <!-- ========================================================= -->
      <!-- 1X2 -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          ⚽ Match Odds (1X2)
        </h3>


        <div class="prob-bar">
          <span>
            Casa (${jogo.nome_time_casa})
            ${hHome}
          </span>

          <strong>
            ${fmt(jogo.p_home)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Empate
            ${hDraw}
          </span>

          <strong>
            ${fmt(jogo.p_draw)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Fora (${jogo.nome_time_fora})
            ${hAway}
          </span>

          <strong>
            ${fmt(jogo.p_away)}
          </strong>
        </div>

      </div>


      <!-- ========================================================= -->
      <!-- GOLS TOTAIS -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          ⚽ Gols Totais & BTTS
        </h3>


        <div class="prob-bar">
          <span>
            Over 1.5 ${hOver15}
          </span>

          <strong>
            ${fmt(jogo.p_over15)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 1.5 ${hUnder15}
          </span>

          <strong>
            ${fmt(jogo.p_under15)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Over 2.5 ${hOver25}
          </span>

          <strong>
            ${fmt(jogo.p_over25)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 2.5 ${hUnder25}
          </span>

          <strong>
            ${fmt(jogo.p_under25)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Over 3.5 ${hOver35}
          </span>

          <strong>
            ${fmt(jogo.p_over35)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 3.5 ${hUnder35}
          </span>

          <strong>
            ${fmt(jogo.p_under35)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Ambas Marcam - Sim ${hBttsYes}
          </span>

          <strong>
            ${fmt(jogo.p_btts_yes)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Ambas Marcam - Não ${hBttsNo}
          </span>

          <strong>
            ${fmt(jogo.p_btts_no)}
          </strong>
        </div>

      </div>


      <!-- ========================================================= -->
      <!-- GOLS POR EQUIPE -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          🏠 Gols Por Equipe (Com Mando C/F)
        </h3>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_casa}
            Over 0.5
            ${hCasaGols05}
          </span>

          <strong>
            ${fmt(jogo.p_casa_over05)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_casa}
            Over 1.5
            ${hCasaGols15}
          </span>

          <strong>
            ${fmt(jogo.p_casa_over15)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Over 0.5
            ${hForaGols05}
          </span>

          <strong>
            ${fmt(jogo.p_fora_over05)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Over 1.5
            ${hForaGols15}
          </span>

          <strong>
            ${fmt(jogo.p_fora_over15)}
          </strong>
        </div>

      </div>


      <!-- ========================================================= -->
      <!-- ESCANTEIOS TOTAIS -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          🚩 Escanteios Totais
        </h3>


        <div class="prob-bar">
          <span>
            Over 7.5 ${hCantos75}
          </span>

          <strong>
            ${fmt(jogo.p_cantos_over75)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 7.5 ${hCantosUnder75}
          </span>

          <strong>
            ${fmt(jogo.p_cantos_under75)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Over 8.5 ${hCantos85}
          </span>

          <strong>
            ${fmt(jogo.p_cantos_over85)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 8.5 ${hCantosUnder85}
          </span>

          <strong>
            ${fmt(jogo.p_cantos_under85)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Over 9.5 ${hCantos95}
          </span>

          <strong>
            ${fmt(jogo.p_cantos_over95)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 9.5 ${hCantosUnder95}
          </span>

          <strong>
            ${fmt(jogo.p_cantos_under95)}
          </strong>
        </div>

      </div>


      <!-- ========================================================= -->
      <!-- ESCANTEIOS POR EQUIPE -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          🚩 Escanteios Por Equipe
        </h3>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_casa}
            Cantos Over 3.5
            ${hCasaCantos35}
          </span>

          <strong>
            ${fmt(jogo.p_casa_cantos_over35)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_casa}
            Cantos Over 4.5
            ${hCasaCantos45}
          </span>

          <strong>
            ${fmt(jogo.p_casa_cantos_over45)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Cantos Over 2.5
            ${hForaCantos25}
          </span>

          <strong>
            ${fmt(jogo.p_fora_cantos_over25)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Cantos Over 3.5
            ${hForaCantos35}
          </span>

          <strong>
            ${fmt(jogo.p_fora_cantos_over35)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Cantos Over 4.5
            ${hForaCantos45}
          </span>

          <strong>
            ${fmt(jogo.p_fora_cantos_over45)}
          </strong>
        </div>

      </div>


      <!-- ========================================================= -->
      <!-- CARTÕES TOTAIS -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          🟨 Cartões Totais
        </h3>


        <div class="prob-bar">
          <span>
            Over 2.5 ${hCartoes25}
          </span>

          <strong>
            ${fmt(jogo.p_cartoes_over25)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 2.5 ${hCartoesUnder25}
          </span>

          <strong>
            ${fmt(jogo.p_cartoes_under25)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Over 3.5 ${hCartoes35}
          </span>

          <strong>
            ${fmt(jogo.p_cartoes_over35)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 3.5 ${hCartoesUnder35}
          </span>

          <strong>
            ${fmt(jogo.p_cartoes_under35)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Over 4.5 ${hCartoes45}
          </span>

          <strong>
            ${fmt(jogo.p_cartoes_over45)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            Under 4.5 ${hCartoesUnder45}
          </span>

          <strong>
            ${fmt(jogo.p_cartoes_under45)}
          </strong>
        </div>

      </div>


      <!-- ========================================================= -->
      <!-- CARTÕES POR EQUIPE -->
      <!-- ========================================================= -->

      <div class="market-group">

        <h3>
          🟨 Cartões Por Equipe
        </h3>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_casa}
            Cartões Over 0.5
            ${hCasaCartoes05}
          </span>

          <strong>
            ${fmt(jogo.p_casa_cartoes_over05)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_casa}
            Cartões Over 1.5
            ${hCasaCartoes15}
          </span>

          <strong>
            ${fmt(jogo.p_casa_cartoes_over15)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_casa}
            Cartões Over 2.5
            ${hCasaCartoes25}
          </span>

          <strong>
            ${fmt(jogo.p_casa_cartoes_over25)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Cartões Over 0.5
            ${hForaCartoes05}
          </span>

          <strong>
            ${fmt(jogo.p_fora_cartoes_over05)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Cartões Over 1.5
            ${hForaCartoes15}
          </span>

          <strong>
            ${fmt(jogo.p_fora_cartoes_over15)}
          </strong>
        </div>


        <div class="prob-bar">
          <span>
            ${jogo.nome_time_fora}
            Cartões Over 2.5
            ${hForaCartoes25}
          </span>

          <strong>
            ${fmt(jogo.p_fora_cartoes_over25)}
          </strong>
        </div>

      </div>

    </div>


    <!-- ============================================================= -->
    <!-- CLASSIFICAÇÃO -->
    <!-- ============================================================= -->

    <div
      id="aba-classificacao"
      style="display: none;"
    >

      <div class="sub-tabs">

        <button
          id="btn-sub-geral"
          class="sub-tab-btn active"
          onclick="
            carregarTabelaCompleta(
              '${jogo.id_competicao}',
              'GERAL',
              '${jogo.id_time_casa}',
              '${jogo.id_time_fora}'
            )
          "
        >
          Geral
        </button>


        <button
          id="btn-sub-casa"
          class="sub-tab-btn"
          onclick="
            carregarTabelaCompleta(
              '${jogo.id_competicao}',
              'CASA',
              '${jogo.id_time_casa}',
              '${jogo.id_time_fora}'
            )
          "
        >
          Casa
        </button>


        <button
          id="btn-sub-fora"
          class="sub-tab-btn"
          onclick="
            carregarTabelaCompleta(
              '${jogo.id_competicao}',
              'FORA',
              '${jogo.id_time_casa}',
              '${jogo.id_time_fora}'
            )
          "
        >
          Fora
        </button>

      </div>


      <div
        id="container-tabela-classificacao"
        style="
          overflow-x: auto;
          margin-bottom: 20px;
        "
      ></div>

    </div>

  `;


  window.mudarAbaModal(
    'mercados'
  );


  modal.classList.remove(
    'hidden'
  );
}
// =======================================================================
// FECHAR MODAL
// =======================================================================
function fecharModal() {
  modal.classList.add(
    'hidden'
  );
}
// =======================================================================
// INICIALIZAÇÃO
// =======================================================================
carregarJogos();