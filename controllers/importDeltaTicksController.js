/**
 * Delta CSV -> MongoDB Time-Series Importer (Futures + Options)
 * - Writes FUT and OPT ticks into separate time-series collections
 * - Streaming CSV (fast-csv) + GZip
 * - Deterministic _id for idempotent re-runs
 * - insertMany (no updates) for time-series compliance
 * - Backpressure (pause -> await flush -> resume)
 * - Microseconds -> milliseconds timestamp normalization
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { MongoClient } = require('mongodb');
const { parse } = require('fast-csv');
const fg = require('fast-glob');
const moment = require('moment-timezone');
const pLimit = require('p-limit').default;
const crypto = require('crypto');
const { PassThrough } = require('stream');

// ----------------------------- Config -----------------------------
const DEFAULTS = {
  dbName: process.env.DB_NAME || 'delta',
  batchSize: Number(process.env.BATCH_SIZE || 1000), // tune: 500–2000
  maxConcurrentFiles: Number(process.env.MAX_CONCURRENT || 2),
  currency: 'USD',
};

// Target collections (separate)
const FUTURES_COLL = process.env.FUTURES_COLL || 'delta_futures_ts';
const OPTIONS_COLL = process.env.OPTIONS_COLL || 'delta_options_ts';

// ----------------------------- Symbol Parsing -----------------------------
function parseOptionSymbol(symbol) {
  // e.g., P-BTC-116000-010825
  const m = symbol.match(/^([CP])-(\w+)-(\d+)-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, otype, asset, strike, dd, mm, yy] = m;

  const expiry = moment.utc(`${dd}-${mm}-20${yy}`, 'DD-MM-YYYY', true);
  if (!expiry.isValid()) return null;

  return {
    instrument: symbol,
    asset,
    contract_type: 'OPT',
    option_type: otype,
    strike: Number(strike),
    expiry: expiry.format('YYYY-MM-DD'),
    currency: DEFAULTS.currency,
  };
}

function parseFuturesSymbol(symbol) {
  // e.g., BTCUSD / ETHUSD
  const m = symbol.match(/^([A-Z]+)USD$/);
  if (!m) return null;
  return {
    instrument: symbol,
    asset: m[1],
    contract_type: 'FUT',
    currency: DEFAULTS.currency,
  };
}

function parseProductSymbol(symbol) {
  if (!symbol) return null;
  if (/^[CP]-/.test(symbol)) return parseOptionSymbol(symbol);
  return parseFuturesSymbol(symbol);
}

function tickId({ instrument, ts, price, size, role }) {
  const key = `${instrument}|${ts.toISOString()}|${price}|${size}|${role}`;
  return crypto.createHash('sha1').update(key).digest('hex'); // deterministic _id
}

// ----------------------------- Timestamp Parsing -----------------------------
function makeTimestampResolver({ filePath, startDate }) {
  // Normalize fractional seconds to millis (e.g., .533193 -> .533)
  function trimFractionToMillis(s) {
    return String(s).replace(/(\.\d{3})\d+/g, '$1');
  }

  // Infer start date from file if not provided
  let inferredStart = startDate;
  if (!inferredStart) {
    const d1 = filePath.match(/\b(\d{4}-\d{2}-\d{2})\b/); // yyyy-mm-dd
    const d2 = filePath.match(/\b(\d{4}-\d{2})\b/); // yyyy-mm
    if (d1) inferredStart = d1[1];
    else if (d2) inferredStart = `${d2[1]}-01`;
  }
  if (!inferredStart) inferredStart = moment.utc().format('YYYY-MM-DD');

  let currentDay = moment.utc(inferredStart, 'YYYY-MM-DD').startOf('day');
  let lastSeconds = -1;

  const FULL_FORMATS = [
    'DD/MM/YYYY HH:mm:ss.SSS',
    'DD/MM/YYYY HH:mm:ss',
    'YYYY-MM-DD HH:mm:ss.SSS',
    'YYYY-MM-DD HH:mm:ss',
  ];
  const TIME_ONLY_FORMATS = ['HH:mm:ss.SSS', 'HH:mm:ss', 'HH:mm.SSS', 'HH:mm'];

  const parseFull = (raw) => {
    const s = trimFractionToMillis(raw);
    const m = moment.utc(s, FULL_FORMATS, true);
    return m.isValid() ? m.toDate() : null;
  };

  const parseTimeOnly = (raw) => {
    const s = trimFractionToMillis(raw);
    const m = moment.utc(s, TIME_ONLY_FORMATS, true);
    if (!m.isValid()) return null;

    const secondsOfDay =
      m.hours() * 3600 +
      m.minutes() * 60 +
      (m.seconds() + m.milliseconds() / 1000);

    // detect wrap (23:59 -> 00:00) and roll day forward
    if (lastSeconds >= 0 && secondsOfDay + 2 < lastSeconds) {
      currentDay = currentDay.clone().add(1, 'day');
    }
    lastSeconds = secondsOfDay;

    const combined = currentDay
      .clone()
      .hour(m.hour())
      .minute(m.minute())
      .second(m.second())
      .millisecond(m.millisecond());
    return combined.toDate(); // UTC
  };

  return function resolve(tsStr) {
    return (
      parseFull(tsStr) ??
      parseTimeOnly(tsStr) ??
      (() => {
        throw new Error(`Unparseable timestamp "${tsStr}" in ${filePath}`);
      })()
    );
  };
}

// ----------------------------- Mongo helpers -----------------------------
async function ensureTimeSeriesCollection(db, collectionName) {
  const exists = await db.listCollections({ name: collectionName }).hasNext();
  if (!exists) {
    await db.createCollection(collectionName, {
      timeseries: {
        timeField: 'ts',
        metaField: 'meta',
        granularity: 'seconds',
      },
    });
    // No unique indexes on time-series collections
    await db
      .collection(collectionName)
      .createIndex({ 'meta.instrument': 1, ts: 1 }, { name: 'inst_ts' });
  }
}

// ----------------------------- Core Import (routes FUT/OPT separately) -----------------------------
async function importFile({
  client,
  filePath,
  dbName = DEFAULTS.dbName,
  batchSize = DEFAULTS.batchSize,
  startDate,
}) {
  const db = client.db(dbName);
  const base = path.basename(filePath);
  const resolveTs = makeTimestampResolver({ filePath, startDate });

  let rowNo = 0;
  let inserted = 0;
  let dupSkipped = 0;
  let lastFlush = Date.now();

  // Keep separate batches
  let batchFut = [];
  let batchOpt = [];

  const flush = async () => {
    const toInsertF = batchFut;
    batchFut = [];
    const toInsertO = batchOpt;
    batchOpt = [];
    lastFlush = Date.now();

    if (toInsertF.length) {
      try {
        const resF = await db
          .collection(FUTURES_COLL)
          .insertMany(toInsertF, { ordered: false });
        inserted += resF.insertedCount || 0;
      } catch (err) {
        if (err && err.writeErrors?.length) {
          const dups = err.writeErrors.filter((e) => e.code === 11000).length;
          dupSkipped += dups;
          const nonDup = err.writeErrors.length - dups;
          if (nonDup > 0) {
            console.error(
              `[${base} FUT] non-duplicate write errors:`,
              nonDup,
              err.message
            );
          }
        } else if (err?.code === 11000) {
          dupSkipped += 1;
        } else if (err) {
          console.error(`[${base} FUT] insertMany error:`, err.message);
        }
      }
    }

    if (toInsertO.length) {
      try {
        const resO = await db
          .collection(OPTIONS_COLL)
          .insertMany(toInsertO, { ordered: false });
        inserted += resO.insertedCount || 0;
      } catch (err) {
        if (err && err.writeErrors?.length) {
          const dups = err.writeErrors.filter((e) => e.code === 11000).length;
          dupSkipped += dups;
          const nonDup = err.writeErrors.length - dups;
          if (nonDup > 0) {
            console.error(
              `[${base} OPT] non-duplicate write errors:`,
              nonDup,
              err.message
            );
          }
        } else if (err?.code === 11000) {
          dupSkipped += 1;
        } else if (err) {
          console.error(`[${base} OPT] insertMany error:`, err.message);
        }
      }
    }
  };

  await new Promise((resolve, reject) => {
    const read = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 });
    const gunzip = filePath.endsWith('.gz')
      ? zlib.createGunzip({ chunkSize: 64 * 1024 })
      : new PassThrough();
    const parser = parse({ headers: true, trim: true, ignoreEmpty: true });

    read
      .on('error', reject)
      .pipe(gunzip)
      .on('error', reject)
      .pipe(parser)
      .on('error', reject)
      .on('data', async (raw) => {
        rowNo++;

        // Normalize column names
        const product_symbol = String(
          raw.product_symbol ?? raw.symbol ?? ''
        ).trim();
        const tsStr = String(raw.timestamp ?? raw.time ?? '').trim();
        const buyer_role = String(raw.buyer_role ?? raw.side ?? '')
          .trim()
          .toLowerCase();
        const priceNum = Number(raw.price);
        const sizeNum = Number(raw.size ?? raw.qty ?? raw.quantity);

        // Lightweight validation
        if (
          !product_symbol ||
          !tsStr ||
          !buyer_role ||
          !isFinite(priceNum) ||
          !isFinite(sizeNum) ||
          priceNum <= 0 ||
          sizeNum <= 0
        ) {
          return;
        }

        const meta = parseProductSymbol(product_symbol);
        if (!meta) return;

        const ts = resolveTs(tsStr);
        const role = buyer_role === 'taker' ? 'taker' : 'maker';

        const doc = {
          _id: tickId({
            instrument: meta.instrument,
            ts,
            price: priceNum,
            size: sizeNum,
            role,
          }),
          ts,
          price: priceNum,
          size: sizeNum,
          role,
          meta,
          src: { file: base, row: rowNo },
        };

        if (meta.contract_type === 'FUT') batchFut.push(doc);
        else batchOpt.push(doc);

        // HARD backpressure
        const needFlush =
          batchFut.length + batchOpt.length >= batchSize ||
          Date.now() - lastFlush > 1500;

        if (needFlush) {
          parser.pause();
          try {
            await flush();
          } finally {
            parser.resume();
          }
        }
      })
      .on('end', async () => {
        try {
          await flush();
          console.log(
            `[${base}] ✔ done - inserted=${inserted}, skippedDup=${dupSkipped}`
          );
          resolve();
        } catch (e) {
          reject(e);
        }
      });
  });
}

// ----------------------------- Public API -----------------------------
/**
 * Import CSV files (glob or array) into MongoDB time-series collections.
 *
 * @param {Object} cfg
 *  - mongoUri (required)
 *  - filesGlob (glob string or array of globs, e.g., "data/2025-08/*.csv.gz")
 *  - dbName, batchSize, startDate (YYYY-MM-DD for time-only rows)
 *  - maxConcurrentFiles
 */
