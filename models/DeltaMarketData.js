const { Schema, model } = require('mongoose');

const deltaMarketSchema = new Schema(
  {
    exch: { type: String, index: true }, // 'DELTA'
    tradingSymbol: { type: String, index: true },
    productId: { type: Number, index: true },
    type: { type: String, index: true }, // 'call_options' | 'put_options'
    underlying: { type: String, index: true },
    strike: Number,

    ltp: Number,
    tradeVolume: Number,
    opnInterest: Number,
    bestBid: Number,
    bestAsk: Number,
    bidIV: Number,
    askIV: Number,
    greeks: Schema.Types.Mixed,
    spotPrice: Number,

    exchTradeTime: { type: Date, index: true },
    ingestTs: { type: Date, default: Date.now },

    // Composite unique key we set at write-time
    _uk: { type: String, index: true, unique: false },
  },
  { strict: false }
);

module.exports = (collectionName) =>
  model(collectionName, deltaMarketSchema, collectionName);
