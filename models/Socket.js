const mongoose = require('mongoose');

const MarketDataSchema = new mongoose.Schema({
  exchange: { type: String, required: true }, // Exchange (NSE, BSE, etc.)
  tradingSymbol: { type: String, required: true }, // Symbol Name (e.g., Nifty Bank)
  symbolToken: { type: String, required: true }, // Unique token ID
  ltp: { type: Number, required: true }, // Last Traded Price
  open: { type: Number, required: true }, // Opening Price
  high: { type: Number, required: true }, // Daily High
  low: { type: Number, required: true }, // Daily Low
  close: { type: Number, required: true }, // Previous Close
  lastTradeQty: { type: Number, required: true }, // Last Trade Quantity
  exchFeedTime: { type: String, required: true }, // Exchange Feed Timestamp
  exchTradeTime: { type: String, required: true }, // Trade Timestamp
  netChange: { type: Number, required: true }, // Net Change in Price
  percentChange: { type: Number, required: true }, // % Change in Price
  avgPrice: { type: Number, required: true }, // Average Price
  tradeVolume: { type: Number, required: true }, // Total Trade Volume
  opnInterest: { type: Number, required: true }, // Open Interest (For F&O)
  lowerCircuit: { type: Number, required: true }, // Lower Circuit Limit
  upperCircuit: { type: Number, required: true }, // Upper Circuit Limit
  totBuyQuan: { type: Number, required: true }, // Total Buy Orders
  totSellQuan: { type: Number, required: true }, // Total Sell Orders
  week52Low: { type: Number, required: true }, // 52 Week Low
  week52High: { type: Number, required: true }, // 52 Week High
  depth: {
    buy: [
      {
        price: { type: Number, required: true },
        quantity: { type: Number, required: true },
        orders: { type: Number, required: true },
      },
    ],
    sell: [
      {
        price: { type: Number, required: true },
        quantity: { type: Number, required: true },
        orders: { type: Number, required: true },
      },
    ],
  },
  timestamp: { type: String },
});

const MarketData = mongoose.model('MarketData', MarketDataSchema);

module.exports = MarketData;
