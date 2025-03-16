const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const InstrumentData = require('../../models/Instrument');
const MarketData = require('../../models/MarketData');
const PaperTradeLog = require('../../models/PaperTrade');
const HistoricalOptionData = require('../../models/Option');
const HistoricalIndicesData = require('../../models/Indices');
const AppError = require('../../utils/AppError');
const HistoricalFuturesData = require('../../models/Futures');

//OPTIONS BREAKOUTS FIRST MINUTE
exports.backtestBreakoutCandleNios = expressAsyncHandler(
  async (req, res, next) => {
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
      const candleStart = moment.tz(
        `${currentDate} ${startTime}`,
        'Asia/Kolkata'
      );
      const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');
      const backtestEnd = moment.tz(
        `${currentDate} ${endTime}`,
        'Asia/Kolkata'
      );

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

      const breakoutTick = tickData.find(
        (tick) => tick.ltp >= breakoutHigh || tick.ltp <= breakoutLow
      );
      if (!breakoutTick) continue;

      const direction = breakoutTick.ltp >= breakoutHigh ? 'LONG' : 'SHORT';
      const nearestStrike =
        Math.round(breakoutTick.ltp / strikeInterval) * strikeInterval;
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
      if (!optionToken) continue;

      const entryTick = await MarketData.findOne({
        symbolToken: optionToken.token,
        exchTradeTime: { $lte: breakoutTick.exchFeedTime },
      })
        .sort({ exchTradeTime: -1 })
        .lean();
      if (!entryTick) continue;

      const entryPrice = entryTick.ltp;
      let stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(2);
      const target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);
      const rrRatio = +(target - entryPrice) / (entryPrice - stopLoss);

      const exitTicks = await MarketData.find({
        symbolToken: optionToken.token,
        $and: [
          {
            $or: [
              { exchTradeTime: { $exists: true, $ne: null } },
              { exchFeedTime: { $exists: true } },
            ],
          },
          {
            $or: [
              {
                exchTradeTime: {
                  $gte: breakoutTick.exchFeedTime,
                  $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
                },
              },
              {
                exchFeedTime: {
                  $gte: breakoutTick.exchFeedTime,
                  $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
                },
              },
            ],
          },
        ],
      }).sort({ exchTradeTime: 1, exchFeedTime: 1 });

      let exitPrice = entryPrice;
      let exitTime = null;
      let exitReason = 'Time Exit';

      for (const tick of exitTicks) {
        const currentLTP = tick.ltp;
        const tickTime = tick.exchTradeTime || tick.exchFeedTime;

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
        exitTime = lastTick.exchTradeTime || lastTick.exchFeedTime;
        exitPrice = lastTick.ltp;
      }

      const pnl = (exitPrice - entryPrice) * lotSize;
      cumulativePnL += pnl;
      totalTrades++;
      pnl > 0 ? winTrades++ : lossTrades++;

      const tradeResult = {
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
        entryTime: breakoutTick.exchFeedTime,
        exitPrice,
        exitTime,
        exitReason,
        pnl,
        lotSize,
        status: 'CLOSED',
      };

      // await PaperTradeLog.create(tradeResult);
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
  }
);

