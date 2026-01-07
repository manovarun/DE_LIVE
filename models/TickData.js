const mongoose = require('mongoose');

const TickDataSchema = new mongoose.Schema(
  {
    ts: { type: Date, index: true },
    price: Number,
    size: Number,
    role: { type: String, enum: ['maker', 'taker'] },
    meta: {
      instrument: String,
      asset: String,
      contract_type: String,
      option_type: String,
      strike: Number,
      expiry: String,
      currency: String,
    },
    src: {
      file: String,
      row: Number,
    },
  },
  { collection: 'delta_ticks_ts' }
);

// Unique compound index for idempotency
TickDataSchema.index(
  { 'meta.instrument': 1, ts: 1, price: 1, size: 1, role: 1 },
  { unique: true }
);

module.exports = mongoose.model('TickData', TickDataSchema);
