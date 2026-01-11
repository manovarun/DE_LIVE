/**
 * SuperTrendBearCallSpreadPaperTradeBTCController
 * ------------------------------------------------
 * BTC (Delta Exchange) SuperTrend Bear Call Spread paper-trade controller.
 *
 * - Futures candles are read from a MongoDB collection (default: btcusd_candles_ts)
 * - Options ticks are read from monthly collections created by DeltaOptionsWsTicksCaptureLiveController
 *   (default prefix: OptionsTicks => OptionsTicksMMYYYY)
 * - Options expiry is treated as DAILY expiry (expiry string = YYYY-MM-DD in configured timezone)
 * - Risk (SL/TP) applies ONLY on MAIN short call leg (same as NIFTY paper controller)
 */

const cron = require('node-cron');
const moment = require('moment-timezone');
const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let expressAsyncHandler;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  expressAsyncHandler = require('express-async-handler');
} catch {
  expressAsyncHandler = (fn) => fn;
}

let AppError;
try {
  AppError = require('../utils/AppError');
} catch {
  AppError = class AppError extends Error {
    constructor(message, statusCode = 400) {
      super(message);
      this.statusCode = statusCode;
    }
  };
}

let addSupertrendToCandles;
try {
  ({ addSupertrendToCandles } = require('../indicators/supertrend'));
} catch {
  try {
    ({ addSupertrendToCandles } = require('./supertrend'));
  } catch {
    // last resort: require by filename if user placed it in project root
    ({ addSupertrendToCandles } = require('../supertrend'));
  }
}

let SupertrendBcsPaperSpread = null;
try {
  // NIFTY controller exports {SupertrendBcsPaperSpread, SupertrendBcsPaperTrade}
  ({ SupertrendBcsPaperSpread } = require('../models/SupertrendBcsPaperTrade'));
} catch {
  // optional fallback to raw inserts
  SupertrendBcsPaperSpread = null;
}

// =====================
// Env / Configuration
// =====================

const TZ = process.env.SUPERTREND_BCS_PAPER_TIMEZONE || 'Asia/Kolkata';

const CRON_EXPR = process.env.SUPERTREND_BCS_PAPER_CRON || '* 0-23 * * *';
const CRON_SECONDS = process.env.SUPERTREND_BCS_PAPER_CRON_SECONDS || '2-59/5';

const STOCK_NAME = process.env.SUPERTREND_BCS_PAPER_STOCK_NAME || 'BTC';
const STOCK_SYMBOL =
  process.env.SUPERTREND_BCS_PAPER_STOCK_SYMBOL ||
  process.env.SUPERTREND_BCS_PAPER_FUT_SYMBOL ||
  'BTCUSD';

const FUT_CANDLES_COLLECTION =
  process.env.SUPERTREND_BCS_PAPER_FUT_CANDLES_COLLECTION ||
  'btcusd_candles_ts';

const OPT_TICKS_PREFIX = process.env.DELTA_OPT_TICKS_PREFIX || 'OptionsTicks';

const INDEX_TF = process.env.SUPERTREND_BCS_PAPER_INDEX_TF || 'M3';
const FROM_TIME = process.env.SUPERTREND_BCS_PAPER_FROM_TIME || '00:00';
const SQUARE_OFF_TIME =
  process.env.SUPERTREND_BCS_PAPER_SQUARE_OFF_TIME || '23:59';

const STOPLOSS_PCT = Number(
  process.env.SUPERTREND_BCS_PAPER_STOPLOSS_PCT || 5000
);
const TARGET_PCT = Number(process.env.SUPERTREND_BCS_PAPER_TARGET_PCT || 50);

const MAIN_MONEYNESS = process.env.SUPERTREND_BCS_PAPER_MAIN_MONEYNESS || 'ATM';
const HEDGE_MONEYNESS =
  process.env.SUPERTREND_BCS_PAPER_HEDGE_MONEYNESS || 'OTM3';

const ATR_PERIOD = Math.max(
  1,
  Number(process.env.SUPERTREND_BCS_PAPER_ATR_PERIOD || 10)
);
const MULTIPLIER = Math.max(
  0.1,
  Number(process.env.SUPERTREND_BCS_PAPER_MULTIPLIER || 3)
);
const CHANGE_ATR_CALC =
  String(
    process.env.SUPERTREND_BCS_PAPER_CHANGE_ATR_CALC || 'true'
  ).toLowerCase() === 'true';

const FORCE_ENTRY =
  String(
    process.env.SUPERTREND_BCS_PAPER_FORCE_ENTRY || 'false'
  ).toLowerCase() === 'true';

const WEEKDAYS = (
  process.env.SUPERTREND_BCS_PAPER_WEEKDAYS || 'MON,TUE,WED,THU,FRI,SAT,SUN'
)
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const MAX_TRADES_PER_DAY = Math.max(
  1,
  Number(process.env.SUPERTREND_BCS_PAPER_MAX_TRADES_PER_DAY || 5)
);
const MIN_CANDLES = Math.max(
  5,
  Number(process.env.SUPERTREND_BCS_PAPER_MIN_CANDLES || 20)
);

const CANDLE_GRACE_SECONDS = Math.max(
  0,
  Number(process.env.SUPERTREND_BCS_PAPER_CANDLE_GRACE_SECONDS || 5)
);
const ALLOW_FORMING_CANDLE =
  String(
    process.env.SUPERTREND_BCS_PAPER_ALLOW_FORMING_CANDLE || 'false'
  ).toLowerCase() === 'true';

const PNL_POLL_MS = Math.max(
  2000,
  Number(process.env.SUPERTREND_BCS_PAPER_PNL_POLL_MS || 15000)
);

// Heartbeat: periodic status line so you can confirm the cron loop is running.
// Set SUPERTREND_BCS_PAPER_HEARTBEAT_MS=0 to disable.
const HEARTBEAT_MS_RAW = Number(
  process.env.SUPERTREND_BCS_PAPER_HEARTBEAT_MS || 60000
);
const HEARTBEAT_MS =
  HEARTBEAT_MS_RAW <= 0 ? 0 : Math.max(1000, HEARTBEAT_MS_RAW);

