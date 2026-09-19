// ======================================================
// ✅ EWMA — pesos exponenciais (valor mais recente = maior peso)
// ======================================================
function ewmaWeights(n, alpha = 0.5) {
  if (n <= 0) return [];
  const weights = [];
  let sum = 0;

  for (let i = 0; i < n; i++) {
    const w = Math.pow(1 - alpha, i);
    weights.push(w);
    sum += w;
  }

  return weights.map(w => w / sum);
}

// ======================================================
// ✅ Média ponderada simples
// ======================================================
function weightedMean(values, weights) {
  if (!values || values.length === 0) return 0;
  let sum = 0, sw = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i] || 0;
    const w = weights?.[i] ?? 1;
    sum += v * w;
    sw += w;
  }

  return sw === 0 ? 0 : sum / sw;
}

// ======================================================
// ✅ Gamma Posterior Weighted — versão robusta
// ======================================================
function gammaPosteriorWeighted(values, weights, priorMean = 1.0, priorStrength = 2.0) {
  const a0 = priorStrength * priorMean;
  const b0 = priorStrength;

  let sum_wx = 0;
  let sum_w = 0;

  for (let i = 0; i < values.length; i++) {
    const v = values[i] || 0;
    const w = weights?.[i] ?? 1;
    sum_wx += w * v;
    sum_w += w;
  }

  const a_post = a0 + sum_wx;
  const b_post = b0 + sum_w;

  let lambda_mean = a_post / b_post;

  // Proteção contra explosões
  if (lambda_mean < 0) lambda_mean = 0;
  if (lambda_mean > 6) lambda_mean = 6;

  return { lambda_mean, a_post, b_post, sum_wx, sum_w };
}

// ======================================================
// ✅ Poisson CDF — versão estável numericamente
// ======================================================
function poissonCdf(k, lambda) {
  if (k < 0) return 0;

  let p = Math.exp(-lambda);
  let sum = p;

  for (let i = 1; i <= k; i++) {
    p *= lambda / i;
    sum += p;
    if (p < 1e-12) break;
  }

  return sum;
}

// ======================================================
// ✅ Probabilidade Over K — P(X > K)
// ======================================================
function probPoissonOver(lambda, K) {
  return 1 - poissonCdf(K, lambda);
}

// ======================================================
// ✅ Probabilidade Under K — P(X ≤ K)
// ======================================================
function probPoissonUnder(lambda, K) {
  return poissonCdf(K, lambda);
}

// ======================================================
// ✅ Probabilidade Exata de Poisson — P(X = k)
// ======================================================
function probPoissonExact(lambda, k) {
  if (k < 0) return 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

// ======================================================
// ✅ Percentil (p50, p75, p90)
// ======================================================
function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

// ======================================================
// ✅ Monte Carlo Poisson — simulação
// ======================================================
function monteCarloPoisson(lambda, threshold, trials = 10000) {
  let count = 0;
  for (let i = 0; i < trials; i++) {
    // gera valor Poisson
    let x = 0, p = Math.exp(-lambda), sum = p, u = Math.random();
    while (u > sum) {
      x++;
      p *= lambda / x;
      sum += p;
    }
    if (x > threshold) count++;
  }
  return count / trials;
}

// ======================================================
// ✅ Combinação das janelas 5 / 10 / 15 — NOVOS PESOS
// ======================================================
function combineLambdas(lambda5, lambda10, lambda15, w5 = 0.7, w10 = 0.2, w15 = 0.1) {
  return (lambda5 || 0) * w5 +
         (lambda10 || 0) * w10 +
         (lambda15 || 0) * w15;
}

// ======================================================
// ✅ Fatorial simples
// ======================================================
function factorial(n) {
  if (n <= 1) return 1;
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

module.exports = {
  ewmaWeights,
  weightedMean,
  gammaPosteriorWeighted,
  poissonCdf,
  probPoissonOver,
  probPoissonUnder,
  probPoissonExact, // 👈 Função essencial para o Dixon-Coles
  percentile,
  monteCarloPoisson,
  combineLambdas,
  factorial
};