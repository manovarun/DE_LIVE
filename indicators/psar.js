// indicators/psar.js

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

/**
 * Calculate Parabolic SAR (PSAR).
 *
 * Standard algorithm:
 *  - Uses step (AF increment) and maxStep (AF cap).
 *  - Tracks trend direction (long/short), extreme point (EP), and acceleration factor (AF).
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {Object} options
 * @param {number} [options.step=0.02] - AF increment
 * @param {number} [options.maxStep=0.2] - AF max cap
 * @returns {(number|null)[]} - PSAR values (same length as highs/lows)
 */
function calculatePSAR(highs, lows, { step = 0.02, maxStep = 0.2 } = {}) {
  const len = Math.min(highs.length, lows.length);
  const psar = new Array(len).fill(null);

  if (len < 2) {
    // Not enough data to compute a meaningful PSAR
    return psar;
  }

  const h = highs.map((v) => Number(v) || 0);
  const l = lows.map((v) => Number(v) || 0);

  // Initial trend direction based on first two bars
  const firstMid = (h[0] + l[0]) / 2;
  const secondMid = (h[1] + l[1]) / 2;
  let isLong = secondMid >= firstMid;

  // Initial extreme point (EP)
  let ep = isLong ? Math.max(h[0], h[1]) : Math.min(l[0], l[1]);

  // Initial acceleration factor (AF)
  let af = step;

  // Initial PSAR (first bar)
  psar[0] = isLong ? l[0] : h[0];

  for (let i = 1; i < len; i++) {
    const prevPsar = psar[i - 1];

    // Basic PSAR formula
    let currPsar = prevPsar + af * (ep - prevPsar);

    if (isLong) {
      // For uptrend, PSAR cannot be above last two lows
      if (i >= 2) {
        currPsar = Math.min(currPsar, l[i - 1], l[i - 2]);
      } else {
        currPsar = Math.min(currPsar, l[i - 1]);
      }

      // Update EP if new high
      if (h[i] > ep) {
        ep = h[i];
        af = Math.min(af + step, maxStep);
      }

      // Check for reversal: price breaks below PSAR
      if (l[i] < currPsar) {
        // Switch to downtrend
        isLong = false;
        currPsar = ep; // On reversal, PSAR resets to previous EP
        ep = l[i]; // New EP is current low
        af = step;
      }
    } else {
      // Downtrend: PSAR cannot be below last two highs
      if (i >= 2) {
        currPsar = Math.max(currPsar, h[i - 1], h[i - 2]);
      } else {
        currPsar = Math.max(currPsar, h[i - 1]);
      }

      // Update EP if new low
      if (l[i] < ep) {
        ep = l[i];
        af = Math.min(af + step, maxStep);
      }

      // Check for reversal: price breaks above PSAR
      if (h[i] > currPsar) {
        // Switch to uptrend
        isLong = true;
        currPsar = ep;
        ep = h[i];
        af = step;
      }
    }

    psar[i] = currPsar;
  }

  return psar;
}

/**
 * Attach PSAR to candles as a single field `psar`.
 *
 * Example output per candle:
 * {
 *   ...candleFields,
 *   psar: 25980.15
 * }
 *
 * @param {Object[]} candles
 * @param {Object} options
 * @param {number} [options.step=0.02]
 * @param {number} [options.maxStep=0.2]
 * @returns {Object[]} new candles array with `psar` added
 */
function addPSARToCandles(candles, { step = 0.02, maxStep = 0.2 } = {}) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }

  const highs = candles.map((c) => Number(c.high) || 0);
  const lows = candles.map((c) => Number(c.low) || 0);

  const psarArr = calculatePSAR(highs, lows, { step, maxStep });

  return candles.map((c, idx) => ({
    ...c,
    psar: psarArr[idx] != null ? round(psarArr[idx]) : null,
  }));
}

module.exports = {
  calculatePSAR,
  addPSARToCandles,
};
