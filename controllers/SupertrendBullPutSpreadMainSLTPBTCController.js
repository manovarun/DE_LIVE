const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const { addSupertrendToCandles } = require('../indicators/supertrend');

// -----------------------------------------------------------------------------
// BTC / Delta Collections
// -----------------------------------------------------------------------------
const DEFAULT_TZ = process.env.DELTA_TZ || 'Asia/Kolkata';

const FUT_CANDLES_COLL =
  process.env.DELTA_FUT_CANDLES_COLL || 'btcusd_candles_ts';
const OPT_TICKS_COLL = process.env.DELTA_OPT_TICKS_COLL || 'delta_options_ts';

const VERBOSE = true;

// -----------------------------------------------------------------------------
// Generic helpers
// -----------------------------------------------------------------------------
function num(x, def = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : def;
}

function toTZISO(dateLike, tz = DEFAULT_TZ) {
  if (!dateLike) return null;
  return moment(dateLike).tz(tz).format('YYYY-MM-DDTHH:mm:ssZ');
}

function parseExpiryToYYYYMMDD(expiry) {
  if (!expiry) return null;
  const s = String(expiry).trim();

  // Delta meta.expiry is "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // Backward compatible (your NIFTY controllers used DDMMMYYYY)
  // e.g., "08JAN2026" -> "2026-01-08"
  const m = moment.tz(s, 'DDMMMYYYY', DEFAULT_TZ);
  if (m.isValid()) return m.format('YYYY-MM-DD');

  return null;
}

// M1/M5/M30/H1/H4/D1 support (for warmup + candle routing)
function parseIntervalSpec(interval) {
  const s = String(interval || '')
    .trim()
    .toUpperCase();

  let m = s.match(/^M(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`Invalid interval "${interval}"`);
    return { unit: 'minute', binSize: n, minutes: n };
  }

  m = s.match(/^H(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`Invalid interval "${interval}"`);
    return { unit: 'hour', binSize: n, minutes: 60 * n };
  }

  m = s.match(/^D(\d+)$/);
  if (m) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0)
      throw new Error(`Invalid interval "${interval}"`);
    return { unit: 'day', binSize: n, minutes: 1440 * n };
  }

  throw new Error(
    `Unsupported interval "${interval}". Use M<n>, H<n>, D<n> (e.g., M5, M30, H1, D1).`
  );
}

// Hardened intraday time parser "HH:mm" or "HH:mm:ss"
function parseTZIntraday(dateStrYYYYMMDD, timeStr, tz = DEFAULT_TZ) {
  const raw = timeStr == null ? '' : String(timeStr);
  const t = raw.split(',')[0].trim();
  const timePart = t || '00:00:00';
  return moment.tz(
    `${dateStrYYYYMMDD} ${timePart}`,
    ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm'],
    tz
  );
}

// -----------------------------------------------------------------------------
// Supertrend direction helper (compatible with your existing style)
// -----------------------------------------------------------------------------
function getSupertrendDirection(candle) {
  const st = candle && candle.supertrend ? candle.supertrend : null;
  if (!st) return null;

  if (typeof st.isUpTrend === 'boolean') return st.isUpTrend ? 'UP' : 'DOWN';
  if (typeof st.inUptrend === 'boolean') return st.inUptrend ? 'UP' : 'DOWN';
  if (typeof st.inUpTrend === 'boolean') return st.inUpTrend ? 'UP' : 'DOWN';
  if (typeof st.upTrend === 'boolean') return st.upTrend ? 'UP' : 'DOWN';
  if (typeof st.isBullish === 'boolean') return st.isBullish ? 'UP' : 'DOWN';
  if (typeof st.isBearish === 'boolean') return st.isBearish ? 'DOWN' : 'UP';

  if (typeof st.trend === 'string') {
    const t = st.trend.toUpperCase();
    if (t.includes('UP')) return 'UP';
    if (t.includes('DOWN')) return 'DOWN';
  }

  if (typeof st.direction === 'string') {
    const d = st.direction.toUpperCase();
    if (d.includes('UP')) return 'UP';
    if (d.includes('DOWN')) return 'DOWN';
  }

  // fallback: close vs st.line
  const line = num(st.line, NaN);
  const close = num(candle && candle.close, NaN);
  if (Number.isFinite(line) && Number.isFinite(close)) {
    return close >= line ? 'UP' : 'DOWN';
  }

  return null;
}

// -----------------------------------------------------------------------------
// DB helpers for DELTA option ticks (time-series)
// Fields: ts (Date), meta.instrument, meta.option_type ("P"/"C"), meta.strike, meta.expiry, price
// -----------------------------------------------------------------------------
async function lastTickOnOrBefore(optColl, instrument, atUTC) {
  // NOTE: With mongoose's native collection driver, findOne() does NOT support .sort().
  // Use find().sort().limit(1).next() instead.
  return await optColl
    .find(
      { 'meta.instrument': instrument, ts: { $lte: atUTC } },
      { projection: { ts: 1, price: 1 } }
    )
    .sort({ ts: -1 })
    .limit(1)
    .next();
}

async function firstTickBetween(optColl, instrument, fromUTC, toUTC) {
  return await optColl
    .find(
      { 'meta.instrument': instrument, ts: { $gte: fromUTC, $lte: toUTC } },
      { projection: { ts: 1, price: 1 } }
    )
    .sort({ ts: 1 })
    .limit(1)
    .next();
}

// Faster SL/TP hit: two indexed queries (no full scan)
async function firstHitShortSLTP(
  optColl,
  instrument,
  fromUTC,
  toUTC,
  stopLossPrice,
  targetPrice
) {
  const hasSL = stopLossPrice != null && Number.isFinite(Number(stopLossPrice));
  const hasTP = targetPrice != null && Number.isFinite(Number(targetPrice));
  if (!hasSL && !hasTP) return null;

  const baseQ = {
    'meta.instrument': instrument,
    ts: { $gte: fromUTC, $lte: toUTC },
  };

  const [slHit, tpHit] = await Promise.all([
    hasSL
      ? optColl
          .find(
            { ...baseQ, price: { $gte: Number(stopLossPrice) } },
            { projection: { ts: 1, price: 1 } }
          )
          .sort({ ts: 1 })
          .limit(1)
          .next()
      : null,
    hasTP
      ? optColl
          .find(
            { ...baseQ, price: { $lte: Number(targetPrice) } },
            { projection: { ts: 1, price: 1 } }
          )
          .sort({ ts: 1 })
          .limit(1)
          .next()
      : null,
  ]);

  if (!slHit && !tpHit) return null;
  if (slHit && !tpHit) return { reason: 'STOPLOSS_HIT_MAIN', tick: slHit };
  if (!slHit && tpHit) return { reason: 'TARGET_HIT_MAIN', tick: tpHit };

  // both exist -> choose earliest
  return slHit.ts <= tpHit.ts
    ? { reason: 'STOPLOSS_HIT_MAIN', tick: slHit }
    : { reason: 'TARGET_HIT_MAIN', tick: tpHit };
}

