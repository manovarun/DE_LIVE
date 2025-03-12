const mongoose = require('mongoose');

const PaperTradeLogSchema = new mongoose.Schema(
  {
    date: {
      type: String,
      required: true,
    },
    firstCandleMinute: {
      type: Number,
      required: true,
    },
    direction: {
      type: String,
      enum: ['LONG', 'SHORT'],
      required: true,
    },
    tradingSymbol: {
      type: String,
      required: true,
    },
    symbolToken: {
      type: String,
      required: true,
    },
    expiry: {
      type: String,
      required: true,
    },
    selectedOptionType: {
      type: String,
      enum: ['CE', 'PE'],
      required: true,
    },
    nearestStrike: {
      type: Number,
      required: true,
    },
    entryPrice: {
      type: Number,
      required: true,
    },
    stopLoss: {
      type: Number,
      required: true,
    },
    target: {
      type: Number,
      required: true,
    },
    rrRatio: {
      type: Number,
      required: true,
    },
    entryTime: {
      type: String, // or Date if you'd prefer native date format
      required: true,
    },
    exitPrice: {
      type: Number,
    },
    exitTime: {
      type: String, // or Date
    },
    exitReason: {
      type: String, // "Target Hit", "Stop Loss Triggered"
    },
    pnl: {
      type: Number,
    },
    lotSize: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['OPEN', 'CLOSED'],
      default: 'OPEN',
    },
  },
  { timestamps: true }
);

const PaperTradeLog = mongoose.model('PaperTradeLog', PaperTradeLogSchema);

module.exports = PaperTradeLog;
