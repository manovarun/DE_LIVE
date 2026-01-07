/**
 * Ticks -> Candles Generator (BTCUSD etc.)
 * - Reads ticks from a MongoDB collection (works well with time-series ticks)
 * - Builds OHLCV candles for intervals like M1, M2, M3, M4, M5...
 * - Uses $dateTrunc with timezone to align candle boundaries
 * - Deterministic candle _id for idempotent re-runs
 * - insertMany ordered:false to tolerate duplicates
 */

const crypto = require('crypto');
const moment = require('moment-timezone');
const { MongoClient } = require('mongodb');

// ----------------------------- Defaults -----------------------------
const DEFAULTS = {
  dbName: process.env.DB_NAME || 'delta',

  // Your importer routes FUT ticks into FUTURES_COLL (default delta_futures_ts)
  // so BTCUSD (contract_type FUT) typically lives there.
  ticksCollection:
    process.env.TICKS_COLL || process.env.FUTURES_COLL || 'delta_futures_ts',

  // Output candles collection (normal collection)
  candlesCollection: process.env.CANDLES_COLL || 'delta_futures_candles',

  instrument: process.env.INSTRUMENT || 'BTCUSD',
  timezone: process.env.TIMEZONE || 'Asia/Kolkata',

  // Which candles to build
  intervals: (process.env.INTERVALS || 'M1,M2,M3,M4,M5')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Insert batch
  insertBatchSize: Number(process.env.CANDLE_BATCH_SIZE || 2000),

  // Chunking by day (helps on large date ranges)
  chunkDays: Number(process.env.CHUNK_DAYS || 1),
};

// ----------------------------- Helpers -----------------------------
function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function parseIntervalSpec(interval) {
  const s = String(interval).trim().toUpperCase();

  let m = s.match(/^M(\d+)$/);
  if (m) {
    const binSize = Number(m[1]);
    if (!Number.isFinite(binSize) || binSize <= 0)
      throw new Error(`Invalid interval "${interval}"`);
    return { unit: 'minute', binSize };
  }

  m = s.match(/^H(\d+)$/);
  if (m) {
    const binSize = Number(m[1]);
    if (!Number.isFinite(binSize) || binSize <= 0)
      throw new Error(`Invalid interval "${interval}"`);
    return { unit: 'hour', binSize };
  }

  m = s.match(/^D(\d+)$/);
  if (m) {
    const binSize = Number(m[1]);
    if (!Number.isFinite(binSize) || binSize <= 0)
      throw new Error(`Invalid interval "${interval}"`);
    return { unit: 'day', binSize };
  }

  throw new Error(
    `Unsupported interval "${interval}". Supported: M<n> (minutes), H<n> (hours), D<n> (days). Examples: M1, M30, H1, D1.`
  );
}

async function ensureCandlesCollection(db, candlesCollection) {
  const exists = await db
    .listCollections({ name: candlesCollection })
    .hasNext();
  if (!exists) {
    await db.createCollection(candlesCollection);
  }

  // Helpful non-unique indexes for reads
  await db
    .collection(candlesCollection)
    .createIndex(
      { stockSymbol: 1, timeInterval: 1, ts: 1 },
      { name: 'sym_tf_ts' }
    );
}

async function getInstrumentMeta(db, ticksCollection, instrument) {
  const doc = await db
    .collection(ticksCollection)
    .findOne({ 'meta.instrument': instrument }, { projection: { meta: 1 } });
  return doc?.meta || { instrument };
}

