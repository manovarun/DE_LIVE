/**
 * SuperTrendBearCallSpreadLiveTradeBTCController
 * ------------------------------------------------
 * BTC (Delta Exchange) SuperTrend Bear Call Spread LIVE-trade controller.
 *
 * Key characteristics (aligned with your BTC paper controllers):
 * - Futures candles are read from a MongoDB collection (default: btcusd_candles_ts)
 * - Options ticks are read from monthly collections created by DeltaOptionsWsTicksCaptureLiveController
 *   (default prefix: OptionsTicks => OptionsTicksMMYYYY)
 * - Options expiry is treated as DAILY expiry (expiry string = YYYY-MM-DD in configured timezone)
 * - Risk (SL/TP) applies ONLY on MAIN short call leg
 *
 * Delta REST auth/signing per Delta.Exchange_doc.txt:
 * signature = HMAC_SHA256(secret, method + timestamp + path + query_string + payload) (hex)
 * timestamp in seconds; also send User-Agent header.
 */

const cron = require('node-cron');
const moment = require('moment-timezone');
const mongoose = require('mongoose');
const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

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

// =====================
// Env / Configuration
// =====================

const TZ = process.env.SUPERTREND_BCS_LIVE_TIMEZONE || 'Asia/Kolkata';

const CRON_EXPR = process.env.SUPERTREND_BCS_LIVE_CRON || '* 0-23 * * *';
const CRON_SECONDS = process.env.SUPERTREND_BCS_LIVE_CRON_SECONDS || '2-59/5';

const STOCK_NAME = process.env.SUPERTREND_BCS_LIVE_STOCK_NAME || 'BTC';
const STOCK_SYMBOL =
  process.env.SUPERTREND_BCS_LIVE_STOCK_SYMBOL ||
  process.env.SUPERTREND_BCS_LIVE_FUT_SYMBOL ||
  'BTCUSD';

const FUT_CANDLES_COLLECTION =
  process.env.SUPERTREND_BCS_LIVE_FUT_CANDLES_COLLECTION ||
  'btcusd_candles_ts';

const OPT_TICKS_PREFIX = process.env.DELTA_OPT_TICKS_PREFIX || 'OptionsTicks';

const INDEX_TF = process.env.SUPERTREND_BCS_LIVE_INDEX_TF || 'M3';
const FROM_TIME = process.env.SUPERTREND_BCS_LIVE_FROM_TIME || '00:00';
const SQUARE_OFF_TIME = process.env.SUPERTREND_BCS_LIVE_SQUARE_OFF_TIME || '23:59';

// Daily expiry cutoff (IST) for Delta BTC daily options. After this time, the "active" expiry rolls to next calendar day.
const DAILY_EXPIRY_CUTOFF =
  process.env.SUPERTREND_BCS_LIVE_DAILY_EXPIRY_CUTOFF || '17:30';

// SL/TP config (applies only to MAIN short call leg)
const STOPLOSS_ENABLED =
  String(process.env.SUPERTREND_BCS_LIVE_STOPLOSS_ENABLED || 'true').toLowerCase() ===
  'true';
const STOPLOSS_PCT = Number(process.env.SUPERTREND_BCS_LIVE_STOPLOSS_PCT || 5000);
const TARGET_PCT = Number(process.env.SUPERTREND_BCS_LIVE_TARGET_PCT || 50);

const MAIN_MONEYNESS = process.env.SUPERTREND_BCS_LIVE_MAIN_MONEYNESS || 'ATM';
const HEDGE_MONEYNESS = process.env.SUPERTREND_BCS_LIVE_HEDGE_MONEYNESS || 'OTM3';

const ATR_PERIOD = Math.max(1, Number(process.env.SUPERTREND_BCS_LIVE_ATR_PERIOD || 10));
const MULTIPLIER = Math.max(0.1, Number(process.env.SUPERTREND_BCS_LIVE_MULTIPLIER || 3));
const CHANGE_ATR_CALC =
  String(process.env.SUPERTREND_BCS_LIVE_CHANGE_ATR_CALC || 'true').toLowerCase() ===
  'true';

const FORCE_ENTRY =
  String(process.env.SUPERTREND_BCS_LIVE_FORCE_ENTRY || 'false').toLowerCase() ===
  'true';

const WEEKDAYS = (process.env.SUPERTREND_BCS_LIVE_WEEKDAYS || 'MON,TUE,WED,THU,FRI,SAT,SUN')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const MAX_TRADES_PER_DAY = Math.max(
  1,
  Number(process.env.SUPERTREND_BCS_LIVE_MAX_TRADES_PER_DAY || 5)
);
const MIN_CANDLES = Math.max(5, Number(process.env.SUPERTREND_BCS_LIVE_MIN_CANDLES || 20));

