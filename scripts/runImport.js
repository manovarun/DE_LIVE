const {
  importDeltaTicksCSV,
} = require('../controllers/importDeltaTicksController');

// scripts/runImport.js
require('dotenv').config();

(async () => {
  await importDeltaTicksCSV({
    mongoUri: process.env.DB_URI || 'mongodb://127.0.0.1:27017',
    filesGlob: process.argv[2] || 'downloads/*.csv',
    dbName: process.env.DB_NAME || 'delta',
    collection: process.env.COLLECTION || 'delta_ticks_ts',
    batchSize: Number(process.env.BATCH_SIZE || 3000),

    // If your CSV rows only have HH:mm:ss, pass the first day of the file.
    // Day rollover will advance when time resets to 00:00.
    startDate: process.env.START_DATE || '2025-08-01',

    maxConcurrentFiles: 2,
  });
})();
