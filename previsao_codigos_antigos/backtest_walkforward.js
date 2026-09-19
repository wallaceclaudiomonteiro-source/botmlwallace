import { spawnSync } from 'child_process';

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return formatDate(d);
}

function runNodeScript(scriptName, dataAlvo) {
  console.log(`\n▶️ Rodando ${scriptName} para ${dataAlvo}`);

  const result = spawnSync(process.execPath, [scriptName, `--date=${dataAlvo}`], {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATA_ALVO: dataAlvo,
    },
  });

  if (result.status !== 0) {
    throw new Error(`Falha ao executar ${scriptName} para ${dataAlvo}`);
  }
}

async function main() {
  const START_DATE = process.env.START_DATE || '2026-08-09';
  const END_DATE = process.env.END_DATE || '2026-08-09';

  const ETL_SCRIPT = process.env.ETL_SCRIPT || 'etl_ratings.js';
  const ANALISE_SCRIPT = process.env.ANALISE_SCRIPT || 'run_analysis.js';

  console.log(`🚀 Walk-forward de ${START_DATE} até ${END_DATE}`);

  let dataAtual = START_DATE;

  while (dataAtual <= END_DATE) {
    console.log(`\n📅 Processando ${dataAtual}`);

    try {
      runNodeScript(ETL_SCRIPT, dataAtual);
      runNodeScript(ANALISE_SCRIPT, dataAtual);
      console.log(`✅ Concluído ${dataAtual}`);
    } catch (err) {
      console.error(`❌ Erro em ${dataAtual}: ${err.message}`);
      break;
    }

    dataAtual = addDays(dataAtual, 1);
  }

  console.log('\n🏁 Fim do walk-forward.');
}

main().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});