// Position sizing for BTC: treat LOT_SIZE as contract_value (e.g., 0.001 BTC) and LOTS as number of contracts
const LOT_SIZE = Number(process.env.SUPERTREND_BCS_PAPER_LOT_SIZE || 0.001);
const LOTS = Math.max(1, Number(process.env.SUPERTREND_BCS_PAPER_LOTS || 1));

// In BTC controllers we keep qty as multiplier (BTC notional) for PnL scaling.
const QTY = LOT_SIZE * LOTS;

const STRATEGY = 'SUPERTREND_BEAR_CALL_SPREAD_PAPER_BTC_DELTA';

// =====================
// Logging helpers
// =====================

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch {
    // ignore
  }
}

function nowTs(tz = TZ) {
  return moment().tz(tz).format('YYYY-MM-DD HH:mm:ss');
}

function info(msg) {
  // keep console concise (user preference)
  // eslint-disable-next-line no-console
  console.log(`[${nowTs()}] [ST_BCS_BTC] ${msg}`);
}

function warn(msg) {
  // eslint-disable-next-line no-console
  console.warn(`[${nowTs()}] [ST_BCS_BTC][WARN] ${msg}`);
}

function error(msg, err) {
  // eslint-disable-next-line no-console
  console.error(`[${nowTs()}] [ST_BCS_BTC][ERROR] ${msg}`);
  if (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
}

// Optional: write a daily log file (kept minimal)
const PAPER_LOG_DIR =
  process.env.SUPERTREND_BCS_PAPER_LOG_DIR ||
  path.join(process.cwd(), 'logs', 'papertrade');
ensureDir(PAPER_LOG_DIR);

function appendPaperLog(line) {
  try {
    const fileName = `ST_BCS_BTC_${moment().tz(TZ).format('YYYYMMDD')}.log`;
    const fp = path.join(PAPER_LOG_DIR, fileName);
    fs.appendFileSync(fp, `${nowTs()} [ST_BCS_BTC] ${line}\n`);
  } catch {
    // ignore
  }
}

// =====================
// Time / Interval helpers
// =====================

function parseIntervalToMs(tf) {
  const s = String(tf || '')
    .toUpperCase()
    .trim();
  const m = s.match(/^([MHD])(\d+)$/);
  if (!m)
    throw new Error(
      `Unsupported interval "${tf}". Use like M1, M2, M5, H1, D1`
    );
  const unit = m[1];
  const n = Number(m[2]);
  if (!Number.isFinite(n) || n <= 0)
    throw new Error(`Invalid interval number for ${tf}`);
  if (unit === 'M') return n * 60 * 1000;
  if (unit === 'H') return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

function hhmmToMoment(dateYYYYMMDD, hhmm, tz = TZ) {
  const [hh, mm] = String(hhmm)
    .split(':')
    .map((x) => Number(x));
  return moment
    .tz(`${dateYYYYMMDD} 00:00:00`, 'YYYY-MM-DD HH:mm:ss', tz)
    .hour(hh)
    .minute(mm)
    .second(0)
    .millisecond(0);
}

function weekdayKey(m) {
  return m.format('ddd').toUpperCase();
}

function monthSuffixUTC(d) {
  const m = moment.utc(d);
  return m.format('MMYYYY');
}

function pickOptTicksCollectionName(prefix, dUtc) {
  return `${prefix}${monthSuffixUTC(dUtc)}`;
}

function listMonthStartsBetweenUtc(fromUtc, toUtc) {
  const out = [];
  const a = moment.utc(fromUtc).startOf('month');
  const b = moment.utc(toUtc).startOf('month');
  const cur = a.clone();
  while (cur.isSameOrBefore(b)) {
    out.push(cur.toDate());
    cur.add(1, 'month');
  }
  return out;
}

// =====================
// DB helpers
// =====================

function getDb() {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    throw new Error(
      'Mongoose is not connected. Ensure db.connect() is called before starting this controller.'
    );
  }
  return mongoose.connection.db;
}

async function findOneSorted(coll, filter, sort, projection) {
  const cursor = coll.find(filter, { projection }).sort(sort).limit(1);
  const arr = await cursor.toArray();
  return arr && arr.length ? arr[0] : null;
}

// =====================
// Candle / SuperTrend
// =====================

function enrichSupertrendCandles(
  stCandles,
  stockSymbol,
  stockName,
  timeInterval
) {
  return (stCandles || []).map((c) => ({
    ...c,
    stockSymbol,
    stockName,
    timeInterval,
  }));
}

async function loadCandlesRange({
  stockSymbol,
  stockName,
  timeInterval,
  fromUtc,
  toUtc,
  collectionName,
}) {
  const db = getDb();
  const coll = db.collection(collectionName);

  const docs = await coll
    .find(
      {
        stockSymbol,
        timeInterval,
        ts: { $gte: fromUtc, $lte: toUtc },
      },
      {
        projection: {
          _id: 1,
          ts: 1,
          datetime: 1,
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
          trades: 1,
          updatedAt: 1,
          lastTradeTime: 1,
        },
      }
    )
    .sort({ ts: 1 })
    .toArray();

  // Normalize numeric fields
  const candles = (docs || []).map((d) => ({
    ...d,
    open: Number(d.open),
    high: Number(d.high),
    low: Number(d.low),
    close: Number(d.close),
    volume: Number(d.volume || 0),
    trades: Number(d.trades || 0),
  }));

  return candles;
}

function pickLastConfirmedCandle(
  candles,
  tfMs,
  nowUtc,
  allowForming,
  graceSeconds
) {
  if (!candles || candles.length === 0) return null;

  if (allowForming) return candles[candles.length - 1];

  const cutoff = new Date(nowUtc.getTime() - graceSeconds * 1000);
  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const c = candles[i];
    const end = new Date(new Date(c.ts).getTime() + tfMs);
    if (end <= cutoff) return c;
  }
  return null;
}

