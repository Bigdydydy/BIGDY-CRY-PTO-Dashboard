function cnd(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2.0);

  const t = 1.0 / (1.0 + p * x);
  const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * erf);
}

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function calcGreeks(S, K, T_years, iv_pct, isCall, r = 0.04) {
  const sigma = Math.max(0.01, iv_pct / 100.0);
  const T = Math.max(0.0001, T_years);
  const sqrtT = Math.sqrt(T);

  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const pdfD1 = normalPdf(d1);
  const cndD1 = cnd(d1);
  const cndD2 = cnd(d2);

  let delta, theta;
  const gamma = pdfD1 / (S * sigma * sqrtT);
  const vega = (S * sqrtT * pdfD1) * 0.01; // USD change per 1% vol change per 1 contract

  if (isCall) {
    delta = cndD1;
    theta = (- (S * sigma * pdfD1) / (2 * sqrtT) - r * K * Math.exp(-r * T) * cndD2) / 365.0;
  } else {
    delta = cndD1 - 1.0;
    theta = (- (S * sigma * pdfD1) / (2 * sqrtT) + r * K * Math.exp(-r * T) * (1.0 - cndD2)) / 365.0;
  }

  return { delta, gamma, vega, theta };
}

// Test with BTC price $77,200, Strike $80,000, 14 days, IV 35%
const res = calcGreeks(77200, 80000, 14 / 365, 35, true);
console.log("Call Greeks:", res);
const resPut = calcGreeks(77200, 75000, 14 / 365, 35, false);
console.log("Put Greeks:", resPut);
