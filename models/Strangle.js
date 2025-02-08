const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  date: { type: String, required: true },
  entryTime: { type: String, required: true },
  exitTime: { type: String, required: true },
  type: { type: String, enum: ['CE', 'PE'], required: true },
  strikePrice: { type: Number, required: true },
  qty: { type: Number, required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, required: true },
  stopLoss: { type: Number, required: true },
  vix: { type: Number },
  profitLoss: { type: Number, required: true },
});

const resultSchema = new mongoose.Schema({
  date: { type: String, required: true },
  spotPrice: { type: Number, required: true },
  strikePrice: { type: Number, required: true },
  expiry: { type: String, required: true },
  lotSize: { type: Number, required: true },
  stopLossPercentage: { type: Number, required: true },
  entryPrice: { type: Number, required: true },
  exitPrice: { type: Number, required: true },
  profitLoss: { type: Number, required: true },
  cumulativeProfit: { type: Number, required: true },
  transactions: [transactionSchema],
});

// The main schema to store multi-day results
const shortStrangleStrategySchema = new mongoose.Schema({
  strategyId: { type: String, unique: true, required: true }, // Unique identifier for the strategy
  timeInterval: { type: String, required: true },
  fromDate: { type: String, required: true },
  toDate: { type: String, required: true },
  stockSymbol: { type: String, required: true },
  expiry: { type: String, required: true },
  lotSize: { type: Number, required: true },
  stopLossPercentage: { type: Number, required: true },
  entryTime: { type: String, required: true },
  exitTime: { type: String, required: true },
  searchType: { type: String, required: true }, // Added searchType (e.g., DAY, WEEK, MONTH)
  totalTradeDays: { type: Number, required: true }, // Added totalTradeDays
  noOfProfitableDays: { type: Number, required: true },
  cumulativeProfit: { type: Number, required: true },
  results: [resultSchema], // Nested results for each day
});

shortStrangleStrategySchema.index({ strategyId: 1 }, { unique: true });

const ShortStrangleStrategy = mongoose.model(
  'ShortStrangleStrategy',
  shortStrangleStrategySchema
);

module.exports = ShortStrangleStrategy;