async function buildTodaySupertrend({
  nowIst,
  stockSymbol,
  stockName,
  timeInterval,
  fromTime,
  squareOffTime,
  atrPeriod,
  multiplier,
  changeAtrCalculation,
  minCandles,
  candleGraceSeconds,
  allowFormingCandle,
  futCandlesCollection,
}) {
  const tfMs = parseIntervalToMs(timeInterval);

  const dayStr = nowIst.format('YYYY-MM-DD');
  const fromIst = hhmmToMoment(dayStr, fromTime, TZ);

  const squareOffIst = hhmmToMoment(dayStr, squareOffTime, TZ);
  const toIst = moment.min(nowIst.clone(), squareOffIst);

  // Warmup lookback bars (ensure ATR and SuperTrend stabilize)
  const warmupBars = Math.max(minCandles + atrPeriod + 5, atrPeriod * 3 + 10);
  const warmupFromUtc = new Date(
    fromIst
      .clone()
      .subtract(warmupBars * tfMs, 'milliseconds')
      .valueOf()
  );

  const fromUtc = new Date(fromIst.clone().utc().valueOf());
  const toUtc = new Date(toIst.clone().utc().valueOf());

  const candles = await loadCandlesRange({
    stockSymbol,
    stockName,
    timeInterval,
    fromUtc: warmupFromUtc,
    toUtc,
    collectionName: futCandlesCollection,
  });

  const lastConfirmed = pickLastConfirmedCandle(
    candles,
    tfMs,
    new Date(),
    allowFormingCandle,
    candleGraceSeconds
  );

  if (!candles.length || !lastConfirmed) {
    return {
      candles,
      stCandles: [],
      lastConfirmedCandle: null,
      lastConfirmedStCandle: null,
      range: { fromIst, toIst, fromUtc, toUtc, warmupFromUtc },
      tfMs,
    };
  }

  // Keep candles up to last confirmed for deterministic signals
  const lastConfirmedTs = new Date(lastConfirmed.ts).getTime();
  const confirmedCandles = candles.filter(
    (c) => new Date(c.ts).getTime() <= lastConfirmedTs
  );

  const stCandlesRaw = addSupertrendToCandles(
    confirmedCandles,
    atrPeriod,
    multiplier,
    changeAtrCalculation
  );

  const stCandles = enrichSupertrendCandles(
    stCandlesRaw,
    stockSymbol,
    stockName,
    timeInterval
  );

  const lastConfirmedStCandle = stCandles.length
    ? stCandles[stCandles.length - 1]
    : null;

  return {
    candles: confirmedCandles,
    stCandles,
    lastConfirmedCandle: lastConfirmed,
    lastConfirmedStCandle,
    range: { fromIst, toIst, fromUtc, toUtc, warmupFromUtc },
    tfMs,
  };
}

// =====================
// Options helpers (Delta)
// =====================

function parseMoneyness(m) {
  const s = String(m || '')
    .toUpperCase()
    .trim();
  if (s === 'ATM') return { kind: 'ATM', n: 0 };
  const it = s.match(/^ITM(\d+)$/);
  if (it) return { kind: 'ITM', n: Number(it[1] || 0) };
  const ot = s.match(/^OTM(\d+)$/);
  if (ot) return { kind: 'OTM', n: Number(ot[1] || 0) };
  throw new Error(
    `Invalid moneyness: ${m}. Use ATM, ITM1, ITM2, OTM1, OTM2...`
  );
}

function pickAtmIndex(strikes, underlying) {
  if (!strikes || strikes.length === 0) return -1;
  let bestIdx = 0;
  let bestDiff = Math.abs(strikes[0] - underlying);
  for (let i = 1; i < strikes.length; i += 1) {
    const d = Math.abs(strikes[i] - underlying);
    if (d < bestDiff) {
      bestDiff = d;
      bestIdx = i;
    } else if (d === bestDiff) {
      // tie-break: prefer strike >= underlying (slightly OTM ATM) to reduce ITM bias
      const cur = strikes[i];
      const best = strikes[bestIdx];
      if (best < underlying && cur >= underlying) bestIdx = i;
    }
  }
  return bestIdx;
}

function pickStrikeByMoneyness(strikes, underlying, moneyness) {
  const { kind, n } = parseMoneyness(moneyness);
  const atmIdx = pickAtmIndex(strikes, underlying);
  if (atmIdx < 0) return null;

  let idx = atmIdx;
  if (kind === 'ITM') idx = atmIdx - n;
  if (kind === 'OTM') idx = atmIdx + n;

  if (idx < 0 || idx >= strikes.length) return null;
  return strikes[idx];
}

