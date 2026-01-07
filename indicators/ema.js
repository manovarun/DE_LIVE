// indicators/ema.js

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

function calculateEMA(values, period) {
  if (!Array.isArray(values)) {
    throw new Error('values must be an array');
  }
  if (!Number.isFinite(Number(period)) || period < 1) {
    throw new Error('period must be a positive integer');
  }

  const p = Number(period);
  const result = new Array(values.length).fill(null);
  const alpha = 2 / (p + 1);

  let sum = 0;
  let emaPrev = null;

  for (let i = 0; i < values.length; i++) {
    const price = Number(values[i]) || 0;

    if (i < p) {
      sum += price;
      if (i === p - 1) {
        emaPrev = sum / p; // SMA seed
        result[i] = emaPrev;
      }
      continue;
    }

    emaPrev = alpha * price + (1 - alpha) * emaPrev;
    result[i] = emaPrev;
  }

  return result;
}

function addEMAsToCandles(candles, { periods, priceField = 'close' } = {}) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error('periods must be a non-empty array');
  }

  const cleanPeriods = periods
    .map((p) => Number(p))
    .filter((p) => Number.isFinite(p) && p >= 1);

  if (cleanPeriods.length === 0) {
    throw new Error(
      'periods must contain at least one valid positive integer.'
    );
  }

  const values = candles.map((c) => Number(c[priceField]) || 0);

  const emaMap = {};
  for (const period of cleanPeriods) {
    emaMap[period] = calculateEMA(values, period);
  }

  const result = candles.map((c, idx) => {
    const emas = {};
    for (const period of cleanPeriods) {
      const v = emaMap[period][idx];
      emas[period] = v !== null ? round(v) : null;
    }
    return {
      ...c,
      emas,
    };
  });

  return result;
}

module.exports = {
  calculateEMA,
  addEMAsToCandles,
};