const CANDLE_GRACE_SECONDS = Math.max(
  0,
  Number(process.env.SUPERTREND_BCS_LIVE_CANDLE_GRACE_SECONDS || 5)
);
const ALLOW_FORMING_CANDLE =
  String(process.env.SUPERTREND_BCS_LIVE_ALLOW_FORMING_CANDLE || 'false').toLowerCase() ===
  'true';

const PNL_POLL_MS = Math.max(2000, Number(process.env.SUPERTREND_BCS_LIVE_PNL_POLL_MS || 15000));
const HEARTBEAT_MS = Math.max(0, Number(process.env.SUPERTREND_BCS_LIVE_HEARTBEAT_MS || 15000));

// Position sizing for BTC options on Delta: treat LOT_SIZE as contract size (e.g. 0.001) and LOTS as number of contracts
const LOT_SIZE = Number(process.env.SUPERTREND_BCS_LIVE_LOT_SIZE || 0.001);
const LOTS = Math.max(1, Number(process.env.SUPERTREND_BCS_LIVE_LOTS || 1));
const QTY = LOT_SIZE * LOTS;

// Delta REST
const DELTA_BASE = (process.env.DELTA_BASE || 'https://api.india.delta.exchange').replace(/\/+$/, '');
const DELTA_KEY = process.env.DELTA_KEY || '';
const DELTA_SECRET = process.env.DELTA_SECRET || '';
const DELTA_USER_AGENT = process.env.DELTA_USER_AGENT || 'delta-exchange-node-client';
const DELTA_TIMEOUT_MS = Math.max(3000, Number(process.env.DELTA_TIMEOUT_MS || 20000));

const STRATEGY = 'SUPERTREND_BEAR_CALL_SPREAD_LIVE_BTC_DELTA';
const SPREADS_COLLECTION = 'SupertrendBcsLiveSpreads';
const PRODUCT_CACHE_COLLECTION = 'DeltaProductCache';

// =====================
// Logging helpers
// =====================

function nowTs(tz = TZ) {
  return moment().tz(tz).format('YYYY-MM-DD HH:mm:ss');
}
function info(msg) {
  // eslint-disable-next-line no-console
  console.log(`[${nowTs()}] [ST_BCS_BTC_LIVE] ${msg}`);
}
function warn(msg) {
  // eslint-disable-next-line no-console
  console.warn(`[${nowTs()}] [ST_BCS_BTC_LIVE][WARN] ${msg}`);
}
function error(msg, err) {
  // eslint-disable-next-line no-console
  console.error(`[${nowTs()}] [ST_BCS_BTC_LIVE][ERROR] ${msg}`);
  if (err) {
    // eslint-disable-next-line no-console
    console.error(err);
  }
}

// =====================
// DB helpers
// =====================

function getDb() {
  const db = mongoose?.connection?.db;
  if (!db) throw new Error('MongoDB not connected (mongoose.connection.db missing).');
  return db;
}

async function findOneSorted(coll, filter, sort) {
  return coll.find(filter).sort(sort).limit(1).next();
}

async function createSpreadDoc(doc) {
  const db = getDb();
  const coll = db.collection(SPREADS_COLLECTION);
  const now = new Date();
  const toInsert = { ...doc, createdAt: doc.createdAt || now, updatedAt: doc.updatedAt || now };
  const res = await coll.insertOne(toInsert);
  return { ...toInsert, _id: res.insertedId };
}

async function updateSpreadDoc(id, patch) {
  const db = getDb();
  const coll = db.collection(SPREADS_COLLECTION);
  let _id = id;
  try {
    if (typeof id === 'string' && mongoose?.Types?.ObjectId?.isValid(id)) _id = new mongoose.Types.ObjectId(id);
  } catch (_) {}
  await coll.updateOne({ _id }, { $set: { ...patch, updatedAt: new Date() } });
}

// =====================
// Delta REST helpers (HMAC signing)
// =====================

function hmacSha256Hex(secret, message) {
  return crypto.createHmac('sha256', String(secret)).update(String(message)).digest('hex');
}