async function getAvailableStrikesForExpiry(
  optColl,
  { underlying = 'BTC', optionType = 'C', expiry }
) {
  const strikes = await optColl.distinct('strike', {
    underlying,
    optionType,
    expiry,
  });
  return (strikes || [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
}

async function getLatestOptionTickByStrike(
  optColl,
  { underlying = 'BTC', optionType = 'C', expiry, strike, atOrBeforeUtc = null }
) {
  const filter = { underlying, optionType, expiry, strike: Number(strike) };
  if (atOrBeforeUtc) filter.exchTradeTime = { $lte: atOrBeforeUtc };

  return findOneSorted(
    optColl,
    filter,
    { exchTradeTime: -1 },
    {
      _id: 1,
      symbol: 1,
      price: 1,
      size: 1,
      side: 1,
      buyer_role: 1,
      seller_role: 1,
      exchTradeTime: 1,
      ingestTs: 1,
      underlying: 1,
      optionType: 1,
      strike: 1,
      expiry: 1,
    }
  );
}

async function getLatestOptionTickBySymbol(
  optColl,
  { symbol, atOrBeforeUtc = null }
) {
  const filter = { symbol };
  if (atOrBeforeUtc) filter.exchTradeTime = { $lte: atOrBeforeUtc };

  return findOneSorted(
    optColl,
    filter,
    { exchTradeTime: -1 },
    {
      _id: 1,
      symbol: 1,
      price: 1,
      size: 1,
      side: 1,
      buyer_role: 1,
      seller_role: 1,
      exchTradeTime: 1,
      ingestTs: 1,
      underlying: 1,
      optionType: 1,
      strike: 1,
      expiry: 1,
    }
  );
}

async function scanFirstTickHit({
  optColl,
  symbol,
  fromUtc,
  toUtc,
  stopLossPrice,
  targetPrice,
  direction, // 'SHORT' only (for now)
  limit = 200000,
}) {
  // For SHORT:
  // - SL hit when price >= stopLossPrice
  // - Target hit when price <= targetPrice
  const cursor = optColl
    .find(
      { symbol, exchTradeTime: { $gte: fromUtc, $lte: toUtc } },
      { projection: { exchTradeTime: 1, price: 1 } }
    )
    .sort({ exchTradeTime: 1 })
    .limit(limit);

  // eslint-disable-next-line no-restricted-syntax
  for await (const t of cursor) {
    const p = Number(t.price);
    if (!Number.isFinite(p)) continue;

    if (direction === 'SHORT') {
      if (Number.isFinite(stopLossPrice) && p >= stopLossPrice) {
        return { kind: 'STOPLOSS', tick: t };
      }
      if (Number.isFinite(targetPrice) && p <= targetPrice) {
        return { kind: 'TARGET', tick: t };
      }
    }
  }

  return null;
}

function buildExitPricesForShort(entryPrice, stopLossPct, targetPct) {
  const sl = entryPrice * (1 + stopLossPct / 100);
  const tp = entryPrice * (1 - targetPct / 100);
  return { stopLossPrice: sl, targetPrice: tp };
}

async function getOptionsCollectionsForRange(db, prefix, fromUtc, toUtc) {
  const months = listMonthStartsBetweenUtc(fromUtc, toUtc);
  const names = months.map((d) => pickOptTicksCollectionName(prefix, d));

  // Filter only existing collections (best-effort)
  const existing = new Set();
  try {
    const list = await db.listCollections({}, { nameOnly: true }).toArray();
    list.forEach((x) => existing.add(x.name));
  } catch {
    // ignore
  }

  return names.filter((n) => (existing.size ? existing.has(n) : true));
}

async function getOptionCollectionForNow(db) {
  const name = pickOptTicksCollectionName(OPT_TICKS_PREFIX, new Date());
  return db.collection(name);
}

// =====================
// Paper-trade state
// =====================

let cronTask = null;
let cronInFlight = false;

// Heartbeat window stats (operational visibility)
let heartbeatTimer = null;
const hb = {
  windowStartMs: Date.now(),
  loops: 0,
  openSeen: 0,
  entered: 0,
  exited: 0,
  skips: {},
  lastCandleTs: null,
  lastSignal: 'NONE',
};

function hbIncSkip(reason) {
  const r = reason || 'NA';
  hb.skips[r] = (hb.skips[r] || 0) + 1;
}

function hbSkipsToString() {
  const entries = Object.entries(hb.skips);
  if (!entries.length) return 'NA';
  // sort desc by count
  entries.sort((a, b) => b[1] - a[1]);
  return entries.map(([k, v]) => `${k}=${v}`).join(',');
}

function hbResetWindow() {
  hb.windowStartMs = Date.now();
  hb.loops = 0;
  hb.openSeen = 0;
  hb.entered = 0;
  hb.exited = 0;
  hb.skips = {};
}

function startHeartbeatIfNeeded() {
  if (heartbeatTimer) return;
  if (!HEARTBEAT_MS) return;

  // One-time hint for where to look for logs
  appendPaperLog(`Paper log file: ${PAPER_LOG_DIR}`);
  info(`Paper log file: ${PAPER_LOG_DIR}`);

  heartbeatTimer = setInterval(() => {
    const elapsedMs = Date.now() - hb.windowStartMs;
    const elapsedSec = Math.max(1, Math.round(elapsedMs / 1000));
    const line = `🧾 Last ${elapsedSec}s | loops=${hb.loops} openSeen=${
      hb.openSeen
    } entered=${hb.entered} exited=${
      hb.exited
    } skips=${hbSkipsToString()} lastCandleTs=${
      hb.lastCandleTs || 'NA'
    } lastSignal=${hb.lastSignal || 'NONE'}`;
    appendPaperLog(line);
    info(line);
    hbResetWindow();
  }, HEARTBEAT_MS);
}

const dailyTradeCount = new Map(); // key: YYYY-MM-DD -> count

function incDailyTradeCount(dayStr) {
  const cur = dailyTradeCount.get(dayStr) || 0;
  dailyTradeCount.set(dayStr, cur + 1);
}

function getDailyTradeCount(dayStr) {
  return dailyTradeCount.get(dayStr) || 0;
}

function resetOldDailyCounts(keepDays = 3) {
  const cutoff = moment().tz(TZ).startOf('day').subtract(keepDays, 'days');
  // eslint-disable-next-line no-restricted-syntax
  for (const [k] of dailyTradeCount.entries()) {
    const d = moment.tz(k, 'YYYY-MM-DD', TZ);
    if (d.isBefore(cutoff)) dailyTradeCount.delete(k);
  }
}

// =====================
// Core trading logic
// =====================

async function findOpenSpreadForExpiry(expiryStr) {
  if (!SupertrendBcsPaperSpread) return null;
  return SupertrendBcsPaperSpread.findOne({
    strategy: STRATEGY,
    stockName: STOCK_NAME,
    stockSymbol: STOCK_SYMBOL,
    expiry: expiryStr,
    status: 'OPEN',
  }).sort({ createdAt: -1 });
}

async function createSpreadDoc(doc) {
  if (SupertrendBcsPaperSpread) {
    return SupertrendBcsPaperSpread.create(doc);
  }

  // Raw fallback
  const db = getDb();
  const coll = db.collection('SupertrendBcsPaperSpreads');
  const res = await coll.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

async function updateSpreadDoc(id, patch) {
  if (SupertrendBcsPaperSpread) {
    await SupertrendBcsPaperSpread.updateOne({ _id: id }, { $set: patch });
    return;
  }
  const db = getDb();
  const coll = db.collection('SupertrendBcsPaperSpreads');
  await coll.updateOne({ _id: id }, { $set: patch });
}

function computeSpreadPnl({ mainEntry, mainExit, hedgeEntry, hedgeExit, qty }) {
  const mainPoints = Number(mainEntry) - Number(mainExit); // short call: profit when premium falls
  const hedgePoints = Number(hedgeExit) - Number(hedgeEntry); // long call: profit when premium rises
  const netPoints = mainPoints + hedgePoints;

  const net = netPoints * qty;

  return {
    qty,
    mainPoints,
    hedgePoints,
    netPoints,
    net,
  };
}

async function pickCeLegsFromTicks({
  optColl,
  expiry,
  underlyingPrice,
  mainMoneyness,
  hedgeMoneyness,
  asOfUtc,
}) {
  const strikes = await getAvailableStrikesForExpiry(optColl, {
    underlying: 'BTC',
    optionType: 'C',
    expiry,
  });

  if (!strikes.length) {
    return { ok: false, reason: 'NO_STRIKES_FOR_EXPIRY', strikes: [] };
  }

  const mainStrike = pickStrikeByMoneyness(
    strikes,
    underlyingPrice,
    mainMoneyness
  );
  const hedgeStrike = pickStrikeByMoneyness(
    strikes,
    underlyingPrice,
    hedgeMoneyness
  );

  if (!Number.isFinite(mainStrike) || !Number.isFinite(hedgeStrike)) {
    return {
      ok: false,
      reason: 'STRIKE_OUT_OF_RANGE',
      strikes,
      mainStrike,
      hedgeStrike,
    };
  }

  const mainTick = await getLatestOptionTickByStrike(optColl, {
    underlying: 'BTC',
    optionType: 'C',
    expiry,
    strike: mainStrike,
    atOrBeforeUtc: asOfUtc,
  });

  const hedgeTick = await getLatestOptionTickByStrike(optColl, {
    underlying: 'BTC',
    optionType: 'C',
    expiry,
    strike: hedgeStrike,
    atOrBeforeUtc: asOfUtc,
  });

  if (!mainTick || !hedgeTick || !mainTick.symbol || !hedgeTick.symbol) {
    return {
      ok: false,
      reason: 'NO_TICKS_FOR_SELECTED_STRIKES',
      strikes,
      mainStrike,
      hedgeStrike,
    };
  }

  return {
    ok: true,
    strikes,
    main: {
      symbol: mainTick.symbol,
      strike: Number(mainTick.strike),
      optionType: 'C',
      ltp: Number(mainTick.price),
      tickTime: mainTick.exchTradeTime,
    },
    hedge: {
      symbol: hedgeTick.symbol,
      strike: Number(hedgeTick.strike),
      optionType: 'C',
      ltp: Number(hedgeTick.price),
      tickTime: hedgeTick.exchTradeTime,
    },
    mainStrike,
    hedgeStrike,
  };
}

async function maybeEnterTrade(nowIst) {
  const dayStr = nowIst.format('YYYY-MM-DD');

  // weekday guard
  const wd = weekdayKey(nowIst);
  if (!WEEKDAYS.includes(wd)) {
    appendPaperLog(`Skip - weekday guard (${wd})`);
    return { took: false, reason: 'WEEKDAY_GUARD' };
  }

  // time guard
  const fromIst = hhmmToMoment(dayStr, FROM_TIME, TZ);
  const squareOffIst = hhmmToMoment(dayStr, SQUARE_OFF_TIME, TZ);
  if (nowIst.isBefore(fromIst))
    return { took: false, reason: 'BEFORE_FROM_TIME' };
  if (nowIst.isSameOrAfter(squareOffIst))
    return { took: false, reason: 'AFTER_SQUAREOFF_TIME' };

  // max trades/day guard
  const taken = getDailyTradeCount(dayStr);
  if (taken >= MAX_TRADES_PER_DAY)
    return { took: false, reason: 'MAX_TRADES_REACHED' };

  // expiry (daily)
  const expiry = dayStr;

  const open = await findOpenSpreadForExpiry(expiry);
  if (open) return { took: false, reason: 'OPEN_SPREAD_EXISTS' };

  // Build SuperTrend
  const st = await buildTodaySupertrend({
    nowIst,
    stockSymbol: STOCK_SYMBOL,
    stockName: STOCK_NAME,
    timeInterval: INDEX_TF,
    fromTime: FROM_TIME,
    squareOffTime: SQUARE_OFF_TIME,
    atrPeriod: ATR_PERIOD,
    multiplier: MULTIPLIER,
    changeAtrCalculation: CHANGE_ATR_CALC,
    minCandles: MIN_CANDLES,
    candleGraceSeconds: CANDLE_GRACE_SECONDS,
    allowFormingCandle: ALLOW_FORMING_CANDLE,
    futCandlesCollection: FUT_CANDLES_COLLECTION,
  });

  if (!st.candles.length || !st.lastConfirmedStCandle) {
    return { took: false, reason: 'NO_FUT_CANDLES' };
  }

  const confirmedCount = st.candles.length;
  if (confirmedCount < MIN_CANDLES) {
    return {
      took: false,
      reason: 'INSUFFICIENT_CANDLES',
      meta: { confirmedCount },
    };
  }

  const signalCandle = st.lastConfirmedStCandle;
  const sellSignal = !!signalCandle.sellSignal;

  // Heartbeat: surface the last candle we processed + most recent signal state
  try {
    const ts = signalCandle?.ts || signalCandle?.datetime;
    if (ts) hb.lastCandleTs = new Date(ts).toISOString();
    hb.lastSignal = sellSignal ? 'SELL' : 'NONE';
  } catch (_) {
    // no-op
  }

  if (!FORCE_ENTRY && !sellSignal) {
    // For BCS, we enter on sellSignal (trend flips down)
    return { took: false, reason: 'NO_SELL_SIGNAL' };
  }

  // Underlying reference price
  const underlyingPrice = Number(signalCandle.close);
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) {
    return { took: false, reason: 'INVALID_UNDERLYING_PRICE' };
  }

  const db = getDb();
  const optColl = await getOptionCollectionForNow(db);

  const asOfUtc = new Date(nowIst.clone().utc().valueOf());

  const legs = await pickCeLegsFromTicks({
    optColl,
    expiry,
    underlyingPrice,
    mainMoneyness: MAIN_MONEYNESS,
    hedgeMoneyness: HEDGE_MONEYNESS,
    asOfUtc,
  });

  if (!legs.ok) {
    return {
      took: false,
      reason: legs.reason,
      meta: { expiry, underlyingPrice },
    };
  }

  const mainEntryPrice = Number(legs.main.ltp);
  const hedgeEntryPrice = Number(legs.hedge.ltp);

  if (!Number.isFinite(mainEntryPrice) || !Number.isFinite(hedgeEntryPrice)) {
    return { took: false, reason: 'INVALID_ENTRY_PRICES' };
  }

  const runId = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');

  const entryTimeIst = nowIst.clone();

  const spreadDoc = {
    strategy: STRATEGY,
    runId,

    stockName: STOCK_NAME,
    stockSymbol: STOCK_SYMBOL,

    expiry, // daily expiry YYYY-MM-DD
    timeInterval: INDEX_TF,

    status: 'OPEN',

    config: {
      timezone: TZ,
      fromTime: FROM_TIME,
      squareOffTime: SQUARE_OFF_TIME,
      atrPeriod: ATR_PERIOD,
      multiplier: MULTIPLIER,
      changeAtrCalculation: CHANGE_ATR_CALC,
      stopLossPct: STOPLOSS_PCT,
      targetPct: TARGET_PCT,
      mainMoneyness: MAIN_MONEYNESS,
      hedgeMoneyness: HEDGE_MONEYNESS,
      lotSize: LOT_SIZE,
      lots: LOTS,
      qty: QTY,
      minCandles: MIN_CANDLES,
      candleGraceSeconds: CANDLE_GRACE_SECONDS,
      allowFormingCandle: ALLOW_FORMING_CANDLE,
    },

    entry: {
      time: entryTimeIst.toISOString(true),
      underlyingPrice,
      signalCandleTs: signalCandle.ts || null,
      signalCandleDatetime: signalCandle.datetime || null,
    },

    main: {
      side: 'SELL',
      optionType: 'C',
      symbol: legs.main.symbol,
      strike: legs.main.strike,
      entry: {
        time: entryTimeIst.toISOString(true),
        tickTimeUtc: legs.main.tickTime || null,
        price: mainEntryPrice,
      },
    },

    hedge: {
      side: 'BUY',
      optionType: 'C',
      symbol: legs.hedge.symbol,
      strike: legs.hedge.strike,
      entry: {
        time: entryTimeIst.toISOString(true),
        tickTimeUtc: legs.hedge.tickTime || null,
        price: hedgeEntryPrice,
      },
    },

    exit: null,
    pnl: null,

    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const created = await createSpreadDoc(spreadDoc);

  incDailyTradeCount(dayStr);

  const line = `ENTRY expiry=${expiry} sellSignal=${sellSignal} underlying=${underlyingPrice.toFixed(
    1
  )} main=${legs.main.symbol}@${mainEntryPrice} hedge=${
    legs.hedge.symbol
  }@${hedgeEntryPrice} qty=${QTY}`;
  info(line);
  appendPaperLog(line);

  return { took: true, reason: 'ENTERED', spread: created };
}

async function maybeExitOpenSpread(nowIst, openSpread) {
  if (!openSpread || openSpread.status !== 'OPEN') return { exited: false };

  const dayStr = nowIst.format('YYYY-MM-DD');
  const squareOffIst = hhmmToMoment(dayStr, SQUARE_OFF_TIME, TZ);

  const entryIst = moment.tz(openSpread?.entry?.time, TZ);
  const entryUtc = new Date(entryIst.clone().utc().valueOf());

  const nowUtc = new Date(nowIst.clone().utc().valueOf());
  const squareOffUtc = new Date(squareOffIst.clone().utc().valueOf());

  const db = getDb();

  // Determine which option tick collections to query (in case entry & now cross month)
  const optCollNames = await getOptionsCollectionsForRange(
    db,
    OPT_TICKS_PREFIX,
    entryUtc,
    nowUtc
  );
  const optColls = optCollNames.map((n) => db.collection(n));
  if (!optColls.length) {
    return { exited: false, reason: 'NO_OPT_COLLECTIONS' };
  }

  // Get SL/TP thresholds from main entry
  const mainEntryPrice = Number(openSpread?.main?.entry?.price);
  const { stopLossPrice, targetPrice } = buildExitPricesForShort(
    mainEntryPrice,
    STOPLOSS_PCT,
    TARGET_PCT
  );

  // Helper to scan across collections in chronological order
  async function scanAcrossCollections() {
    // If multiple months: scan month-by-month
    // For each month, constrain by the overlap range
    for (let i = 0; i < optColls.length; i += 1) {
      const name = optCollNames[i];
      const coll = optColls[i];

      const monthStart = moment.utc(name.slice(-6), 'MMYYYY').startOf('month');
      const monthEnd = monthStart.clone().endOf('month');

      const a = moment.utc(entryUtc);
      const b = moment.utc(nowUtc);
      const from = moment.max(a, monthStart).toDate();
      const to = moment.min(b, monthEnd).toDate();

      const hit = await scanFirstTickHit({
        optColl: coll,
        symbol: openSpread.main.symbol,
        fromUtc: from,
        toUtc: to,
        stopLossPrice,
        targetPrice,
        direction: 'SHORT',
      });
      if (hit) return { ...hit, collection: name };
    }
    return null;
  }

  // Exit reason priority: SL/TP first, then SuperTrend buySignal, then squareoff
  const hit = await scanAcrossCollections();
  if (hit) {
    const exitTickUtc = new Date(hit.tick.exchTradeTime);
    const exitIst = moment(exitTickUtc).tz(TZ);

    // Resolve hedge exit price at/before this time
    let hedgeExitTick = null;
    for (let i = 0; i < optColls.length && !hedgeExitTick; i += 1) {
      hedgeExitTick = await getLatestOptionTickBySymbol(optColls[i], {
        symbol: openSpread.hedge.symbol,
        atOrBeforeUtc: exitTickUtc,
      });
    }

    const mainExitPrice = Number(hit.tick.price);
    const hedgeExitPrice = Number(hedgeExitTick?.price);

    if (!Number.isFinite(hedgeExitPrice)) {
      // fallback: exit hedge at its latest tick (best-effort)
      let last = null;
      for (let i = 0; i < optColls.length && !last; i += 1) {
        last = await getLatestOptionTickBySymbol(optColls[i], {
          symbol: openSpread.hedge.symbol,
          atOrBeforeUtc: nowUtc,
        });
      }
      if (last) {
        hedgeExitTick = last;
      }
    }

    const hedgeExit = Number(hedgeExitTick?.price);

    const pnl = computeSpreadPnl({
      mainEntry: mainEntryPrice,
      mainExit: mainExitPrice,
      hedgeEntry: Number(openSpread?.hedge?.entry?.price),
      hedgeExit,
      qty: Number(openSpread?.config?.qty || QTY),
    });

    const patch = {
      status: 'CLOSED',
      updatedAt: new Date(),
      exit: {
        reason: hit.kind,
        time: exitIst.toISOString(true),
        tickTimeUtc: exitTickUtc,
        main: {
          symbol: openSpread.main.symbol,
          price: mainExitPrice,
        },
        hedge: {
          symbol: openSpread.hedge.symbol,
          price: hedgeExit,
        },
      },
      pnl,
    };

    await updateSpreadDoc(openSpread._id, patch);

    const line = `EXIT(${hit.kind}) expiry=${openSpread.expiry} main=${
      openSpread.main.symbol
    }@${mainExitPrice} hedge=${
      openSpread.hedge.symbol
    }@${hedgeExit} net=${pnl.net.toFixed(4)}`;
    info(line);
    appendPaperLog(line);

    return { exited: true, reason: hit.kind, pnl };
  }

  // SuperTrend buySignal exit (trend reversal) before squareoff
  // Only evaluate if we're not already at squareoff
  if (nowIst.isBefore(squareOffIst)) {
    // Build ST again and find first buySignal candle after entry
    const st = await buildTodaySupertrend({
      nowIst,
      stockSymbol: STOCK_SYMBOL,
      stockName: STOCK_NAME,
      timeInterval: INDEX_TF,
      fromTime: FROM_TIME,
      squareOffTime: SQUARE_OFF_TIME,
      atrPeriod: ATR_PERIOD,
      multiplier: MULTIPLIER,
      changeAtrCalculation: CHANGE_ATR_CALC,
      minCandles: MIN_CANDLES,
      candleGraceSeconds: CANDLE_GRACE_SECONDS,
      allowFormingCandle: ALLOW_FORMING_CANDLE,
      futCandlesCollection: FUT_CANDLES_COLLECTION,
    });

    const entryCandleTsMs = openSpread?.entry?.signalCandleTs
      ? new Date(openSpread.entry.signalCandleTs).getTime()
      : null;

    // Find first buySignal after entry signal candle
    const buyCandle = (st.stCandles || []).find((c) => {
      if (!c.buySignal) return false;
      const tsMs = new Date(c.ts).getTime();
      if (!entryCandleTsMs) return tsMs >= entryUtc.getTime();
      return tsMs > entryCandleTsMs;
    });

    // Heartbeat: last candle processed + most recent signal state while monitoring open trade
    try {
      const ts =
        buyCandle?.ts ||
        buyCandle?.datetime ||
        st?.lastConfirmedStCandle?.ts ||
        st?.lastConfirmedStCandle?.datetime;
      if (ts) hb.lastCandleTs = new Date(ts).toISOString();
      hb.lastSignal = buyCandle ? 'BUY' : 'NONE';
    } catch (e) {
      // ignore heartbeat errors
    }

    if (buyCandle) {
      // Exit at latest tick (main & hedge) at or before now
      const exitTickUtc = nowUtc;
      const exitIst = nowIst.clone();

      let mainExitTick = null;
      let hedgeExitTick = null;

      for (let i = 0; i < optColls.length && !mainExitTick; i += 1) {
        mainExitTick = await getLatestOptionTickBySymbol(optColls[i], {
          symbol: openSpread.main.symbol,
          atOrBeforeUtc: exitTickUtc,
        });
      }
      for (let i = 0; i < optColls.length && !hedgeExitTick; i += 1) {
        hedgeExitTick = await getLatestOptionTickBySymbol(optColls[i], {
          symbol: openSpread.hedge.symbol,
          atOrBeforeUtc: exitTickUtc,
        });
      }

      if (mainExitTick && hedgeExitTick) {
        const mainExitPrice = Number(mainExitTick.price);
        const hedgeExitPrice = Number(hedgeExitTick.price);

        const pnl = computeSpreadPnl({
          mainEntry: mainEntryPrice,
          mainExit: mainExitPrice,
          hedgeEntry: Number(openSpread?.hedge?.entry?.price),
          hedgeExit: hedgeExitPrice,
          qty: Number(openSpread?.config?.qty || QTY),
        });

        await updateSpreadDoc(openSpread._id, {
          status: 'CLOSED',
          updatedAt: new Date(),
          exit: {
            reason: 'BUY_SIGNAL',
            time: exitIst.toISOString(true),
            tickTimeUtc: exitTickUtc,
            main: { symbol: openSpread.main.symbol, price: mainExitPrice },
            hedge: { symbol: openSpread.hedge.symbol, price: hedgeExitPrice },
            buySignalCandleTs: buyCandle.ts || null,
          },
          pnl,
        });

        const line = `EXIT(BUY_SIGNAL) expiry=${openSpread.expiry} main=${
          openSpread.main.symbol
        }@${mainExitPrice} hedge=${
          openSpread.hedge.symbol
        }@${hedgeExitPrice} net=${pnl.net.toFixed(4)}`;
        info(line);
        appendPaperLog(line);

        return { exited: true, reason: 'BUY_SIGNAL', pnl };
      }
    }
  }

  // Square-off exit
  if (nowIst.isSameOrAfter(squareOffIst)) {
    const exitTickUtc = squareOffUtc;

    // Exit at latest ticks at/before squareoff
    const optColl = await getOptionCollectionForNow(db);

    const mainExitTick = await getLatestOptionTickBySymbol(optColl, {
      symbol: openSpread.main.symbol,
      atOrBeforeUtc: exitTickUtc,
    });
    const hedgeExitTick = await getLatestOptionTickBySymbol(optColl, {
      symbol: openSpread.hedge.symbol,
      atOrBeforeUtc: exitTickUtc,
    });

    if (mainExitTick && hedgeExitTick) {
      const exitIst = moment(exitTickUtc).tz(TZ);

      const mainExitPrice = Number(mainExitTick.price);
      const hedgeExitPrice = Number(hedgeExitTick.price);

      const pnl = computeSpreadPnl({
        mainEntry: mainEntryPrice,
        mainExit: mainExitPrice,
        hedgeEntry: Number(openSpread?.hedge?.entry?.price),
        hedgeExit: hedgeExitPrice,
        qty: Number(openSpread?.config?.qty || QTY),
      });

      await updateSpreadDoc(openSpread._id, {
        status: 'CLOSED',
        updatedAt: new Date(),
        exit: {
          reason: 'SQUARE_OFF',
          time: exitIst.toISOString(true),
          tickTimeUtc: exitTickUtc,
          main: { symbol: openSpread.main.symbol, price: mainExitPrice },
          hedge: { symbol: openSpread.hedge.symbol, price: hedgeExitPrice },
        },
        pnl,
      });

      const line = `EXIT(SQUARE_OFF) expiry=${openSpread.expiry} main=${
        openSpread.main.symbol
      }@${mainExitPrice} hedge=${
        openSpread.hedge.symbol
      }@${hedgeExitPrice} net=${pnl.net.toFixed(4)}`;
      info(line);
      appendPaperLog(line);

      return { exited: true, reason: 'SQUARE_OFF', pnl };
    }

    return { exited: false, reason: 'SQUARE_OFF_NO_TICKS' };
  }

  return { exited: false };
}

async function paperLoopOnce() {
  const nowIst = moment().tz(TZ);
  const expiry = nowIst.format('YYYY-MM-DD');

  hb.loops += 1;

  // If open spread, try exit first
  const open = await findOpenSpreadForExpiry(expiry);
  if (open) {
    hb.openSeen += 1;
    const ex = await maybeExitOpenSpread(nowIst, open);
    if (ex && ex.exited) hb.exited += 1;
    else if (ex && ex.reason) hbIncSkip(`EXIT_${ex.reason}`);
    return;
  }

  // Otherwise try enter
  const en = await maybeEnterTrade(nowIst);
  if (en && en.took) hb.entered += 1;
  else if (en && en.reason) hbIncSkip(en.reason);
}

// =====================
// Express handler
// =====================

const SuperTrendBearCallSpreadPaperTradeBTCController = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const nowIst = moment().tz(TZ);
      const expiry = nowIst.format('YYYY-MM-DD');

      // run one loop (enter/exit)
      await paperLoopOnce();

      // Return current open spread (if any) for easy UI
      const open = await findOpenSpreadForExpiry(expiry);

      res.status(200).json({
        success: true,
        strategy: STRATEGY,
        now: nowIst.toISOString(true),
        stockSymbol: STOCK_SYMBOL,
        stockName: STOCK_NAME,
        expiry,
        open,
        config: {
          TZ,
          CRON_EXPR,
          CRON_SECONDS,
          INDEX_TF,
          FROM_TIME,
          SQUARE_OFF_TIME,
          STOPLOSS_PCT,
          TARGET_PCT,
          MAIN_MONEYNESS,
          HEDGE_MONEYNESS,
          ATR_PERIOD,
          MULTIPLIER,
          CHANGE_ATR_CALC,
          FORCE_ENTRY,
          WEEKDAYS,
          MAX_TRADES_PER_DAY,
          MIN_CANDLES,
          CANDLE_GRACE_SECONDS,
          ALLOW_FORMING_CANDLE,
          PNL_POLL_MS,
          LOT_SIZE,
          LOTS,
          QTY,
          FUT_CANDLES_COLLECTION,
          OPT_TICKS_PREFIX,
        },
      });
    } catch (e) {
      error('Controller error', e);
      next(new AppError(e.message || 'Paper trade controller failed', 500));
    }
  }
);