// -----------------------------------------------------------------------------
// Option chain discovery (from ticks) for a given expiry + date window
// Returns arrays: puts [{strike,instrument}], calls [{strike,instrument}]
// -----------------------------------------------------------------------------
async function fetchOptionChainFromTicks({
  optColl,
  asset = 'BTC',
  currency = 'USD',
  expiryYYYYMMDD,
  fromUTC,
  toUTC,
}) {
  const match = {
    'meta.contract_type': 'OPT',
    'meta.asset': asset,
    'meta.currency': currency,
    'meta.expiry': expiryYYYYMMDD,
    ts: { $gte: fromUTC, $lte: toUTC },
  };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: '$meta.instrument',
        strike: { $first: '$meta.strike' },
        option_type: { $first: '$meta.option_type' },
      },
    },
    {
      $project: {
        _id: 0,
        instrument: '$_id',
        strike: 1,
        option_type: 1,
      },
    },
  ];

  const rows = await optColl
    .aggregate(pipeline, { allowDiskUse: true })
    .toArray();

  const puts = [];
  const calls = [];
  for (const r of rows) {
    const strike = num(r.strike, NaN);
    if (!Number.isFinite(strike)) continue;
    const inst = String(r.instrument || '').trim();
    const ot = String(r.option_type || '')
      .trim()
      .toUpperCase();
    if (!inst || (ot !== 'P' && ot !== 'C')) continue;

    if (ot === 'P') puts.push({ strike, instrument: inst });
    else calls.push({ strike, instrument: inst });
  }

  puts.sort((a, b) => a.strike - b.strike);
  calls.sort((a, b) => a.strike - b.strike);

  return { puts, calls };
}

// -----------------------------------------------------------------------------
// AUTO expiry picker (daily expiry) from option ticks
// - meta.expiry is expected to be "YYYY-MM-DD"
// - daysOut=0 means same-day expiry, daysOut=1 means next-day expiry
// -----------------------------------------------------------------------------
async function pickAutoExpiryForEntry({
  optColl,
  asset = 'BTC',
  currency = 'USD',
  entryUTC,
  daysOut = 0,
  lookaheadDays = 14,
}) {
  const entry = moment(entryUTC).utc();
  if (!entry.isValid()) return null;

  const baseDate = entry
    .clone()
    .startOf('day')
    .add(Number(daysOut) || 0, 'day')
    .format('YYYY-MM-DD');
  const maxDate = entry
    .clone()
    .startOf('day')
    .add((Number(daysOut) || 0) + (Number(lookaheadDays) || 14), 'day')
    .format('YYYY-MM-DD');

  // Prefer expiries that have ticks around entry time (tight window first)
  const w1From = new Date(entryUTC.getTime() - 5 * 60 * 1000);
  const w1To = new Date(entryUTC.getTime() + 5 * 60 * 1000);

  let expiries = await optColl.distinct('meta.expiry', {
    'meta.contract_type': 'OPT',
    'meta.asset': asset,
    'meta.currency': currency,
    'meta.expiry': { $gte: baseDate, $lte: maxDate },
    ts: { $gte: w1From, $lte: w1To },
  });

  // If nothing in +/-5 minutes, widen to the UTC day window
  if (!expiries || !expiries.length) {
    const dayFrom = entry.clone().startOf('day').toDate();
    const dayTo = entry.clone().endOf('day').toDate();
    expiries = await optColl.distinct('meta.expiry', {
      'meta.contract_type': 'OPT',
      'meta.asset': asset,
      'meta.currency': currency,
      'meta.expiry': { $gte: baseDate, $lte: maxDate },
      ts: { $gte: dayFrom, $lte: dayTo },
    });
  }

  expiries = (expiries || []).filter((e) =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(e))
  );
  expiries.sort(); // lexical works for YYYY-MM-DD

  if (!expiries.length) return null;
  if (expiries.includes(baseDate)) return baseDate;

  // nearest available expiry on/after baseDate
  return expiries[0];
}

// ATM selection for PUT ladder (prefer strike <= underlying on tie)
function pickAtmPutIndex(puts, underlying) {
  if (!Array.isArray(puts) || !puts.length) return -1;
  if (!Number.isFinite(underlying)) return -1;

  let bestIdx = 0;
  let bestDiff = Math.abs(puts[0].strike - underlying);

  for (let i = 1; i < puts.length; i += 1) {
    const d = Math.abs(puts[i].strike - underlying);
    if (d < bestDiff) {
      bestDiff = d;
      bestIdx = i;
    } else if (d === bestDiff) {
      // tie-break: prefer <= underlying for ATM-puts ladder
      const aLe = puts[bestIdx].strike <= underlying ? 1 : 0;
      const bLe = puts[i].strike <= underlying ? 1 : 0;
      if (bLe > aLe) bestIdx = i;
    }
  }

  return bestIdx;
}

// PE ladder rules (ascending strikes):
//   ITM: higher strikes => atmIndex + steps
//   OTM: lower strikes  => atmIndex - steps
function parseMoneynessSpec(spec, defaultType = 'ATM', defaultSteps = 0) {
  if (!spec) return { type: defaultType, steps: defaultSteps, raw: null };

  const s = String(spec).toUpperCase().trim();
  if (s === 'ATM' || s === 'ATM0') return { type: 'ATM', steps: 0, raw: s };

  const m = s.match(/^(ATM|ITM|OTM)(\d+)?$/);
  if (!m) return { type: defaultType, steps: defaultSteps, raw: s };

  const type = m[1];
  const steps = m[2] != null ? parseInt(m[2], 10) : type === 'ATM' ? 0 : 1;
  return { type, steps, raw: s };
}