async function getRangeBounds(db, ticksCollection, instrument, fromTs, toTs) {
  const q = { 'meta.instrument': instrument };
  const proj = { projection: { ts: 1 } };

  let from = fromTs ? new Date(fromTs) : null;
  let to = toTs ? new Date(toTs) : null;

  if (!from) {
    const first = await db
      .collection(ticksCollection)
      .find(q, proj)
      .sort({ ts: 1 })
      .limit(1)
      .next();
    from = first?.ts || null;
  }
  if (!to) {
    const last = await db
      .collection(ticksCollection)
      .find(q, proj)
      .sort({ ts: -1 })
      .limit(1)
      .next();
    to = last?.ts || null;
  }

  if (!from || !to) {
    throw new Error(
      `No ticks found for instrument=${instrument} in ${ticksCollection}`
    );
  }

  if (from >= to)
    throw new Error(
      `Invalid range: from >= to (${from.toISOString()} >= ${to.toISOString()})`
    );

  return { from, to };
}

function* dayChunks({ from, to, timezone, chunkDays }) {
  // Align to timezone day boundaries so buckets don't get split.
  let cur = moment(from).tz(timezone).startOf('day');
  const end = moment(to).tz(timezone);

  while (cur.isBefore(end)) {
    const chunkStart = cur.clone();
    const chunkEnd = cur.clone().add(chunkDays, 'day');
    yield {
      start: chunkStart.toDate(), // UTC Date
      end: moment.min(chunkEnd, end).toDate(),
    };
    cur = chunkEnd;
  }
}

async function insertCandlesBatch(db, candlesCollection, batch) {
  if (!batch.length) return { inserted: 0, dupSkipped: 0 };

  try {
    const res = await db
      .collection(candlesCollection)
      .insertMany(batch, { ordered: false });
    return { inserted: res.insertedCount || 0, dupSkipped: 0 };
  } catch (err) {
    // Handle duplicate key errors (11000) gracefully
    let dupSkipped = 0;
    if (err?.writeErrors?.length) {
      dupSkipped = err.writeErrors.filter((e) => e.code === 11000).length;
      const nonDup = err.writeErrors.length - dupSkipped;
      if (nonDup > 0) {
        console.error(
          `[candles] non-duplicate write errors:`,
          nonDup,
          err.message
        );
      }
    } else if (err?.code === 11000) {
      dupSkipped = 1;
    } else {
      console.error(`[candles] insertMany error:`, err?.message || err);
    }
    return { inserted: Math.max(0, batch.length - dupSkipped), dupSkipped };
  }
}

// ----------------------------- Core per interval -----------------------------
async function buildCandlesForInterval({
  db,
  ticksCollection,
  candlesCollection,
  instrument,
  timezone,
  interval,
  from,
  to,
  chunkDays,
  insertBatchSize,
  meta,
}) {
  const { unit, binSize } = parseIntervalSpec(interval);

  console.log(
    `[${instrument} ${interval}] Building candles. tz=${timezone}, range=${from.toISOString()} -> ${to.toISOString()}, chunkDays=${chunkDays}`
  );

  let insertedTotal = 0;
  let dupSkippedTotal = 0;

  // Process in day chunks to keep aggregation memory stable for large ranges
  for (const chunk of dayChunks({ from, to, timezone, chunkDays })) {
    const { start, end } = chunk;
    if (start >= end) continue;

    const pipeline = [
      {
        $match: {
          'meta.instrument': instrument,
          ts: { $gte: start, $lt: end },
        },
      },
      { $sort: { ts: 1 } },
      {
        $addFields: {
          bucket: {
            $dateTrunc: {
              date: '$ts',
              unit,
              binSize,
              timezone,
            },
          },
        },
      },
      {
        $group: {
          _id: '$bucket',
          open: { $first: '$price' },
          high: { $max: '$price' },
          low: { $min: '$price' },
          close: { $last: '$price' },
          volume: { $sum: '$size' },
          trades: { $sum: 1 },
          firstTs: { $first: '$ts' },
          lastTs: { $last: '$ts' },
        },
      },
      { $sort: { _id: 1 } },
    ];

    const cursor = db
      .collection(ticksCollection)
      .aggregate(pipeline, { allowDiskUse: true, batchSize: 5000 });

    let batch = [];
    for await (const row of cursor) {
      const bucketDate = row._id; // Date (UTC), aligned to timezone buckets
      const datetime = moment(bucketDate).tz(timezone).format(); // "YYYY-MM-DDTHH:mm:ss+05:30"

      // Deterministic candle id
      const candleId = sha1(
        `${instrument}|${interval}|${bucketDate.toISOString()}`
      );

      batch.push({
        _id: candleId,

        // Your candle schema fields
        stockSymbol: instrument,
        stockName: meta.asset || instrument, // "BTC" for BTCUSD
        datetime, // with offset as you showed
        timeInterval: interval,

        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,

        // Optional but usually useful
        volume: row.volume,
        trades: row.trades,

        // Strongly recommended for querying/sorting (UTC Date)
        ts: bucketDate,

        // Optional traceability
        src: {
          ticksCollection,
          chunkStart: start,
          chunkEnd: end,
        },
      });

      if (batch.length >= insertBatchSize) {
        const r = await insertCandlesBatch(db, candlesCollection, batch);
        insertedTotal += r.inserted;
        dupSkippedTotal += r.dupSkipped;
        batch = [];
      }
    }

    if (batch.length) {
      const r = await insertCandlesBatch(db, candlesCollection, batch);
      insertedTotal += r.inserted;
      dupSkippedTotal += r.dupSkipped;
    }

    console.log(
      `[${instrument} ${interval}] chunk done: ${start.toISOString()} -> ${end.toISOString()} (insertedSoFar=${insertedTotal}, dupSkippedSoFar=${dupSkippedTotal})`
    );
  }

  console.log(
    `[${instrument} ${interval}] ✔ done - inserted=${insertedTotal}, dupSkipped=${dupSkippedTotal}`
  );
}

