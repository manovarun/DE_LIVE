/**
 * SuperTrendBullPutSpreadLiveTradeBTCController
 * ---------------------------------------------
 * BTC (Delta Exchange) SuperTrend Bull Put Spread LIVE-trade controller.
 *
 * Characteristics aligned with your BTC paper controllers:
 * - Futures candles from MongoDB (default: btcusd_candles_ts)
 * - Options ticks from monthly collections (OptionsTicksMMYYYY)
 * - BTC options treated as WEEKLY expiry (expiry string YYYY-MM-DD in TZ)
 * - Risk (SL/TP) applies ONLY on MAIN short put leg
 *
 * Delta REST signing per Delta.Exchange_doc.txt:
 * signature = HMAC_SHA256(secret, method + timestamp + path + query_string + payload) (hex)
 */

const cron = require('node-cron');
const moment = require('moment-timezone');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
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
    ({ addSupertrendToCandles } = require('../supertrend'));
  }
}
const { addEMAsToCandles } = require('../indicators/ema');

// =====================
// Env / Configuration
// =====================

const TZ = process.env.SUPERTREND_BPS_LIVE_TIMEZONE || 'Asia/Kolkata';

const CRON_EXPR = process.env.SUPERTREND_BPS_LIVE_CRON || '* 0-23 * * *';
const CRON_SECONDS = process.env.SUPERTREND_BPS_LIVE_CRON_SECONDS || '2-59/5';

const STOCK_NAME = process.env.SUPERTREND_BPS_LIVE_STOCK_NAME || 'BTC';
const STOCK_SYMBOL =
  process.env.SUPERTREND_BPS_LIVE_STOCK_SYMBOL ||
  process.env.SUPERTREND_BPS_LIVE_FUT_SYMBOL ||
  'BTCUSD';

const FUT_CANDLES_COLLECTION =
  process.env.SUPERTREND_BPS_LIVE_FUT_CANDLES_COLLECTION || 'btcusd_candles_ts';

const OPT_TICKS_PREFIX = process.env.DELTA_OPT_TICKS_PREFIX || 'OptionsTicks';

const INDEX_TF = process.env.SUPERTREND_BPS_LIVE_INDEX_TF || 'M3';
const FROM_TIME = process.env.SUPERTREND_BPS_LIVE_FROM_TIME || '00:00';
// Weekly expiry cutoff (IST) for Delta BTC weekly options (Friday). After this time, the "active" expiry rolls to next Friday.
const WEEKLY_EXPIRY_CUTOFF =
  process.env.SUPERTREND_BPS_LIVE_WEEKLY_EXPIRY_CUTOFF ||
  process.env.SUPERTREND_BPS_LIVE_DAILY_EXPIRY_CUTOFF ||
  '17:30';

// No-trade window: avoid entries during daily expiry hour; optionally force-close open spreads at the start.
const NO_TRADE_START =
  process.env.SUPERTREND_BPS_LIVE_NO_TRADE_START || '17:00';
const NO_TRADE_END = process.env.SUPERTREND_BPS_LIVE_NO_TRADE_END || '18:30';
const CLOSE_AT_NO_TRADE_START =
  String(
    process.env.SUPERTREND_BPS_LIVE_CLOSE_AT_NO_TRADE_START || 'true',
  ).toLowerCase() === 'true';

// SL/TP config (applies only to MAIN short put leg)
const STOPLOSS_ENABLED =
  String(
    process.env.SUPERTREND_BPS_LIVE_STOPLOSS_ENABLED || 'true',
  ).toLowerCase() === 'true';
const STOPLOSS_PCT = Number(
  process.env.SUPERTREND_BPS_LIVE_STOPLOSS_PCT || 5000,
);
const TARGET_PCT = Number(process.env.SUPERTREND_BPS_LIVE_TARGET_PCT || 50);
const TRAILING_STOP_PCT = Number(
  process.env.SUPERTREND_BPS_LIVE_TRAILING_STOP_PCT || 0,
);

const MAIN_MONEYNESS = process.env.SUPERTREND_BPS_LIVE_MAIN_MONEYNESS || 'ATM';
const HEDGE_MONEYNESS_RAW = process.env.SUPERTREND_BPS_LIVE_HEDGE_MONEYNESS;
const HEDGE_MONEYNESS =
  HEDGE_MONEYNESS_RAW === undefined ? 'OTM3' : String(HEDGE_MONEYNESS_RAW).trim();
const HEDGE_ENABLED = (() => {
  const v = String(HEDGE_MONEYNESS || '').trim().toUpperCase();
  return !(
    !v ||
    v === 'NONE' ||
    v === 'OFF' ||
    v === 'FALSE' ||
    v === 'DISABLED' ||
    v === 'NAKED'
  );
})();

const ATR_PERIOD = Math.max(
  1,
  Number(process.env.SUPERTREND_BPS_LIVE_ATR_PERIOD || 10),
);
const MULTIPLIER = Math.max(
  0.1,
  Number(process.env.SUPERTREND_BPS_LIVE_MULTIPLIER || 3),
);
// Role-specific SuperTrend params (for multi-timeframe setups)
// - TREND_* : used for HTF trend filter (e.g., M10)
// - ENTRY_* : used for entry signal timeframe (INDEX_TF)
// - EXIT_*  : used for exit/reversal timeframe (EXIT_TF)
// Defaults fall back to base ATR_PERIOD/MULTIPLIER for backward compatibility.
const TREND_ATR_PERIOD = Math.max(
  1,
  Number(process.env.SUPERTREND_BPS_LIVE_TREND_ATR_PERIOD || ATR_PERIOD),
);
const TREND_MULTIPLIER = Math.max(
  0.1,
  Number(process.env.SUPERTREND_BPS_LIVE_TREND_MULTIPLIER || MULTIPLIER),
);
const ENTRY_ATR_PERIOD = Math.max(
  1,
  Number(process.env.SUPERTREND_BPS_LIVE_ENTRY_ATR_PERIOD || ATR_PERIOD),
);
const ENTRY_MULTIPLIER = Math.max(
  0.1,
  Number(process.env.SUPERTREND_BPS_LIVE_ENTRY_MULTIPLIER || MULTIPLIER),
);
const EXIT_ATR_PERIOD = Math.max(
  1,
  Number(process.env.SUPERTREND_BPS_LIVE_EXIT_ATR_PERIOD || ATR_PERIOD),
);
const EXIT_MULTIPLIER = Math.max(
  0.1,
  Number(process.env.SUPERTREND_BPS_LIVE_EXIT_MULTIPLIER || MULTIPLIER),
);

const CHANGE_ATR_CALC =
  String(
    process.env.SUPERTREND_BPS_LIVE_CHANGE_ATR_CALC || 'true',
  ).toLowerCase() === 'true';

const FORCE_ENTRY =
  String(
    process.env.SUPERTREND_BPS_LIVE_FORCE_ENTRY || 'false',
  ).toLowerCase() === 'true';

const WEEKDAYS = (
  process.env.SUPERTREND_BPS_LIVE_WEEKDAYS || 'MON,TUE,WED,THU,FRI,SAT,SUN'
)
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const MAX_TRADES_PER_DAY = Math.max(
  1,
  Number(process.env.SUPERTREND_BPS_LIVE_MAX_TRADES_PER_DAY || 5),
);
const MIN_CANDLES = Math.max(
  5,
  Number(process.env.SUPERTREND_BPS_LIVE_MIN_CANDLES || 20),
);

const HTF_INDEX_TF = String(
  process.env.SUPERTREND_BPS_LIVE_HTF_INDEX_TF || '',
).trim();
const HTF_ENABLED =
  String(process.env.SUPERTREND_BPS_LIVE_HTF_ENABLED ?? 'true').toLowerCase() ===
  'true';
const MOMENTUM_HTF_ENABLED =
  String(
    process.env.SUPERTREND_BPS_LIVE_MOMENTUM_HTF_ENABLED || 'false',
  ).toLowerCase() === 'true';
const MOMENTUM_HTF_INDEX_TF = String(
  process.env.SUPERTREND_BPS_LIVE_MOMENTUM_HTF_INDEX_TF || '',
).trim();
const MOMENTUM_FAST_EMA_RAW = envPositiveInt(
  'SUPERTREND_BPS_LIVE_MOMENTUM_FAST_EMA',
  9,
);
const MOMENTUM_SLOW_EMA_RAW = envPositiveInt(
  'SUPERTREND_BPS_LIVE_MOMENTUM_SLOW_EMA',
  21,
);
const { fast: MOMENTUM_FAST_EMA, slow: MOMENTUM_SLOW_EMA } =
  normalizeMomentumEmaPair(
    MOMENTUM_FAST_EMA_RAW,
    MOMENTUM_SLOW_EMA_RAW,
    'SUPERTREND_BPS_LIVE',
  );
const EXIT_TF =
  String(process.env.SUPERTREND_BPS_LIVE_EXIT_TF || INDEX_TF).trim() ||
  INDEX_TF;

// Note: HTF has fewer candles intraday; keep this separate from MIN_CANDLES
const HTF_MIN_CANDLES = Math.max(
  5,
  Number(process.env.SUPERTREND_BPS_LIVE_HTF_MIN_CANDLES || 20),
);
const MOMENTUM_MIN_CANDLES = Math.max(
  MOMENTUM_SLOW_EMA + 2,
  envPositiveInt(
    'SUPERTREND_BPS_LIVE_MOMENTUM_MIN_CANDLES',
    MOMENTUM_SLOW_EMA + 2,
  ),
);
const EXIT_MIN_CANDLES = Math.max(
  5,
  Number(process.env.SUPERTREND_BPS_LIVE_EXIT_MIN_CANDLES || MIN_CANDLES),
);

const CANDLE_GRACE_SECONDS = Math.max(
  0,
  Number(process.env.SUPERTREND_BPS_LIVE_CANDLE_GRACE_SECONDS || 5),
);

// Separate grace windows for HTF and EXIT timeframe candle confirmation.
// Needed because M1/M2 candle inserts into Mongo can lag; using a single strict grace can delay LTF exits.
const HTF_CANDLE_GRACE_SECONDS = Math.max(
  0,
  Number(
    process.env.SUPERTREND_BPS_LIVE_HTF_CANDLE_GRACE_SECONDS ||
      CANDLE_GRACE_SECONDS,
  ),
);
const MOMENTUM_CANDLE_GRACE_SECONDS = Math.max(
  0,
  Number(
    process.env.SUPERTREND_BPS_LIVE_MOMENTUM_CANDLE_GRACE_SECONDS ||
      CANDLE_GRACE_SECONDS,
  ),
);
const EXIT_CANDLE_GRACE_SECONDS = Math.max(
  0,
  Number(
    process.env.SUPERTREND_BPS_LIVE_EXIT_CANDLE_GRACE_SECONDS ||
      CANDLE_GRACE_SECONDS,
  ),
);

const ALLOW_FORMING_CANDLE =
  String(
    process.env.SUPERTREND_BPS_LIVE_ALLOW_FORMING_CANDLE || 'false',
  ).toLowerCase() === 'true';
const FORMING_MIN_ELAPSED_PCT = Math.min(
  100,
  Math.max(
    0,
    Number(process.env.SUPERTREND_BPS_LIVE_FORMING_MIN_ELAPSED_PCT || 50),
  ),
);
const FORMING_SIGNAL_HOLD_SECS = Math.max(
  0,
  Number(process.env.SUPERTREND_BPS_LIVE_FORMING_SIGNAL_HOLD_SECS || 0),
);
const EXIT_ON_NEXT_OPEN_MISMATCH =
  String(
    process.env.SUPERTREND_BPS_LIVE_EXIT_ON_NEXT_OPEN_MISMATCH ??
      process.env.SUPERTREND_BPS_LIVE_EXIT_ON_NEXT_CLOSE_MISMATCH ??
      'false',
  ).toLowerCase() === 'true';

