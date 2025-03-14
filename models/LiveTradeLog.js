// models/LiveTradeLog.js
const mongoose = require('mongoose');

const LiveTradeDataSchema = new mongoose.Schema(
  {
    date: String,
    direction: String,
    tradingSymbol: String,
    symbolToken: String,
    nearestStrike: Number,
    selectedOptionType: String,
    expiry: String,
    entryPrice: Number,
    stopLoss: Number,
    target: Number,
    rrRatio: Number,
    entryTime: Date,
    exitTime: Date,
    exitLtp: Number,
    exitReason: String,
    entryOrderId: String,
    slOrderId: String,
    slOrderStatus: String,
    slCancelResponse: Object,
    retryTimestamps: [String],
    status: String,
    lotSize: Number,
    pnl: Number,
  },
  { timestamps: true }
);

const LiveTradeData = (module.exports = mongoose.model(
  'LiveTradeData',
  LiveTradeDataSchema
));

module.exports = LiveTradeData;
