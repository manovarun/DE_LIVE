const mongoose = require('mongoose');

// Define the schema for storing historical options data
const HistoricalOptionDataSchema = new mongoose.Schema({
  datetime: {
    type: String, // Store datetime as a String
    required: true,
  },
  timeInterval: {
    type: String,
    required: true,
    enum: ['M1', 'M3', 'M5', 'M10', 'M15', 'M30', 'H1', 'D1'],
  },
  stockName: {
    type: String,
    required: true,
  },
  stockSymbol: {
    type: String,
    required: true,
  },
  strikePrice: {
    type: Number,
    required: true,
  },
  expiry: {
    type: String,
    required: true,
  },
  optionType: {
    type: String, // 'CE' or 'PE'
    required: true,
    enum: ['CE', 'PE'],
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
  openInterest: {
    type: Number, // Open interest data
    required: true, // Make it required since we're storing both price and OI together
  },
});

// Create an index to prevent duplicate entries for the same datetime, timeInterval, stockSymbol, strikePrice, and optionType
HistoricalOptionDataSchema.index(
  {
    datetime: 1,
    timeInterval: 1,
    stockSymbol: 1,
    strikePrice: 1,
    optionType: 1,
  },
  { unique: true }
);

const HistoricalOptionData = mongoose.model(
  'HistoricalOptionData',
  HistoricalOptionDataSchema
);

module.exports = HistoricalOptionData;
