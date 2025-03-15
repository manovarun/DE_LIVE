// controllers/breakoutBacktestControllerAura.js
const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const HistoricalIndicesData = require('../../models/HistoricalIndicesData');
const HistoricalOptionData = require('../../models/HistoricalOptionData');

exports.backtestBreakoutCandleAura = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        fromDate,
        toDate,
        startTime = '09:15',
        endTime = '09:50',
        firstCandleMinute,
        breakoutBuffer,
        strikeInterval,
        stopLossMultiplier,
        targetMultiplier,
        lotSize,
        trailingStopLoss = false,
        trailMultiplier = 5,
        stockSymbol = 'Nifty Bank',
        stockName = 'BANKNIFTY',
        expiries = [],
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

        const expiryObj =
          expiries.find((e) =>
            moment(currentDate).isSameOrBefore(e.validUntil)
          ) || expiries[expiries.length - 1];
        const expiry = expiryObj.expiry;

        const candleStart = moment.tz(
          `${currentDate} ${startTime}`,
          'Asia/Kolkata'
        );
        const breakoutCheckStart = candleStart
          .clone()
          .add(firstCandleMinute, 'minute');
        const backtestEnd = moment.tz(
          `${currentDate} ${endTime}`,
          'Asia/Kolkata'
        );

        const spotData = await HistoricalIndicesData.findOne({
          stockSymbol,
          stockName,
          timeInterval: `M${firstCandleMinute}`,
          datetime: candleStart.format('YYYY-MM-DDTHH:mm:ssZ'),
        })
          .select('open high low close')
          .lean();

        if (!spotData) continue;

        const breakoutHigh = spotData.high + breakoutBuffer;
        const breakoutLow = spotData.low - breakoutBuffer;

        const tickData = await HistoricalIndicesData.find({
          stockSymbol,
          stockName,
          timeInterval: 'M1',
          datetime: {
            $gte: breakoutCheckStart.format('YYYY-MM-DDTHH:mm:ssZ'),
            $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
          },
        })
          .select('datetime close')
          .sort({ datetime: 1 })
          .lean();

        const breakoutTick = tickData.find(
          (tick) => tick.close >= breakoutHigh || tick.close <= breakoutLow
        );

        if (!breakoutTick) continue;

        const breakoutDirection =
          breakoutTick.close >= breakoutHigh ? 'LONG' : 'SHORT';
        const nearestStrike =
          Math.round(breakoutTick.close / strikeInterval) * strikeInterval;
        const selectedOptionType = breakoutDirection === 'LONG' ? 'CE' : 'PE';
        const breakoutTime = breakoutTick.datetime;

        const optionData = await HistoricalOptionData.findOne({
          stockName,
          expiry,
          strikePrice: nearestStrike,
          optionType: selectedOptionType,
          timeInterval: 'M1',
          datetime: breakoutTime,
        })
          .select('datetime close strikePrice optionType')
          .lean();

        if (!optionData) continue;

        const entryPrice = optionData.close;
        let stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(
          2
        );
        const target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);
        const rrRatio = +(
          (target - entryPrice) /
          (entryPrice - stopLoss)
        ).toFixed(2);

        const exitTicks = await HistoricalOptionData.find({
          stockName,
          expiry,
          strikePrice: nearestStrike,
          optionType: selectedOptionType,
          timeInterval: 'M1',
          datetime: {
            $gte: breakoutTime,
            $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
          },
        })
          .sort({ datetime: 1 })
          .lean();

        let exitPrice = entryPrice;
        let exitTime = null;
        let exitReason = 'Time Exit';

        for (const tick of exitTicks) {
          const currentLTP = tick.close;
          const tickTime = tick.datetime;

          if (currentLTP >= target) {
            exitPrice = target;
            exitTime = tickTime;
            exitReason = 'Target Hit';
            break;
          } else if (currentLTP <= stopLoss) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Stop Loss Triggered';
            break;
          } else if (trailingStopLoss && currentLTP > entryPrice) {
            const newTrailSL = +(
              currentLTP *
              (1 - trailMultiplier / 100)
            ).toFixed(2);
            if (newTrailSL > stopLoss) stopLoss = newTrailSL;
          } else if (moment(tickTime).isSameOrAfter(backtestEnd)) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Time Exit';
            break;
          }
        }

        if (!exitTime && exitTicks.length > 0) {
          const lastTick = exitTicks[exitTicks.length - 1];
          exitTime = lastTick.datetime;
          exitPrice = lastTick.close;
        }

        const pnl = (exitPrice - entryPrice) * lotSize;
        cumulativePnL += pnl;
        totalTrades++;
        pnl > 0 ? winTrades++ : lossTrades++;

        const tradeResult = {
          date: currentDate,
          firstCandleMinute,
          direction: breakoutDirection,
          tradingSymbol: `${stockSymbol}${expiry}${nearestStrike}${selectedOptionType}`,
          strikePrice: nearestStrike,
          selectedOptionType,
          expiry,
          entryPrice,
          stopLoss,
          target,
          rrRatio,
          entryTime: breakoutTime,
          exitPrice,
          exitTime,
          exitReason,
          pnl,
          lotSize,
          status: 'CLOSED',
        };

        allResults.push(tradeResult);
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
    } catch (error) {
      console.error('Backtest Error:', error);
      res
        .status(500)
        .json({
          success: false,
          message: 'Internal Server Error',
          error: error.message,
        });
    }
  }
);
