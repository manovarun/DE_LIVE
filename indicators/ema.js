// indicators/ema.js

const isFiniteNumber = (v) => Number.isFinite(Number(v));

function toPositiveInteger(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function calculateEMA(values, period) {
  if (!Array.isArray(values)) {
    throw new Error('values must be an array');
  }
  const p = toPositiveInteger(period, 'period');
  if (values.some((v) => !isFiniteNumber(v))) {
    throw new Error('values must contain only finite numbers');
  }
  const result = new Array(values.length).fill(null);
  const alpha = 2 / (p + 1);

  let sum = 0;
  let emaPrev = null;

  for (let i = 0; i < values.length; i++) {
    const price = Number(values[i]);

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

function addEMAsToCandles(
  candles,
  { periods, priceField = 'close', decimals = null } = {},
) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new Error('periods must be a non-empty array');
  }

  const cleanPeriods = periods
    .map((p) => toPositiveInteger(p, 'period'))
    .filter((p, idx, arr) => arr.indexOf(p) === idx);

  if (cleanPeriods.length === 0) {
    throw new Error(
      'periods must contain at least one valid positive integer.'
    );
  }

  const values = candles.map((c, idx) => {
    const v = Number(c?.[priceField]);
    if (!Number.isFinite(v)) {
      throw new Error(
        `candles[${idx}].${priceField} must be a finite number for EMA calculation`,
      );
    }
    return v;
  });

  const useRounding =
    decimals !== null &&
    decimals !== undefined &&
    Number.isInteger(Number(decimals)) &&
    Number(decimals) >= 0;
  const round = (v) =>
    v === null || v === undefined
      ? null
      : useRounding
        ? Number(v.toFixed(Number(decimals)))
        : v;

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