function buildSortedQueryString(query) {
  if (!query || typeof query !== 'object') return '';
  const keys = Object.keys(query).filter((k) => query[k] !== undefined && query[k] !== null);
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
        Object.entries(res.headers || {}).forEach(([k, v]) => (headersLower[String(k).toLowerCase()] = v));
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
    if (!DELTA_KEY || !DELTA_SECRET) throw new Error('Missing DELTA_KEY / DELTA_SECRET in env.');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signatureData = m + timestamp + p + qs + payload;
    headers['api-key'] = DELTA_KEY;
    headers.timestamp = timestamp;
    headers.signature = hmacSha256Hex(DELTA_SECRET, signatureData);
  }

  const res = await httpRequestJson(m, url, headers, payload, DELTA_TIMEOUT_MS);

  // 429 handling (best-effort backoff once)
  if (res.status === 429) {
    const reset = res.headers['x-rate-limit-reset'];
    const waitMs = Math.min(5000, Math.max(250, Number(reset || 0)));
    warn(`Rate limited (429). Backing off ${waitMs}ms.`);
    await new Promise((r) => setTimeout(r, waitMs));
    const retry = await httpRequestJson(m, url, headers, payload, DELTA_TIMEOUT_MS);
    if (retry.status >= 200 && retry.status < 300) return retry.json;
    throw new Error(`Delta API error ${retry.status}: ${retry.raw}`);
  }

  if (res.status >= 200 && res.status < 300) return res.json;

  // Common SignatureExpired retry once
  const errCode = res?.json?.error || res?.json?.error?.code;
  if (String(errCode || '').toLowerCase().includes('signatureexpired')) {
    warn('SignatureExpired from Delta. Retrying once with fresh timestamp.');
    // rebuild with fresh signature
    return deltaRequest(m, p, { query, body, auth });
  }

  throw new Error(`Delta API error ${res.status}: ${res.raw}`);
}

async function getProductIdBySymbol(symbol) {
  const sym = String(symbol || '').trim();
  if (!sym) throw new Error('getProductIdBySymbol: empty symbol');

  const db = getDb();
  const cache = db.collection(PRODUCT_CACHE_COLLECTION);

  const cached = await cache.findOne({ symbol: sym });
  if (cached && Number.isFinite(Number(cached.product_id))) return Number(cached.product_id);

  // paginate products until found
  let after = null;
  for (let i = 0; i < 50; i += 1) {
    const query = { page_size: 1000 };
    if (after) query.after = after;

    const resp = await deltaRequest('GET', '/v2/products', { query, auth: false });
    const arr = resp?.result || [];
    const hit = arr.find((p) => String(p.symbol) === sym);
    if (hit && Number.isFinite(Number(hit.id))) {
      const pid = Number(hit.id);
      await cache.updateOne(
        { symbol: sym },
        { $set: { symbol: sym, product_id: pid, updatedAt: new Date() } },
        { upsert: true }
      );
      return pid;
    }

    after = resp?.meta?.after;
    if (!after) break;
  }

  throw new Error(`Product not found for symbol=${sym}`);
}

async function placeOrder({ product_id, side, size, order_type = 'market_order', limit_price, stop_order_type, stop_price, reduce_only, client_order_id }) {
  const body = {
    product_id: Number(product_id),
    side: String(side),
    size: Number(size),
    order_type: String(order_type),
    reduce_only: !!reduce_only,
    client_order_id: client_order_id ? String(client_order_id) : undefined,
  };
  if (limit_price !== undefined && limit_price !== null) body.limit_price = String(limit_price);
  if (stop_order_type) body.stop_order_type = String(stop_order_type);
  if (stop_price !== undefined && stop_price !== null) body.stop_price = String(stop_price);

  // Remove undefined keys (Delta signature must match payload exactly)
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  const resp = await deltaRequest('POST', '/v2/orders', { body, auth: true });
  if (!resp?.success) throw new Error(`Order placement failed: ${JSON.stringify(resp)}`);
  return resp.result;
}

async function cancelOrder({ id, client_order_id, product_id }) {
  const body = { id: id ? Number(id) : undefined, client_order_id, product_id: product_id ? Number(product_id) : undefined };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  const resp = await deltaRequest('DELETE', '/v2/orders', { body, auth: true });
  if (!resp?.success) throw new Error(`Cancel failed: ${JSON.stringify(resp)}`);
  return resp.result;
}

