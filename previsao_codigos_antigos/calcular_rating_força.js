const { criarPool } = require('../db'); // Lembre de ajustar o ../ de acordo com a pasta do arquivo

const pool = criarPool('modelo', { 
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// =========================================================
// 🧰 FUNÇÕES AUXILIARES
// =========================================================

function classificarForca(rating, limForte, limFraco, isDefesa = false) {
  const r = parseFloat(rating);
  const f = parseFloat(limForte);
  const fr = parseFloat(limFraco);
  if (isDefesa) {
    if (r <= f) return 'FORTE';
    if (r >= fr) return 'FRACO';
    return 'MEDIO';
  } else {
    if (r >= f) return 'FORTE';
    if (r <= fr) return 'FRACO';
    return 'MEDIO';
  }
}

// 🔥 FUNÇÃO CORRIGIDA: Mesclar as estatísticas (pegando decimais)
// 🔥 FUNÇÃO CORRIGIDA 2.0: Mesclar as estatísticas (Sem sobrescrever nomes)
function mesclarEstatisticas(linhaAtaque, linhaDefesa, nomeTime) {
  if (!linhaAtaque && !linhaDefesa) return { "=== CLUBE ===": nomeTime, aviso: "Sem dados para mesclar" };

  const objAtaque = linhaAtaque || {};
  const objDefesa = linhaDefesa || {};
  
  const dividePor = (linhaAtaque && linhaDefesa) ? 2 : 1;

  // Adicionado 'nome_time' e 'time' para evitar que o código tente somar IDs ou nomes
  const colunasIgnoradas = [
    'id', 'id_time', 'casa_fora', 'tipo_analise', 'grid_forca_adv', 
    'jogos_usados', 'data_ultima_atualizacao', 'rating_ataque', 'rating_defesa', 'nome_time', 'time'
  ];

  // Chave alterada para não bater com nenhuma coluna do seu banco
  const estatisticasMescladas = { "=== CLUBE ===": nomeTime };

  const chaves = new Set([...Object.keys(objAtaque), ...Object.keys(objDefesa)]);

  chaves.forEach(chave => {
    if (colunasIgnoradas.includes(chave)) return;

    let valA = parseFloat(objAtaque[chave]);
    let valB = parseFloat(objDefesa[chave]);

    if (isNaN(valA) && isNaN(valB)) return;

    valA = isNaN(valA) ? 0 : valA;
    valB = isNaN(valB) ? 0 : valB;
    
    estatisticasMescladas[chave] = Number(((valA + valB) / dividePor).toFixed(2));
  });

  return estatisticasMescladas;
}
// =========================================================
// 🚀 PIPELINE PRINCIPAL
// =========================================================
async function processarJogosPorData(dataAlvo) {
  console.log(`\n🚀 [ETL] Iniciando varredura para a data: ${dataAlvo}`);
  const client = await pool.connect();
  
  try {
    const { rows: jogosDoDia } = await client.query(`
      SELECT id, id_time_casa, id_time_fora, id_competicao 
      FROM calendario 
      WHERE DATE(data_jogo) = $1
    `, [dataAlvo]);

    if (jogosDoDia.length === 0) return console.log(`ℹ️ Nenhum jogo encontrado.`);

    for (const jogo of jogosDoDia) {
      console.log(`\n======================================================`);
      
      // 🆕 BUSCAR NOME DOS TIMES
      const { rows: infoTimes } = await client.query(`
        SELECT id, nome FROM times WHERE id IN ($1, $2)
      `, [jogo.id_time_casa, jogo.id_time_fora]);

      const nomeCasa = infoTimes.find(t => t.id === jogo.id_time_casa)?.nome || `ID ${jogo.id_time_casa}`;
      const nomeFora = infoTimes.find(t => t.id === jogo.id_time_fora)?.nome || `ID ${jogo.id_time_fora}`;

      console.log(`⚙️ PROCESSANDO JOGO ID: ${jogo.id} | ${nomeCasa} (CASA) x ${nomeFora} (FORA)`);
      
      // BUSCAR RATINGS
      const { rows: ratings } = await client.query(`
        SELECT id_time, casa_rating_ataque, casa_rating_defesa, fora_rating_ataque, fora_rating_defesa
        FROM rating_times WHERE id_time IN ($1, $2)
      `, [jogo.id_time_casa, jogo.id_time_fora]);

      const dadosCasa = ratings.find(r => r.id_time === jogo.id_time_casa);
      const dadosFora = ratings.find(r => r.id_time === jogo.id_time_fora);

      if (!dadosCasa || !dadosFora) {
        console.log(`⚠️ Ignorando jogo: Falta rating para um dos times.`);
        continue; 
      }

      const { rows: limitesComp } = await client.query(`
        SELECT * FROM competicoes WHERE id = $1
      `, [jogo.id_competicao]);

      if (limitesComp.length === 0) continue;
      const limites = limitesComp[0];

      // DEFINIÇÃO DAS FORÇAS
      const forca = {
        casaAtaque: classificarForca(dadosCasa.casa_rating_ataque, limites.casa_ataque_limite_forte, limites.casa_ataque_limite_fraco, false),
        casaDefesa: classificarForca(dadosCasa.casa_rating_defesa, limites.casa_defesa_limite_forte, limites.casa_defesa_limite_fraco, true),
        foraAtaque: classificarForca(dadosFora.fora_rating_ataque, limites.fora_ataque_limite_forte, limites.fora_ataque_limite_fraco, false),
        foraDefesa: classificarForca(dadosFora.fora_rating_defesa, limites.fora_defesa_limite_forte, limites.fora_defesa_limite_fraco, true)
      };

      // BUSCAR COMPORTAMENTO MANDANTE
      const { rows: compCasa } = await client.query(`
        SELECT * FROM analise_comportamento_times
        WHERE id_time = $1 AND casa_fora = 'C'
        AND ((tipo_analise = 'DEFESA_ADV' AND grid_forca_adv = $2) OR (tipo_analise = 'ATAQUE_ADV' AND grid_forca_adv = $3))
      `, [jogo.id_time_casa, forca.foraDefesa, forca.foraAtaque]);

      const linhaCasaVsDefesa = compCasa.find(r => r.tipo_analise === 'DEFESA_ADV');
      const linhaCasaVsAtaque = compCasa.find(r => r.tipo_analise === 'ATAQUE_ADV');

      // 🔥 MESCLAR ESTATÍSTICAS DO MANDANTE (Passando o nome do time agora!)
      const estatisticasFinaisCasa = mesclarEstatisticas(linhaCasaVsAtaque, linhaCasaVsDefesa, nomeCasa);


      // BUSCAR COMPORTAMENTO VISITANTE
      const { rows: compFora } = await client.query(`
        SELECT * FROM analise_comportamento_times
        WHERE id_time = $1 AND casa_fora = 'F'
        AND ((tipo_analise = 'DEFESA_ADV' AND grid_forca_adv = $2) OR (tipo_analise = 'ATAQUE_ADV' AND grid_forca_adv = $3))
      `, [jogo.id_time_fora, forca.casaDefesa, forca.casaAtaque]);

      const linhaForaVsDefesa = compFora.find(r => r.tipo_analise === 'DEFESA_ADV');
      const linhaForaVsAtaque = compFora.find(r => r.tipo_analise === 'ATAQUE_ADV');

      // 🔥 MESCLAR ESTATÍSTICAS DO VISITANTE (Passando o nome do time agora!)
      const estatisticasFinaisFora = mesclarEstatisticas(linhaForaVsAtaque, linhaForaVsDefesa, nomeFora);


      // 5️⃣ EXIBIR OS RESULTADOS MESCLADOS NO CONSOLE
      console.log(`\n🏠 ESTATÍSTICAS ESPERADAS - ${nomeCasa} (CASA)`);
      console.log(`(Mescla de como joga vs ATAQUE ${forca.foraAtaque} e vs DEFESA ${forca.foraDefesa} do Visitante)`);
      console.log(estatisticasFinaisCasa);

      console.log(`\n✈️ ESTATÍSTICAS ESPERADAS - ${nomeFora} (FORA)`);
      console.log(`(Mescla de como joga vs ATAQUE ${forca.casaAtaque} e vs DEFESA ${forca.casaDefesa} do Mandante)`);
      console.log(estatisticasFinaisFora);
      
      console.log(`======================================================\n`);
    }

  } catch (e) {
    console.error('❌ ERRO DURANTE O PROCESSO:', e.message);
  } finally {
    client.release();
  }
}

// Rodando para a data especificada
processarJogosPorData('2026-08-18').then(() => pool.end());