exports.backtestBreakoutCandleAura = expressAsyncHandler(
  async (req, res, next) => {
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
      enableScalping = true,
      scalpingProfit = 1000,
      scalpingLoss = 1000,
      stockSymbol = 'Nifty Bank',
      stockName = 'BANKNIFTY',
      // expiry = '27MAR2025',
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
        stockSymbol: 'Nifty Bank',
        stockName: 'BANKNIFTY',
        timeInterval: `M${firstCandleMinute}`,
        datetime: candleStart.format('YYYY-MM-DDTHH:mm:ssZ'),
      })
        .select('open high low close')
        .lean();

      if (!spotData) {
        console.warn(`No spot data found for on ${date}`);
        continue;
      }

      const breakoutHigh = spotData.high + breakoutBuffer;
      const breakoutLow = spotData.low - breakoutBuffer;

      console.log(
        `Breakout High: ${breakoutHigh}, Breakout Low: ${breakoutLow}, Expiry: ${expiry}`
      );

      let breakoutTime = null;
      let direction = null;

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

      for (const candle of tickData) {
        if (!direction) {
          if (candle.close >= breakoutHigh) {
            direction = 'LONG';
            breakoutTime = candle.datetime;
            break;
          } else if (candle.close <= breakoutLow) {
            direction = 'SHORT';
            breakoutTime = candle.datetime;
            break;
          }
        }
      }

      console.log('direction', direction);

      const nearestStrike =
        Math.round(breakoutTick.close / strikeInterval) * strikeInterval;

      console.log('nearestStrike', nearestStrike);

      const selectedOptionType = direction === 'LONG' ? 'CE' : 'PE';

      console.log('selectedOptionType', selectedOptionType);

      const selectedExpiry = expiry;

      const optionToken = await InstrumentData.findOne({
        name: 'BANKNIFTY',
        expiry: selectedExpiry,
        strike: (nearestStrike * 100).toFixed(6),
        symbol: { $regex: selectedOptionType + '$' },
      })
        .select('token symbol expiry')
        .lean();

      if (!optionToken) continue;

      const entryTick = await HistoricalOptionData.findOne({
        stockName: 'BANKNIFTY',
        expiry,
        strikePrice: nearestStrike,
        optionType: selectedOptionType,
        timeInterval: 'M1',
        datetime: breakoutTime,
      })
        .select('datetime close strikePrice optionType')
        .lean();

      if (!entryTick) continue;

      const entryPrice = entryTick.close;

      let stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(2);
      let target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);
      const rrRatio = +(target - entryPrice) / (entryPrice - stopLoss);

      console.log('stopLoss', stopLoss);
      console.log('target', target);

      const exitTicks = await HistoricalOptionData.find({
        stockName: 'BANKNIFTY',
        expiry,
        strikePrice: nearestStrike,
        optionType: selectedOptionType,
        timeInterval: 'M1',
        datetime: {
          $gte: breakoutCheckStart.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      })
        .select('datetime close')
        .sort({ datetime: 1 })
        .lean();

      if (exitTicks.length === 0) continue;

      let exitPrice = entryPrice;
      let exitTime = null;
      let exitReason = 'Time Exit';

      for (const tick of exitTicks) {
        const currentLTP = tick.close;
        const tickTime = tick.datetime;
        const pnl = (currentLTP - entryPrice) * lotSize;

        if (enableScalping) {
          if (pnl >= scalpingProfit) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Scalping Target Hit';
            break;
          }
          // } else if (pnl <= -scalpingLoss) {
          //   exitPrice = currentLTP;
          //   exitTime = tickTime;
          //   exitReason = 'Scalping Stop Loss';
          //   break;
          // }
        } else {
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
      }

      if (!exitTime && exitTicks.length > 0) {
        const lastTick = exitTicks[exitTicks.length - 1];
        exitTime = lastTick.exchTradeTime || lastTick.exchFeedTime;
        exitPrice = lastTick.close;
      }

      const pnl = (exitPrice - entryPrice) * lotSize;
      cumulativePnL += pnl;
      totalTrades++;
      pnl > 0 ? winTrades++ : lossTrades++;

      const tradeResult = {
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
        entryTime: breakoutTick.datetime,
        exitPrice,
        exitTime,
        exitReason,
        pnl,
        lotSize,
        status: 'CLOSED',
      };

      // await PaperTradeLog.create(tradeResult);
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
  }
);

