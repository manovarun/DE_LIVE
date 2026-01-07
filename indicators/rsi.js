// indicators/rsi.js

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

/**
 * Calculate Relative Strength Index (RSI) using Wilder's smoothing.
 *
 * Steps:
 *  1. For each bar, compute change = close[i] - close[i-1]
 *     gain = max(change, 0), loss = max(-change, 0)
 *  2. Initial avgGain / avgLoss = simple average over first `period` changes.
 *  3. Then Wilder smoothing:
 *       avgGain = (prevAvgGain * (period - 1) + gain) / period
 *       avgLoss = (prevAvgLoss * (period - 1) + loss) / period
 *  4. RS = avgGain / avgLoss
 *     RSI = 100 - (100 / (1 + RS))
 *
 * @param {number[]} values - array of prices (e.g. closes)
 * @param {number} period   - RSI period (e.g. 14)
 * @returns {(number|null)[]} - RSI array; null where not enough data
 */
function calculateRSI(values, period) {
  if (!Array.isArray(values)) {
    throw new Error('values must be an array');
  }
  if (!Number.isFinite(Number(period)) || period < 1) {
    throw new Error('period must be a positive integer');
  }

  const p = Number(period);
  const len = values.length;
  const result = new Array(len).fill(null);

  if (len <= 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  // 1) Build initial avgGain / avgLoss over first `p` changes
  for (let i = 1; i <= p && i < len; i++) {
    const change = (Number(values[i]) || 0) - (Number(values[i - 1]) || 0);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain += gain;
    avgLoss += loss;
  }

  if (len <= p) {
    // Not enough data to compute first RSI
    return result;
  }

  avgGain /= p;
  avgLoss /= p;

  // First RSI value at index p
  let rsi;
  if (avgLoss === 0 && avgGain === 0) {
    rsi = 50;
  } else if (avgLoss === 0) {
    rsi = 100;
  } else {
    const rs = avgGain / avgLoss;
    rsi = 100 - 100 / (1 + rs);
  }
  result[p] = Number(rsi.toFixed(4));

  // 2) Wilder smoothing for the rest
  for (let i = p + 1; i < len; i++) {
    const change = (Number(values[i]) || 0) - (Number(values[i - 1]) || 0);
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;

    if (avgLoss === 0 && avgGain === 0) {
      rsi = 50;
    } else if (avgLoss === 0) {
      rsi = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi = 100 - 100 / (1 + rs);
    }

    result[i] = Number(rsi.toFixed(4));
  }

  return result;
}

/**
 * Add multiple RSIs to candle objects, grouped under `rsis` field.
 *
 * Output example for periods [7,14,21]:
 * {
 *   ...candleFields,
 *   rsis: {
 *     "7":  70.1234,
 *     "14": 62.3456,
 *     "21": null
 *   }
 * }
 *
 * @param {Object[]} candles
 * @param {Object} options
 * @param {number[]} options.periods - RSI periods (e.g. [14] or [7,14,21])
 * @param {string} [options.priceField='close'] - which field to use as price
 * @returns {Object[]} new array with `rsis` object attached
 */
function addRSIsToCandles(candles, { periods, priceField = 'close' } = {}) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error('periods must be a non-empty array');
  }

  // "Normalize" / clean periods like SMA/EMA
  const cleanPeriods = periods
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p >= 1);

  if (cleanPeriods.length === 0) {
    throw new Error(
      'periods must contain at least one valid positive integer.'
    );
  }

  const values = candles.map((c) => Number(c[priceField]) || 0);

  // Precompute RSI arrays for each period
  const rsiMap = {};
  for (const period of cleanPeriods) {
    rsiMap[period] = calculateRSI(values, period);
  }

  // Build new candles with nested `rsis` map
  const result = candles.map((c, idx) => {
    const rsis = {};
    for (const period of cleanPeriods) {
      const v = rsiMap[period][idx];
      rsis[period] = v !== null ? round(v) : null;
    }
    return {
      ...c,
      rsis,
    };
  });

  return result;
}

module.exports = {
  calculateRSI,
  addRSIsToCandles,
};