// =====================
// Cron starter
// =====================

function startSuperTrendBearCallSpreadPaperTradeBTCron() {
  if (cronTask) {
    info('Cron already running.');
    return cronTask;
  }

  const expr = `${CRON_SECONDS} ${CRON_EXPR}`; // 6-field cron with seconds

  info(`Starting paper cron: ${expr} (TZ=${TZ})`);
  appendPaperLog(`Starting paper cron: ${expr} (TZ=${TZ})`);

  // Heartbeat so you can see progress even when there are no entries/exits.
  startHeartbeatIfNeeded();

  cronTask = cron.schedule(
    expr,
    async () => {
      if (cronInFlight) return;
      cronInFlight = true;

      try {
        resetOldDailyCounts();
        await paperLoopOnce();
      } catch (e) {
        error('Cron loop error', e);
        appendPaperLog(`Cron loop error: ${e.message || e}`);
      } finally {
        cronInFlight = false;
      }
    },
    { timezone: TZ }
  );

  // Optional PnL poller: updates OPEN spread with mark-to-market without spamming console
  setInterval(async () => {
    try {
      const nowIst = moment().tz(TZ);
      const expiry = nowIst.format('YYYY-MM-DD');
      const open = await findOpenSpreadForExpiry(expiry);
      if (!open) return;

      const nowUtc = new Date(nowIst.clone().utc().valueOf());
      const db = getDb();
      const optColl = await getOptionCollectionForNow(db);

      const mainTick = await getLatestOptionTickBySymbol(optColl, {
        symbol: open.main.symbol,
        atOrBeforeUtc: nowUtc,
      });
      const hedgeTick = await getLatestOptionTickBySymbol(optColl, {
        symbol: open.hedge.symbol,
        atOrBeforeUtc: nowUtc,
      });

      if (!mainTick || !hedgeTick) return;

      const pnl = computeSpreadPnl({
        mainEntry: Number(open?.main?.entry?.price),
        mainExit: Number(mainTick.price), // mark
        hedgeEntry: Number(open?.hedge?.entry?.price),
        hedgeExit: Number(hedgeTick.price), // mark
        qty: Number(open?.config?.qty || QTY),
      });

      await updateSpreadDoc(open._id, {
        updatedAt: new Date(),
        mtm: {
          time: nowIst.toISOString(true),
          mainPrice: Number(mainTick.price),
          hedgePrice: Number(hedgeTick.price),
          pnl,
        },
      });
    } catch {
      // keep silent
    }
  }, PNL_POLL_MS);

  return cronTask;
}

module.exports = {
  SuperTrendBearCallSpreadPaperTradeBTCController,
  startSuperTrendBearCallSpreadPaperTradeBTCron,
};
