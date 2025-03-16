const mongoose = require('mongoose');

// Define the schema for storing historical futures data
const HistoricalFuturesDataSchema = new mongoose.Schema({
  datetime: {
    type: String, // Store datetime as a String to maintain format consistency
    required: true,
  },
  timeInterval: {
    type: String,
    required: true,
    enum: ['M1', 'M3', 'M5', 'M10', 'M15', 'M30', 'H1', 'D1'],
  },
  stockSymbol: {
    type: String,
    required: true,
  },
  stockName: {
    type: String,
    required: true,
  },
  instrumenttype: {
    type: String,
    required: true,
    enum: ['FUTIDX'], // Ensuring that only 'FUTIDX' is allowed
  },
  expiry: {
    type: String, // Futures have an expiry date (e.g., "29MAY2025")
    required: true,
  },
  lotSize: {
    type: Number, // Futures have a predefined lot size (e.g., 30 for Bank Nifty)
    required: true,
  },
  tickSize: {
    type: Number, // Tick size for price movements (e.g., 5.000000 for Bank Nifty)
    required: true,
  },
  open: {
    type: Number,
    required: true,
  },
  high: {
    type: Number,
    required: true,
  },
  low: {
    type: Number,
    required: true,
  },
  close: {
    type: Number,
    required: true,
  },
  volume: {
    type: Number,
    required: true,
  },
});

// Create an index to prevent duplicate entries for the same datetime, timeInterval, stockSymbol, and expiry
HistoricalFuturesDataSchema.index(
  { datetime: 1, timeInterval: 1, stockSymbol: 1, expiry: 1 },
  { unique: true }
);

// Create the model for HistoricalFuturesData
const HistoricalFuturesData = mongoose.model(
  'HistoricalFuturesData',
  HistoricalFuturesDataSchema
);

module.exports = HistoricalFuturesData;
