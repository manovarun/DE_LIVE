// indicators/macd.js

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

/**
 * Simple EMA calculator for a numeric array.
 * values: number[]
 * period: integer > 0
 *
 * Returns an array same length as values:
 *  - null before EMA is "ready"
 *  - numeric EMA afterwards
 */
function calculateEMA(values, period) {
  const len = values.length;
  const ema = new Array(len).fill(null);
  const p = Number(period);

  if (!Number.isFinite(p) || p <= 0 || len === 0) {
    return ema;
  }

  const k = 2 / (p + 1);
  let sum = 0;
  let start = p - 1;

  if (len < p) {
    return ema;
  }

  // First EMA point: SMA of first `p` values
  for (let i = 0; i < p; i++) {
    sum += values[i];
  }
  ema[start] = sum / p;

  // Subsequent EMA points
  for (let i = start + 1; i < len; i++) {
    const price = values[i];
    ema[i] = ema[i - 1] + k * (price - ema[i - 1]);
  }

  return ema;
}

/**
 * Attach MACD to candles.
 *
 * MACD (12,26,9) style:
 *   macdLine   = EMA(fast) - EMA(slow)
 *   signalLine = EMA(macdLine, signalPeriod)
 *   histogram  = macdLine - signalLine
 *
 * Each candle gets:
 *   macd: {
 *     line: number | null,
 *     signal: number | null,
 *     histogram: number | null
 *   }
 */
function addMACDToCandles(
  candles,
  {
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9,
    priceField = 'close',
  } = {}
) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }

  const len = candles.length;
  if (len === 0) return candles;

  const closes = candles.map((c) => Number(c[priceField]) || 0);

  const fastP = Number(fastPeriod) || 12;
  const slowP = Number(slowPeriod) || 26;
  const signalP = Number(signalPeriod) || 9;

  const fastEMA = calculateEMA(closes, fastP);
  const slowEMA = calculateEMA(closes, slowP);

  const macdLine = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    if (fastEMA[i] != null && slowEMA[i] != null) {
      macdLine[i] = fastEMA[i] - slowEMA[i];
    }
  }

  // Signal line: EMA of macdLine, ignoring initial nulls
  const signal = new Array(len).fill(null);

  let firstMacdIdx = -1;
  for (let i = 0; i < len; i++) {
    if (macdLine[i] != null) {
      firstMacdIdx = i;
      break;
    }
  }

  if (firstMacdIdx >= 0) {
    const available = len - firstMacdIdx;
    if (available >= signalP) {
      // Seed with SMA over first `signalP` MACD values
      let sum = 0;
      const seedStart = firstMacdIdx;
      const seedEnd = firstMacdIdx + signalP; // exclusive

      for (let i = seedStart; i < seedEnd; i++) {
        sum += macdLine[i];
      }
      const seedIdx = seedEnd - 1;
      signal[seedIdx] = sum / signalP;

      const kSig = 2 / (signalP + 1);
      for (let i = seedIdx + 1; i < len; i++) {
        const prev = signal[i - 1];
        const m = macdLine[i];
        if (m == null || prev == null) {
          signal[i] = prev;
        } else {
          signal[i] = prev + kSig * (m - prev);
        }
      }
    }
  }

  const histogram = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const m = macdLine[i];
    const s = signal[i];
    if (m != null && s != null) {
      histogram[i] = m - s;
    }
  }

  // Attach rounded MACD to candles
  return candles.map((c, idx) => {
    const m = macdLine[idx];
    const s = signal[idx];
    const h = histogram[idx];

    let macd = null;
    if (m != null && s != null && h != null) {
      macd = {
        line: round(m),
        signal: round(s),
        histogram: round(h),
      };
    }

    return {
      ...c,
      macd,
    };
  });
}

module.exports = {
  addMACDToCandles,
};
