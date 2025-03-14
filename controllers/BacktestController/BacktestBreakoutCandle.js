const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const InstrumentData = require('../../models/Instrument');
const MarketData = require('../../models/MarketData');
const PaperTradeLog = require('../../models/PaperTrade');

const breakoutBuffer = 13;
const strikeInterval = 100;

exports.backtestBreakoutCandleNios = expressAsyncHandler(
  async (req, res, next) => {
    const {
      fromDate,
      toDate,
      lotSize,
      targetMultiplier,
      stopLossMultiplier,
      firstCandleMinute,
    } = req.body;
    if (!fromDate || !toDate) {
      return res
        .status(400)
        .json({ success: false, message: 'Missing date range' });
    }

    const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
    const toDateMoment = moment(toDate, 'YYYY-MM-DD');

    const allResults = [];
    let totalTrades = 0;
    let winTrades = 0;
    let lossTrades = 0;
    let cumulativePnL = 0;

    for (
      let date = fromDateMoment.clone();
      date.isSameOrBefore(toDateMoment);
      date.add(1, 'day')
    ) {
      const currentDate = date.format('YYYY-MM-DD');
      const candleStart = moment.tz(`${currentDate} 09:15:00`, 'Asia/Kolkata');
      const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');
      const backtestEnd = moment.tz(`${currentDate} 09:50:00`, 'Asia/Kolkata');

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

      if (!firstCandleAgg.length) continue;
      const firstCandle = firstCandleAgg[0];
      const breakoutHigh = firstCandle.high + breakoutBuffer;
      const breakoutLow = firstCandle.low - breakoutBuffer;

      const tickData = await MarketData.find({
        tradingSymbol: 'Nifty Bank',
        exchange: 'NSE',
        exchFeedTime: {
          $gte: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      }).sort({ exchFeedTime: 1 });

      let paperTrade = null;

      for (let i = 0; i < tickData.length; i++) {
        const tick = tickData[i];
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

          const optionToken = await InstrumentData.findOne({
            name: 'BANKNIFTY',
            expiry: selectedExpiry,
            strike: (nearestStrike * 100).toFixed(6),
            symbol: { $regex: selectedOptionType + '$' },
          })
            .select('token symbol expiry')
            .lean();

          if (!optionToken) break;

          const optionLTP = await MarketData.findOne({
            symbolToken: optionToken.token,
            exchFeedTime: { $lte: tick.exchFeedTime },
          })
            .sort({ exchFeedTime: -1 })
            .lean();

          if (!optionLTP) break;

          const entryPrice = optionLTP.ltp;
          const stopLoss = +(
            entryPrice *
            (1 - stopLossMultiplier / 100)
          ).toFixed(2);
          const target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(
            2
          );
          const rrRatio = (target - entryPrice) / (entryPrice - stopLoss);

          paperTrade = {
            date: currentDate,
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
            `🔍 Tick: ${tick.exchFeedTime} | Option Trade Time: ${
              optionTick.exchTradeTime
            } | Option Price: ${price.toFixed(2)} | SL: ${
              paperTrade.stopLoss
            } | Target: ${paperTrade.target}`
          );

          if (price >= paperTrade.target) {
            exitReason = 'Target Hit';
          } else if (price <= paperTrade.stopLoss) {
            exitReason = 'Stop Loss Triggered';
          } else if (moment(tick.exchFeedTime).isSameOrAfter(backtestEnd)) {
            exitReason = 'Time Exit';
          }

          if (exitReason || i === tickData.length - 1) {
            paperTrade.status = 'CLOSED';
            paperTrade.exitPrice = price;
            paperTrade.exitTime = optionTick.exchFeedTime;
            paperTrade.exitReason = exitReason || 'Session End';
            paperTrade.pnl =
              (paperTrade.direction === 'LONG'
                ? paperTrade.exitPrice - paperTrade.entryPrice
                : paperTrade.entryPrice - paperTrade.exitPrice) *
              paperTrade.lotSize;

            totalTrades++;
            cumulativePnL += paperTrade.pnl;
            paperTrade.pnl > 0 ? winTrades++ : lossTrades++;

            await PaperTradeLog.create({ ...paperTrade });
            allResults.push({ ...paperTrade });
            paperTrade = null;
            break;
          }
        }
      }
    }

    const winRate = ((winTrades / totalTrades) * 100).toFixed(2);

    res.status(200).json({
      success: true,
      summary: {
        totalTrades,
        winTrades,
        lossTrades,
        winRate: `${winRate}%`,
        cumulativePnL,
      },
      results: allResults,
    });
  }
);
