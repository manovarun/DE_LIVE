// indicators/supertrend.js

const DECIMALS = 2;
const round = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

/**
 * True Range series from candle array
 * TR = max(
 *   high - low,
 *   abs(high - prevClose),
 *   abs(low - prevClose)
 * )
 */
function computeTrueRangeSeries(
  candles,
  { highField = 'high', lowField = 'low', closeField = 'close' } = {}
) {
  const len = candles.length;
  const tr = new Array(len).fill(null);

  if (len === 0) return tr;

  for (let i = 0; i < len; i++) {
    const c = candles[i];

    const high = Number(c[highField]);
    const low = Number(c[lowField]);
    const close = Number(c[closeField]);

    if (!Number.isFinite(high) || !Number.isFinite(low)) {
      tr[i] = null;
      continue;
    }

    const prevClose =
      i > 0 && candles[i - 1][closeField] != null
        ? Number(candles[i - 1][closeField])
        : close;

    const range1 = high - low;
    const range2 = Math.abs(high - prevClose);
    const range3 = Math.abs(low - prevClose);

    tr[i] = Math.max(range1, range2, range3);
  }

  return tr;
}

/**
 * ATR series from a precomputed TR series.
 *
 * If useWilder = true => Wilder's ATR (like TradingView atr())
 * If useWilder = false => simple moving average of TR.
 */
function computeATRSeries(tr, period, { useWilder = true } = {}) {
  const len = tr.length;
  const p = Number(period);

  if (!Number.isFinite(p) || p < 1) {
    throw new Error('ATR period must be a positive integer');
  }

  const atr = new Array(len).fill(null);
  if (len === 0) return atr;

  if (useWilder) {
    // Wilder's ATR: first ATR is SMA of first p TRs, then:
    // ATR[i] = (ATR[i-1] * (p - 1) + TR[i]) / p
    let sum = 0;
    let atrPrev = null;

    for (let i = 0; i < len; i++) {
      const trVal = tr[i];
      if (trVal == null) {
        atr[i] = null;
        continue;
      }

      if (i < p) {
        sum += trVal;
        if (i === p - 1) {
          atrPrev = sum / p;
          atr[i] = atrPrev;
        } else {
          atr[i] = null;
        }
      } else {
        atrPrev = (atrPrev * (p - 1) + trVal) / p;
        atr[i] = atrPrev;
      }
    }
  } else {
    // Simple moving average of TR
    let windowSum = 0;
    for (let i = 0; i < len; i++) {
      const trVal = tr[i];
      if (trVal == null) {
        atr[i] = null;
        continue;
      }

      windowSum += trVal;
      if (i >= p) {
        // remove element that falls out of window
        const old = tr[i - p];
        if (old != null) {
          windowSum -= old;
        }
      }

      if (i >= p - 1) {
        atr[i] = windowSum / p;
      } else {
        atr[i] = null;
      }
    }
  }

  return atr;
}

/**
 * Attach Supertrend to candle objects.
 *
 * Mirrors your Pine script:
 *   - ATR Period      -> atrPeriod
 *   - ATR Multiplier  -> multiplier
 *   - Change ATR Calc -> changeAtrCalculation (true => Wilder ATR, false => SMA(TR))
 *   - src = (high + low) / 2  (HL2)
 *
 * For each candle, adds:
 *
 *   supertrend: {
 *     atr: number | null,
 *     upperBand: number | null,   // up
 *     lowerBand: number | null,   // dn
 *     line: number | null,        // active Supertrend line (upper if uptrend, lower if downtrend)
 *     trend: 1 | -1 | null,       // 1 = uptrend, -1 = downtrend
 *     isUpTrend: boolean,
 *     isDownTrend: boolean,
 *     buySignal: boolean,         // trend flipped -1 -> 1 on this bar
 *     sellSignal: boolean         // trend flipped  1 -> -1 on this bar
 *   }
 */
