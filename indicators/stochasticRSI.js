// indicators/stochastic.js
// Now implements TradingView-style Stochastic RSI:
// rsi1 = ta.rsi(src, lengthRSI)
// k = ta.sma(ta.stoch(rsi1, rsi1, rsi1, lengthStoch), smoothK)
// d = ta.sma(k, smoothD)

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

/**
 * Wilder-style RSI, similar to TradingView ta.rsi
 */
function calculateRSI(values, period) {
  const len = values.length;
  const rsi = new Array(len).fill(null);
  const p = Number(period) || 14;

  if (p <= 0 || len === 0) return rsi;
  if (len <= p) return rsi;

  const gains = new Array(len).fill(0);
  const losses = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) {
      gains[i] = diff;
      losses[i] = 0;
    } else {
      gains[i] = 0;
      losses[i] = -diff;
    }
  }

  // Seed average gain/loss
  let sumGain = 0;
  let sumLoss = 0;
  for (let i = 1; i <= p; i++) {
    sumGain += gains[i];
    sumLoss += losses[i];
  }

  let avgGain = sumGain / p;
  let avgLoss = sumLoss / p;

  // First RSI value at index p
  if (avgLoss === 0) {
    rsi[p] = 100;
  } else {
    const rs = avgGain / avgLoss;
    rsi[p] = 100 - 100 / (1 + rs);
  }

  // Wilder smoothing
  for (let i = p + 1; i < len; i++) {
    avgGain = (avgGain * (p - 1) + gains[i]) / p;
    avgLoss = (avgLoss * (p - 1) + losses[i]) / p;

    if (avgLoss === 0) {
      rsi[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi[i] = 100 - 100 / (1 + rs);
    }
  }

  return rsi;
}

/**
 * Simple SMA that returns null until there are `period` valid values
 * (similar to TradingView ta.sma behaviour).
 */
function smaSeries(src, period) {
  const len = src.length;
  const out = new Array(len).fill(null);
  const p = Number(period) || 1;
  if (p <= 1) {
    for (let i = 0; i < len; i++) {
      out[i] = src[i] == null ? null : src[i];
    }
    return out;
  }

  for (let i = p - 1; i < len; i++) {
    let sum = 0;
    let valid = true;
    for (let j = i - p + 1; j <= i; j++) {
      const v = src[j];
      if (v == null) {
        valid = false;
        break;
      }
      sum += v;
    }
    if (valid) {
      out[i] = sum / p;
    } else {
      out[i] = null;
    }
  }

  return out;
}

/**
 * Adds TradingView-style Stochastic RSI to candles.
 *
 * Params map to your Pine script:
 *  - rsiPeriod   ~ lengthRSI (default 14)
 *  - kPeriod     ~ lengthStoch (default 14)
 *  - kSmoothing  ~ smoothK (default 3)
 *  - dPeriod     ~ smoothD (default 3)
 *
 * Each candle gets:
 *   stochastic: {
 *     k: <slowK>,  // %K line
 *     d: <dLine>   // %D line
 *   }
 */
function addStochasticToCandles(
  candles,
  {
    rsiPeriod = 14,
    kPeriod = 14,
    kSmoothing = 3,
    dPeriod = 3,
    priceField = 'close',
  } = {}
) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }

  const len = candles.length;
  if (len === 0) return candles;

  const rsiP = Number(rsiPeriod) || 14;
  const kP = Number(kPeriod) || 14;
  const kS = Number(kSmoothing) || 3;
  const dP = Number(dPeriod) || 3;

  const closes = candles.map((c) => Number(c[priceField]) || 0);

  // 1) RSI of close (Wilder style)
  const rsi = calculateRSI(closes, rsiP);

  // 2) Stoch of RSI (ta.stoch(rsi, rsi, rsi, lengthStoch))
  const rawK = new Array(len).fill(null);

  for (let i = 0; i < len; i++) {
    if (i < kP - 1) {
      rawK[i] = null;
      continue;
    }

    let highest = -Infinity;
    let lowest = Infinity;
    let hasNa = false;

    for (let j = i - kP + 1; j <= i; j++) {
      const v = rsi[j];
      if (v == null) {
        hasNa = true;
        break;
      }
      if (v > highest) highest = v;
      if (v < lowest) lowest = v;
    }

    if (hasNa) {
      rawK[i] = null;
      continue;
    }

    const range = highest - lowest;
    if (range === 0) {
      rawK[i] = 0;
    } else {
      rawK[i] = ((rsi[i] - lowest) / range) * 100;
    }
  }

  // 3) smoothK = sma(rawK, kSmoothing)
  const smoothK = smaSeries(rawK, kS);

  // 4) dLine = sma(smoothK, dPeriod)
  const dLine = smaSeries(smoothK, dP);

  // Attach to candles as stochastic (Stoch RSI)
  return candles.map((c, idx) => {
    const kVal = smoothK[idx];
    const dVal = dLine[idx];

    let stochastic = null;
    if (kVal != null && dVal != null) {
      stochastic = {
        k: round(kVal),
        d: round(dVal),
      };
    }

    return {
      ...c,
      stochastic,
    };
  });
}

module.exports = {
  addStochasticToCandles,
};
