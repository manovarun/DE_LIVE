// models/DeltaOptionsTick.js
const mongoose = require('mongoose');

function createOptionsModel(collectionName = 'OptionsTicks') {
  const PriceBandSchema = new mongoose.Schema(
    {
      lower_limit: { type: String, default: null },
      upper_limit: { type: String, default: null },
    },
    { _id: false }
  );

  const QuotesSchema = new mongoose.Schema(
    {
      ask_iv: { type: String, default: null },
      ask_size: { type: String, default: null },
      best_ask: { type: String, default: null },
      best_ask_mm: { type: String, default: null },
      best_bid: { type: String, default: null },
      best_bid_mm: { type: String, default: null },
      bid_iv: { type: String, default: null },
      bid_size: { type: String, default: null },
      impact_mid_price: { type: String, default: null },
      mark_iv: { type: String, default: null },
    },
    { _id: false }
  );

  const GreeksSchema = new mongoose.Schema(
    {
      delta: { type: String, default: null },
      gamma: { type: String, default: null },
      rho: { type: String, default: null },
      spot: { type: String, default: null },
      theta: { type: String, default: null },
      vega: { type: String, default: null },
    },
    { _id: false }
  );

  const schema = new mongoose.Schema(
    {
      // --- raw API properties (as-is) ---
      oi_value_symbol: { type: String, default: null },
      product_id: { type: Number, index: true },
      quotes: { type: QuotesSchema, default: undefined },
      tags: { type: [String], default: [] },
      oi: { type: String, default: null },
      sort_priority: { type: Number, default: null },
      oi_value: { type: String, default: null },
      price_band: { type: PriceBandSchema, default: undefined },
      strike_price: { type: String, index: true }, // API sends string
      spot_price: { type: String, default: null },
      close: { type: Number, default: null },
      turnover: { type: Number, default: null },
      turnover_usd: { type: Number, default: null },
      symbol: { type: String, index: true }, // e.g. P-BTC-128000-061025
      tick_size: { type: String, default: null },
      mark_change_24h: { type: String, default: null },
      low: { type: Number, default: null },
      mark_vol: { type: String, default: null },
      open: { type: Number, default: null },
      high: { type: Number, default: null },
      mark_price: { type: String, default: null },
      contract_value: { type: String, default: null },
      timestamp: { type: Number, default: null }, // may be microseconds
      contract_type: { type: String, index: true }, // call_options | put_options
      volume: { type: Number, default: null },
      initial_margin: { type: String, default: null },
      oi_value_usd: { type: String, default: null },
      time: { type: String, default: null }, // exchange iso
      turnover_symbol: { type: String, default: null },
      size: { type: Number, default: null },
      oi_contracts: { type: String, default: null },
      underlying_asset_symbol: { type: String, index: true },
      greeks: { type: GreeksSchema, default: undefined },
      oi_change_usd_6h: { type: String, default: null },
      description: { type: String, default: null },

      // --- normalized / computed additions ---
      exch: { type: String, default: 'DELTA', index: true },
      underlying: { type: String, default: 'BTC', index: true },
      strike: { type: Number, default: null }, // numeric copy of strike_price if parsable
      spotPrice: { type: Number, default: null }, // numeric copy of spot_price if parsable
      ltp: { type: Number, default: null }, // numeric copy of mark_price if parsable

      exchTradeTime: { type: Date, index: true },
      ingestTs: { type: Date, default: Date.now, index: true },

      // 5s snapshot bucket key
      _bucketMs: { type: Number, index: true },
      _uk: { type: String, index: true }, // UNIQUE (symbol|_bucketMs)

      // expiry inferred from symbol (DD-MM-YYYY)
      expiry: { type: String, index: true },
      expirySource: { type: String, default: null },

      // full raw row as a safeguard (keeps "all properties" exactly)
      raw: { type: mongoose.Schema.Types.Mixed, default: undefined },
    },
    { strict: true, minimize: true }
  );

  // Unique snapshot key per 5s per symbol
  // (Created in controller too, but define here in case the collection is new)
  schema.index({ _uk: 1 }, { name: 'uniq_uk', unique: true, background: true });

  return mongoose.models[collectionName]
    ? mongoose.model(collectionName)
    : mongoose.model(collectionName, schema, collectionName);
}

module.exports = createOptionsModel;