// Candle timestamp semantics for futures candles collection:
// - If true: candle `ts` in DB represents candle CLOSE time (end).
// - If false: candle `ts` represents candle OPEN time (start).
// NOTE: If `ts` is actually CLOSE but treated as OPEN, signals appear ~1 TF late.
const CANDLE_TS_IS_CLOSE =
  String(
    process.env.SUPERTREND_BPS_LIVE_CANDLE_TS_IS_CLOSE || 'false',
  ).toLowerCase() === 'true';

let candleTsHeuristicWarned = false;
const formingSignalHoldState = new Map();
const PNL_POLL_MS = Math.max(
  2000,
  Number(process.env.SUPERTREND_BPS_LIVE_PNL_POLL_MS || 15000),
);
const LOG_SKIP_REASONS =
  String(process.env.SUPERTREND_BPS_LIVE_LOG_SKIP_REASONS || 'false').toLowerCase() ===
  'true';
const HEARTBEAT_MS = Math.max(
  0,
  Number(process.env.SUPERTREND_BPS_LIVE_HEARTBEAT_MS || 15000),
);

// File logging (paper-controller parity)
const LOG_DIR = process.env.SUPERTREND_BPS_LIVE_LOG_DIR || './logs/livetrade';
const LOG_TO_FILE =
  String(
    process.env.SUPERTREND_BPS_LIVE_LOG_TO_FILE || 'false',
  ).toLowerCase() === 'true';

// Position sizing for BTC options on Delta: treat LOT_SIZE as contract size (e.g. 0.001) and LOTS as number of contracts
const LOT_SIZE = Number(process.env.SUPERTREND_BPS_LIVE_LOT_SIZE || 0.001);
const LOTS = Math.max(
  1,
  parseInt(process.env.SUPERTREND_BPS_LIVE_LOTS || '1', 10) || 1,
);
const ORDER_SIZE = LOTS;
// Contract multiplier (BTC per option contract) used for PnL scaling.
// If SUPERTREND_BPS_LIVE_CONTRACT_MULTIPLIER is not set, fall back to LOT_SIZE for backward compatibility.
const CONTRACT_MULTIPLIER = Number(
  process.env.SUPERTREND_BPS_LIVE_CONTRACT_MULTIPLIER || LOT_SIZE || 0.001,
);
// QTY is kept for PnL scaling/logging parity with paper controller
const QTY = CONTRACT_MULTIPLIER * ORDER_SIZE;

// Delta REST
const DELTA_BASE = (
  process.env.DELTA_BASE || 'https://api.india.delta.exchange'
).replace(/\/+$/, '');
const DELTA_KEY = process.env.DELTA_KEY || '';
const DELTA_SECRET = process.env.DELTA_SECRET || '';
const DELTA_USER_AGENT =
  process.env.DELTA_USER_AGENT || 'delta-exchange-node-client';
const DELTA_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.DELTA_TIMEOUT_MS || 20000),
);

// Auto topup (Delta) - helps avoid liquidation by automatically topping up margin on the SHORT position
const AUTO_TOPUP_ENABLED =
  String(
    process.env.SUPERTREND_BPS_LIVE_AUTO_TOPUP_ENABLED || 'false',
  ).toLowerCase() === 'true';
// Delta docs list auto_topup as boolean, but examples show string. Keep an option to send as string.
const AUTO_TOPUP_AS_STRING =
  String(
    process.env.SUPERTREND_BPS_LIVE_AUTO_TOPUP_AS_STRING || 'false',
  ).toLowerCase() === 'true';

// Order leverage (Delta) - sets leverage for OPEN ORDERS on the product (helps control order margin)
const ORDER_LEVERAGE_ENABLED =
  String(
    process.env.SUPERTREND_BPS_LIVE_ORDER_LEVERAGE_ENABLED || 'false',
  ).toLowerCase() === 'true';
const ORDER_LEVERAGE = String(
  process.env.SUPERTREND_BPS_LIVE_ORDER_LEVERAGE || '',
).trim(); // e.g. "25"
const ORDER_LEVERAGE_APPLY_TO = String(
  process.env.SUPERTREND_BPS_LIVE_ORDER_LEVERAGE_APPLY_TO || 'MAIN',
).toUpperCase(); // MAIN | HEDGE | BOTH

const STRATEGY = 'ST_BPS_M5_STRGY';
const SPREADS_COLLECTION = 'ST_BPS_M5_COLLE';
const PRODUCT_CACHE_COLLECTION = 'ST_BPS_M5_CACHE';

// =====================
// Logging helpers
// =====================

let _logDirAbs = null;
let _logFilePath = null;
let _fileLoggingReady = false;

function nowTs(tz = TZ) {
  return moment().tz(tz).format('YYYY-MM-DD HH:mm:ss');
}

function _resolveLogFilePath(now = null) {
  const day = (now ? moment(now) : moment()).tz(TZ).format('YYYYMMDD');
  const fname = `ST_BPS_M5_LOG_${day}.log`;
  return path.join(_logDirAbs, fname);
}