async function importDeltaTicksCSV(cfg) {
  const {
    mongoUri,
    filesGlob,
    dbName = DEFAULTS.dbName,
    batchSize = DEFAULTS.batchSize,
    startDate,
    maxConcurrentFiles = DEFAULTS.maxConcurrentFiles,
  } = cfg;

  if (!mongoUri) throw new Error('mongoUri is required');
  if (!filesGlob)
    throw new Error('filesGlob (glob string or array) is required');

  const patterns = Array.isArray(filesGlob) ? filesGlob : [filesGlob];
  const files = await fg(patterns, { absolute: true, onlyFiles: true });
  if (!files.length) {
    console.warn('No files matched:', patterns.join(', '));
    return;
  }

  const client = await MongoClient.connect(mongoUri, {
    // No compressors to avoid optional deps locally
    maxPoolSize: 20,
    writeConcern: { w: 1 },
  });

  try {
    const db = client.db(dbName);
    // Ensure both TS collections exist
    await ensureTimeSeriesCollection(db, FUTURES_COLL);
    await ensureTimeSeriesCollection(db, OPTIONS_COLL);

    const limit = pLimit(maxConcurrentFiles);
    await Promise.all(
      files.map((f) =>
        limit(() =>
          importFile({ client, filePath: f, dbName, batchSize, startDate })
        )
      )
    );

    console.log('All imports completed.');
  } finally {
    await client.close();
  }
}

module.exports = { importDeltaTicksCSV };