function pickPutByMoneyness(puts, atmIndex, spec, legLabel) {
  const parsed = parseMoneynessSpec(spec);
  const { type, steps, raw } = parsed;

  let idx = atmIndex;
  if (type === 'ITM') idx = atmIndex + steps;
  else if (type === 'OTM') idx = atmIndex - steps;

  if (idx < 0 || idx >= puts.length) {
    return {
      inst: null,
      parsed,
      reason: `${legLabel}_MONEYNESS_OUT_OF_RANGE_${raw || ''}`.trim(),
    };
  }

  return { inst: puts[idx], parsed, reason: null };
}

// -----------------------------------------------------------------------------
// Build Supertrend candles from BTCUSD futures candles collection
// -----------------------------------------------------------------------------
async function buildBtcFuturesSupertrendByDate({
  db,
  fromDate,
  toDate,
  stockSymbol = 'BTCUSD',
  timeInterval = 'M5',
  fromTime = '00:00',
  toTime = '23:59',
  weekDays,
  timezone = DEFAULT_TZ,
  atrPeriod = 10,
  multiplier = 3,
  changeAtrCalculation = true,
}) {
  if (!fromDate || !toDate || !stockSymbol) {
    throw new Error(
      'fromDate, toDate, stockSymbol are required for BTC Supertrend map.'
    );
  }

  const fromDay = moment.tz(fromDate, 'YYYY-MM-DD', timezone);
  const toDay = moment.tz(toDate, 'YYYY-MM-DD', timezone);
  if (!fromDay.isValid() || !toDay.isValid())
    throw new Error('fromDate/toDate must be YYYY-MM-DD.');
  if (toDay.isBefore(fromDay, 'day'))
    throw new Error('toDate must be on or after fromDate.');

  const analysisFrom = parseTZIntraday(fromDate, fromTime, timezone);
  const analysisTo = parseTZIntraday(toDate, toTime, timezone);
  if (!analysisFrom.isValid() || !analysisTo.isValid())
    throw new Error('Invalid fromTime/toTime.');
  if (analysisTo.isBefore(analysisFrom))
    throw new Error('toDate/toTime must be on or after fromDate/fromTime.');

  const { minutes: tfMins } = parseIntervalSpec(timeInterval);
  const atrP = Number(atrPeriod) || 10;
  const warmupMinutes = Math.max(0, (atrP - 1) * tfMins);
  const warmupFrom = analysisFrom.clone().subtract(warmupMinutes, 'minutes');

  const warmupFromUTC = warmupFrom.clone().utc().toDate();
  const analysisToUTC = analysisTo.clone().utc().toDate();

  // Returnable debug context (included in API response) so you can diagnose
  // date range / timezone / collection issues without only relying on server logs.
  const debug = {
    stockSymbol,
    timeInterval,
    timezone,
    atrPeriod: atrP,
    multiplier,
    changeAtrCalculation,
    analysisFromIST: analysisFrom.format('YYYY-MM-DDTHH:mm:ssZ'),
    analysisToIST: analysisTo.format('YYYY-MM-DDTHH:mm:ssZ'),
    warmupFromIST: warmupFrom.format('YYYY-MM-DDTHH:mm:ssZ'),
    analysisFromUTC: analysisFrom.clone().utc().toISOString(),
    analysisToUTC: analysisTo.clone().utc().toISOString(),
    warmupFromUTC: warmupFrom.clone().utc().toISOString(),
    collection: FUT_CANDLES_COLL,
  };

  if (VERBOSE) {
    console.log(
      `[BTC_ST] stockSymbol=${stockSymbol} tf=${timeInterval} warmupFrom=${warmupFrom.format()} analysisTo=${analysisTo.format()} atrPeriod=${atrP} multiplier=${multiplier}`
    );
  }

  const candles = await db
    .collection(FUT_CANDLES_COLL)
    .find(
      {
        stockSymbol,
        timeInterval,
        ts: { $gte: warmupFromUTC, $lte: analysisToUTC },
      },
      {
        projection: {
          ts: 1,
          datetime: 1,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          trades: 1,
          stockName: 1,
          stockSymbol: 1,
        },
      }
    )
    .sort({ ts: 1 })
    .toArray();

  debug.queryMatchedCandles = candles ? candles.length : 0;

  if (!candles || !candles.length) {
    if (VERBOSE) {
      console.log(`[BTC_ST] No BTC candles found in warmup range.`);
      try {
        const coll = db.collection(FUT_CANDLES_COLL);

        // Does the collection even exist in this DB?
        let exists = null;
        try {
          exists = await db
            .listCollections({ name: FUT_CANDLES_COLL })
            .hasNext();
        } catch (_) {
          exists = null;
        }
        debug.collectionExists = exists;

        // How many docs in the candles collection (rough)?
        let estCount = null;
        try {
          estCount = await coll.estimatedDocumentCount();
        } catch (_) {
          estCount = null;
        }
        debug.collectionEstimatedCount = estCount;

        // Counts for requested symbol / symbol+tf
        let countSym = null;
        let countSymTf = null;
        try {
          countSym = await coll.countDocuments({ stockSymbol });
        } catch (_) {
          countSym = null;
        }
        try {
          countSymTf = await coll.countDocuments({ stockSymbol, timeInterval });
        } catch (_) {
          countSymTf = null;
        }
        debug.countForSymbol = countSym;
        debug.countForSymbolTimeInterval = countSymTf;

        // Available range for requested symbol+tf
        const first = await coll
          .find(
            { stockSymbol, timeInterval },
            { projection: { ts: 1, datetime: 1 } }
          )
          .sort({ ts: 1 })
          .limit(1)
          .next();

        const last = await coll
          .find(
            { stockSymbol, timeInterval },
            { projection: { ts: 1, datetime: 1 } }
          )
          .sort({ ts: -1 })
          .limit(1)
          .next();

        debug.availableRange = {
          firstTs: first?.ts ? first.ts.toISOString() : null,
          lastTs: last?.ts ? last.ts.toISOString() : null,
        };

        // Overall sample range (unfiltered) - helps detect DB/collection mismatch
        const anyFirst = await coll
          .find(
            {},
            {
              projection: {
                ts: 1,
                datetime: 1,
                stockSymbol: 1,
                timeInterval: 1,
              },
            }
          )
          .sort({ ts: 1 })
          .limit(1)
          .next();

        const anyLast = await coll
          .find(
            {},
            {
              projection: {
                ts: 1,
                datetime: 1,
                stockSymbol: 1,
                timeInterval: 1,
              },
            }
          )
          .sort({ ts: -1 })
          .limit(1)
          .next();

        debug.anyRange = {
          first: anyFirst
            ? {
                ts: anyFirst.ts ? anyFirst.ts.toISOString() : null,
                stockSymbol: anyFirst.stockSymbol || null,
                timeInterval: anyFirst.timeInterval || null,
              }
            : null,
          last: anyLast
            ? {
                ts: anyLast.ts ? anyLast.ts.toISOString() : null,
                stockSymbol: anyLast.stockSymbol || null,
                timeInterval: anyLast.timeInterval || null,
              }
            : null,
        };

        // Sample distinct symbols / timeIntervals (limited) for quick inspection
        try {
          const symRows = await coll
            .aggregate([{ $group: { _id: '$stockSymbol' } }, { $limit: 25 }], {
              allowDiskUse: true,
            })
            .toArray();
          debug.symbolsSample = symRows.map((r) => r._id).filter(Boolean);
        } catch (_) {
          debug.symbolsSample = [];
        }

        try {
          const tfRows = await coll
            .aggregate(
              [
                { $match: { stockSymbol } },
                { $group: { _id: '$timeInterval' } },
                { $limit: 25 },
              ],
              { allowDiskUse: true }
            )
            .toArray();
          debug.timeIntervalsForSymbolSample = tfRows
            .map((r) => r._id)
            .filter(Boolean);
        } catch (_) {
          debug.timeIntervalsForSymbolSample = [];
        }

        console.log(
          `[BTC_ST] Available candle range for ${stockSymbol} ${timeInterval}: ${
            first?.ts || 'NA'
          } -> ${
            last?.ts || 'NA'
          } | collExists=${exists} estCount=${estCount} countSym=${countSym} countSymTf=${countSymTf}`
        );
      } catch (e) {
        console.log(`[BTC_ST] Range lookup failed: ${e?.message || e}`);
        debug.availableRangeError = e?.message || String(e);
      }
    }
    return { candlesByDate: {}, rawCandles: [], debug };
  }

  // Ensure "datetime" exists for indicator libs; prefer stored datetime, else derive from ts
  const candlesNorm = candles.map((c) => ({
    ...c,
    datetime:
      c.datetime || moment(c.ts).tz(timezone).format('YYYY-MM-DDTHH:mm:ssZ'),
  }));

  const candlesWith = addSupertrendToCandles(candlesNorm, {
    atrPeriod: atrP,
    multiplier,
    changeAtrCalculation,
    highField: 'high',
    lowField: 'low',
    closeField: 'close',
  });

  const weekDaysNorm = Array.isArray(weekDays)
    ? weekDays.map((d) => String(d).trim().toUpperCase())
    : [];

  const candlesByDate = {};
  for (const c of candlesWith) {
    const m = moment(c.ts).tz(timezone);

    const inWeekDay =
      weekDaysNorm.length === 0 ||
      weekDaysNorm.includes(m.format('ddd').toUpperCase());

    const inRange =
      m.isSameOrAfter(analysisFrom) && m.isSameOrBefore(analysisTo);
    if (!inWeekDay || !inRange) continue;

    const dateKey = m.format('YYYY-MM-DD');
    if (!candlesByDate[dateKey]) candlesByDate[dateKey] = [];

    candlesByDate[dateKey].push({
      ...c,
      datetimeIST: m.format('YYYY-MM-DDTHH:mm:ssZ'),
    });
  }

  return { candlesByDate, rawCandles: candlesWith, debug };
}