function initFileLogger() {
  if (!LOG_TO_FILE) return false;
  try {
    _logDirAbs = path.isAbsolute(LOG_DIR)
      ? LOG_DIR
      : path.join(process.cwd(), LOG_DIR);
    fs.mkdirSync(_logDirAbs, { recursive: true });
    _logFilePath = _resolveLogFilePath();
    // touch file so folder + file are guaranteed to exist
    fs.appendFileSync(_logFilePath, '');
    _fileLoggingReady = true;
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[${nowTs()}] [ST_BPS_M5_LIVE][WARN] File logging init failed (dir=${LOG_DIR}): ${
        e && e.message ? e.message : e
      }`,
    );
    _fileLoggingReady = false;
    return false;
  }
}

function writeToFile(line) {
  if (!LOG_TO_FILE || !_fileLoggingReady) return;
  try {
    const expected = _resolveLogFilePath();
    if (_logFilePath !== expected) {
      _logFilePath = expected; // day rollover
      fs.appendFileSync(_logFilePath, '');
    }
    fs.appendFile(
      _logFilePath,
      `${line}
`,
      () => {},
    );
  } catch {
    // silent
  }
}

function info(msg) {
  const line = `[${nowTs()}] [ST_BPS_M5_LIVE] ${msg}`;
  // eslint-disable-next-line no-console
  // console.log(line);
  writeToFile(line);
}
function warn(msg) {
  const line = `[${nowTs()}] [ST_BPS_M5_LIVE][WARN] ${msg}`;
  // eslint-disable-next-line no-console
  console.warn(line);
  writeToFile(line);
}
function error(msg, err) {
  const line = `[${nowTs()}] [ST_BPS_M5_LIVE][ERROR] ${msg}`;
  // eslint-disable-next-line no-console
  console.error(line);
  writeToFile(line);
  if (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    try {
      const errLine = err && err.stack ? String(err.stack) : String(err);
      writeToFile(errLine);
    } catch {
      // silent
    }
  }
}

// Initialize file logging at module load (no impact if disabled)
initFileLogger();

// =====================
// DB helpers
// =====================

function getDb() {
  const db = mongoose?.connection?.db;
  if (!db)
    throw new Error('MongoDB not connected (mongoose.connection.db missing).');
  return db;
}

async function findOneSorted(coll, filter, sort) {
  return coll.find(filter).sort(sort).limit(1).next();
}

async function createSpreadDoc(doc) {
  const db = getDb();
  const coll = db.collection(SPREADS_COLLECTION);
  const now = new Date();
  const toInsert = {
    ...doc,
    createdAt: doc.createdAt || now,
    updatedAt: doc.updatedAt || now,
  };
  const res = await coll.insertOne(toInsert);
  return { ...toInsert, _id: res.insertedId };
}

async function updateSpreadDoc(id, patch) {
  const db = getDb();
  const coll = db.collection(SPREADS_COLLECTION);
  let _id = id;
  try {
    if (typeof id === 'string' && mongoose?.Types?.ObjectId?.isValid(id))
      _id = new mongoose.Types.ObjectId(id);
  } catch (_) {}
  await coll.updateOne({ _id }, { $set: { ...patch, updatedAt: new Date() } });
}

// =====================
// Delta REST helpers (HMAC signing)
// =====================

function hmacSha256Hex(secret, message) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(String(message))
    .digest('hex');
}

function buildSortedQueryString(query) {
  if (!query || typeof query !== 'object') return '';
  const keys = Object.keys(query).filter(
    (k) => query[k] !== undefined && query[k] !== null,
  );
  if (!keys.length) return '';
  keys.sort();
  const usp = new URLSearchParams();
  keys.forEach((k) => usp.append(k, String(query[k])));
  return `?${usp.toString()}`;
}

function httpRequestJson(method, urlStr, headers, bodyStr, timeoutMs) {
  const url = new URL(urlStr);
  const opts = {
    method,
    hostname: url.hostname,
    path: url.pathname + url.search,
    protocol: url.protocol,
    headers,
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        const headersLower = {};
        Object.entries(res.headers || {}).forEach(
          ([k, v]) => (headersLower[String(k).toLowerCase()] = v),
        );
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = null;
        }
        resolve({ status, headers: headersLower, raw: data, json: parsed });
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new Error(`Delta request timeout after ${timeoutMs}ms`));
      } catch {}
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function deltaRequest(method, path, { query, body, auth } = {}) {
  const m = String(method || 'GET').toUpperCase();
  const p = path.startsWith('/') ? path : `/${path}`;
  const qs = buildSortedQueryString(query);
  const payload = body ? JSON.stringify(body) : '';
  const url = `${DELTA_BASE}${p}${qs}`;

  const headers = {
    'User-Agent': DELTA_USER_AGENT,
    Accept: 'application/json',
  };
  if (payload) headers['Content-Type'] = 'application/json';

  if (auth) {
    if (!DELTA_KEY || !DELTA_SECRET)
      throw new Error('Missing DELTA_KEY / DELTA_SECRET in env.');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signatureData = m + timestamp + p + qs + payload;
    headers['api-key'] = DELTA_KEY;
    headers.timestamp = timestamp;
    headers.signature = hmacSha256Hex(DELTA_SECRET, signatureData);
  }

  const res = await httpRequestJson(m, url, headers, payload, DELTA_TIMEOUT_MS);

  if (res.status === 429) {
    const reset = res.headers['x-rate-limit-reset'];
    const waitMs = Math.min(5000, Math.max(250, Number(reset || 0)));
    warn(`Rate limited (429). Backing off ${waitMs}ms.`);
    await new Promise((r) => setTimeout(r, waitMs));
    const retry = await httpRequestJson(
      m,
      url,
      headers,
      payload,
      DELTA_TIMEOUT_MS,
    );
    if (retry.status >= 200 && retry.status < 300) return retry.json;
    throw new Error(`Delta API error ${retry.status}: ${retry.raw}`);
  }

  if (res.status >= 200 && res.status < 300) return res.json;

  const errCode = res?.json?.error || res?.json?.error?.code;
  if (
    String(errCode || '')
      .toLowerCase()
      .includes('signatureexpired')
  ) {
    warn('SignatureExpired from Delta. Retrying once with fresh timestamp.');
    return deltaRequest(m, p, { query, body, auth });
  }

  throw new Error(`Delta API error ${res.status}: ${res.raw}`);
}

// =====================
// Ticker mark-price helper (Delta REST) - used for MTM display when last-trade ticks are stale
// =====================

const MTM_STALE_MS = 30000; // If last-trade tick older than this, use Delta ticker mark_price for MTM
const _tickerMarkCacheBySymbol = new Map(); // symbol -> { price, tsMs }

async function getMarkPriceFromDeltaTicker(symbol) {
  const sym = String(symbol || '').trim();
  if (!sym) return Number.NaN;

  // Public endpoint (no auth): /v2/tickers/{symbol}
  const path = `/v2/tickers/${encodeURIComponent(sym)}`;
  const resp = await deltaRequest('GET', path, { auth: false });
  const r = resp?.result || resp;

  // Prefer mark_price (matches Delta UI better than last trade in illiquid options)
  const mark = Number(r?.mark_price);
  if (Number.isFinite(mark)) return mark;

  // Fallback to mid of best bid/ask if present
  const bid = Number(r?.quotes?.best_bid);
  const ask = Number(r?.quotes?.best_ask);
  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;

  // Fallback to close/last
  const close = Number(r?.close);
  if (Number.isFinite(close)) return close;

  return Number.NaN;
}

async function getMarkPriceFromDeltaTickerCached(symbol) {
  const sym = String(symbol || '').trim();
  if (!sym) return Number.NaN;

  const now = Date.now();
  const cached = _tickerMarkCacheBySymbol.get(sym);
  // Small cache to avoid hammering REST on every poll
  if (cached && Number.isFinite(cached.price) && now - cached.tsMs < 2000) {
    return cached.price;
  }

  try {
    const price = await getMarkPriceFromDeltaTicker(sym);
    if (Number.isFinite(price))
      _tickerMarkCacheBySymbol.set(sym, { price, tsMs: now });
    return price;
  } catch (e) {
    return Number.NaN;
  }
}

async function pickMtmMarkPriceForSymbol(
  symbol,
  lastTradePrice,
  lastTradeAgeMs,
) {
  const ltp = Number(lastTradePrice);

  // Prefer Delta ticker mark_price for MTM (matches exchange UI better than last trade).
  const mark = await getMarkPriceFromDeltaTickerCached(symbol);
  if (Number.isFinite(mark)) return mark;

  // If mark is unavailable, fall back to last-traded price when it's reasonably fresh.
  const age =
    typeof lastTradeAgeMs === 'number' && Number.isFinite(lastTradeAgeMs)
      ? lastTradeAgeMs
      : Number.NaN;

  const hasRecentTrade =
    Number.isFinite(ltp) && Number.isFinite(age) && age <= MTM_STALE_MS;
  if (hasRecentTrade) return ltp;

  return Number.NaN;
}

// =====================
// Auto topup helper (Delta)
// =====================

const _autoTopupAppliedProductIds = new Set();

function buildAutoTopupBody(productId, enabled) {
  // The docs show example body with "auto_topup": "false" but parameter type says boolean.
  // Support both formats via env toggle for compatibility.
  return {
    product_id: Number(productId),
    auto_topup: AUTO_TOPUP_AS_STRING ? (enabled ? 'true' : 'false') : !!enabled,
  };
}

async function setPositionAutoTopup(productId, enabled, contextLabel = '') {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const body = buildAutoTopupBody(pid, enabled);

  info(
    `AUTO_TOPUP request ${
      contextLabel ? '(' + contextLabel + ') ' : ''
    }body=${JSON.stringify(body)}`,
  );

  const resp = await deltaRequest('PUT', '/v2/positions/auto_topup', {
    body,
    auth: true,
  });
  return resp;
}

async function ensureAutoTopupOnce(productId, contextLabel = '') {
  if (!AUTO_TOPUP_ENABLED) return;
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (_autoTopupAppliedProductIds.has(pid)) return;

  try {
    await setPositionAutoTopup(pid, true, contextLabel);
    _autoTopupAppliedProductIds.add(pid);
    info(
      `AUTO_TOPUP enabled for product_id=${pid} ${
        contextLabel ? '(' + contextLabel + ')' : ''
      }`,
    );
  } catch (e) {
    warn(
      `AUTO_TOPUP failed for product_id=${pid} ${
        contextLabel ? '(' + contextLabel + ')' : ''
      }: ${e && e.message ? e.message : e}`,
    );
  }
}

// =====================
// Order leverage helper (Delta) - applies to OPEN ORDERS for a product
// =====================

const _orderLeverageAppliedByProductId = new Map();

function _normalizeLeverageValue(v) {
  const val = String(v ?? '').trim();
  if (!val) return null;
  // keep as string (Delta docs accept string; examples also show numeric)
  return val;
}

function _shouldApplyOrderLeverageForLeg(legLabel) {
  const mode = String(ORDER_LEVERAGE_APPLY_TO || 'MAIN').toUpperCase();
  const leg = String(legLabel || '').toUpperCase();
  if (mode === 'BOTH') return true;
  if (mode === 'MAIN' && leg === 'MAIN') return true;
  if (mode === 'HEDGE' && leg === 'HEDGE') return true;
  return false;
}

async function setOrderLeverage(productId, leverageValue, contextLabel = '') {
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const lev = _normalizeLeverageValue(leverageValue);
  if (!lev) return null;

  const body = { leverage: lev };
  info(
    `ORDER_LEVERAGE request ${
      contextLabel ? '(' + contextLabel + ') ' : ''
    }product_id=${pid} body=${JSON.stringify(body)}`,
  );

  const resp = await deltaRequest(
    'POST',
    `/v2/products/${pid}/orders/leverage`,
    {
      body,
      auth: true,
    },
  );
  return resp;
}

async function ensureOrderLeverageOnce(
  productId,
  legLabel = '',
  contextLabel = '',
) {
  if (!ORDER_LEVERAGE_ENABLED) return;
  if (!_shouldApplyOrderLeverageForLeg(legLabel)) return;
  const pid = Number(productId);
  if (!Number.isFinite(pid) || pid <= 0) return;

  const lev = _normalizeLeverageValue(ORDER_LEVERAGE);
  if (!lev) {
    warn('ORDER_LEVERAGE enabled but ORDER_LEVERAGE value is empty; skipping.');
    return;
  }

  const prev = _orderLeverageAppliedByProductId.get(pid);
  if (prev === lev) return;

  try {
    await setOrderLeverage(pid, lev, contextLabel);
    _orderLeverageAppliedByProductId.set(pid, lev);
    info(
      `ORDER_LEVERAGE set to ${lev} for product_id=${pid} ${
        contextLabel ? '(' + contextLabel + ')' : ''
      }`,
    );
  } catch (e) {
    warn(
      `ORDER_LEVERAGE failed for product_id=${pid} ${
        contextLabel ? '(' + contextLabel + ')' : ''
      }: ${e && e.message ? e.message : e}`,
    );
  }
}

async function getProductIdBySymbol(symbol) {
  const sym = String(symbol || '').trim();
  if (!sym) throw new Error('getProductIdBySymbol: empty symbol');

  const db = getDb();
  const cache = db.collection(PRODUCT_CACHE_COLLECTION);

  const cached = await cache.findOne({ symbol: sym });
  if (cached && Number.isFinite(Number(cached.product_id)))
    return Number(cached.product_id);

  let after = null;
  for (let i = 0; i < 50; i += 1) {
    const query = { page_size: 1000 };
    if (after) query.after = after;

    const resp = await deltaRequest('GET', '/v2/products', {
      query,
      auth: false,
    });
    const arr = resp?.result || [];
    const hit = arr.find((p) => String(p.symbol) === sym);
    if (hit && Number.isFinite(Number(hit.id))) {
      const pid = Number(hit.id);
      await cache.updateOne(
        { symbol: sym },
        { $set: { symbol: sym, product_id: pid, updatedAt: new Date() } },
        { upsert: true },
      );
      return pid;
    }

    after = resp?.meta?.after;
    if (!after) break;
  }

  throw new Error(`Product not found for symbol=${sym}`);
}

async function placeOrder({
  product_id,
  side,
  size,
  order_type = 'market_order',
  limit_price,
  stop_order_type,
  stop_price,
  reduce_only,
  client_order_id,
}) {
  const body = {
    product_id: Number(product_id),
    side: String(side),
    size: Number(size),
    order_type: String(order_type),
    reduce_only: !!reduce_only,
    client_order_id: client_order_id ? String(client_order_id) : undefined,
  };
  if (limit_price !== undefined && limit_price !== null)
    body.limit_price = String(limit_price);
  if (stop_order_type) body.stop_order_type = String(stop_order_type);
  if (stop_price !== undefined && stop_price !== null)
    body.stop_price = String(stop_price);

  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const resp = await deltaRequest('POST', '/v2/orders', { body, auth: true });
  if (!resp?.success)
    throw new Error(`Order placement failed: ${JSON.stringify(resp)}`);
  return resp.result;
}

async function getRecentFills({
  product_ids,
  startTimeMicros,
  endTimeMicros,
  page_size = 100,
}) {
  const query = {
    product_ids: Array.isArray(product_ids)
      ? product_ids.join(',')
      : String(product_ids || ''),
    start_time: Number(startTimeMicros),
    end_time: Number(endTimeMicros),
    page_size: Number(page_size),
  };
  const resp = await deltaRequest('GET', '/v2/fills', { query, auth: true });
  if (!resp?.success)
    throw new Error(`Fills fetch failed: ${JSON.stringify(resp)}`);
  return resp.result || [];
}

function computeVwapFromFills(fills) {
  let notional = 0;
  let qty = 0;
  (fills || []).forEach((f) => {
    const p = Number(f.price);
    const s = Number(f.size);
    if (!Number.isFinite(p) || !Number.isFinite(s)) return;
    notional += p * s;
    qty += s;
  });
  if (!qty) return null;
  return notional / qty;
}

// =====================
// Client order id helper (Delta limit: <= 32 chars)
// =====================
function buildClientOrderId(runId, tag) {
  const t = String(tag || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  const base = `${STRATEGY}|${runId}|${t}`;
  const hash = crypto
    .createHash('sha1')
    .update(base)
    .digest('hex')
    .slice(0, 20);
  // Prefix kept short to stay within 32 chars deterministically
  return `SBPS${t}${hash}`.slice(0, 32);
}

// =====================
// Time / candle helpers
// =====================

function tfToMs(tf) {
  const s = String(tf || '')
    .toUpperCase()
    .trim();
  const m = s.match(/^M(\d+)$/);
  if (m) return Number(m[1]) * 60 * 1000;
  const h = s.match(/^H(\d+)$/);
  if (h) return Number(h[1]) * 60 * 60 * 1000;
  if (s === 'D1') return 24 * 60 * 60 * 1000;
  throw new Error(`Unsupported timeframe: ${tf}`);
}

function elapsedMsInCurrentTf(nowIst, tfMs) {
  const nowMs = nowIst ? Number(nowIst.valueOf()) : Date.now();
  return ((nowMs % tfMs) + tfMs) % tfMs;
}

function minElapsedMsForTf(tfMs, elapsedPct) {
  const pct = Math.min(100, Math.max(0, Number(elapsedPct || 0)));
  return Math.floor((tfMs * pct) / 100);
}

function isCandleClosedAt({
  candleTsMs,
  tfMs,
  nowMs,
  candleGraceSeconds = 0,
  candleTsIsClose = false,
}) {
  const graceMs = Math.max(0, Number(candleGraceSeconds || 0)) * 1000;
  const closeMs = candleTsIsClose ? candleTsMs : candleTsMs + tfMs;
  return nowMs >= closeMs + graceMs;
}

function isNextCandleClosedAfterSignal({
  signalCandleTsMs,
  tfMs,
  nowMs,
  candleGraceSeconds = 0,
  candleTsIsClose = false,
}) {
  const graceMs = Math.max(0, Number(candleGraceSeconds || 0)) * 1000;
  const signalCloseMs = candleTsIsClose
    ? signalCandleTsMs
    : signalCandleTsMs + tfMs;
  const nextCloseMs = signalCloseMs + tfMs;
  return nowMs >= nextCloseMs + graceMs;
}

function buildFormingSignalStateKey(expiry, tf, side, signalTsMs) {
  return `${expiry}|${tf}|${side}|${signalTsMs}`;
}

function clearFormingSignalStateForPrefix(prefix, keepKey = null) {
  for (const k of formingSignalHoldState.keys()) {
    if (!k.startsWith(prefix)) continue;
    if (keepKey && k === keepKey) continue;
    formingSignalHoldState.delete(k);
  }
}

function weekdayKey(nowIst) {
  const wd = nowIst.format('ddd').toUpperCase();
  return wd.slice(0, 3);
}

function hhmmToMoment(dayStr, hhmm, tz) {
  const [h, m] = String(hhmm || '00:00')
    .split(':')
    .map((x) => Number(x));
  return moment
    .tz(dayStr, 'YYYY-MM-DD', tz)
    .hour(h || 0)
    .minute(m || 0)
    .second(0)
    .millisecond(0);
}

function getActiveWeeklyExpiry(nowIst) {
  const friday = nowIst.clone().isoWeekday(5);
  const dayStr = friday.format('YYYY-MM-DD');
  const cutoff = hhmmToMoment(dayStr, WEEKLY_EXPIRY_CUTOFF, TZ);
  if (nowIst.isSameOrAfter(cutoff))
    return friday.add(7, 'days').format('YYYY-MM-DD');
  return dayStr;
}

// =====================
// Futures candles → SuperTrend
// =====================

function getNoTradeWindow(nowIst) {
  const dayStr = nowIst.format('YYYY-MM-DD');
  const start = hhmmToMoment(dayStr, NO_TRADE_START, TZ);
  let end = hhmmToMoment(dayStr, NO_TRADE_END, TZ);
  // Support windows that cross midnight (end <= start).
  if (end.isSameOrBefore(start)) end = end.add(1, 'day');
  return { start, end };
}

function isInNoTradeWindow(nowIst) {
  const w = getNoTradeWindow(nowIst);
  return nowIst.isSameOrAfter(w.start) && nowIst.isBefore(w.end);
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

  const rows = await coll
    .find({
      stockSymbol: String(stockSymbol),
      stockName: String(stockName),
      timeInterval: String(timeInterval),
      ts: { $gte: new Date(fromUtc), $lte: new Date(toUtc) },
    })
    .sort({ ts: 1 })
    .limit(5000)
    .toArray();

  return (rows || []).map((r) => {
    const ts = r.ts || r.timestamp || r.datetime;
    return {
      ...r,
      ts: ts instanceof Date ? ts : new Date(ts),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
    };
  });
}

function pickLastConfirmedCandle(
  candles,
  tfMs,
  now = new Date(),
  allowFormingCandle = false,
  candleGraceSeconds = 0,
  candleTsIsClose = false,
) {
  if (!candles || !candles.length) return null;
  const nowMs = now.getTime();
  const graceMs = Math.max(0, Number(candleGraceSeconds || 0)) * 1000;

  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const c = candles[i];
    const tsMs = new Date(c.ts).getTime();
    const end = candleTsIsClose ? tsMs : tsMs + tfMs;
    const isClosed = nowMs >= end + graceMs;
    if (allowFormingCandle) return c;
    if (isClosed) return c;
  }
  return null;
}

function stTrendDir(sig) {
  if (!sig) return null;
  const stx = sig.supertrend || {};
  const isUp = stx.isUpTrend ?? sig.isUpTrend;
  const trendVal = stx.trend ?? sig.trend;
  if (isUp === true || Number(trendVal) === 1) return 'UP';
  if (isUp === false || Number(trendVal) === -1) return 'DOWN';
  return null;
}

function tfEnabled(tf) {
  return String(tf || '').trim().length > 0;
}

function envPositiveInt(envKey, fallback) {
  const n = parseInt(String(process.env[envKey] || ''), 10);
  if (Number.isInteger(n) && n > 0) return n;
  return fallback;
}

function normalizeMomentumEmaPair(fast, slow, tag) {
  if (fast < slow) return { fast, slow };
  const fallbackFast = 9;
  const fallbackSlow = 21;
  warn(
    `[${tag}] Invalid momentum EMA config: FAST_EMA=${fast}, SLOW_EMA=${slow}. ` +
      `FAST_EMA must be < SLOW_EMA. Falling back to ${fallbackFast}/${fallbackSlow}.`,
  );
  return { fast: fallbackFast, slow: fallbackSlow };
}

function emaMomentumDir(candles, fastPeriod, slowPeriod) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const fast = Number(fastPeriod);
  const slow = Number(slowPeriod);
  if (!Number.isInteger(fast) || !Number.isInteger(slow) || fast < 1 || slow < 1)
    return null;
  if (candles.length < Math.max(fast, slow)) return null;

  try {
    const withEma = addEMAsToCandles(candles, {
      periods: [fast, slow],
      priceField: 'close',
    });
    const last = withEma[withEma.length - 1];
    const fastVal = Number(last?.emas?.[fast]);
    const slowVal = Number(last?.emas?.[slow]);
    if (!Number.isFinite(fastVal) || !Number.isFinite(slowVal)) return null;
    if (fastVal > slowVal) return 'UP';
    if (fastVal < slowVal) return 'DOWN';
  } catch (err) {
    warn(`Momentum EMA calculation failed: ${err?.message || err}`);
    return null;
  }
  return null;
}

function enrichSupertrendCandles(
  stCandles,
  stockSymbol,
  stockName,
  timeInterval,
) {
  return (stCandles || []).map((c) => ({
    ...c,
    stockSymbol,
    stockName,
    timeInterval,
  }));
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
  candleTsIsClose,
  futCandlesCollection,
}) {
  const tfMs = tfToMs(timeInterval);

  const dayStr = nowIst.format('YYYY-MM-DD');
  const fromIst = hhmmToMoment(dayStr, fromTime, TZ);
  const toIst = nowIst.clone();

  const warmupCandles = Math.max(
    2 * minCandles,
    minCandles + atrPeriod + 5,
    50,
  );
  const warmupFromIst = fromIst
    .clone()
    .subtract(warmupCandles * tfMs, 'milliseconds');
  const warmupFromUtc = new Date(warmupFromIst.clone().utc().valueOf());

  const toUtc = new Date(toIst.clone().utc().valueOf());

  const candles = await loadCandlesRange({
    stockSymbol,
    stockName,
    timeInterval,
    fromUtc: warmupFromUtc,
    toUtc,
    collectionName: futCandlesCollection,
  });

  // Heuristic safety: prevent "forming candle" entry if candle `ts` is actually OPEN-time
  // but config is set to treat it as CLOSE-time. We detect this by checking if lastTradeTime > ts.
  let candleTsIsCloseResolved = candleTsIsClose;
  if (candleTsIsCloseResolved && candles && candles.length) {
    const last = candles[candles.length - 1];
    const tsMs = new Date(last.ts).getTime();
    const lttRaw = last.lastTradeTime;
    const ltt =
      lttRaw instanceof Date
        ? lttRaw
        : lttRaw && lttRaw.$date
          ? new Date(lttRaw.$date)
          : null;

    if (ltt && ltt.getTime() > tsMs + 2000) {
      if (!candleTsHeuristicWarned) {
        warn(
          `Detected fut candle lastTradeTime (${new Date(ltt).toISOString()}) > ts (${new Date(tsMs).toISOString()}). ` +
            `Assuming candle ts is OPEN-time (CANDLE_TS_IS_CLOSE=false) to prevent forming-candle entry. ` +
            `Set SUPERTREND_BPS_LIVE_CANDLE_TS_IS_CLOSE=false explicitly in .env.`,
        );
        candleTsHeuristicWarned = true;
      }
      candleTsIsCloseResolved = false;
    }
  }

  const lastConfirmed = pickLastConfirmedCandle(
    candles,
    tfMs,
    new Date(),
    allowFormingCandle,
    candleGraceSeconds,
    candleTsIsCloseResolved,
  );

  if (!candles.length || !lastConfirmed) {
    return {
      candles,
      stCandles: [],
      lastConfirmedCandle: null,
      lastConfirmedStCandle: null,
      tfMs,
    };
  }

  const lastConfirmedTs = new Date(lastConfirmed.ts).getTime();
  const confirmedCandles = candles.filter(
    (c) => new Date(c.ts).getTime() <= lastConfirmedTs,
  );

  const stCandlesRaw = addSupertrendToCandles(confirmedCandles, {
    atrPeriod,
    multiplier,
    changeAtrCalculation,
  });
  const stCandles = enrichSupertrendCandles(
    stCandlesRaw,
    stockSymbol,
    stockName,
    timeInterval,
  );
  const lastConfirmedStCandle = stCandles.length
    ? stCandles[stCandles.length - 1]
    : null;

  return {
    candles: confirmedCandles,
    stCandles,
    lastConfirmedCandle: lastConfirmed,
    lastConfirmedStCandle,
    tfMs,
  };
}

// =====================
// Options tick helpers
// =====================

function pickOptTicksCollectionName(prefix, date) {
  const d = moment(date);
  return `${prefix}${d.format('MMYYYY')}`;
}

async function getOptionCollectionForNow(db) {
  const name = pickOptTicksCollectionName(OPT_TICKS_PREFIX, new Date());
  return db.collection(name);
}

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
    `Invalid moneyness: ${m}. Use ATM, ITM1, ITM2, OTM1, OTM2...`,
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
    }
  }
  return bestIdx;
}

function pickStrikeByMoneyness(strikes, underlying, moneyness, optionType) {
  const { kind, n } = parseMoneyness(moneyness);
  const idxAtm = pickAtmIndex(strikes, underlying);
  if (idxAtm < 0) return Number.NaN;

  const isCall = String(optionType).toUpperCase() === 'C';

  if (kind === 'ATM') return strikes[idxAtm];

  if (isCall) {
    if (kind === 'ITM') return strikes[Math.max(0, idxAtm - n)];
    return strikes[Math.min(strikes.length - 1, idxAtm + n)];
  }

  // put
  if (kind === 'ITM') return strikes[Math.min(strikes.length - 1, idxAtm + n)];
  return strikes[Math.max(0, idxAtm - n)];
}

async function getAvailableStrikesForExpiry(
  optColl,
  { underlying, optionType, expiry },
) {
  const strikes = await optColl.distinct('strike', {
    underlying: String(underlying),
    optionType: String(optionType),
    expiry: String(expiry),
  });
  return (strikes || [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
}

async function getLatestOptionTickByStrike(
  optColl,
  { underlying, optionType, expiry, strike, atOrBeforeUtc },
) {
  const q = {
    underlying: String(underlying),
    optionType: String(optionType),
    expiry: String(expiry),
    strike: Number(strike),
  };
  if (atOrBeforeUtc) q.exchTradeTime = { $lte: new Date(atOrBeforeUtc) };

  const row = await optColl.find(q).sort({ exchTradeTime: -1 }).limit(1).next();
  return row || null;
}

async function getLatestOptionTickBySymbolSafe(optColl, symbol, nowUtc) {
  const sym = String(symbol || '').trim();
  if (!sym)
    return { tick: null, price: Number.NaN, tickTime: null, ageMs: null };

  // Prefer exchange trade time (<= now) when available
  let tick = null;
  try {
    tick = await optColl
      .find({ symbol: sym, exchTradeTime: { $lte: nowUtc } })
      .sort({ exchTradeTime: -1 })
      .limit(1)
      .next();
  } catch (_) {
    tick = null;
  }

  // Fallback 1: ingest time (<= now)
  if (!tick) {
    try {
      tick = await optColl
        .find({ symbol: sym, ingestTs: { $lte: nowUtc } })
        .sort({ ingestTs: -1 })
        .limit(1)
        .next();
    } catch (_) {
      tick = null;
    }
  }

  // Fallback 2: absolute latest by exchTradeTime
  if (!tick) {
    try {
      tick = await optColl
        .find({ symbol: sym })
        .sort({ exchTradeTime: -1 })
        .limit(1)
        .next();
    } catch (_) {
      tick = null;
    }
  }

  // Fallback 3: absolute latest by ingestTs
  if (!tick) {
    try {
      tick = await optColl
        .find({ symbol: sym })
        .sort({ ingestTs: -1 })
        .limit(1)
        .next();
    } catch (_) {
      tick = null;
    }
  }

  const price = Number(tick?.price);
  const tickTime = tick?.exchTradeTime || tick?.ingestTs || null;
  const ageMs = tickTime
    ? nowUtc.getTime() - new Date(tickTime).getTime()
    : null;

  return { tick, price, tickTime, ageMs };
}

async function pickPeLegsFromTicks({
  optColl,
  expiry,
  underlyingPrice,
  mainMoneyness,
  hedgeMoneyness,
  hedgeEnabled = true,
  asOfUtc,
}) {
  const strikes = await getAvailableStrikesForExpiry(optColl, {
    underlying: 'BTC',
    optionType: 'P',
    expiry,
  });
  if (!strikes.length)
    return { ok: false, reason: 'NO_STRIKES_FOR_EXPIRY', strikes: [] };

  const mainStrike = pickStrikeByMoneyness(
    strikes,
    underlyingPrice,
    mainMoneyness,
    'P',
  );
  const hedgeStrike = hedgeEnabled
    ? pickStrikeByMoneyness(strikes, underlyingPrice, hedgeMoneyness, 'P')
    : null;

  if (
    !Number.isFinite(mainStrike) ||
    (hedgeEnabled && !Number.isFinite(hedgeStrike))
  ) {
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
    optionType: 'P',
    expiry,
    strike: mainStrike,
    atOrBeforeUtc: asOfUtc,
  });
  const hedgeTick = hedgeEnabled
    ? await getLatestOptionTickByStrike(optColl, {
        underlying: 'BTC',
        optionType: 'P',
        expiry,
        strike: hedgeStrike,
        atOrBeforeUtc: asOfUtc,
      })
    : null;

  if (
    !mainTick ||
    !mainTick.symbol ||
    (hedgeEnabled && (!hedgeTick || !hedgeTick.symbol))
  ) {
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
      optionType: 'P',
      ltp: Number(mainTick.price),
      tickTime: mainTick.exchTradeTime,
    },
    hedge: hedgeEnabled
      ? {
          symbol: hedgeTick.symbol,
          strike: Number(hedgeTick.strike),
          optionType: 'P',
          ltp: Number(hedgeTick.price),
          tickTime: hedgeTick.exchTradeTime,
        }
      : null,
    mainStrike,
    hedgeStrike,
  };
}

function buildExitPricesForShort(entryPrice, stopLossPct, targetPct) {
  const sl = entryPrice * (1 + stopLossPct / 100);
  const tp = entryPrice * (1 - targetPct / 100);
  return { stopLossPrice: sl, targetPrice: tp };
}

function buildTrailingStopForShort(lowWater, trailingStopPct) {
  if (!Number.isFinite(lowWater) || !Number.isFinite(trailingStopPct))
    return Number.NaN;
  if (trailingStopPct <= 0) return Number.NaN;
  return lowWater * (1 + trailingStopPct / 100);
}

function computeSpreadPnl({ mainEntry, mainExit, hedgeEntry, hedgeExit, qty }) {
  const mainPoints = Number(mainEntry) - Number(mainExit); // short leg
  const hedgePoints = Number(hedgeExit) - Number(hedgeEntry); // long leg
  const netPoints = mainPoints + hedgePoints;
  const net = netPoints * qty;
  return { qty, mainPoints, hedgePoints, netPoints, net };
}

function computeShortOnlyPnl({ mainEntry, mainExit, qty }) {
  const mainPoints = Number(mainEntry) - Number(mainExit); // short leg
  const hedgePoints = 0;
  const netPoints = mainPoints;
  const net = netPoints * qty;
  return { qty, mainPoints, hedgePoints, netPoints, net };
}

function resolveQtyForPnl(spreadDoc) {
  // Prefer deterministic qty = lots * contractMultiplier (Delta contract_value)
  const lots = Number(spreadDoc?.config?.lots);
  const cm =
    Number(spreadDoc?.config?.contractMultiplier) ||
    Number(process.env.SUPERTREND_BPS_LIVE_CONTRACT_MULTIPLIER) ||
    CONTRACT_MULTIPLIER;
  if (Number.isFinite(lots) && lots > 0 && Number.isFinite(cm) && cm > 0)
    return lots * cm;

  const q = Number(spreadDoc?.config?.qty);
  if (Number.isFinite(q) && q > 0) return q;

  return QTY;
}

// =====================
// Live trade state
// =====================

let cronTask = null;
let cronInFlight = false;
let heartbeatTimer = null;
let pnlTimer = null;

const dailyTradeCount = new Map(); // key: expiry YYYY-MM-DD -> count
function incDailyTradeCount(expiry) {
  const cur = dailyTradeCount.get(expiry) || 0;
  dailyTradeCount.set(expiry, cur + 1);
}
function getDailyTradeCount(expiry) {
  return dailyTradeCount.get(expiry) || 0;
}
function resetOldDailyCounts(keepDays = 5) {
  const cutoff = moment().tz(TZ).startOf('day').subtract(keepDays, 'days');
  for (const [k] of dailyTradeCount.entries()) {
    const d = moment.tz(k, 'YYYY-MM-DD', TZ);
    if (d.isBefore(cutoff)) dailyTradeCount.delete(k);
  }
}

async function findOpenSpreadForExpiry(expiryStr) {
  const db = getDb();
  const coll = db.collection(SPREADS_COLLECTION);
  return findOneSorted(
    coll,
    {
      strategy: STRATEGY,
      stockName: STOCK_NAME,
      stockSymbol: STOCK_SYMBOL,
      expiry: expiryStr,
      status: 'OPEN',
    },
    { createdAt: -1 },
  );
}

async function findActiveSpreadForExpiry(expiryStr) {
  const db = getDb();
  const coll = db.collection(SPREADS_COLLECTION);
  return findOneSorted(
    coll,
    {
      strategy: STRATEGY,
      stockName: STOCK_NAME,
      stockSymbol: STOCK_SYMBOL,
      expiry: expiryStr,
      status: { $in: ['OPEN', 'PENDING_ENTRY', 'PENDING_EXIT'] },
    },
    { createdAt: -1 },
  );
}

// =====================
// Live execution helpers
// =====================

async function executeEntry({ runId, expiry, underlyingPrice, legs, nowIst }) {
  const mainSymbol = legs.main.symbol;
  const hasHedge = !!legs?.hedge?.symbol;
  const hedgeSymbol = hasHedge ? legs.hedge.symbol : null;

  const mainPid = await getProductIdBySymbol(mainSymbol);
  const hedgePid = hasHedge ? await getProductIdBySymbol(hedgeSymbol) : null;

  // Set order leverage (best-effort, non-blocking)
  if (hasHedge) await ensureOrderLeverageOnce(hedgePid, 'HEDGE', 'ENTRY_HEDGE');
  await ensureOrderLeverageOnce(mainPid, 'MAIN', 'ENTRY_MAIN');

  // Hedge first (BUY), then main (SELL) for Bull Put Spread
  const hedgeClientId = hasHedge ? buildClientOrderId(runId, 'HBUY') : null;
  const mainClientId = buildClientOrderId(runId, 'MSELL');

  const entryStart = Date.now();

  const hedgeOrder = hasHedge
    ? await placeOrder({
        product_id: hedgePid,
        side: 'buy',
        size: ORDER_SIZE,
        order_type: 'market_order',
        reduce_only: false,
        client_order_id: hedgeClientId,
      })
    : null;

  const mainOrder = await placeOrder({
    product_id: mainPid,
    side: 'sell',
    size: ORDER_SIZE,
    order_type: 'market_order',
    reduce_only: false,
    client_order_id: mainClientId,
  });

  // Enable auto-topup for the MAIN short leg to reduce liquidation risk (non-blocking)
  await ensureAutoTopupOnce(mainPid, 'ENTRY_MAIN');

  const endMicros = Date.now() * 1000;
  const startMicros = (Date.now() - 2 * 60 * 1000) * 1000;

  const fills = await getRecentFills({
    product_ids: hasHedge ? [mainPid, hedgePid] : [mainPid],
    startTimeMicros: startMicros,
    endTimeMicros: endMicros,
    page_size: 200,
  });

  const mainFills = fills.filter(
    (f) => String(f.order_id) === String(mainOrder.id),
  );
  const hedgeFills =
    hasHedge && hedgeOrder
      ? fills.filter((f) => String(f.order_id) === String(hedgeOrder.id))
      : [];

  const mainFillPrice =
    computeVwapFromFills(mainFills) ?? Number(legs.main.ltp);
  const hedgeFillPrice =
    hasHedge
      ? computeVwapFromFills(hedgeFills) ?? Number(legs.hedge.ltp)
      : null;

  const tookMs = Date.now() - entryStart;

  return {
    main: {
      symbol: mainSymbol,
      product_id: mainPid,
      order: mainOrder,
      fillPrice: mainFillPrice,
    },
    hedge: hasHedge
      ? {
          symbol: hedgeSymbol,
          product_id: hedgePid,
          order: hedgeOrder,
          fillPrice: hedgeFillPrice,
        }
      : null,
    tookMs,
    underlyingPrice,
    expiry,
    time: nowIst.toISOString(true),
  };
}

async function executeExit({ runId, open, reason, nowIst }) {
  const mainPid = Number(open?.main?.product_id);
  const hasHedge = !!open?.hedge?.symbol;
  const hedgePid = Number(open?.hedge?.product_id);
  if (!Number.isFinite(mainPid))
    throw new Error('Missing product_id on open spread doc.');
  if (hasHedge && !Number.isFinite(hedgePid))
    throw new Error('Missing hedge product_id on open spread doc.');

  // Set order leverage for exit orders as well (best-effort, non-blocking)
  await ensureOrderLeverageOnce(mainPid, 'MAIN', 'EXIT_MAIN');
  if (hasHedge) await ensureOrderLeverageOnce(hedgePid, 'HEDGE', 'EXIT_HEDGE');

  const exitStart = Date.now();

  // Main first (BUY) to close short put, then hedge (SELL)
  const mainClientId = buildClientOrderId(runId, 'MBUYX');
  const hedgeClientId = hasHedge ? buildClientOrderId(runId, 'HSELLX') : null;

  const parseDeltaErrorCode = (err) => {
    const msg = String(err?.message || '');
    const m = msg.match(/"code":"([^"]+)"/);
    return m ? m[1] : null;
  };
  const placeExitLeg = async ({ legName, orderPayload }) => {
    try {
      const order = await placeOrder(orderPayload);
      return { status: 'PLACED', order, errorCode: null, errorMessage: null };
    } catch (err) {
      const errorCode = parseDeltaErrorCode(err);
      const errorMessage = String(err?.message || err);
      if (errorCode === 'no_position_for_reduce_only') {
        warn(
          `EXIT leg=${legName} treated as already closed (reduce_only no position).`,
        );
        return {
          status: 'ALREADY_CLOSED',
          order: null,
          errorCode,
          errorMessage,
        };
      }
      warn(
        `EXIT leg=${legName} failed errorCode=${errorCode || 'UNKNOWN'} message=${errorMessage}`,
      );
      return { status: 'FAILED', order: null, errorCode, errorMessage };
    }
  };

  const mainLeg = await placeExitLeg({
    legName: 'MAIN',
    orderPayload: {
      product_id: mainPid,
      side: 'buy',
      size: ORDER_SIZE,
      order_type: 'market_order',
      reduce_only: true,
      client_order_id: mainClientId,
    },
  });
  const hedgeLeg = hasHedge
    ? await placeExitLeg({
        legName: 'HEDGE',
        orderPayload: {
          product_id: hedgePid,
          side: 'sell',
          size: ORDER_SIZE,
          order_type: 'market_order',
          reduce_only: true,
          client_order_id: hedgeClientId,
        },
      })
    : { status: 'SKIPPED', order: null, errorCode: null, errorMessage: null };

  const placedProductIds = [];
  if (mainLeg.order) placedProductIds.push(mainPid);
  if (hedgeLeg.order) placedProductIds.push(hedgePid);
  const fills =
    placedProductIds.length > 0
      ? await getRecentFills({
          product_ids: placedProductIds,
          startTimeMicros: (Date.now() - 2 * 60 * 1000) * 1000,
          endTimeMicros: Date.now() * 1000,
          page_size: 200,
        })
      : [];

  const mainFills = mainLeg.order
    ? fills.filter((f) => String(f.order_id) === String(mainLeg.order.id))
    : [];
  const hedgeFills = hedgeLeg.order
    ? fills.filter((f) => String(f.order_id) === String(hedgeLeg.order.id))
    : [];

  const mainExitPrice =
    computeVwapFromFills(mainFills) ??
    Number(open?.mtm?.mainPrice ?? open?.main?.entry?.price);
  const hedgeExitPrice =
    hasHedge
      ? computeVwapFromFills(hedgeFills) ??
        Number(open?.mtm?.hedgePrice ?? open?.hedge?.entry?.price)
      : null;

  const pnl = hasHedge
    ? computeSpreadPnl({
        mainEntry: Number(open?.main?.entry?.price),
        mainExit: mainExitPrice,
        hedgeEntry: Number(open?.hedge?.entry?.price),
        hedgeExit: hedgeExitPrice,
        qty: resolveQtyForPnl(open),
      })
    : computeShortOnlyPnl({
        mainEntry: Number(open?.main?.entry?.price),
        mainExit: mainExitPrice,
        qty: resolveQtyForPnl(open),
      });

  const tookMs = Date.now() - exitStart;
  const completed =
    mainLeg.status !== 'FAILED' && hedgeLeg.status !== 'FAILED';

  return {
    completed,
    reason,
    time: nowIst.toISOString(true),
    orders: {
      mainExitOrder: mainLeg.order,
      hedgeExitOrder: hedgeLeg.order,
    },
    legs: {
      main: {
        status: mainLeg.status,
        errorCode: mainLeg.errorCode,
        errorMessage: mainLeg.errorMessage,
      },
      hedge: {
        status: hedgeLeg.status,
        errorCode: hedgeLeg.errorCode,
        errorMessage: hedgeLeg.errorMessage,
      },
    },
    prices: { mainExitPrice, hedgeExitPrice },
    pnl,
    tookMs,
  };
}

// =====================
// Core trading loop
// =====================

async function maybeEnterTrade(nowIst) {
  const dayStr = nowIst.format('YYYY-MM-DD');

  const wd = weekdayKey(nowIst);
  if (!WEEKDAYS.includes(wd)) return { took: false, reason: 'WEEKDAY_GUARD' };

  const fromIst = hhmmToMoment(dayStr, FROM_TIME, TZ);
  if (nowIst.isBefore(fromIst))
    return { took: false, reason: 'BEFORE_FROM_TIME' };
  // No-trade window: skip NEW entries during daily expiry hour
  if (isInNoTradeWindow(nowIst))
    return { took: false, reason: 'NO_TRADE_WINDOW' };

  const expiry = getActiveWeeklyExpiry(nowIst);
  const signalStatePrefix = `${expiry}|${INDEX_TF}|BUY|`;

  if (getDailyTradeCount(expiry) >= MAX_TRADES_PER_DAY)
    return { took: false, reason: 'MAX_TRADES_REACHED' };

  const active = await findActiveSpreadForExpiry(expiry);
  if (active)
    return {
      took: false,
      reason: 'ACTIVE_SPREAD_EXISTS',
      status: active.status,
    };

  const st = await buildTodaySupertrend({
    nowIst,
    stockSymbol: STOCK_SYMBOL,
    stockName: STOCK_NAME,
    timeInterval: INDEX_TF,
    fromTime: FROM_TIME,
    atrPeriod: ENTRY_ATR_PERIOD,
    multiplier: ENTRY_MULTIPLIER,
    changeAtrCalculation: CHANGE_ATR_CALC,
    minCandles: MIN_CANDLES,
    candleGraceSeconds: CANDLE_GRACE_SECONDS,
    allowFormingCandle: ALLOW_FORMING_CANDLE,
    candleTsIsClose: CANDLE_TS_IS_CLOSE,
    futCandlesCollection: FUT_CANDLES_COLLECTION,
  });

  const signalCandle = st.lastConfirmedStCandle;
  if (!signalCandle) return { took: false, reason: 'NO_FUT_CANDLES' };
  if ((st.candles || []).length < MIN_CANDLES)
    return { took: false, reason: 'INSUFFICIENT_CANDLES' };

  // Optional Higher Timeframe (HTF) trend filter:
  // - Entry signal is on INDEX_TF (execution TF)
  // - Trend confirmation is on HTF_INDEX_TF (e.g., M30)
  if (HTF_ENABLED && tfEnabled(HTF_INDEX_TF) && HTF_INDEX_TF !== INDEX_TF) {
    const htf = await buildTodaySupertrend({
      nowIst,
      stockSymbol: STOCK_SYMBOL,
      stockName: STOCK_NAME,
      timeInterval: HTF_INDEX_TF,
      fromTime: FROM_TIME,
      atrPeriod: TREND_ATR_PERIOD,
      multiplier: TREND_MULTIPLIER,
      changeAtrCalculation: CHANGE_ATR_CALC,
      minCandles: HTF_MIN_CANDLES,
      candleGraceSeconds: HTF_CANDLE_GRACE_SECONDS,
      allowFormingCandle: ALLOW_FORMING_CANDLE,
      candleTsIsClose: CANDLE_TS_IS_CLOSE,
      futCandlesCollection: FUT_CANDLES_COLLECTION,
    });

    const htfSig = htf.lastConfirmedStCandle;
    if (!htfSig) return { took: false, reason: 'NO_HTF_FUT_CANDLES' };
    if ((htf.candles || []).length < HTF_MIN_CANDLES)
      return { took: false, reason: 'INSUFFICIENT_HTF_CANDLES' };

    const dir = stTrendDir(htfSig);
    if (dir !== 'UP')
      return {
        took: false,
        reason: 'HTF_TREND_MISMATCH',
        meta: { htfDir: dir, htfTf: HTF_INDEX_TF },
      };
  } else if (HTF_ENABLED && tfEnabled(HTF_INDEX_TF) && HTF_INDEX_TF === INDEX_TF) {
    // If HTF is set equal to INDEX_TF, treat it as a no-op (keeps env flexible).
  }

  // Optional momentum HTF filter using EMA fast/slow alignment (e.g., M10 EMA9/EMA21).
  // Momentum is evaluated only on closed candles to avoid intra-candle EMA flips.
  if (MOMENTUM_HTF_ENABLED) {
    if (!tfEnabled(MOMENTUM_HTF_INDEX_TF)) {
      return { took: false, reason: 'MOMENTUM_HTF_TF_NOT_SET' };
    }

    const momentum = await buildTodaySupertrend({
      nowIst,
      stockSymbol: STOCK_SYMBOL,
      stockName: STOCK_NAME,
      timeInterval: MOMENTUM_HTF_INDEX_TF,
      fromTime: FROM_TIME,
      atrPeriod: TREND_ATR_PERIOD,
      multiplier: TREND_MULTIPLIER,
      changeAtrCalculation: CHANGE_ATR_CALC,
      minCandles: MOMENTUM_MIN_CANDLES,
      candleGraceSeconds: MOMENTUM_CANDLE_GRACE_SECONDS,
      allowFormingCandle: false,
      candleTsIsClose: CANDLE_TS_IS_CLOSE,
      futCandlesCollection: FUT_CANDLES_COLLECTION,
    });

    if ((momentum.candles || []).length < MOMENTUM_MIN_CANDLES) {
      return { took: false, reason: 'INSUFFICIENT_MOMENTUM_CANDLES' };
    }

    const mDir = emaMomentumDir(
      momentum.candles,
      MOMENTUM_FAST_EMA,
      MOMENTUM_SLOW_EMA,
    );
    if (mDir !== 'UP') {
      return {
        took: false,
        reason: 'MOMENTUM_TREND_MISMATCH',
        meta: {
          momentumDir: mDir,
          momentumTf: MOMENTUM_HTF_INDEX_TF,
          fastEma: MOMENTUM_FAST_EMA,
          slowEma: MOMENTUM_SLOW_EMA,
        },
      };
    }
  }

  const buySignal = !!(
    signalCandle?.supertrend?.buySignal ?? signalCandle?.buySignal
  );
  if (!FORCE_ENTRY && !buySignal) {
    clearFormingSignalStateForPrefix(signalStatePrefix);
    return { took: false, reason: 'NO_BUY_SIGNAL' };
  }

  const nowMs = Number(nowIst.valueOf());
  const indexTfMs = tfToMs(INDEX_TF);
  if (ALLOW_FORMING_CANDLE) {
    const minElapsedMs = minElapsedMsForTf(indexTfMs, FORMING_MIN_ELAPSED_PCT);
    const elapsedMs = elapsedMsInCurrentTf(nowIst, indexTfMs);
    if (elapsedMs < minElapsedMs) {
      clearFormingSignalStateForPrefix(signalStatePrefix);
      info(
        `ENTRY_BLOCKED reason=FORMING_CANDLE_BEFORE_MIN_ELAPSED tf=${INDEX_TF} elapsedMs=${elapsedMs} requiredElapsedMs=${minElapsedMs} minElapsedPct=${FORMING_MIN_ELAPSED_PCT}`,
      );
      return {
        took: false,
        reason: 'FORMING_CANDLE_BEFORE_MIN_ELAPSED',
        meta: {
          indexTf: INDEX_TF,
          elapsedMs,
          requiredElapsedMs: minElapsedMs,
          minElapsedPct: FORMING_MIN_ELAPSED_PCT,
        },
      };
    }
  }

  const signalTsMs = new Date(signalCandle.ts).getTime();
  const isSignalClosedNow = isCandleClosedAt({
    candleTsMs: signalTsMs,
    tfMs: indexTfMs,
    nowMs,
    candleGraceSeconds: CANDLE_GRACE_SECONDS,
    candleTsIsClose: CANDLE_TS_IS_CLOSE,
  });
  const isFormingSignalEntry = ALLOW_FORMING_CANDLE && !isSignalClosedNow;

  if (isFormingSignalEntry && FORMING_SIGNAL_HOLD_SECS > 0) {
    const holdMs = Math.floor(FORMING_SIGNAL_HOLD_SECS * 1000);
    const holdKey = buildFormingSignalStateKey(
      expiry,
      INDEX_TF,
      'BUY',
      signalTsMs,
    );
    const firstSeenMs = formingSignalHoldState.has(holdKey)
      ? formingSignalHoldState.get(holdKey)
      : nowMs;
    if (!formingSignalHoldState.has(holdKey))
      formingSignalHoldState.set(holdKey, nowMs);
    clearFormingSignalStateForPrefix(signalStatePrefix, holdKey);
    const heldMs = nowMs - firstSeenMs;
    if (heldMs < holdMs) {
      info(
        `ENTRY_BLOCKED reason=FORMING_SIGNAL_HOLD_PENDING tf=${INDEX_TF} heldMs=${heldMs} requiredHoldMs=${holdMs} holdSecs=${FORMING_SIGNAL_HOLD_SECS}`,
      );
      return {
        took: false,
        reason: 'FORMING_SIGNAL_HOLD_PENDING',
        meta: {
          holdSecs: FORMING_SIGNAL_HOLD_SECS,
          heldSecs: Number((heldMs / 1000).toFixed(3)),
          indexTf: INDEX_TF,
        },
      };
    }
  } else {
    clearFormingSignalStateForPrefix(signalStatePrefix);
  }

  const underlyingPrice = Number(signalCandle.close);
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0)
    return { took: false, reason: 'INVALID_UNDERLYING_PRICE' };

  const db = getDb();
  const optColl = await getOptionCollectionForNow(db);
  const asOfUtc = new Date(nowIst.clone().utc().valueOf());

  const legs = await pickPeLegsFromTicks({
    optColl,
    expiry,
    underlyingPrice,
    mainMoneyness: MAIN_MONEYNESS,
    hedgeMoneyness: HEDGE_MONEYNESS,
    hedgeEnabled: HEDGE_ENABLED,
    asOfUtc,
  });
  if (!legs.ok)
    return {
      took: false,
      reason: legs.reason,
      meta: { expiry, underlyingPrice },
    };

  const runId = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');

  const entryDoc = await createSpreadDoc({
    strategy: STRATEGY,
    runId,
    stockName: STOCK_NAME,
    stockSymbol: STOCK_SYMBOL,
    expiry,
    timeInterval: INDEX_TF,
    status: 'PENDING_ENTRY',
    config: {
      timezone: TZ,
      fromTime: FROM_TIME,
      atrPeriod: ENTRY_ATR_PERIOD,
      multiplier: ENTRY_MULTIPLIER,
      trendAtrPeriod: TREND_ATR_PERIOD,
      trendMultiplier: TREND_MULTIPLIER,
      entryAtrPeriod: ENTRY_ATR_PERIOD,
      entryMultiplier: ENTRY_MULTIPLIER,
      exitAtrPeriod: EXIT_ATR_PERIOD,
      exitMultiplier: EXIT_MULTIPLIER,
      changeAtrCalculation: CHANGE_ATR_CALC,
      stopLossPct: STOPLOSS_PCT,
      stopLossEnabled: STOPLOSS_ENABLED,
      trailingStopPct: TRAILING_STOP_PCT,
      targetPct: TARGET_PCT,
      mainMoneyness: MAIN_MONEYNESS,
      hedgeMoneyness: HEDGE_MONEYNESS,
      hedgeEnabled: HEDGE_ENABLED,
      lotSize: LOT_SIZE,
      lots: LOTS,
      qty: QTY,
      minCandles: MIN_CANDLES,
      candleGraceSeconds: CANDLE_GRACE_SECONDS,
      htfIndexTimeInterval: HTF_INDEX_TF || null,
      htfEnabled: HTF_ENABLED,
      exitTimeInterval: EXIT_TF || INDEX_TF,
      htfMinCandles: HTF_MIN_CANDLES,
      exitMinCandles: EXIT_MIN_CANDLES,
      htfCandleGraceSeconds: HTF_CANDLE_GRACE_SECONDS,
      exitCandleGraceSeconds: EXIT_CANDLE_GRACE_SECONDS,
      allowFormingCandle: ALLOW_FORMING_CANDLE,
      formingMinElapsedPct: FORMING_MIN_ELAPSED_PCT,
      formingSignalHoldSecs: FORMING_SIGNAL_HOLD_SECS,
      exitOnNextOpenMismatch: EXIT_ON_NEXT_OPEN_MISMATCH,
    },
    entry: {
      time: nowIst.toISOString(true),
      underlyingPrice,
      signalCandleTs: signalCandle.ts || null,
      signalCandleDatetime: signalCandle.datetime || null,
      formingCandleEntry: isFormingSignalEntry,
    },
    main: {
      side: 'SELL',
      optionType: 'P',
      symbol: legs.main.symbol,
      strike: legs.main.strike,
      entry: { time: nowIst.toISOString(true), price: Number(legs.main.ltp) },
    },
    hedge: legs.hedge
      ? {
          side: 'BUY',
          optionType: 'P',
          symbol: legs.hedge.symbol,
          strike: legs.hedge.strike,
          entry: { time: nowIst.toISOString(true), price: Number(legs.hedge.ltp) },
        }
      : null,
    exit: null,
    pnl: null,
  });

  let exec;
  try {
    exec = await executeEntry({
      runId,
      expiry,
      underlyingPrice,
      legs,
      nowIst,
    });
  } catch (e) {
    await updateSpreadDoc(entryDoc._id, {
      status: 'ENTRY_FAILED',
      entryError: {
        at: new Date(),
        message: String(e?.message || e),
      },
    });
    clearFormingSignalStateForPrefix(signalStatePrefix);
    throw e;
  }

  try {
    await updateSpreadDoc(entryDoc._id, {
      status: 'OPEN',
      main: {
        ...entryDoc.main,
        product_id: exec.main.product_id,
        entry: {
          ...entryDoc.main.entry,
          price: exec.main.fillPrice,
          orderId: exec.main.order.id,
          clientOrderId: exec.main.order.client_order_id || null,
        },
      },
      ...(entryDoc.hedge && exec.hedge
        ? {
            hedge: {
              ...entryDoc.hedge,
              product_id: exec.hedge.product_id,
              entry: {
                ...entryDoc.hedge.entry,
                price: exec.hedge.fillPrice,
                orderId: exec.hedge.order.id,
                clientOrderId: exec.hedge.order.client_order_id || null,
              },
            },
          }
        : {}),
      trailing:
        TRAILING_STOP_PCT > 0
          ? {
              side: 'SHORT',
              lowWater: Number(exec.main.fillPrice),
              stopPrice: buildTrailingStopForShort(
                Number(exec.main.fillPrice),
                TRAILING_STOP_PCT,
              ),
              pct: TRAILING_STOP_PCT,
              updatedAt: nowIst.toISOString(true),
            }
          : null,
      entryExecution: { tookMs: exec.tookMs, at: new Date() },
    });
  } catch (e) {
    await updateSpreadDoc(entryDoc._id, {
      status: 'ENTRY_FAILED',
      entryError: {
        at: new Date(),
        message: `Entry post-processing failed: ${String(e?.message || e)}`,
      },
    });
    clearFormingSignalStateForPrefix(signalStatePrefix);
    throw e;
  }

  incDailyTradeCount(expiry);
  clearFormingSignalStateForPrefix(signalStatePrefix);

  const entryLegText = legs.hedge && exec.hedge
    ? `main=${legs.main.symbol}@${exec.main.fillPrice} hedge=${legs.hedge.symbol}@${exec.hedge.fillPrice}`
    : `main=${legs.main.symbol}@${exec.main.fillPrice} hedge=DISABLED`;
  info(
    `ENTRY expiry=${expiry} buySignal=${buySignal} underlying=${underlyingPrice.toFixed(
      1,
    )} ${entryLegText} qty=${QTY}`,
  );
  return {
    took: true,
    reason: 'ENTERED',
    spreadId: String(entryDoc._id),
    runId,
  };
}

async function maybeExitOpenSpread(nowIst, open) {
  if (!open || open.status !== 'OPEN') return { exited: false };

  // If controller restarts with an OPEN spread, re-apply auto-topup once (best-effort)
  await ensureAutoTopupOnce(open?.main?.product_id, 'OPEN_MAIN');

  const db = getDb();
  const optColl = await getOptionCollectionForNow(db);
  const nowUtc = new Date(nowIst.clone().utc().valueOf());

  const mainRes = await getLatestOptionTickBySymbolSafe(
    optColl,
    open.main.symbol,
    nowUtc,
  );
  const hasHedge = !!open?.hedge?.symbol;
  const hedgeRes = hasHedge
    ? await getLatestOptionTickBySymbolSafe(optColl, open.hedge.symbol, nowUtc)
    : { price: Number.NaN, ageMs: null };

  // Use latest available mark; if missing, fall back to last MTM, then entry price.
  const prevMainMtm = Number(open?.mtm?.mainPrice);
  const prevHedgeMtm = Number(open?.mtm?.hedgePrice);

  const mainMark = Number.isFinite(mainRes.price)
    ? mainRes.price
    : Number.isFinite(prevMainMtm)
      ? prevMainMtm
      : Number(open?.main?.entry?.price);

  const hedgeMark = Number.isFinite(hedgeRes.price)
    ? hedgeRes.price
    : Number.isFinite(prevHedgeMtm)
      ? prevHedgeMtm
      : Number(open?.hedge?.entry?.price);

  const mainEntry = Number(open?.main?.entry?.price);
  let { stopLossPrice, targetPrice } = buildExitPricesForShort(
    mainEntry,
    STOPLOSS_PCT,
    TARGET_PCT,
  );
  if (!STOPLOSS_ENABLED) stopLossPrice = Number.NaN;

  const trailingEnabled = Number.isFinite(TRAILING_STOP_PCT) && TRAILING_STOP_PCT > 0;
  const prevLowWater = Number(open?.trailing?.lowWater);
  const seedLowWater = Number.isFinite(prevLowWater)
    ? prevLowWater
    : Number.isFinite(mainEntry)
      ? mainEntry
      : mainMark;
  const lowWater = trailingEnabled
    ? Number.isFinite(mainMark)
      ? Math.min(seedLowWater, mainMark)
      : seedLowWater
    : Number.NaN;
  const trailingStopPrice = trailingEnabled
    ? buildTrailingStopForShort(lowWater, TRAILING_STOP_PCT)
    : Number.NaN;
  const effectiveStopPrice =
    Number.isFinite(stopLossPrice) && Number.isFinite(trailingStopPrice)
      ? Math.min(stopLossPrice, trailingStopPrice)
      : Number.isFinite(stopLossPrice)
        ? stopLossPrice
        : trailingStopPrice;

  let exitReason = null;

  // No-trade window: force exit at/after NO_TRADE_START to avoid holding during daily expiry hour
  if (!exitReason && CLOSE_AT_NO_TRADE_START && isInNoTradeWindow(nowIst))
    exitReason = 'NO_TRADE_WINDOW';

  if (Number.isFinite(mainMark)) {
    if (
      Number.isFinite(trailingStopPrice) &&
      mainMark >= trailingStopPrice &&
      (!Number.isFinite(stopLossPrice) || trailingStopPrice <= stopLossPrice)
    )
      exitReason = 'TRAILING_STOP_HIT';
    if (!exitReason && Number.isFinite(effectiveStopPrice) && mainMark >= effectiveStopPrice)
      exitReason = 'STOPLOSS';
    if (!exitReason && Number.isFinite(targetPrice) && mainMark <= targetPrice)
      exitReason = 'TARGET';
  }
  if (
    !exitReason &&
    EXIT_ON_NEXT_OPEN_MISMATCH &&
    open?.entry?.formingCandleEntry === true &&
    !open?.entry?.nextOpenMismatchCheckedAt
  ) {
    const signalTsMs = new Date(open?.entry?.signalCandleTs || 0).getTime();
    const nowMs = Number(nowIst.valueOf());
    const indexTfMs = tfToMs(INDEX_TF);
    if (
      Number.isFinite(signalTsMs) &&
      signalTsMs > 0 &&
      isCandleClosedAt({
        candleTsMs: signalTsMs,
        tfMs: indexTfMs,
        nowMs,
        candleGraceSeconds: CANDLE_GRACE_SECONDS,
        candleTsIsClose: CANDLE_TS_IS_CLOSE,
      })
    ) {
      const nextOpenSt = await buildTodaySupertrend({
        nowIst,
        stockSymbol: STOCK_SYMBOL,
        stockName: STOCK_NAME,
        timeInterval: INDEX_TF,
        fromTime: FROM_TIME,
        atrPeriod: ENTRY_ATR_PERIOD,
        multiplier: ENTRY_MULTIPLIER,
        changeAtrCalculation: CHANGE_ATR_CALC,
        minCandles: MIN_CANDLES,
        candleGraceSeconds: CANDLE_GRACE_SECONDS,
        allowFormingCandle: false,
        candleTsIsClose: CANDLE_TS_IS_CLOSE,
        futCandlesCollection: FUT_CANDLES_COLLECTION,
      });
      const confirmSig = nextOpenSt.lastConfirmedStCandle;
      const dir = stTrendDir(confirmSig);
      await updateSpreadDoc(open._id, {
        'entry.nextOpenMismatchCheckedAt': nowIst.toISOString(true),
        'entry.nextOpenMismatchDir': dir || null,
      });
      if (dir !== 'UP') exitReason = 'NEXT_OPEN_TREND_MISMATCH';
    }
  }
  // SuperTrend reversal: for BPS exit when SELL signal appears
  // NOTE: Reversal exit is evaluated ONLY on the last fully-closed (confirmed) SuperTrend candle (no mid-candle exits).
  // If the reversal signal persists on the closed candle, exit ASAP at the beginning of the next candle (next cron tick).
  if (!exitReason) {
    const st = await buildTodaySupertrend({
      nowIst,
      stockSymbol: STOCK_SYMBOL,
      stockName: STOCK_NAME,
      timeInterval: EXIT_TF,
      fromTime: FROM_TIME,
      atrPeriod: EXIT_ATR_PERIOD,
      multiplier: EXIT_MULTIPLIER,
      changeAtrCalculation: CHANGE_ATR_CALC,
      minCandles: EXIT_MIN_CANDLES,
      candleGraceSeconds: EXIT_CANDLE_GRACE_SECONDS,
      // force closed candle evaluation for reversal exit only
      allowFormingCandle: false,
      candleTsIsClose: CANDLE_TS_IS_CLOSE,
      futCandlesCollection: FUT_CANDLES_COLLECTION,
    });
    const sig = st.lastConfirmedStCandle;
    const stx = sig?.supertrend || {};
    const sellSignal = !!(stx.sellSignal ?? sig?.sellSignal);
    const isDownTrend = !!(stx.isDownTrend ?? sig?.isDownTrend);
    const trendVal = Number(stx.trend ?? sig?.trend);

    // Robust reversal detection: even if the one-candle `sellSignal` is missed (late candle insert),
    // the DOWN trend state persists and should still trigger the reversal exit.
    if (sellSignal || isDownTrend || trendVal === -1)
      exitReason = 'ST_REVERSAL_SELL';
  }
  if (!exitReason) {
    // Update MTM (store best-effort marks; pnl only when both marks are finite)
    const mainMtmMark = await pickMtmMarkPriceForSymbol(
      open.main.symbol,
      mainMark,
      mainRes?.ageMs,
    );
    const hedgeMtmMark = hasHedge
      ? await pickMtmMarkPriceForSymbol(
          open.hedge.symbol,
          hedgeMark,
          hedgeRes?.ageMs,
        )
      : Number.NaN;

    const hasMain = Number.isFinite(mainMtmMark);
    const hasHedgeMtm = Number.isFinite(hedgeMtmMark);

    if (hasMain || hasHedgeMtm) {
      const pnl = hasMain
        ? hasHedgeMtm
          ? computeSpreadPnl({
              mainEntry: Number(open?.main?.entry?.price),
              mainExit: mainMtmMark,
              hedgeEntry: Number(open?.hedge?.entry?.price),
              hedgeExit: hedgeMtmMark,
              qty: resolveQtyForPnl(open),
            })
          : computeShortOnlyPnl({
              mainEntry: Number(open?.main?.entry?.price),
              mainExit: mainMtmMark,
              qty: resolveQtyForPnl(open),
            })
        : null;

      await updateSpreadDoc(open._id, {
        mtm: {
          time: nowIst.toISOString(true),
          mainPrice: mainMtmMark,
          hedgePrice: hasHedge ? hedgeMtmMark : null,
          ...(pnl ? { pnl } : {}),
        },
        ...(trailingEnabled
          ? {
              trailing: {
                side: 'SHORT',
                lowWater: Number.isFinite(lowWater) ? lowWater : null,
                stopPrice: Number.isFinite(trailingStopPrice)
                  ? trailingStopPrice
                  : null,
                pct: TRAILING_STOP_PCT,
                updatedAt: nowIst.toISOString(true),
              },
            }
          : {}),
      });
    }
    return { exited: false };
  }

  const exec = await executeExit({
    runId: open.runId,
    open,
    reason: exitReason,
    nowIst,
  });
  if (!exec.completed) {
    info(
      `EXIT_PENDING reason=${exec.reason} mainStatus=${exec.legs?.main?.status} hedgeStatus=${exec.legs?.hedge?.status} mainErr=${exec.legs?.main?.errorCode || 'NA'} hedgeErr=${exec.legs?.hedge?.errorCode || 'NA'}`,
    );
    return { exited: false, reason: 'EXIT_PENDING' };
  }

  await updateSpreadDoc(open._id, {
    status: 'CLOSED',
    exit: {
      reason: exec.reason,
      time: exec.time,
      main: {
        symbol: open.main.symbol,
        price: exec.prices.mainExitPrice,
        orderId: exec.orders.mainExitOrder?.id || null,
      },
      hedge: open?.hedge?.symbol
        ? {
            symbol: open.hedge.symbol,
            price: exec.prices.hedgeExitPrice,
            orderId: exec.orders.hedgeExitOrder?.id || null,
          }
        : null,
      legs: {
        main: {
          status: exec.legs?.main?.status || null,
          errorCode: exec.legs?.main?.errorCode || null,
          errorMessage: exec.legs?.main?.errorMessage || null,
        },
        hedge: {
          status: exec.legs?.hedge?.status || null,
          errorCode: exec.legs?.hedge?.errorCode || null,
          errorMessage: exec.legs?.hedge?.errorMessage || null,
        },
      },
    },
    pnl: exec.pnl,
    exitExecution: { tookMs: exec.tookMs, at: new Date() },
  });

  info(
    `EXIT(${exec.reason}) expiry=${open.expiry} main=${open.main.symbol}@${
      exec.prices.mainExitPrice
    } hedge=${
      open?.hedge?.symbol ? `${open.hedge.symbol}@${exec.prices.hedgeExitPrice}` : 'DISABLED'
    } net=${exec.pnl.net.toFixed(6)}`,
  );
  return { exited: true, reason: exec.reason, pnl: exec.pnl };
}

async function liveLoopOnce() {
  const nowIst = moment().tz(TZ);
  const expiry = getActiveWeeklyExpiry(nowIst);

  const open = await findOpenSpreadForExpiry(expiry);
  if (open) return maybeExitOpenSpread(nowIst, open);
  const enterRes = await maybeEnterTrade(nowIst);
  if (LOG_SKIP_REASONS && enterRes && !enterRes.took) {
    const statusPart = enterRes.status ? ` status=${enterRes.status}` : '';
    const metaPart = enterRes.meta
      ? ` meta=${JSON.stringify(enterRes.meta)}`
      : '';
    info(`ENTRY_SKIP reason=${enterRes.reason || 'UNKNOWN'}${statusPart}${metaPart}`);
  }
  return enterRes;
}

// =====================
// Express handler (status / config)
// =====================

const SuperTrendBullPutSpreadLiveTradeBTCController = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const nowIst = moment().tz(TZ);
      const expiry = getActiveWeeklyExpiry(nowIst);
      const open = await findOpenSpreadForExpiry(expiry);

      res.status(200).json({
        success: true,
        controller: 'SuperTrendBullPutSpreadLiveTradeBTCController',
        now: nowIst.toISOString(true),
        activeExpiry: expiry,
        open: open
          ? {
              id: String(open._id),
              runId: open.runId,
              status: open.status,
              main: open.main?.symbol,
              hedge: open.hedge?.symbol,
            }
          : null,
        config: {
          TZ,
          CRON_EXPR,
          CRON_SECONDS,
          STOCK_NAME,
          STOCK_SYMBOL,
          FUT_CANDLES_COLLECTION,
          OPT_TICKS_PREFIX,
          INDEX_TF,
          HTF_ENABLED,
          HTF_INDEX_TF,
          EXIT_TF,
          HTF_MIN_CANDLES,
          EXIT_MIN_CANDLES,

          FROM_TIME,
          WEEKLY_EXPIRY_CUTOFF,
          NO_TRADE_START,
          NO_TRADE_END,
          CLOSE_AT_NO_TRADE_START,
          STOPLOSS_ENABLED,
          STOPLOSS_PCT,
          TRAILING_STOP_PCT,
          TARGET_PCT,
          MAIN_MONEYNESS,
          HEDGE_MONEYNESS,
          HEDGE_ENABLED,
          ATR_PERIOD,
          MULTIPLIER,
          CHANGE_ATR_CALC,
          FORCE_ENTRY,
          WEEKDAYS,
          MAX_TRADES_PER_DAY,
          MIN_CANDLES,
          CANDLE_GRACE_SECONDS,
          HTF_CANDLE_GRACE_SECONDS,
          EXIT_CANDLE_GRACE_SECONDS,
          ALLOW_FORMING_CANDLE,
          FORMING_MIN_ELAPSED_PCT,
          FORMING_SIGNAL_HOLD_SECS,
          EXIT_ON_NEXT_OPEN_MISMATCH,
          LOG_SKIP_REASONS,
          PNL_POLL_MS,
          HEARTBEAT_MS,
          LOT_SIZE,
          LOTS,
          QTY,
          AUTO_TOPUP_ENABLED,
          AUTO_TOPUP_AS_STRING,
          ORDER_LEVERAGE_ENABLED,
          ORDER_LEVERAGE,
          ORDER_LEVERAGE_APPLY_TO,
          DELTA_BASE,
        },
      });
    } catch (e) {
      error('Controller error', e);
      next(new AppError(e.message || 'Live trade controller failed', 500));
    }
  },
);

// =====================
// Cron starter
// =====================

function startSuperTrendBullPutSpreadLiveTradeBTCron() {
  if (cronTask) {
    info('Cron already running.');
    return cronTask;
  }
  const expr = `${CRON_SECONDS} ${CRON_EXPR}`; // 6-field cron with seconds
  info(`Starting LIVE cron: ${expr} (TZ=${TZ})`);
  cronTask = cron.schedule(
    expr,
    async () => {
      if (cronInFlight) return;
      cronInFlight = true;
      try {
        resetOldDailyCounts();
        await liveLoopOnce();
      } catch (e) {
        error('Cron loop error', e);
      } finally {
        cronInFlight = false;
      }
    },
    { timezone: TZ },
  );

  if (!pnlTimer) {
    pnlTimer = setInterval(async () => {
      try {
        const nowIst = moment().tz(TZ);
        const expiry = getActiveWeeklyExpiry(nowIst);
        const open = await findOpenSpreadForExpiry(expiry);
        if (!open) return;
        await maybeExitOpenSpread(nowIst, open);
      } catch {
        // silent
      }
    }, PNL_POLL_MS);

    if (pnlTimer && typeof pnlTimer.unref === 'function') pnlTimer.unref();
  }

  if (!heartbeatTimer && HEARTBEAT_MS > 0) {
    heartbeatTimer = setInterval(async () => {
      try {
        const nowIst = moment().tz(TZ);
        const activeExpiry = getActiveWeeklyExpiry(nowIst);
        const openActive = await findActiveSpreadForExpiry(activeExpiry);
        info(
          `HEARTBEAT now=${nowIst.format(
            'YYYY-MM-DD HH:mm:ss',
          )} activeExpiry=${activeExpiry} inFlight=${cronInFlight} trades(activeExpiry)=${getDailyTradeCount(
            activeExpiry,
          )} openActive=${!!openActive}`,
        );
      } catch {
        // silent
      }
    }, HEARTBEAT_MS);

    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function')
      heartbeatTimer.unref();
  }

  return cronTask;
}

function stopSuperTrendBullPutSpreadLiveTradeBTCron() {
  try {
    if (cronTask) cronTask.stop();
  } catch {}
  cronTask = null;
  cronInFlight = false;

  try {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  } catch {}
  heartbeatTimer = null;

  try {
    if (pnlTimer) clearInterval(pnlTimer);
  } catch {}
  pnlTimer = null;

  info('Stopped LIVE cron.');
}

async function runSuperTrendBullPutSpreadLiveTradeBTCCycle() {
  return liveLoopOnce();
}

module.exports = {
  SuperTrendBullPutSpreadLiveTradeBTCController,
  startSuperTrendBullPutSpreadLiveTradeBTCron,
  stopSuperTrendBullPutSpreadLiveTradeBTCron,
  runSuperTrendBullPutSpreadLiveTradeBTCCycle,
};