// ----------------------------- Public API -----------------------------
/**
 * Generate candles from ticks.
 *
 * @param {Object} cfg
 *  - mongoUri (required)
 *  - dbName
 *  - ticksCollection
 *  - candlesCollection
 *  - instrument (e.g., BTCUSD)
 *  - timezone (e.g., Asia/Kolkata or UTC)
 *  - intervals (array like ["M1","M2","M5"])
 *  - fromTs, toTs (ISO strings) optional
 *  - chunkDays, insertBatchSize
 */
async function generateCandlesFromTicks(cfg) {
  const mongoUri = cfg.mongoUri;
  if (!mongoUri) throw new Error('mongoUri is required');

  const dbName = cfg.dbName || DEFAULTS.dbName;
  const ticksCollection = cfg.ticksCollection || DEFAULTS.ticksCollection;
  const candlesCollection = cfg.candlesCollection || DEFAULTS.candlesCollection;
  const instrument = cfg.instrument || DEFAULTS.instrument;
  const timezone = cfg.timezone || DEFAULTS.timezone;
  const intervals = cfg.intervals || DEFAULTS.intervals;

  const insertBatchSize = Number(
    cfg.insertBatchSize || DEFAULTS.insertBatchSize
  );
  const chunkDays = Number(cfg.chunkDays || DEFAULTS.chunkDays);

  const fromTs = cfg.fromTs || process.env.FROM_TS || null;
  const toTs = cfg.toTs || process.env.TO_TS || null;

  const client = await MongoClient.connect(mongoUri, {
    maxPoolSize: 20,
    writeConcern: { w: 1 },
  });

  try {
    const db = client.db(dbName);

    await ensureCandlesCollection(db, candlesCollection);

    // Meta used for stockName (BTC) etc.
    const meta = await getInstrumentMeta(db, ticksCollection, instrument);

    // Determine bounds (or use provided)
    const { from, to } = await getRangeBounds(
      db,
      ticksCollection,
      instrument,
      fromTs,
      toTs
    );

    for (const interval of intervals) {
      await buildCandlesForInterval({
        db,
        ticksCollection,
        candlesCollection,
        instrument,
        timezone,
        interval,
        from,
        to,
        chunkDays,
        insertBatchSize,
        meta,
      });
    }

    console.log('All candle builds completed.');
  } finally {
    await client.close();
  }
}

module.exports = { generateCandlesFromTicks };