// -----------------------------------------------------------------------------
// Single-run executor: BTC Supertrend Bull Put Spread
// -----------------------------------------------------------------------------
async function runSupertrendBullPutSingleRunBTC(params) {
  const {
    fromDate,
    toDate,

    stockSymbol = 'BTCUSD',
    stockName = 'BTC',
    expiry, // expected "YYYY-MM-DD" (Delta) but DDMMMYYYY accepted too
    expiryMode = 'FIXED',
    expiryDaysOut = 0,
    expiryLookaheadDays = 14,

    timeInterval = 'M5',
    fromTime = '00:00',
    toTime = '23:59',
    weekDays,
    timezone = DEFAULT_TZ,

    // legs
    mainMoneyness = 'OTM1',
    hedgeMoneyness = 'OTM3',

    // risk on MAIN short leg
    stopLossPct = 30,
    targetPct = 30,

    // supertrend params
    atrPeriod = 10,
    multiplier = 3,
    changeAtrCalculation = true,

    // trading controls
    maxTradesPerDay,
    entryMode = 'signal_or_trend',

    // PnL sizing (Delta contract multiplier varies; default=1 gives points-based PnL)
    qty = 1,

    // Optional time exit candle, e.g. "23:30". If not present, last candle is used when no sellSignal.
    timeExitHHmm,
  } = params || {};

  const TAG = 'BTC_ST_BPS';

  if (!fromDate || !toDate) {
    throw new Error('fromDate and toDate are required.');
  }

  const expiryModeNorm = String(expiryMode || 'FIXED')
    .trim()
    .toUpperCase();
  if (expiryModeNorm !== 'FIXED' && expiryModeNorm !== 'AUTO_DAILY') {
    throw new Error(
      `Unsupported expiryMode "${expiryMode}". Use "FIXED" or "AUTO_DAILY".`
    );
  }

  const expiryFixed =
    expiryModeNorm === 'FIXED' ? parseExpiryToYYYYMMDD(expiry) : null;

  if (expiryModeNorm === 'FIXED' && !expiryFixed) {
    throw new Error(
      `Invalid expiry "${expiry}". Use YYYY-MM-DD (recommended) or DDMMMYYYY.`
    );
  }

  const maxTradesPerDayNum =
    maxTradesPerDay != null &&
    Number.isFinite(Number(maxTradesPerDay)) &&
    Number(maxTradesPerDay) > 0
      ? Number(maxTradesPerDay)
      : Infinity;

  const db = mongoose.connection.db;
  if (!db)
    throw new Error(
      'MongoDB not connected (mongoose.connection.db is missing).'
    );

  const optColl = db.collection(OPT_TICKS_COLL);

  // Build ST candles from futures candles
  const { candlesByDate, debug: candlesDebug } =
    await buildBtcFuturesSupertrendByDate({
      db,
      fromDate,
      toDate,
      stockSymbol,
      timeInterval,
      fromTime,
      toTime,
      weekDays,
      timezone,
      atrPeriod,
      multiplier,
      changeAtrCalculation,
    });

  if (VERBOSE && candlesDebug) {
    console.log(`[${TAG}] Candles debug:`, candlesDebug);
  }

  // Determine full analysis UTC bounds (for option chain discovery)
  const analysisFrom = parseTZIntraday(fromDate, fromTime, timezone);
  const analysisTo = parseTZIntraday(toDate, toTime, timezone);
  const analysisFromUTC = analysisFrom.clone().utc().toDate();
  const analysisToUTC = analysisTo.clone().utc().toDate();
  // Option chain cache per expiry for this run (computed from option ticks)
  const optionChainCache = new Map();

  const getPutsForExpiry = async (expiryYMD) => {
    if (!expiryYMD) return [];
    if (optionChainCache.has(expiryYMD)) return optionChainCache.get(expiryYMD);

    const { puts } = await fetchOptionChainFromTicks({
      optColl,
      asset: stockName,
      currency: 'USD',
      expiryYYYYMMDD: expiryYMD,
      fromUTC: analysisFromUTC,
      toUTC: analysisToUTC,
    });

    optionChainCache.set(expiryYMD, puts || []);
    return puts || [];
  };

  // If FIXED expiry, prefetch chain once so we can fast-fail per day if missing
  let putsFixed = null;
  if (expiryModeNorm === 'FIXED') {
    putsFixed = await getPutsForExpiry(expiryFixed);
    if (!putsFixed.length && VERBOSE) {
      console.log(
        `[${TAG}] No PUT instruments found in delta_options_ts for expiry=${expiryFixed}.`
      );
    }
  }

  const results = [];
  let totalTrades = 0;
  let wins = 0;
  let losses = 0;
  let cumulativePnL = 0;

  const fromDateMoment = moment.tz(fromDate, 'YYYY-MM-DD', timezone);
  const toDateMoment = moment.tz(toDate, 'YYYY-MM-DD', timezone);

  for (
    let d = fromDateMoment.clone();
    d.isSameOrBefore(toDateMoment, 'day');
    d.add(1, 'day')
  ) {
    const currentDate = d.format('YYYY-MM-DD');
    const dayCandles = candlesByDate[currentDate] || [];

    if (VERBOSE) {
      let buys = 0;
      let sells = 0;
      dayCandles.forEach((c) => {
        const st = c.supertrend || {};
        if (st.buySignal) buys += 1;
        if (st.sellSignal) sells += 1;
      });
      console.log(
        `[${TAG}_DAY] date=${currentDate} candles=${dayCandles.length} buySignals=${buys} sellSignals=${sells}`
      );
    }

    if (!dayCandles.length) {
      results.push({
        date: currentDate,
        trade: { took: false, reason: 'NO_FUT_CANDLES' },
        meta: { stockSymbol, timeInterval },
      });
      continue;
    }
    if (expiryModeNorm === 'FIXED' && (!putsFixed || !putsFixed.length)) {
      results.push({
        date: currentDate,
        trade: { took: false, reason: 'NO_PUT_CHAIN' },
        meta: { expiry: expiryFixed, stockSymbol, timeInterval },
      });
      continue;
    }

    let tradesForDay = 0;
    let scanStartIdx = 0;

    while (scanStartIdx < dayCandles.length) {
      if (tradesForDay >= maxTradesPerDayNum) break;

      // Entry: first buySignal after scanStartIdx
      let entryIdx = dayCandles.findIndex(
        (c, idx) =>
          idx >= scanStartIdx && c?.supertrend && !!c.supertrend.buySignal
      );
      let entryReasonTag = 'SUPERTREND_BUY_SIGNAL';

      // Fallback: if no buySignal but trend already UP (only for first trade of the day)
      if (
        entryIdx === -1 &&
        String(entryMode || '').toLowerCase() === 'signal_or_trend' &&
        tradesForDay === 0
      ) {
        const fallbackIdx = dayCandles.findIndex(
          (c, idx) => idx >= scanStartIdx && getSupertrendDirection(c) === 'UP'
        );
        if (fallbackIdx !== -1) {
          entryIdx = fallbackIdx;
          entryReasonTag = 'SUPERTREND_UPTREND_NO_BUY_SIGNAL';
        }
      }

      if (entryIdx === -1) {
        if (tradesForDay === 0) {
          results.push({
            date: currentDate,
            trade: { took: false, reason: 'NO_ENTRY_SIGNAL' },
            meta: { entryMode, stockSymbol, timeInterval },
          });
        }
        break;
      }

      // Exit: first sellSignal after entry; else timeExitHHmm candle; else last candle
      let exitIdx = dayCandles.findIndex(
        (c, idx) => idx > entryIdx && c?.supertrend && !!c.supertrend.sellSignal
      );
      let exitByTimeFallback = false;

      if (exitIdx === -1) {
        let fallbackIdx = -1;

        if (timeExitHHmm) {
          for (let i = dayCandles.length - 1; i > entryIdx; i -= 1) {
            const hhmm = moment(dayCandles[i].ts).tz(timezone).format('HH:mm');
            if (hhmm === String(timeExitHHmm)) {
              fallbackIdx = i;
              break;
            }
          }
        }

        if (fallbackIdx === -1 && dayCandles.length - 1 > entryIdx)
          fallbackIdx = dayCandles.length - 1;
        if (fallbackIdx === -1) break;

        exitIdx = fallbackIdx;
        exitByTimeFallback = true;
      }

      const entryCandle = dayCandles[entryIdx];
      const exitCandle = dayCandles[exitIdx];

      const entryIST = moment(entryCandle.ts).tz(timezone);
      const plannedExitIST = moment(exitCandle.ts).tz(timezone);

      if (!plannedExitIST.isAfter(entryIST)) {
        scanStartIdx = exitIdx + 1;
        continue;
      }

      const underlyingPrice = num(entryCandle.close, NaN);
      if (!Number.isFinite(underlyingPrice)) {
        results.push({
          date: currentDate,
          indexSignals: {
            entry: { datetimeIST: entryCandle.datetimeIST },
            exit: { datetimeIST: exitCandle.datetimeIST },
          },
          trade: { took: false, reason: 'NO_UNDERLYING_CLOSE' },
        });
        scanStartIdx = exitIdx + 1;
        continue;
      }

      const entryUTC = entryIST.clone().utc().toDate();
      const plannedExitUTC = plannedExitIST.clone().utc().toDate();

      // Resolve expiry (fixed or auto-daily) for this entry and fetch PUT chain
      let expiryUsed = expiryFixed;

      if (expiryModeNorm === 'AUTO_DAILY') {
        expiryUsed = await pickAutoExpiryForEntry({
          optColl,
          asset: stockName,
          currency: 'USD',
          entryUTC,
          daysOut: expiryDaysOut,
          lookaheadDays: expiryLookaheadDays,
        });

        if (!expiryUsed) {
          results.push({
            date: currentDate,
            trade: { took: false, reason: 'NO_AUTO_EXPIRY_FOUND' },
            meta: {
              stockSymbol,
              timeInterval,
              expiryMode: expiryModeNorm,
              expiryDaysOut,
              expiryLookaheadDays,
            },
          });
          scanStartIdx = exitIdx + 1;
          continue;
        }
      }

      const putsRef =
        expiryModeNorm === 'FIXED'
          ? putsFixed || []
          : await getPutsForExpiry(expiryUsed);

      if (!putsRef || !putsRef.length) {
        results.push({
          date: currentDate,
          trade: { took: false, reason: 'NO_PUT_CHAIN' },
          meta: {
            expiry: expiryUsed,
            stockSymbol,
            timeInterval,
            expiryMode: expiryModeNorm,
          },
        });
        scanStartIdx = exitIdx + 1;
        continue;
      }

      // Select strikes
      const atmIdx = pickAtmPutIndex(putsRef, underlyingPrice);
      if (atmIdx < 0) {
        results.push({
          date: currentDate,
          trade: { took: false, reason: 'NO_ATM_PUT' },
          meta: { underlyingPrice },
        });
        scanStartIdx = exitIdx + 1;
        continue;
      }

      const mainPick = pickPutByMoneyness(
        putsRef,
        atmIdx,
        mainMoneyness,
        'MAIN_PUT'
      );
      const hedgePick = pickPutByMoneyness(
        putsRef,
        atmIdx,
        hedgeMoneyness,
        'HEDGE_PUT'
      );

      if (!mainPick.inst) {
        results.push({
          date: currentDate,
          trade: {
            took: false,
            reason: mainPick.reason || 'MAIN_PUT_NOT_FOUND',
          },
          meta: { underlyingPrice, mainMoneyness },
        });
        scanStartIdx = exitIdx + 1;
        continue;
      }
      if (!hedgePick.inst) {
        results.push({
          date: currentDate,
          trade: {
            took: false,
            reason: hedgePick.reason || 'HEDGE_PUT_NOT_FOUND',
          },
          meta: { underlyingPrice, hedgeMoneyness },
        });
        scanStartIdx = exitIdx + 1;
        continue;
      }

      const mainInst = mainPick.inst.instrument;
      const hedgeInst = hedgePick.inst.instrument;

      // Entry ticks
      const mainEntry = await firstTickBetween(
        optColl,
        mainInst,
        entryUTC,
        plannedExitUTC
      );
      if (!mainEntry || typeof mainEntry.price === 'undefined') {
        results.push({
          date: currentDate,
          trade: { took: false, reason: 'NO_MAIN_ENTRY_TICK' },
          peLeg: { main: mainPick.inst, hedge: hedgePick.inst },
        });
        scanStartIdx = exitIdx + 1;
        continue;
      }

      const hedgeEntry = await firstTickBetween(
        optColl,
        hedgeInst,
        entryUTC,
        plannedExitUTC
      );
      if (!hedgeEntry || typeof hedgeEntry.price === 'undefined') {
        results.push({
          date: currentDate,
          trade: { took: false, reason: 'NO_HEDGE_ENTRY_TICK' },
          peLeg: { main: mainPick.inst, hedge: hedgePick.inst },
        });
        scanStartIdx = exitIdx + 1;
        continue;
      }

      // MAIN SL/TP levels (short put)
      const slPctNum = num(stopLossPct, 0);
      const tpPctNum = num(targetPct, 0);

      const mainEntryPx = num(mainEntry.price);
      const mainStopLoss =
        slPctNum > 0 ? mainEntryPx * (1 + slPctNum / 100) : null;
      const mainTarget =
        tpPctNum > 0 ? mainEntryPx * (1 - tpPctNum / 100) : null;

      // Determine earliest exit: SL/TP vs planned (sellSignal/time)
      let actualExitUTC = plannedExitUTC;
      let exitReasonTag = exitByTimeFallback
        ? 'TIME_EXIT_NO_SELL_SIGNAL'
        : 'SUPERTREND_SELL_SIGNAL';
      let exitVia = 'SUPERTREND_OR_TIME';

      const sltpHit = await firstHitShortSLTP(
        optColl,
        mainInst,
        mainEntry.ts,
        plannedExitUTC,
        mainStopLoss,
        mainTarget
      );

      if (sltpHit && sltpHit.tick) {
        actualExitUTC = sltpHit.tick.ts;
        exitReasonTag = sltpHit.reason;
        exitVia = 'MAIN_SLTP';
      }

      // Next scan start
      let nextScanStartIdx = exitIdx + 1;
      if (exitVia === 'MAIN_SLTP') {
        const exitMomentIST = moment(actualExitUTC).tz(timezone);
        const idxAfter = dayCandles.findIndex(
          (c, idx) =>
            idx > entryIdx && moment(c.ts).tz(timezone).isAfter(exitMomentIST)
        );
        nextScanStartIdx = idxAfter !== -1 ? idxAfter : dayCandles.length;
      }

      // Exit ticks (both legs exit on the same anchor time)
      const mainExit =
        (sltpHit && sltpHit.tick) ||
        (await lastTickOnOrBefore(optColl, mainInst, actualExitUTC)) ||
        (await firstTickBetween(
          optColl,
          mainInst,
          actualExitUTC,
          plannedExitUTC
        ));

      if (!mainExit || typeof mainExit.price === 'undefined') {
        results.push({
          date: currentDate,
          trade: { took: false, reason: 'NO_MAIN_EXIT_TICK' },
          peLeg: { main: mainPick.inst, hedge: hedgePick.inst },
        });
        scanStartIdx = nextScanStartIdx;
        continue;
      }

      const hedgeExitTolUTC = new Date(actualExitUTC.getTime() + 2 * 60 * 1000);

      const hedgeExit =
        (await lastTickOnOrBefore(optColl, hedgeInst, actualExitUTC)) ||
        (await firstTickBetween(
          optColl,
          hedgeInst,
          actualExitUTC,
          hedgeExitTolUTC
        )) ||
        (await lastTickOnOrBefore(optColl, hedgeInst, plannedExitUTC)) ||
        (await firstTickBetween(optColl, hedgeInst, entryUTC, plannedExitUTC));

      if (!hedgeExit || typeof hedgeExit.price === 'undefined') {
        results.push({
          date: currentDate,
          trade: { took: false, reason: 'NO_HEDGE_EXIT_TICK' },
          peLeg: { main: mainPick.inst, hedge: hedgePick.inst },
        });
        scanStartIdx = nextScanStartIdx;
        continue;
      }

      // PnL (points + scaled PnL)
      // PnL sizing:
      // - We allow fractional multipliers (e.g., qty=0.001) to scale "premium points" into
      //   USD-like PnL based on a contract multiplier you choose.
      // - If you want integer lots, pass qty as 1,2,3...; if you want USD conversion, pass a
      //   fractional multiplier.
      let q = num(qty, 1);
      if (!Number.isFinite(q) || q <= 0) q = 1;

      const mainExitPx = num(mainExit.price);
      const hedgeEntryPx = num(hedgeEntry.price);
      const hedgeExitPx = num(hedgeExit.price);

      const mainPoints = mainEntryPx - mainExitPx; // short
      const hedgePoints = hedgeExitPx - hedgeEntryPx; // long
      const netPoints = mainPoints + hedgePoints;

      const netPnl = netPoints * q;

      totalTrades += 1;
      tradesForDay += 1;
      cumulativePnL += netPnl;
      if (netPnl > 0) wins += 1;
      else if (netPnl < 0) losses += 1;

      if (VERBOSE) {
        console.log(
          `[${TAG}_TRADE] date=${currentDate} trade#${tradesForDay} netPoints=${netPoints.toFixed(
            4
          )} qty=${q} netPnl=${netPnl.toFixed(2)} exitReason=${exitReasonTag}`
        );
      }

      results.push({
        date: currentDate,
        indexSignals: {
          entry: {
            datetimeIST: entryCandle.datetimeIST,
            supertrend: entryCandle.supertrend,
          },
          exit: {
            datetimeIST: exitCandle.datetimeIST,
            supertrend: exitCandle.supertrend,
          },
        },
        underlying: {
          type: 'BTCUSD_FUT_CANDLE',
          symbol: stockSymbol,
          ltp: underlyingPrice,
          timeIST: entryCandle.datetimeIST,
        },
        peLeg: {
          mainSelection: {
            side: 'P_SHORT',
            instrument: mainInst,
            strike: mainPick.inst.strike,
            moneyness: mainPick.parsed,
          },
          hedgeSelection: {
            side: 'P_LONG',
            relation: 'HEDGE',
            instrument: hedgeInst,
            strike: hedgePick.inst.strike,
            moneyness: hedgePick.parsed,
          },
          mainEntry: {
            time: toTZISO(mainEntry.ts, timezone),
            price: mainEntryPx,
          },
          mainExit: {
            time: toTZISO(actualExitUTC, timezone),
            tickTime: toTZISO(mainExit.ts, timezone),
            price: mainExitPx,
          },
          hedgeEntry: {
            time: toTZISO(hedgeEntry.ts, timezone),
            price: hedgeEntryPx,
          },
          hedgeExit: {
            time: toTZISO(actualExitUTC, timezone),
            tickTime: toTZISO(hedgeExit.ts, timezone),
            price: hedgeExitPx,
          },
          pnl: {
            qty: q,
            mainPoints,
            hedgePoints,
            netPoints,
            net: netPnl,
          },
        },
        trade: {
          took: true,
          qty: q,
          pnlNet: netPnl,
          pnlPointsNet: netPoints,
          entryReason: entryReasonTag,
          exitReason: exitReasonTag,
          exitVia,
          actualExitTimeIST: toTZISO(actualExitUTC, timezone),
          stopLossPct: slPctNum,
          targetPct: tpPctNum,
          stopLossPrice: mainStopLoss,
          targetPrice: mainTarget,
          tradeIndexInDay: tradesForDay,
        },
        meta: {
          expiry: expiryUsed,
          timezone,
          stockSymbol,
          stockName,
          timeInterval,
          fromTime,
          toTime,
          mainMoneyness,
          hedgeMoneyness,
        },
      });

      scanStartIdx = nextScanStartIdx;
    }
  }

  const breakeven = Math.max(totalTrades - wins - losses, 0);
  const summary = {
    totalTrades,
    wins,
    losses,
    breakeven,
    cumulativePnL: Number(cumulativePnL.toFixed(2)),
    winRatePct: totalTrades
      ? Number(((wins / totalTrades) * 100).toFixed(2))
      : 0,
    lossRatePct: totalTrades
      ? Number(((losses / totalTrades) * 100).toFixed(2))
      : 0,
    avgPnLPerTrade: totalTrades
      ? Number((cumulativePnL / totalTrades).toFixed(2))
      : 0,
  };

  return {
    summary,
    results,
    debug: {
      dbName: db?.databaseName || null,
      candles: candlesDebug || null,
    },
  };
}

