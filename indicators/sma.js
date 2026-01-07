// indicators/sma.js

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

/**
 * Calculate Simple Moving Average (SMA) over an array of numeric values.
 */
function calculateSMA(values, period) {
  if (!Array.isArray(values)) {
    throw new Error('values must be an array');
  }
  if (!Number.isFinite(Number(period)) || period < 1) {
    throw new Error('period must be a positive integer');
  }

  const p = Number(period);
  const result = new Array(values.length).fill(null);
  const window = [];
  let rollingSum = 0;

  for (let i = 0; i < values.length; i++) {
    const val = Number(values[i]) || 0;

    window.push(val);
    rollingSum += val;

    if (window.length > p) {
      const removed = window.shift();
      rollingSum -= removed;
    }

    if (window.length === p) {
      result[i] = rollingSum / p;
    }
  }

  return result;
}

/**
 * Add multiple SMAs to candle objects, grouped under `smas` field.
 */
function addSMAsToCandles(candles, { periods, priceField = 'close' } = {}) {
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

  const smaMap = {};
  for (const period of cleanPeriods) {
    smaMap[period] = calculateSMA(values, period);
  }

  const result = candles.map((c, idx) => {
    const smas = {};
    for (const period of cleanPeriods) {
      const v = smaMap[period][idx];
      smas[period] = v !== null ? round(v) : null;
    }
    return {
      ...c,
      smas,
    };
  });

  return result;
}

module.exports = {
  calculateSMA,
  addSMAsToCandles,
};
