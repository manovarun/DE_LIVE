// scripts/runCandleBuild.js
require('dotenv').config();

const {
  generateCandlesFromTicks,
} = require('../controllers/generateCandlesFromTicksController');

(async () => {
  await generateCandlesFromTicks({
    mongoUri: process.env.DB_URI || 'mongodb://127.0.0.1:27017',
    dbName: process.env.DB_NAME || 'delta',

    // ticks source
    ticksCollection:
      process.env.TICKS_COLL || process.env.FUTURES_COLL || 'delta_futures_ts',

    // candles destination
    candlesCollection: process.env.CANDLES_COLL || 'delta_futures_candles',

    instrument: process.env.INSTRUMENT || 'BTCUSD',
    timezone: process.env.TIMEZONE || 'Asia/Kolkata',

    // e.g. "M1,M2,M3,M4,M5"
    intervals: (process.env.INTERVALS || 'M5')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    // optional: restrict range
    fromTs: process.env.FROM_TS || process.argv[2] || null,
    toTs: process.env.TO_TS || process.argv[3] || null,

    // tuning
    insertBatchSize: Number(process.env.CANDLE_BATCH_SIZE || 2000),
    chunkDays: Number(process.env.CHUNK_DAYS || 1),
  });
})().catch((e) => {
  console.error('Candle build failed:', e);
  process.exit(1);
});