function addSupertrendToCandles(
  candles,
  {
    atrPeriod = 10,
    multiplier = 3.0,
    changeAtrCalculation = true, // true => Wilder ATR, false => SMA(TR)
    highField = 'high',
    lowField = 'low',
    closeField = 'close',
  } = {}
) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }

  const len = candles.length;
  if (len === 0) return candles;

  const p = Number(atrPeriod);
  if (!Number.isFinite(p) || p < 1) {
    throw new Error('atrPeriod must be a positive integer');
  }

  const m = Number(multiplier);
  if (!Number.isFinite(m) || m <= 0) {
    throw new Error('multiplier must be a positive number');
  }

  // --- Precompute TR + ATR ---
  const trSeries = computeTrueRangeSeries(candles, {
    highField,
    lowField,
    closeField,
  });
  const atrSeries = computeATRSeries(trSeries, p, {
    useWilder: !!changeAtrCalculation,
  });

  const up = new Array(len).fill(null);
  const dn = new Array(len).fill(null);
  const trendArr = new Array(len).fill(null); // 1 or -1
  const stLine = new Array(len).fill(null);
  const buySignalArr = new Array(len).fill(false);
  const sellSignalArr = new Array(len).fill(false);

  for (let i = 0; i < len; i++) {
    const c = candles[i];
    const high = Number(c[highField]);
    const low = Number(c[lowField]);
    const close = Number(c[closeField]);
    const atr = atrSeries[i];

    if (
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      atr == null
    ) {
      // Not enough / invalid data yet
      if (i === 0) {
        trendArr[i] = null;
      } else {
        trendArr[i] = trendArr[i - 1];
      }
      up[i] = null;
      dn[i] = null;
      stLine[i] = null;
      continue;
    }

    // src = HL2
    const src = (high + low) / 2;

    // Basic bands for this bar
    const basicUp = src - m * atr;
    const basicDn = src + m * atr;

    if (i === 0) {
      // Seed first bar
      up[i] = basicUp;
      dn[i] = basicDn;
      trendArr[i] = 1; // default uptrend
      stLine[i] = up[i];
      continue;
    }

    const prevClose =
      candles[i - 1][closeField] != null
        ? Number(candles[i - 1][closeField])
        : close;

    const prevUp = up[i - 1] != null ? up[i - 1] : basicUp;
    const prevDn = dn[i - 1] != null ? dn[i - 1] : basicDn;

    // TV logic:
    // up := close[1] > up1 ? max(up, up1) : up
    // dn := close[1] < dn1 ? min(dn, dn1) : dn
    const finalUp = prevClose > prevUp ? Math.max(basicUp, prevUp) : basicUp;
    const finalDn = prevClose < prevDn ? Math.min(basicDn, prevDn) : basicDn;

    up[i] = finalUp;
    dn[i] = finalDn;

    // Trend persistence + flip logic:
    // trend := trend == -1 and close > dn1 ? 1 :
    //           trend == 1 and close < up1 ? -1 :
    //           trend
    let curTrend =
      trendArr[i - 1] === 1 || trendArr[i - 1] === -1 ? trendArr[i - 1] : 1;

    if (curTrend === -1 && close > prevDn) {
      curTrend = 1;
    } else if (curTrend === 1 && close < prevUp) {
      curTrend = -1;
    }

    const prevTrend = trendArr[i - 1];
    trendArr[i] = curTrend;

    if (prevTrend != null) {
      if (curTrend === 1 && prevTrend === -1) {
        buySignalArr[i] = true;
      } else if (curTrend === -1 && prevTrend === 1) {
        sellSignalArr[i] = true;
      }
    }

    // Active Supertrend line for plotting
    stLine[i] = curTrend === 1 ? up[i] : dn[i];
  }

  // Attach to candles (non-mutating)
  const out = candles.map((c, i) => {
    const atr = atrSeries[i];
    const u = up[i];
    const d = dn[i];
    const t = trendArr[i];

    let supertrend = null;

    if (atr != null && u != null && d != null && (t === 1 || t === -1)) {
      supertrend = {
        atr: round(atr),
        upperBand: round(u),
        lowerBand: round(d),
        line: stLine[i] != null ? round(stLine[i]) : null,
        trend: t, // 1 = uptrend, -1 = downtrend
        isUpTrend: t === 1,
        isDownTrend: t === -1,
        buySignal: !!buySignalArr[i],
        sellSignal: !!sellSignalArr[i],
      };
    }

    return {
      ...c,
      supertrend,
    };
  });

  return out;
}

module.exports = {
  addSupertrendToCandles,
};
