const mongoose = require('mongoose');

// Define the schema for storing India VIX historical data
const HistoricalIndiaVIXDataSchema = new mongoose.Schema({
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
    type: String, // Typically "INDIA VIX"
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
    type: Number, // If applicable (otherwise, optional)
  },
});

// Create an index to prevent duplicate entries for the same datetime and timeInterval
HistoricalIndiaVIXDataSchema.index(
  {
    datetime: 1,
    timeInterval: 1,
    stockName: 1,
  },
  { unique: true }
);

const HistoricalIndiaVIXData = mongoose.model(
  'HistoricalIndiaVIXData',
  HistoricalIndiaVIXDataSchema
);

module.exports = HistoricalIndiaVIXData;