// -----------------------------------------------------------------------------
// Runs builder (optional): from expiries[] or runs[]
// -----------------------------------------------------------------------------
function buildRunsFromExpiries(payload) {
  if (!payload) return [];

  const {
    fromDate,
    toDate,
    expiries = [],
    stockSymbol,
    stockName,

    timeInterval,
    fromTime,
    toTime,
    timezone,

    mainMoneyness,
    hedgeMoneyness,

    stopLossPct,
    targetPct,

    atrPeriod,
    multiplier,
    changeAtrCalculation,

    maxTradesPerDay,
    entryMode,
    qty,
    timeExitHHmm,
  } = payload;

  if (!fromDate || !toDate || !Array.isArray(expiries) || !expiries.length)
    return [];

  // Unlike NIFTY weekly expiries routing, Delta expiries are YYYY-MM-DD; we just create runs for each expiry.
  return expiries.map((e) => ({
    fromDate,
    toDate,
    expiry: e,
    stockSymbol,
    stockName,
    timeInterval,
    fromTime,
    toTime,
    timezone,
    mainMoneyness,
    hedgeMoneyness,
    stopLossPct,
    targetPct,
    atrPeriod,
    multiplier,
    changeAtrCalculation,
    maxTradesPerDay,
    entryMode,
    qty,
    timeExitHHmm,
  }));
}

