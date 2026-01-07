// indicators/adx.js

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

/**
 * Attach ADX + DMI (DI+, DI-) to candles.
 *
 * Implementation follows Wilder's DMI:
 *  - TR, +DM, -DM for each bar
 *  - Smoothed TR, +DM, -DM over `period`
 *  - +DI = 100 * (+DM_smoothed / TR_smoothed)
 *  - -DI = 100 * (-DM_smoothed / TR_smoothed)
 *  - DX  = 100 * |+DI - -DI| / (+DI + -DI)
 *  - ADX = smoothed DX over `period`
 *
 * Each candle gets:
 *   adx: {
 *     value: <ADX>,     // trend strength
 *     diPlus: <+DI>,    // DI+
 *     diMinus: <-DI>    // DI-
 *   }
 */
function addADXToCandles(candles, { period = 14 } = {}) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }

  const len = candles.length;
  if (len === 0) return candles;

  const p = Number(period) || 14;
  if (p <= 1) {
    // Not meaningful, just return with null adx
    return candles.map((c) => ({ ...c, adx: null }));
  }

  const highs = candles.map((c) => Number(c.high) || 0);
  const lows = candles.map((c) => Number(c.low) || 0);
  const closes = candles.map((c) => Number(c.close) || 0);

  const tr = new Array(len).fill(0);
  const plusDM = new Array(len).fill(0);
  const minusDM = new Array(len).fill(0);

  for (let i = 0; i < len; i++) {
    if (i === 0) {
      tr[i] = highs[i] - lows[i];
      plusDM[i] = 0;
      minusDM[i] = 0;
      continue;
    }

    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    // True Range (TR)
    const tr1 = highs[i] - lows[i];
    const tr2 = Math.abs(highs[i] - closes[i - 1]);
    const tr3 = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(tr1, tr2, tr3);

    // +DM / -DM
    plusDM[i] = upMove > 0 && upMove > downMove ? upMove : 0;
    minusDM[i] = downMove > 0 && downMove > upMove ? downMove : 0;
  }

  // Wilder smoothing for TR, +DM, -DM
  const trSmooth = new Array(len).fill(null);
  const plusDMSmooth = new Array(len).fill(null);
  const minusDMSmooth = new Array(len).fill(null);

  let trSum = 0;
  let plusDMSum = 0;
  let minusDMSum = 0;

  for (let i = 0; i < len; i++) {
    if (i < p) {
      trSum += tr[i];
      plusDMSum += plusDM[i];
      minusDMSum += minusDM[i];

      if (i === p - 1) {
        trSmooth[i] = trSum;
        plusDMSmooth[i] = plusDMSum;
        minusDMSmooth[i] = minusDMSum;
      }
    } else {
      // Wilder: prev - (prev / p) + current
      trSmooth[i] = trSmooth[i - 1] - trSmooth[i - 1] / p + tr[i];
      plusDMSmooth[i] =
        plusDMSmooth[i - 1] - plusDMSmooth[i - 1] / p + plusDM[i];
      minusDMSmooth[i] =
        minusDMSmooth[i - 1] - minusDMSmooth[i - 1] / p + minusDM[i];
    }
  }

  // DI+ / DI-
  const plusDI = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);

  for (let i = 0; i < len; i++) {
    const trVal = trSmooth[i];
    if (trVal == null || trVal === 0) continue;

    plusDI[i] = (plusDMSmooth[i] * 100) / trVal;
    minusDI[i] = (minusDMSmooth[i] * 100) / trVal;
  }

  // DX
  const dx = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const pd = plusDI[i];
    const md = minusDI[i];

    if (pd == null || md == null) continue;

    const denom = pd + md;
    if (denom === 0) {
      dx[i] = 0;
      continue;
    }

    dx[i] = (Math.abs(pd - md) * 100) / denom;
  }

  // ADX: average of DX over `p`, then Wilder smoothing
  const adx = new Array(len).fill(null);

  let firstDXIdx = -1;
  for (let i = 0; i < len; i++) {
    if (dx[i] != null) {
      firstDXIdx = i;
      break;
    }
  }

  if (firstDXIdx >= 0) {
    // Need at least p DX values to seed ADX
    const adxSeedStart = firstDXIdx;
    const adxSeedEnd = adxSeedStart + p;

    if (adxSeedEnd <= len) {
      let dxSum = 0;
      for (let i = adxSeedStart; i < adxSeedEnd; i++) {
        dxSum += dx[i];
      }
      const seedIdx = adxSeedEnd - 1;
      adx[seedIdx] = dxSum / p;

      // Wilder smoothing for ADX
      for (let i = seedIdx + 1; i < len; i++) {
        adx[i] = (adx[i - 1] * (p - 1) + dx[i]) / p;
      }
    }
  }

  // Attach to candles
  return candles.map((c, idx) => {
    const a = adx[idx];
    const pd = plusDI[idx];
    const md = minusDI[idx];

    let adxObj = null;
    if (a != null && pd != null && md != null) {
      adxObj = {
        value: round(a),
        diPlus: round(pd),
        diMinus: round(md),
      };
    }

    return {
      ...c,
      adx: adxObj,
    };
  });
}

module.exports = {
  addADXToCandles,
};
