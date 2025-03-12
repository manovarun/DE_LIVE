// 📦 Live Breakout Paper Trade Engine Based on Backtest Strategy Logic
const moment = require('moment-timezone');
const MarketData = require('../models/Socket');
const InstrumentData = require('../models/Instrument');
const PaperTradeLog = require('../models/PaperTrade'); // ✅ Add model for logging

let paperTrade = null;

const breakoutBuffer = 13;
const stopLossMultiplier = 20;
const targetMultiplier = 20;
const lotSize = 30;
const strikeInterval = 100;
const firstCandleMinute = 3;

// Simulator Function to Replay from Stored Tick Data
const simulatePaperTradingFromTickData = async (startTimeStr, endTimeStr) => {
  const candleStart = moment.tz(startTimeStr, 'Asia/Kolkata');
  const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');

  console.log('candleStart', candleStart);
  console.log('candleEnd', candleEnd);

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

  console.log(`First ${firstCandleMinute} minute Candle:`, firstCandle);

  const breakoutHigh = firstCandle.high + breakoutBuffer;
  const breakoutLow = firstCandle.low - breakoutBuffer;

  console.log('breakoutHigh', breakoutHigh);
  console.log('breakoutLow', breakoutLow);

  const tickData = await MarketData.find({
    tradingSymbol: 'Nifty Bank',
    exchange: 'NSE',
    exchFeedTime: {
      $gte: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
      $lte: moment
        .tz(endTimeStr, 'Asia/Kolkata')
        .format('YYYY-MM-DDTHH:mm:ssZ'),
    },
  }).sort({ exchFeedTime: 1 });

  for (const tick of tickData) {
    if (!paperTrade) {
      const direction =
        tick.ltp >= breakoutHigh
          ? 'LONG'
          : tick.ltp <= breakoutLow
          ? 'SHORT'
          : null;

      if (!direction) continue;

      const nearestStrike =
        Math.round(tick.ltp / strikeInterval) * strikeInterval;
      const selectedOptionType = direction === 'LONG' ? 'CE' : 'PE';
      const selectedExpiry = '27MAR2025';

      console.log(nearestStrike);

      const optionToken = await InstrumentData.findOne({
        name: 'BANKNIFTY',
        expiry: selectedExpiry,
        strike: (nearestStrike * 100).toFixed(6),
        symbol: { $regex: selectedOptionType + '$' },
      })
        .select('token symbol expiry')
        .lean();

      if (!optionToken) continue;

      const optionLTP = await MarketData.findOne({
        symbolToken: optionToken.token,
        exchFeedTime: { $lte: tick.exchFeedTime },
      })
        .sort({ exchFeedTime: -1 })
        .lean();

      if (!optionLTP) continue;

      const entryPrice = optionLTP.ltp;
      const stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(
        2
      );
      const target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);
      const rrRatio = (target - entryPrice) / (entryPrice - stopLoss);

      paperTrade = {
        date: moment().tz('Asia/Kolkata').format('YYYY-MM-DD'),
        firstCandleMinute,
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
        entryTime: tick.exchFeedTime,
        lotSize,
        status: 'OPEN',
      };

      console.log('📌 Simulated Paper Trade Entered:', paperTrade);
    } else if (paperTrade.status === 'OPEN') {
      const optionTick = await MarketData.findOne({
        symbolToken: paperTrade.symbolToken,
        exchFeedTime: { $lte: tick.exchFeedTime },
      })
        .sort({ exchFeedTime: -1 })
        .lean();

      if (!optionTick) continue;

      const price = optionTick.ltp;
      let exitReason = '';
      console.log(
        `📡 Monitoring => Tick Time: ${tick.exchFeedTime}, Option Price: ${price}, SL: ${paperTrade.stopLoss}, Target: ${paperTrade.target}`
      );
      if (price >= paperTrade.target) {
        exitReason = 'Target Hit';
        console.log(`🎯 Target hit at ${tick.exchFeedTime}`);
      } else if (price <= paperTrade.stopLoss) {
        exitReason = 'Stop Loss Triggered';
        console.log(`🛑 Stop loss hit at ${tick.exchFeedTime}`);
      } else if (
        moment(tick.exchFeedTime).isSameOrAfter(
          moment.tz(endTimeStr, 'Asia/Kolkata')
        )
      ) {
        exitReason = 'Time Exit';
      }

      if (exitReason || tick === tickData[tickData.length - 1]) {
        paperTrade.status = 'CLOSED';
        paperTrade.exitPrice = price;
        paperTrade.exitTime = tick.exchFeedTime;
        paperTrade.exitReason = exitReason || 'Session End';
        paperTrade.pnl =
          (paperTrade.exitPrice - paperTrade.entryPrice) * paperTrade.lotSize;

        console.log('✅ Simulated Paper Trade Closed:', paperTrade);
        await PaperTradeLog.create({ ...paperTrade });
        paperTrade = null;
      }
    }
  }
};

simulatePaperTradingFromTickData('2025-03-12 09:15:00', '2025-03-12 09:50:00');

module.exports = { simulatePaperTradingFromTickData };