async function getRecentFills({ product_ids, startTimeMicros, endTimeMicros, page_size = 100 }) {
  const query = {
    product_ids: Array.isArray(product_ids) ? product_ids.join(',') : String(product_ids || ''),
    start_time: Number(startTimeMicros),
    end_time: Number(endTimeMicros),
    page_size: Number(page_size),
  };
  const resp = await deltaRequest('GET', '/v2/fills', { query, auth: true });
  if (!resp?.success) throw new Error(`Fills fetch failed: ${JSON.stringify(resp)}`);
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
// Time / candle helpers (ported from paper controller)
// =====================

function tfToMs(tf) {
  const s = String(tf || '').toUpperCase().trim();
  const m = s.match(/^M(\d+)$/);
  if (m) return Number(m[1]) * 60 * 1000;
  const h = s.match(/^H(\d+)$/);
  if (h) return Number(h[1]) * 60 * 60 * 1000;
  if (s === 'D1') return 24 * 60 * 60 * 1000;
  throw new Error(`Unsupported timeframe: ${tf}`);
}

function weekdayKey(nowIst) {
  const wd = nowIst.format('ddd').toUpperCase(); // Mon, Tue ...
  return wd.slice(0, 3);
}

function hhmmToMoment(dayStr, hhmm, tz) {
  const [h, m] = String(hhmm || '00:00').split(':').map((x) => Number(x));
  return moment.tz(dayStr, 'YYYY-MM-DD', tz).hour(h || 0).minute(m || 0).second(0).millisecond(0);
}

function getActiveDailyExpiry(nowIst) {
  const dayStr = nowIst.format('YYYY-MM-DD');
  const cutoff = hhmmToMoment(dayStr, DAILY_EXPIRY_CUTOFF, TZ);
  if (nowIst.isSameOrAfter(cutoff)) return nowIst.clone().add(1, 'day').format('YYYY-MM-DD');
  return dayStr;
}

// =====================
// Futures candles → SuperTrend
// =====================

async function loadCandlesRange({ stockSymbol, stockName, timeInterval, fromUtc, toUtc, collectionName }) {
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

function pickLastConfirmedCandle(candles, tfMs, now = new Date(), allowFormingCandle = false, candleGraceSeconds = 0) {
  if (!candles || !candles.length) return null;
  const nowMs = now.getTime();
  const graceMs = Math.max(0, Number(candleGraceSeconds || 0)) * 1000;

  for (let i = candles.length - 1; i >= 0; i -= 1) {
    const c = candles[i];
    const start = new Date(c.ts).getTime();
    const end = start + tfMs;
    const isClosed = nowMs >= end + graceMs;
    if (allowFormingCandle) return c;
    if (isClosed) return c;
  }
  return null;
}

function enrichSupertrendCandles(stCandles, stockSymbol, stockName, timeInterval) {
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
  futCandlesCollection,
}) {
  const tfMs = tfToMs(timeInterval);

  const dayStr = nowIst.format('YYYY-MM-DD');
  const fromIst = hhmmToMoment(dayStr, fromTime, TZ);
  const toIst = nowIst.clone();

  // Warmup: pull additional history so ATR stabilizes
  const warmupFromIst = fromIst.clone().subtract(Math.max(2 * minCandles, 50), 'minutes');
  const warmupFromUtc = new Date(warmupFromIst.clone().utc().valueOf());

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

  const lastConfirmed = pickLastConfirmedCandle(candles, tfMs, new Date(), allowFormingCandle, candleGraceSeconds);

  if (!candles.length || !lastConfirmed) {
    return { candles, stCandles: [], lastConfirmedCandle: null, lastConfirmedStCandle: null, tfMs };
  }

  const lastConfirmedTs = new Date(lastConfirmed.ts).getTime();
  const confirmedCandles = candles.filter((c) => new Date(c.ts).getTime() <= lastConfirmedTs);

  const stCandlesRaw = addSupertrendToCandles(confirmedCandles, { atrPeriod, multiplier, changeAtrCalculation });
  const stCandles = enrichSupertrendCandles(stCandlesRaw, stockSymbol, stockName, timeInterval);
  const lastConfirmedStCandle = stCandles.length ? stCandles[stCandles.length - 1] : null;

  return { candles: confirmedCandles, stCandles, lastConfirmedCandle: lastConfirmed, lastConfirmedStCandle, tfMs };
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
  const s = String(m || '').toUpperCase().trim();
  if (s === 'ATM') return { kind: 'ATM', n: 0 };
  const it = s.match(/^ITM(\d+)$/);
  if (it) return { kind: 'ITM', n: Number(it[1] || 0) };
  const ot = s.match(/^OTM(\d+)$/);
  if (ot) return { kind: 'OTM', n: Number(ot[1] || 0) };
  throw new Error(`Invalid moneyness: ${m}. Use ATM, ITM1, ITM2, OTM1, OTM2...`);
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

  // For CALL: ITM -> lower strikes, OTM -> higher strikes
  // For PUT : ITM -> higher strikes, OTM -> lower strikes
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

async function getAvailableStrikesForExpiry(optColl, { underlying, optionType, expiry }) {
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

async function getLatestOptionTickByStrike(optColl, { underlying, optionType, expiry, strike, atOrBeforeUtc }) {
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

async function pickCeLegsFromTicks({ optColl, expiry, underlyingPrice, mainMoneyness, hedgeMoneyness, asOfUtc }) {
  const strikes = await getAvailableStrikesForExpiry(optColl, { underlying: 'BTC', optionType: 'C', expiry });
  if (!strikes.length) return { ok: false, reason: 'NO_STRIKES_FOR_EXPIRY', strikes: [] };

  const mainStrike = pickStrikeByMoneyness(strikes, underlyingPrice, mainMoneyness, 'C');
  const hedgeStrike = pickStrikeByMoneyness(strikes, underlyingPrice, hedgeMoneyness, 'C');

  if (!Number.isFinite(mainStrike) || !Number.isFinite(hedgeStrike)) {
    return { ok: false, reason: 'STRIKE_OUT_OF_RANGE', strikes, mainStrike, hedgeStrike };
  }

  const mainTick = await getLatestOptionTickByStrike(optColl, { underlying: 'BTC', optionType: 'C', expiry, strike: mainStrike, atOrBeforeUtc: asOfUtc });
  const hedgeTick = await getLatestOptionTickByStrike(optColl, { underlying: 'BTC', optionType: 'C', expiry, strike: hedgeStrike, atOrBeforeUtc: asOfUtc });

  if (!mainTick || !hedgeTick || !mainTick.symbol || !hedgeTick.symbol) {
    return { ok: false, reason: 'NO_TICKS_FOR_SELECTED_STRIKES', strikes, mainStrike, hedgeStrike };
  }

  return {
    ok: true,
    strikes,
    main: { symbol: mainTick.symbol, strike: Number(mainTick.strike), optionType: 'C', ltp: Number(mainTick.price), tickTime: mainTick.exchTradeTime },
    hedge: { symbol: hedgeTick.symbol, strike: Number(hedgeTick.strike), optionType: 'C', ltp: Number(hedgeTick.price), tickTime: hedgeTick.exchTradeTime },
    mainStrike,
    hedgeStrike,
  };
}

function buildExitPricesForShort(entryPrice, stopLossPct, targetPct) {
  const sl = entryPrice * (1 + stopLossPct / 100);
  const tp = entryPrice * (1 - targetPct / 100);
  return { stopLossPrice: sl, targetPrice: tp };
}

function computeSpreadPnl({ mainEntry, mainExit, hedgeEntry, hedgeExit, qty }) {
  const mainPoints = Number(mainEntry) - Number(mainExit); // short leg
  const hedgePoints = Number(hedgeExit) - Number(hedgeEntry); // long leg
  const netPoints = mainPoints + hedgePoints;
  const net = netPoints * qty;
  return { qty, mainPoints, hedgePoints, netPoints, net };
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
    { strategy: STRATEGY, stockName: STOCK_NAME, stockSymbol: STOCK_SYMBOL, expiry: expiryStr, status: 'OPEN' },
    { createdAt: -1 }
  );
}

// =====================
// Live execution helpers
// =====================

async function executeEntry({ runId, expiry, underlyingPrice, legs, nowIst }) {
  const mainSymbol = legs.main.symbol;
  const hedgeSymbol = legs.hedge.symbol;

  const hedgePid = await getProductIdBySymbol(hedgeSymbol);
  const mainPid = await getProductIdBySymbol(mainSymbol);

  // Hedge first (BUY), then main (SELL)
  const hedgeClientId = `${runId}-HEDGE-BUY`;
  const mainClientId = `${runId}-MAIN-SELL`;

  const entryStart = Date.now();
  const hedgeOrder = await placeOrder({
    product_id: hedgePid,
    side: 'buy',
    size: QTY,
    order_type: 'market_order',
    reduce_only: false,
    client_order_id: hedgeClientId,
  });

  const mainOrder = await placeOrder({
    product_id: mainPid,
    side: 'sell',
    size: QTY,
    order_type: 'market_order',
    reduce_only: false,
    client_order_id: mainClientId,
  });

  // Pull fills for the last ~2 minutes for both products and compute VWAP for each order_id
  const endMicros = Date.now() * 1000;
  const startMicros = (Date.now() - 2 * 60 * 1000) * 1000;

  const fills = await getRecentFills({ product_ids: [mainPid, hedgePid], startTimeMicros: startMicros, endTimeMicros: endMicros, page_size: 200 });

  const mainFills = fills.filter((f) => String(f.order_id) === String(mainOrder.id));
  const hedgeFills = fills.filter((f) => String(f.order_id) === String(hedgeOrder.id));

  const mainFillPrice = computeVwapFromFills(mainFills) ?? Number(legs.main.ltp);
  const hedgeFillPrice = computeVwapFromFills(hedgeFills) ?? Number(legs.hedge.ltp);

  const tookMs = Date.now() - entryStart;

  return {
    main: { symbol: mainSymbol, product_id: mainPid, order: mainOrder, fillPrice: mainFillPrice },
    hedge: { symbol: hedgeSymbol, product_id: hedgePid, order: hedgeOrder, fillPrice: hedgeFillPrice },
    tookMs,
    underlyingPrice,
    expiry,
    time: nowIst.toISOString(true),
  };
}

async function executeExit({ runId, open, reason, nowIst }) {
  const mainPid = Number(open?.main?.product_id);
  const hedgePid = Number(open?.hedge?.product_id);
  if (!Number.isFinite(mainPid) || !Number.isFinite(hedgePid)) throw new Error('Missing product_id on open spread doc.');

  const exitStart = Date.now();

  // Main first (BUY) to remove naked short exposure, then hedge (SELL)
  const mainClientId = `${runId}-MAIN-BUY-EXIT`;
  const hedgeClientId = `${runId}-HEDGE-SELL-EXIT`;

  const mainExitOrder = await placeOrder({
    product_id: mainPid,
    side: 'buy',
    size: QTY,
    order_type: 'market_order',
    reduce_only: true,
    client_order_id: mainClientId,
  });

  const hedgeExitOrder = await placeOrder({
    product_id: hedgePid,
    side: 'sell',
    size: QTY,
    order_type: 'market_order',
    reduce_only: true,
    client_order_id: hedgeClientId,
  });

  const endMicros = Date.now() * 1000;
  const startMicros = (Date.now() - 2 * 60 * 1000) * 1000;

  const fills = await getRecentFills({ product_ids: [mainPid, hedgePid], startTimeMicros: startMicros, endTimeMicros: endMicros, page_size: 200 });

  const mainFills = fills.filter((f) => String(f.order_id) === String(mainExitOrder.id));
  const hedgeFills = fills.filter((f) => String(f.order_id) === String(hedgeExitOrder.id));

  const mainExitPrice = computeVwapFromFills(mainFills) ?? Number(open?.mtm?.mainPrice ?? open?.main?.entry?.price);
  const hedgeExitPrice = computeVwapFromFills(hedgeFills) ?? Number(open?.mtm?.hedgePrice ?? open?.hedge?.entry?.price);

  const pnl = computeSpreadPnl({
    mainEntry: Number(open?.main?.entry?.price),
    mainExit: mainExitPrice,
    hedgeEntry: Number(open?.hedge?.entry?.price),
    hedgeExit: hedgeExitPrice,
    qty: Number(open?.config?.qty || QTY),
  });

  const tookMs = Date.now() - exitStart;

  return {
    reason,
    time: nowIst.toISOString(true),
    orders: { mainExitOrder, hedgeExitOrder },
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

  // weekday guard
  const wd = weekdayKey(nowIst);
  if (!WEEKDAYS.includes(wd)) return { took: false, reason: 'WEEKDAY_GUARD' };

  // time guard
  const fromIst = hhmmToMoment(dayStr, FROM_TIME, TZ);
  const squareOffIst = hhmmToMoment(dayStr, SQUARE_OFF_TIME, TZ);
  if (nowIst.isBefore(fromIst)) return { took: false, reason: 'BEFORE_FROM_TIME' };
  if (nowIst.isSameOrAfter(squareOffIst)) return { took: false, reason: 'AFTER_SQUAREOFF_TIME' };

  const expiry = getActiveDailyExpiry(nowIst);

  // max trades/day guard (keyed by expiry)
  if (getDailyTradeCount(expiry) >= MAX_TRADES_PER_DAY) return { took: false, reason: 'MAX_TRADES_REACHED' };

  const open = await findOpenSpreadForExpiry(expiry);
  if (open) return { took: false, reason: 'OPEN_SPREAD_EXISTS' };

  // Build SuperTrend & signal candle
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

  const signalCandle = st.lastConfirmedStCandle;
  if (!signalCandle) return { took: false, reason: 'NO_FUT_CANDLES' };
  if ((st.candles || []).length < MIN_CANDLES) return { took: false, reason: 'INSUFFICIENT_CANDLES' };

  const sellSignal = !!(signalCandle?.supertrend?.sellSignal ?? signalCandle?.sellSignal);
  if (!FORCE_ENTRY && !sellSignal) return { took: false, reason: 'NO_SELL_SIGNAL' };

  const underlyingPrice = Number(signalCandle.close);
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return { took: false, reason: 'INVALID_UNDERLYING_PRICE' };

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
  if (!legs.ok) return { took: false, reason: legs.reason, meta: { expiry, underlyingPrice } };

  const runId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

  // Create a doc first (idempotency + audit)
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
      squareOffTime: SQUARE_OFF_TIME,
      atrPeriod: ATR_PERIOD,
      multiplier: MULTIPLIER,
      changeAtrCalculation: CHANGE_ATR_CALC,
      stopLossPct: STOPLOSS_PCT,
      stopLossEnabled: STOPLOSS_ENABLED,
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
      time: nowIst.toISOString(true),
      underlyingPrice,
      signalCandleTs: signalCandle.ts || null,
      signalCandleDatetime: signalCandle.datetime || null,
    },
    main: { side: 'SELL', optionType: 'C', symbol: legs.main.symbol, strike: legs.main.strike, entry: { time: nowIst.toISOString(true), price: Number(legs.main.ltp) } },
    hedge: { side: 'BUY', optionType: 'C', symbol: legs.hedge.symbol, strike: legs.hedge.strike, entry: { time: nowIst.toISOString(true), price: Number(legs.hedge.ltp) } },
    exit: null,
    pnl: null,
  });

  // Execute live entry
  const exec = await executeEntry({ runId, expiry, underlyingPrice, legs, nowIst });

  await updateSpreadDoc(entryDoc._id, {
    status: 'OPEN',
    main: {
      ...entryDoc.main,
      product_id: exec.main.product_id,
      entry: { ...entryDoc.main.entry, price: exec.main.fillPrice, orderId: exec.main.order.id, clientOrderId: exec.main.order.client_order_id || null },
    },
    hedge: {
      ...entryDoc.hedge,
      product_id: exec.hedge.product_id,
      entry: { ...entryDoc.hedge.entry, price: exec.hedge.fillPrice, orderId: exec.hedge.order.id, clientOrderId: exec.hedge.order.client_order_id || null },
    },
    entryExecution: { tookMs: exec.tookMs, at: new Date() },
  });

  incDailyTradeCount(expiry);

  info(`ENTRY expiry=${expiry} sellSignal=${sellSignal} underlying=${underlyingPrice.toFixed(1)} main=${legs.main.symbol}@${exec.main.fillPrice} hedge=${legs.hedge.symbol}@${exec.hedge.fillPrice} qty=${QTY}`);
  return { took: true, reason: 'ENTERED', spreadId: String(entryDoc._id), runId };
}

async function maybeExitOpenSpread(nowIst, open) {
  if (!open || open.status !== 'OPEN') return { exited: false };

  const dayStr = nowIst.format('YYYY-MM-DD');
  const squareOffIst = hhmmToMoment(dayStr, SQUARE_OFF_TIME, TZ);
  const shouldSquareOff = nowIst.isSameOrAfter(squareOffIst);

  // Get latest ticks for main/hedge (current month collection)
  const db = getDb();
  const optColl = await getOptionCollectionForNow(db);
  const nowUtc = new Date(nowIst.clone().utc().valueOf());

  const mainTick = await optColl.find({ symbol: open.main.symbol, exchTradeTime: { $lte: nowUtc } }).sort({ exchTradeTime: -1 }).limit(1).next();
  const hedgeTick = await optColl.find({ symbol: open.hedge.symbol, exchTradeTime: { $lte: nowUtc } }).sort({ exchTradeTime: -1 }).limit(1).next();

  const mainMark = Number(mainTick?.price);
  const hedgeMark = Number(hedgeTick?.price);

  // SL/TP decision is based on main mark (short call)
  const mainEntry = Number(open?.main?.entry?.price);
  let { stopLossPrice, targetPrice } = buildExitPricesForShort(mainEntry, STOPLOSS_PCT, TARGET_PCT);
  if (!STOPLOSS_ENABLED) stopLossPrice = Number.NaN;

  let exitReason = null;

  if (Number.isFinite(mainMark)) {
    if (Number.isFinite(stopLossPrice) && mainMark >= stopLossPrice) exitReason = 'STOPLOSS';
    if (!exitReason && Number.isFinite(targetPrice) && mainMark <= targetPrice) exitReason = 'TARGET';
  }

  // SuperTrend reversal: for BCS exit when BUY signal appears
  if (!exitReason) {
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
    const sig = st.lastConfirmedStCandle;
    const buySignal = !!(sig?.supertrend?.buySignal ?? sig?.buySignal);
    if (buySignal) exitReason = 'ST_REVERSAL_BUY';
  }

  if (!exitReason && shouldSquareOff) exitReason = 'SQUARE_OFF';

  if (!exitReason) {
    // Update MTM if we have marks
    if (Number.isFinite(mainMark) && Number.isFinite(hedgeMark)) {
      const pnl = computeSpreadPnl({
        mainEntry: Number(open?.main?.entry?.price),
        mainExit: mainMark,
        hedgeEntry: Number(open?.hedge?.entry?.price),
        hedgeExit: hedgeMark,
        qty: Number(open?.config?.qty || QTY),
      });
      await updateSpreadDoc(open._id, { mtm: { time: nowIst.toISOString(true), mainPrice: mainMark, hedgePrice: hedgeMark, pnl } });
    }
    return { exited: false };
  }

  // Execute live exit
  const exec = await executeExit({ runId: open.runId, open, reason: exitReason, nowIst });

  await updateSpreadDoc(open._id, {
    status: 'CLOSED',
    exit: {
      reason: exec.reason,
      time: exec.time,
      main: { symbol: open.main.symbol, price: exec.prices.mainExitPrice, orderId: exec.orders.mainExitOrder.id },
      hedge: { symbol: open.hedge.symbol, price: exec.prices.hedgeExitPrice, orderId: exec.orders.hedgeExitOrder.id },
    },
    pnl: exec.pnl,
    exitExecution: { tookMs: exec.tookMs, at: new Date() },
  });

  info(`EXIT(${exec.reason}) expiry=${open.expiry} main=${open.main.symbol}@${exec.prices.mainExitPrice} hedge=${open.hedge.symbol}@${exec.prices.hedgeExitPrice} net=${exec.pnl.net.toFixed(6)}`);
  return { exited: true, reason: exec.reason, pnl: exec.pnl };
}

async function liveLoopOnce() {
  const nowIst = moment().tz(TZ);
  const expiry = getActiveDailyExpiry(nowIst);

  const open = await findOpenSpreadForExpiry(expiry);
  if (open) {
    return maybeExitOpenSpread(nowIst, open);
  }
  return maybeEnterTrade(nowIst);
}

// =====================
// Express handler (status / config)
// =====================

const SuperTrendBearCallSpreadLiveTradeBTCController = expressAsyncHandler(async (req, res, next) => {
  try {
    const nowIst = moment().tz(TZ);
    const expiry = getActiveDailyExpiry(nowIst);
    const open = await findOpenSpreadForExpiry(expiry);

    res.status(200).json({
      success: true,
      controller: 'SuperTrendBearCallSpreadLiveTradeBTCController',
      now: nowIst.toISOString(true),
      activeExpiry: expiry,
      open: open ? { id: String(open._id), runId: open.runId, status: open.status, main: open.main?.symbol, hedge: open.hedge?.symbol } : null,
      config: {
        TZ,
        CRON_EXPR,
        CRON_SECONDS,
        STOCK_NAME,
        STOCK_SYMBOL,
        FUT_CANDLES_COLLECTION,
        OPT_TICKS_PREFIX,
        INDEX_TF,
        FROM_TIME,
        SQUARE_OFF_TIME,
        DAILY_EXPIRY_CUTOFF,
        STOPLOSS_ENABLED,
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
        HEARTBEAT_MS,
        LOT_SIZE,
        LOTS,
        QTY,
        DELTA_BASE,
      },
    });
  } catch (e) {
    error('Controller error', e);
    next(new AppError(e.message || 'Live trade controller failed', 500));
  }
});

// =====================
// Cron starter
// =====================

function startSuperTrendBearCallSpreadLiveTradeBTCron() {
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
    { timezone: TZ }
  );

  // Optional MTM poller (lightweight)
  if (!pnlTimer) {
    pnlTimer = setInterval(async () => {
      try {
        const nowIst = moment().tz(TZ);
        const expiry = getActiveDailyExpiry(nowIst);
        const open = await findOpenSpreadForExpiry(expiry);
        if (!open) return;
        await maybeExitOpenSpread(nowIst, open); // will update MTM if not exiting
      } catch {
        // silent
      }
    }, PNL_POLL_MS);

    if (pnlTimer && typeof pnlTimer.unref === 'function') pnlTimer.unref();
  }

  // Heartbeat
  if (!heartbeatTimer && HEARTBEAT_MS > 0) {
    heartbeatTimer = setInterval(async () => {
      try {
        const nowIst = moment().tz(TZ);
        const activeExpiry = getActiveDailyExpiry(nowIst);
        const openActive = await findOpenSpreadForExpiry(activeExpiry);
        info(
          `HEARTBEAT now=${nowIst.format('YYYY-MM-DD HH:mm:ss')} activeExpiry=${activeExpiry} inFlight=${cronInFlight} trades(activeExpiry)=${getDailyTradeCount(
            activeExpiry
          )} openActive=${!!openActive}`
        );
      } catch {
        // silent
      }
    }, HEARTBEAT_MS);

    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  return cronTask;
}

function stopSuperTrendBearCallSpreadLiveTradeBTCron() {
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

// For manual trigger/testing (no cron)
async function runSuperTrendBearCallSpreadLiveTradeBTCCycle() {
  return liveLoopOnce();
}

module.exports = {
  SuperTrendBearCallSpreadLiveTradeBTCController,
  startSuperTrendBearCallSpreadLiveTradeBTCron,
  stopSuperTrendBearCallSpreadLiveTradeBTCron,
  runSuperTrendBearCallSpreadLiveTradeBTCCycle,
};