// -----------------------------------------------------------------------------
// Controller: BTC Supertrend Bull Put Spread backtest (Delta ticks + BTC candles)
// -----------------------------------------------------------------------------
exports.SupertrendBullPutSpreadMainSLTPBTCController = expressAsyncHandler(
  async (req, res) => {
    try {
      const payload = req.body || {};
      if (VERBOSE) console.log('BTC_ST_BPS payload=', payload);

      let runs = [];
      if (Array.isArray(payload.expiries) && payload.expiries.length) {
        runs = buildRunsFromExpiries(payload);
      } else if (Array.isArray(payload.runs) && payload.runs.length) {
        runs = payload.runs;
      } else if (payload && typeof payload === 'object') {
        runs = [payload];
      }

      const invalid = runs.find((r) => {
        if (!r?.fromDate || !r?.toDate) return true;
        const em = String(r.expiryMode || payload.expiryMode || 'FIXED')
          .trim()
          .toUpperCase();
        if (em === 'AUTO_DAILY') return false;
        return !r?.expiry;
      });

      if (!runs.length || invalid) {
        return res.status(400).json({
          success: false,
          message:
            'Provide {fromDate,toDate} and either (a) expiryMode:"FIXED" with expiry, or (b) expiryMode:"AUTO_DAILY". You may also use expiries:[...] for fixed-expiry runs, or runs[].',
        });
      }

      const initAgg = () => ({
        totalTrades: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        cumulativePnL: 0,
        winRatePct: 0,
        lossRatePct: 0,
        avgPnLPerTrade: 0,
      });

      const foldAgg = (agg, s) => {
        agg.totalTrades += s.totalTrades;
        agg.wins += s.wins;
        agg.losses += s.losses;
        agg.cumulativePnL += num(s.cumulativePnL, 0);
        return agg;
      };

      const finalizeAgg = (agg) => {
        agg.cumulativePnL = Number(agg.cumulativePnL.toFixed(2));
        agg.breakeven = Math.max(agg.totalTrades - agg.wins - agg.losses, 0);
        agg.winRatePct = agg.totalTrades
          ? Number(((agg.wins / agg.totalTrades) * 100).toFixed(2))
          : 0;
        agg.lossRatePct = agg.totalTrades
          ? Number(((agg.losses / agg.totalTrades) * 100).toFixed(2))
          : 0;
        agg.avgPnLPerTrade = agg.totalTrades
          ? Number((agg.cumulativePnL / agg.totalTrades).toFixed(2))
          : 0;
        return agg;
      };

      const runsOutput = [];
      let overallAgg = initAgg();

      for (let i = 0; i < runs.length; i += 1) {
        const r = runs[i];

        const resolved = {
          fromDate: r.fromDate,
          toDate: r.toDate,

          expiry: r.expiry ?? payload.expiry ?? undefined,
          expiryMode: r.expiryMode || payload.expiryMode || 'FIXED',
          expiryDaysOut: r.expiryDaysOut ?? payload.expiryDaysOut ?? 0,
          expiryLookaheadDays:
            r.expiryLookaheadDays ?? payload.expiryLookaheadDays ?? 14,

          stockSymbol: r.stockSymbol || payload.stockSymbol || 'BTCUSD',
          stockName: r.stockName || payload.stockName || 'BTC',

          timeInterval: r.timeInterval || payload.timeInterval || 'M5',
          fromTime: r.fromTime || payload.fromTime || '00:00',
          toTime: r.toTime || payload.toTime || '23:59',
          timezone: r.timezone || payload.timezone || DEFAULT_TZ,

          mainMoneyness: r.mainMoneyness || payload.mainMoneyness || 'OTM1',
          hedgeMoneyness: r.hedgeMoneyness || payload.hedgeMoneyness || 'OTM3',

          stopLossPct: r.stopLossPct ?? payload.stopLossPct ?? 30,
          targetPct: r.targetPct ?? payload.targetPct ?? 30,

          atrPeriod:
            r.atrPeriod || payload.atrPeriod || payload.stAtrPeriod || 10,
          multiplier:
            r.multiplier || payload.multiplier || payload.stMultiplier || 3,
          changeAtrCalculation:
            typeof r.changeAtrCalculation === 'boolean'
              ? r.changeAtrCalculation
              : typeof payload.changeAtrCalculation === 'boolean'
              ? payload.changeAtrCalculation
              : true,

          maxTradesPerDay:
            r.maxTradesPerDay || payload.maxTradesPerDay || undefined,
          entryMode: r.entryMode || payload.entryMode || 'signal_or_trend',

          qty: r.qty ?? payload.qty ?? payload.lotSize ?? 1,
          timeExitHHmm: r.timeExitHHmm || payload.timeExitHHmm || null,
        };

        const { summary, results, debug } =
          await runSupertrendBullPutSingleRunBTC(resolved);

        runsOutput.push({
          index: i,
          meta: resolved,
          summary,
          results,
          debug,
        });

        overallAgg = foldAgg(overallAgg, summary);
      }

      const overall = finalizeAgg(overallAgg);

      return res.status(200).json({
        success: true,
        strategy: 'SUPERTREND_BULL_PUT_SPREAD_MAIN_SLTP_BTC_DELTA',
        collections: {
          futCandles: FUT_CANDLES_COLL,
          optTicks: OPT_TICKS_COLL,
        },
        overall,
        runs: runsOutput,
      });
    } catch (err) {
      console.error(
        '[SupertrendBullPutSpreadMainSLTPBTCController] Error:',
        err
      );
      return res.status(400).json({
        success: false,
        message:
          err.message || 'Error running BTC Supertrend BPS backtest controller',
      });
    }
  }
);

module.exports = exports;