//OPTIONS BREAKOUTS FIRST MINUTE
exports.backtestBreakoutFuturesNios = expressAsyncHandler(
  async (req, res, next) => {
    const {
      fromDate,
      toDate,
      startTime = '09:15',
      endTime = '15:15',
      firstCandleMinute,
      breakoutBuffer,
      stopLossMultiplier = 0.1,
      targetMultiplier = 0.1,
      lotSize,
      trailingStopLoss = false,
      trailMultiplier = 5,
      enableScalping = false,
      scalpingPoints = 100,
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
      const candleStart = moment.tz(
        `${currentDate} ${startTime}`,
        'Asia/Kolkata'
      );
      const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');
      const backtestEnd = moment.tz(
        `${currentDate} ${endTime}`,
        'Asia/Kolkata'
      );

      const firstCandleAgg = await MarketData.aggregate([
        {
          $match: {
            tradingSymbol: { $regex: /^BANKNIFTY.*FUT$/ },
            exchange: 'NFO',
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

      console.log('firstCandle', firstCandle);

      const breakoutHigh = firstCandle.high + breakoutBuffer;
      const breakoutLow = firstCandle.low - breakoutBuffer;

      console.log('breakoutHigh', breakoutHigh);
      console.log('breakoutLow', breakoutLow);

      const tickData = await MarketData.find({
        tradingSymbol: { $regex: /^BANKNIFTY.*FUT$/ },
        exchange: 'NFO',
        exchTradeTime: {
          $gte: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      }).sort({ exchTradeTime: 1 });

      const breakoutTick = tickData.find(
        (tick) => tick.ltp >= breakoutHigh || tick.ltp <= breakoutLow
      );
      if (!breakoutTick) continue;

      console.log('breakoutTick', breakoutTick);

      const direction = breakoutTick.ltp >= breakoutHigh ? 'LONG' : 'SHORT';
      console.log('direction', direction);

      const entryPrice = breakoutTick.ltp;
      console.log('entryPrice', entryPrice);

      let stopLoss =
        direction === 'LONG'
          ? +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(2)
          : +(entryPrice * (1 + stopLossMultiplier / 100)).toFixed(2);
      console.log('stopLoss', stopLoss);

      const target =
        direction === 'LONG'
          ? +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2)
          : +(entryPrice * (1 - targetMultiplier / 100)).toFixed(2);
      console.log('target', target);

      const rrRatio = +(
        Math.abs(target - entryPrice) / Math.abs(entryPrice - stopLoss)
      ).toFixed(2);

      const exitTicks = tickData.filter((tick) =>
        moment(tick.exchTradeTime).isSameOrAfter(breakoutTick.exchTradeTime)
      );

      let exitPrice = entryPrice;
      let exitTime = null;
      let exitReason = 'Time Exit';

      for (const tick of exitTicks) {
        const currentLTP = tick.ltp;
        const tickTime = tick.exchTradeTime;

        if (enableScalping) {
          const pnlPoints =
            direction === 'LONG'
              ? currentLTP - entryPrice
              : entryPrice - currentLTP;

          if (pnlPoints >= scalpingPoints) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Scalping Target Hit';
            break;
          } else if (pnlPoints <= -scalpingPoints) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Scalping Stop Loss';
            break;
          }
        } else {
          if (
            (direction === 'LONG' && currentLTP >= target) ||
            (direction === 'SHORT' && currentLTP <= target)
          ) {
            exitPrice = target;
            exitTime = tickTime;
            exitReason = 'Target Hit';
            break;
          } else if (
            (direction === 'LONG' && currentLTP <= stopLoss) ||
            (direction === 'SHORT' && currentLTP >= stopLoss)
          ) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Stop Loss Triggered';
            break;
          } else if (
            trailingStopLoss &&
            ((direction === 'LONG' && currentLTP > entryPrice) ||
              (direction === 'SHORT' && currentLTP < entryPrice))
          ) {
            const newTrailSL =
              direction === 'LONG'
                ? +(currentLTP * (1 - trailMultiplier / 100)).toFixed(2)
                : +(currentLTP * (1 + trailMultiplier / 100)).toFixed(2);
            if (
              (direction === 'LONG' && newTrailSL > stopLoss) ||
              (direction === 'SHORT' && newTrailSL < stopLoss)
            ) {
              stopLoss = newTrailSL;
            }
          }
        }
      }

      if (!exitTime && exitTicks.length > 0) {
        const lastTick = exitTicks[exitTicks.length - 1];
        exitTime = lastTick.exchTradeTime;
        exitPrice = lastTick.ltp;
      }

      const pnl =
        direction === 'LONG'
          ? (exitPrice - entryPrice) * lotSize
          : (entryPrice - exitPrice) * lotSize;

      console.log(
        `Calculated PnL => Direction: ${direction}, Entry: ${entryPrice}, Exit: ${exitPrice}, Lot: ${lotSize}, PnL: ${pnl}`
      );

      cumulativePnL += pnl;
      totalTrades++;
      pnl > 0 ? winTrades++ : lossTrades++;

      const tradeResult = {
        date: currentDate,
        firstCandleMinute,
        direction,
        tradingSymbol: breakoutTick.tradingSymbol,
        symbolToken: breakoutTick.symbolToken,
        entryPrice,
        stopLoss,
        target,
        rrRatio,
        entryTime: breakoutTick.exchTradeTime,
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
  }
);

exports.backtestBreakoutFuturesAura = expressAsyncHandler(
  async (req, res, next) => {
    const {
      fromDate,
      toDate,
      startTime = '09:15',
      endTime = '15:15',
      firstCandleMinute,
      breakoutBuffer,
      stopLossMultiplier = 0.1,
      targetMultiplier = 0.1,
      lotSize,
      trailingStopLoss = false,
      trailMultiplier = 5,
      enableScalping = false,
      scalpingProfit = 1000,
      scalpingLoss = 1000,
      stockSymbol,
      stockName,
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

      const candleStart = moment.tz(
        `${currentDate} ${startTime}`,
        'Asia/Kolkata'
      );
      const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');
      const backtestEnd = moment.tz(
        `${currentDate} ${endTime}`,
        'Asia/Kolkata'
      );

      const firstCandleAgg = await HistoricalFuturesData.aggregate([
        {
          $match: {
            stockSymbol,
            stockName,
            timeInterval: 'M1',
            datetime: {
              $gte: candleStart.format('YYYY-MM-DDTHH:mm:ssZ'),
              $lt: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
            },
          },
        },
        { $sort: { datetime: 1 } },
        {
          $group: {
            _id: null,
            open: { $first: '$open' },
            high: { $max: '$high' },
            low: { $min: '$low' },
            close: { $last: '$close' },
          },
        },
      ]);

      if (!firstCandleAgg.length) continue;
      const firstCandle = firstCandleAgg[0];

      const breakoutHigh = firstCandle.high + breakoutBuffer;
      console.log(breakoutHigh);
      const breakoutLow = firstCandle.low - breakoutBuffer;
      console.log(breakoutLow);

      const tickData = await HistoricalFuturesData.find({
        stockSymbol,
        stockName,
        timeInterval: 'M1',
        datetime: {
          $gte: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      })
        .sort({ datetime: 1 })
        .lean();

      const breakoutTick = tickData.find(
        (tick) => tick.close >= breakoutHigh || tick.close <= breakoutLow
      );
      console.log('breakoutTick', breakoutTick);
      if (!breakoutTick) continue;

      const direction = breakoutTick.close >= breakoutHigh ? 'LONG' : 'SHORT';
      console.log('direction', direction);

      const entryPrice = breakoutTick.close;
      console.log('entryPrice', entryPrice);

      let stopLoss =
        direction === 'LONG'
          ? +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(2)
          : +(entryPrice * (1 + stopLossMultiplier / 100)).toFixed(2);
      console.log('stopLoss', stopLoss);

      let target =
        direction === 'LONG'
          ? +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2)
          : +(entryPrice * (1 - targetMultiplier / 100)).toFixed(2);
      console.log('target', entryPrice * (1 + targetMultiplier / 100));

      const rrRatio = +(
        Math.abs(target - entryPrice) / Math.abs(entryPrice - stopLoss)
      ).toFixed(2);

      const exitTicks = tickData.filter((tick) =>
        moment(tick.datetime).isSameOrAfter(breakoutTick.datetime)
      );

      let exitPrice = entryPrice;
      let exitTime = null;
      let exitReason = 'Time Exit';

      for (const tick of exitTicks) {
        const currentLTP = tick.close;
        const tickTime = tick.datetime;

        const pnlPoints =
          direction === 'LONG'
            ? currentLTP - entryPrice
            : entryPrice - currentLTP;

        if (enableScalping) {
          if (pnlPoints >= scalpingProfit) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Scalping Target Hit';
            break;
          } else if (pnlPoints <= -scalpingLoss) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Scalping Stop Loss';
            break;
          }
        } else {
          if (
            (direction === 'LONG' && currentLTP >= target) ||
            (direction === 'SHORT' && currentLTP <= target)
          ) {
            console.log('target', target);
            console.log('currentLTP', currentLTP);
            exitPrice = target;
            exitTime = tickTime;
            exitReason = 'Target Hit';
            break;
          } else if (
            (direction === 'LONG' && currentLTP <= stopLoss) ||
            (direction === 'SHORT' && currentLTP >= stopLoss)
          ) {
            console.log('stopLoss', stopLoss);
            console.log('currentLTP', currentLTP);
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Stop Loss Triggered';
            break;
          } else if (
            trailingStopLoss &&
            ((direction === 'LONG' && currentLTP > entryPrice) ||
              (direction === 'SHORT' && currentLTP < entryPrice))
          ) {
            const newTrailSL =
              direction === 'LONG'
                ? +(currentLTP * (1 - trailMultiplier / 100)).toFixed(2)
                : +(currentLTP * (1 + trailMultiplier / 100)).toFixed(2);
            if (
              (direction === 'LONG' && newTrailSL > stopLoss) ||
              (direction === 'SHORT' && newTrailSL < stopLoss)
            ) {
              stopLoss = newTrailSL;
            }
          }
        }
      }

      if (!exitTime && exitTicks.length > 0) {
        const lastTick = exitTicks[exitTicks.length - 1];
        exitTime = lastTick.datetime;
        exitPrice = lastTick.close;
      }

      const pnl =
        direction === 'LONG'
          ? (exitPrice - entryPrice) * lotSize
          : (entryPrice - exitPrice) * lotSize;

      cumulativePnL += pnl;
      totalTrades++;
      pnl > 0 ? winTrades++ : lossTrades++;

      const tradeResult = {
        date: currentDate,
        firstCandleMinute,
        direction,
        tradingSymbol: breakoutTick.stockSymbol,
        entryPrice,
        stopLoss,
        target,
        rrRatio,
        entryTime: breakoutTick.datetime,
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
  }
);
