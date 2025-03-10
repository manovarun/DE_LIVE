// 📦 Live Breakout Paper Trade Engine Based on Backtest Strategy Logic
const moment = require('moment-timezone');
const MarketData = require('../models/Socket');
const InstrumentData = require('../models/Instrument');
const cron = require('node-cron');
const { getLiveNSEMarketData } = require('./SocketController');

let paperTrade = null;

const breakoutBuffer = 10;
const stopLossMultiplier = 5;
const targetMultiplier = 4;
const lotSize = 30;
const strikeInterval = 100;
const optionTimeInterval = 'M1';

const runLiveBreakoutFromBacktestStrategy = async () => {
  const dateStr = moment().format('YYYY-MM-DD');

  // Step 1: Fetch First Candle (09:15–09:18)
  const candleStart = moment.tz(`${dateStr} 09:15:00`, 'Asia/Kolkata');
  const candleEnd = candleStart.clone().add(1, 'minute');

  const firstCandleAgg = await MarketData.aggregate([
    {
      $match: {
        tradingSymbol: 'Nifty Bank',
        exchange: 'NSE',
        exchFeedTime: {
          $gte: candleStart.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lt: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      },
    },
    { $sort: { exchFeedTime: 1 } },
    {
      $group: {
        _id: null,
        open: { $first: '$ltp' },
        high: { $max: '$ltp' },
        low: { $min: '$ltp' },
        close: { $last: '$ltp' },
      },
    },
  ]);

  if (!firstCandleAgg.length) return console.log('❌ First Candle Missing');
  const firstCandle = firstCandleAgg[0];

  console.log('✅ First 3-minute Candle:', firstCandle);

  const breakoutHigh = firstCandle.high + breakoutBuffer;
  const breakoutLow = firstCandle.low - breakoutBuffer;

  // Step 2: Fetch latest tick
  const latestTick = await MarketData.findOne({
    tradingSymbol: 'Nifty Bank',
    exchange: 'NSE',
  })
    .sort({ exchFeedTime: -1 })
    .lean();

  if (!latestTick) return;
  console.log('latestTick', latestTick);

  // Step 3: Detect Breakout & Execute Paper Trade
  if (!paperTrade) {
    const direction =
      latestTick.ltp >= breakoutHigh
        ? 'LONG'
        : latestTick.ltp <= breakoutLow
        ? 'SHORT'
        : null;

    if (!direction) return;

    const nearestStrike =
      Math.round(latestTick.ltp / strikeInterval) * strikeInterval;
    console.log('nearestStrike: ', nearestStrike);

    const selectedOptionType = direction === 'LONG' ? 'CE' : 'PE';
    console.log('selectedOptionType: ', selectedOptionType);

    const selectedExpiry = '27MAR2025';

    const optionToken = await InstrumentData.findOne({
      name: 'BANKNIFTY',
      expiry: selectedExpiry, // ✅ now filtering by valid expiry
      strike: (nearestStrike * 100).toFixed(6),
      symbol: { $regex: selectedOptionType + '$' },
    })
      .select('token symbol expiry')
      .lean();

    console.log('optionToken: ', optionToken);

    if (!optionToken) return console.log('❌ Option token not found');

    const optionLTP = await MarketData.findOne({
      symbolToken: optionToken.token,
    })
      .sort({ exchFeedTime: -1 })
      .lean();

    console.log('optionLTP', optionLTP);
    if (!optionLTP) return;

    const entryPrice = optionLTP.ltp;

    // 📌 Stop loss is calculated as percentage below entryPrice (e.g., 1.5% if stopLossMultiplier=1.5)
    const stopLoss = entryPrice * (1 - stopLossMultiplier / 100);

    // 📌 Target is calculated as percentage above entryPrice (e.g., 2% if targetMultiplier=2)
    const target = entryPrice * (1 + targetMultiplier / 100);

    paperTrade = {
      direction,
      tradingSymbol: optionToken.symbol,
      entryPrice,
      stopLoss,
      target,
      entryTime: latestTick.exchFeedTime,
      lotSize,
      status: 'OPEN',
    };

    console.log('📌 Paper Trade Entered:', paperTrade);
  }

  // Step 4: Monitor Exit
  if (paperTrade && paperTrade.status === 'OPEN') {
    const latestOptionTick = await MarketData.findOne({
      symbolToken: paperTrade.tradingSymbol,
    })
      .sort({ exchFeedTime: -1 })
      .lean();

    console.log('latestOptionTick: ', latestOptionTick);

    if (!latestOptionTick) return;

    const price = latestOptionTick.ltp;

    const exitCondition =
      price >= paperTrade.target || price <= paperTrade.stopLoss;

    if (exitCondition) {
      paperTrade.status = 'CLOSED';
      paperTrade.exitPrice = price;
      paperTrade.exitTime = latestOptionTick.exchFeedTime;
      paperTrade.pnl =
        (paperTrade.exitPrice - paperTrade.entryPrice) * paperTrade.lotSize;

      console.log('✅ Paper Trade Closed:', paperTrade);
    }
  }
};

let marketDataInterval = null;

let intervalRef = null;

// ⏱️ Start storing data at 9:15 AM IST
cron.schedule(
  '50 14 09 * * 1-5',
  () => {
    console.log('📊 Starting Live Market Data Capture...');
    marketDataInterval = setInterval(async () => {
      try {
        await getLiveNSEMarketData(
          {},
          { status: () => ({ json: () => {} }) },
          () => {}
        );
      } catch (err) {
        console.error('❌ Error in getLiveNSEMarketData:', err.message);
      }
    }, 5000);
  },
  { timezone: 'Asia/Kolkata' }
);

// ⏹️ Stop storing data at 10:00 AM IST
cron.schedule(
  '30 15 * * 1-5',
  () => {
    if (marketDataInterval) {
      clearInterval(marketDataInterval);
      console.log('🛑 Stopped Live Market Data Capture');
    }
  },
  { timezone: 'Asia/Kolkata' }
);

// Start Paper Trade
cron.schedule(
  '05 16 09 * * 1-5',
  () => {
    console.log('🚀 Starting Paper Trading Engine');
    intervalRef = setInterval(runLiveBreakoutFromBacktestStrategy, 5000);
  },
  { timezone: 'Asia/Kolkata' }
);

// 🕙 Stop  at 10:00:00 IST
cron.schedule(
  '0 10 * * 1-5',
  () => {
    console.log('🛑 Stopping Paper Trading Engine');
    if (intervalRef) clearInterval(intervalRef);
  },
  { timezone: 'Asia/Kolkata' }
);

module.exports = { runLiveBreakoutFromBacktestStrategy };
