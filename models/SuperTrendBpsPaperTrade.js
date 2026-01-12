// models/SupertrendBpsPaperTrade.js
const mongoose = require('mongoose');

const LegSchema = new mongoose.Schema(
  {
    side: { type: String },
    symbol: { type: String },
    token: { type: String },
    strike: { type: String },
    orderId: { type: String },
    fillPrice: { type: Number },
    qty: { type: Number },
    moneyness: {
      type: {
        type: String,
      },
      steps: { type: Number },
      raw: { type: String },
    },
  },
  { _id: false }
);

const PnlSchema = new mongoose.Schema(
  {
    mainLtp: { type: Number },
    hedgeLtp: { type: Number },
    mainPnl: { type: Number },
    hedgePnl: { type: Number },
    netPnl: { type: Number },
    source: { type: String }, // 'WS' | 'DB' | 'ENTRY' | 'EXIT' | 'FINAL'
    updatedAt: { type: Date },
  },
  { _id: false }
);

const SupertrendBpsPaperTradeSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, unique: true, index: true },

    stockName: { type: String },
    expiry: { type: String },
    futuresSymbol: { type: String },

    lotSize: { type: Number },
    lots: { type: Number },
    totalQty: { type: Number },

    // Signal candle time (IST) that triggered entry
    signalTimeIST: { type: String },

    // Entry time (IST/UTC) when paper fill was simulated
    entryTimeIST: { type: String },
    entryTimeUTC: { type: Date },

    // Exit time (IST) when the trade is finally closed
    exitTimeIST: { type: String },

    index: {
      lastCandleTimeIST: { type: String },
      close: { type: Number },
      supertrend: { type: mongoose.Schema.Types.Mixed },
    },

    underlying: {
      source: { type: String },
      price: { type: Number },
      indexClose: { type: Number },
    },

    futures: {
      close: { type: Number },
      candle: { type: mongoose.Schema.Types.Mixed },
    },

    moneyness: {
      mainMoneyness: { type: String },
      hedgeMoneyness: { type: String },
      atmIndexCE: { type: Number },
    },

    legs: {
      main: { type: LegSchema },
      hedge: { type: LegSchema },
    },

    credit: {
      perQty: { type: Number },
      total: { type: Number },
    },

    tradesTodayAfterEntry: { type: Number },

    config: {
      indexTimeInterval: { type: String },
      fromTime: { type: String },

      // Supertrend settings
      atrPeriod: { type: Number },
      multiplier: { type: Number },
      changeAtrCalculation: { type: Boolean },

      minCandlesForSupertrend: { type: Number },
      squareOffTime: { type: String },
      forceEntry: { type: Boolean },

      // Risk used by the paper controller (main-leg only)
      stopLossPct: { type: Number },
      targetPct: { type: Number },

      maxTradesPerDay: { type: Number },
      weekDays: [{ type: Number }],
      effectiveTestDate: { type: String },
    },

    // EXIT metadata
    exit: {
      timeIST: { type: String },
      reason: { type: String },
      supertrend: { type: mongoose.Schema.Types.Mixed },
      sltp: { type: mongoose.Schema.Types.Mixed },
      viaTestDate: { type: Boolean },
      checkedAtIST: { type: String },
    },

    pnl: { type: PnlSchema },

    status: {
      type: String,
      enum: ['OPEN', 'CLOSED'],
      default: 'OPEN',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model(
  'SupertrendBpsPaperTrade',
  SupertrendBpsPaperTradeSchema
);
