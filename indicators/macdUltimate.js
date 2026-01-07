// indicators/macdUltimate.js
//
// CM_MacD_Ult_MTF style indicator (no MTF/security)
// - Standard MACD (EMA fast/slow, SMA signal)
// - Histogram with 4-color state
// - MACD vs Signal relationship + cross detection
// - Extra fields: crossDirection, isBullishCross, isBearishCross

const DECIMALS = 2;
const round2 = (v) =>
  v === null || v === undefined ? null : Number(v.toFixed(DECIMALS));

function emaSeries(values, period) {
  const len = values.length;
  const out = new Array(len).fill(null);
  const p = Number(period) || 1;
  if (p <= 1) {
    for (let i = 0; i < len; i++) {
      const v = values[i];
      out[i] = v == null ? null : Number(v);
    }
    return out;
  }

  const k = 2 / (p + 1);
  let emaPrev = null;

  for (let i = 0; i < len; i++) {
    const vRaw = values[i];
    if (vRaw == null || Number.isNaN(vRaw)) {
      out[i] = null;
      continue;
    }
    const v = Number(vRaw);
    if (emaPrev === null) {
      // seed with first value
      emaPrev = v;
      out[i] = emaPrev;
    } else {
      emaPrev = v * k + emaPrev * (1 - k);
      out[i] = emaPrev;
    }
  }

  return out;
}

function smaSeries(values, period) {
  const len = values.length;
  const out = new Array(len).fill(null);
  const p = Number(period) || 1;
  if (p <= 1) {
    for (let i = 0; i < len; i++) {
      const v = values[i];
      out[i] = v == null ? null : Number(v);
    }
    return out;
  }

  for (let i = 0; i < len; i++) {
    if (i < p - 1) {
      out[i] = null;
      continue;
    }
    let sum = 0;
    let valid = true;
    for (let j = i - p + 1; j <= i; j++) {
      const v = values[j];
      if (v == null) {
        valid = false;
        break;
      }
      sum += v;
    }
    out[i] = valid ? sum / p : null;
  }

  return out;
}

/**
 * Detect cross(prev -> current) like TradingView cross().
 */
function detectCross(prevMacd, prevSignal, curMacd, curSignal) {
  if (
    prevMacd == null ||
    prevSignal == null ||
    curMacd == null ||
    curSignal == null
  ) {
    return false;
  }
  const wasAbove = prevMacd > prevSignal;
  const isAbove = curMacd > curSignal;
  return wasAbove !== isAbove;
}

/**
 * Add CM-style Ultimate MACD info to candles.
 *
 * Options:
 *  - fastPeriod: 12
 *  - slowPeriod: 26
 *  - signalPeriod: 9      (SMA of MACD, like the Pine script)
 *  - priceField: 'close'
 *  - macdColorChange: true   (change MACD line color based on MACD vs signal)
 *  - histColorChange: true   (4-color histogram vs 1-color)
 */
function addUltimateMACDToCandles(
  candles,
  {
    fastPeriod = 12,
    slowPeriod = 26,
    signalPeriod = 9,
    priceField = 'close',
    macdColorChange = true,
    histColorChange = true,
  } = {}
) {
  if (!Array.isArray(candles)) {
    throw new Error('candles must be an array');
  }
  const len = candles.length;
  if (len === 0) return candles;

  const fastP = Number(fastPeriod) || 12;
  const slowP = Number(slowPeriod) || 26;
  const signalP = Number(signalPeriod) || 9;

  const src = candles.map((c) =>
    c[priceField] != null ? Number(c[priceField]) : null
  );

  // --- Standard MACD series ---
  const fast = emaSeries(src, fastP);
  const slow = emaSeries(src, slowP);
  const macd = new Array(len).fill(null);

  for (let i = 0; i < len; i++) {
    if (fast[i] == null || slow[i] == null) {
      macd[i] = null;
    } else {
      macd[i] = fast[i] - slow[i];
    }
  }

  const signal = smaSeries(macd, signalP);
  const hist = new Array(len).fill(null);

  for (let i = 0; i < len; i++) {
    if (macd[i] == null || signal[i] == null) {
      hist[i] = null;
    } else {
      hist[i] = macd[i] - signal[i];
    }
  }

  // --- Attach to candles with states/colors/cross info ---
  const out = candles.map((c, i) => {
    const m = macd[i];
    const s = signal[i];
    const h = hist[i];

    // Histogram classification
    let histState = null;
    let histColor = 'gray';

    if (h != null && i > 0 && hist[i - 1] != null) {
      const prevH = hist[i - 1];

      const histA_IsUp = h > prevH && h > 0;
      const histA_IsDown = h < prevH && h > 0;
      const histB_IsDown = h < prevH && h <= 0;
      const histB_IsUp = h > prevH && h <= 0;

      if (histColorChange) {
        if (histA_IsUp) {
          histState = 'A_UP';
          histColor = 'aqua';
        } else if (histA_IsDown) {
          histState = 'A_DOWN';
          histColor = 'blue';
        } else if (histB_IsDown) {
          histState = 'B_DOWN';
          histColor = 'red';
        } else if (histB_IsUp) {
          histState = 'B_UP';
          histColor = 'maroon';
        } else {
          histState = null;
          histColor = 'yellow';
        }
      } else {
        histColor = 'gray';
      }
    } else {
      histState = null;
      histColor = histColorChange ? 'yellow' : 'gray';
    }

    // MACD vs Signal
    let macdAboveSignal = null;
    let macdColor = 'red';
    let signalColor = 'lime';

    if (m != null && s != null) {
      macdAboveSignal = m >= s;
      if (macdColorChange) {
        macdColor = macdAboveSignal ? 'lime' : 'red';
        signalColor = 'yellow';
      } else {
        macdColor = 'red';
        signalColor = 'lime';
      }
    }

    // Cross + direction
    const prevM = i > 0 ? macd[i - 1] : null;
    const prevS = i > 0 ? signal[i - 1] : null;
    const cross = detectCross(prevM, prevS, m, s);

    let crossDirection = null; // 'UP' | 'DOWN' | null
    let isBullishCross = false;
    let isBearishCross = false;

    if (cross && prevM != null && prevS != null && m != null && s != null) {
      const prevAbove = prevM >= prevS;
      const curAbove = m >= s;

      if (!prevAbove && curAbove) {
        crossDirection = 'UP';
        isBullishCross = true;
      } else if (prevAbove && !curAbove) {
        crossDirection = 'DOWN';
        isBearishCross = true;
      }
    }

    return {
      ...c,
      ultimateMacd: {
        macd: m != null ? round2(m) : null,
        signal: s != null ? round2(s) : null,
        hist: h != null ? round2(h) : null,
        histState, // 'A_UP' | 'A_DOWN' | 'B_UP' | 'B_DOWN' | null
        histColor, // 'aqua' | 'blue' | 'red' | 'maroon' | 'yellow' | 'gray'
        macdAboveSignal,
        macdColor,
        signalColor,
        cross,
        crossDirection, // 'UP' (bullish) | 'DOWN' (bearish) | null
        isBullishCross,
        isBearishCross,
      },
    };
  });

  return out;
}

module.exports = {
  addUltimateMACDToCandles,
};
