// 📦 Live Breakout Paper Trade Engine Based on Backtest Strategy Logic
const moment = require('moment-timezone');
const MarketData = require('../models/Socket');
const InstrumentData = require('../models/Instrument');
const cron = require('node-cron');
const { getLiveNSEMarketData } = require('./SocketController');
const PaperTradeLog = require('../models/PaperTrade');

let paperTrade = null;

const breakoutBuffer = 13;
const stopLossMultiplier = 20;
const targetMultiplier = 20;
const lotSize = 30;
const strikeInterval = 100;
const optionTimeInterval = 'M1';
const firstCandleMinute = 5;

const runLiveBreakoutFromBacktestStrategy = async () => {
  const dateStr = moment().format('YYYY-MM-DD');

  // Step 1: Fetch First Candle (09:15–09:18)
  const candleStart = moment.tz(`${dateStr} 09:15:00`, 'Asia/Kolkata');
  const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');

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

  console.log('✅ First 1-minute Candle:', firstCandle);

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

    const stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(2);
    const target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);

    const rrRatio = (target - entryPrice) / (entryPrice - stopLoss);

    paperTrade = {
      direction,
      tradingSymbol: optionToken.symbol,
      symbolToken: optionToken.token,
      nearestStrike,
      selectedOptionType,
      expiry: selectedExpiry,
      entryPrice,
      stopLoss,
      target,
      rrRatio,
      entryTime: latestTick.exchFeedTime,
      lotSize,
      status: 'OPEN',
    };

    console.log('📌 Paper Trade Entered:', paperTrade);
  }

  // Step 4: Monitor Exit
  if (paperTrade && paperTrade.status === 'OPEN') {
    const latestOptionTick = await MarketData.findOne({
      symbolToken: paperTrade.symbolToken,
    })
      .sort({ exchFeedTime: -1 })
      .lean();

    console.log('latestOptionTick: ', latestOptionTick);

    if (!latestOptionTick) {
      console.warn(
        `⚠️ No tick data found for token: ${paperTrade.symbolToken}`
      );
      return;
    }

    const price = latestOptionTick.ltp;
    let exitReason = '';

    if (price >= paperTrade.target) {
      exitReason = 'Target Hit';
    } else if (price <= paperTrade.stopLoss) {
      exitReason = 'Stop Loss Triggered';
    }

    const nowTime = moment().tz('Asia/Kolkata');
    const maxExitTime = moment.tz(`${dateStr} 15:15:00`, 'Asia/Kolkata');

    if (!exitReason && nowTime.isSameOrAfter(maxExitTime)) {
      exitReason = 'Time Exit';
    }

    if (exitReason) {
      paperTrade.status = 'CLOSED';
      paperTrade.exitPrice = price;
      paperTrade.exitTime = latestOptionTick.exchFeedTime;
      paperTrade.exitReason = exitReason;
      paperTrade.pnl =
        (paperTrade.exitPrice - paperTrade.entryPrice) * paperTrade.lotSize;

      console.log('✅ Paper Trade Closed:', paperTrade);

      await PaperTradeLog.create({ ...paperTrade });
      paperTrade = null;
    }
  }
};

let intervalRef = null;

// Start Paper Trade
cron.schedule(
  '05 18 09 * * 1-5',
  () => {
    console.log('🚀 Starting Paper Trading Engine');
    intervalRef = setInterval(runLiveBreakoutFromBacktestStrategy, 5000);
  },
  { timezone: 'Asia/Kolkata' }
);

// 🕙 Stop  at 10:00:00 IST
cron.schedule(
  '05 48 09 * * 1-5',
  () => {
    console.log('🛑 Stopping Paper Trading Engine');
    if (intervalRef) clearInterval(intervalRef);
  },
  { timezone: 'Asia/Kolkata' }
);

module.exports = { runLiveBreakoutFromBacktestStrategy };
