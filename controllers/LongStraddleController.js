const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');
const { calculateIndicators } = require('../utils/Indicators');

exports.createFirstCandleStrategy = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        stockSymbol,
        stockName,
        lotSize,
        breakoutBuffer = 0.5,
        exitTime = '15:10',
        enableIndicators = true,
        stopLossMultiplier = 1.5,
        targetMultiplier = 2,
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !stockSymbol ||
        !stockName ||
        !lotSize
      ) {
        return next(new AppError('Invalid input parameters.', 400));
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');
      const allResults = [];
      let cumulativeProfit = 0;
      let totalTrades = 0;
      let profitableTrades = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        const entryTimeStr = moment
          .tz(`${date} 09:15`, 'Asia/Kolkata')
          .format();
        const exitTimeStr = moment
          .tz(`${date} ${exitTime}`, 'Asia/Kolkata')
          .format();

        try {
          const firstCandle = await HistoricalIndicesData.findOne({
            stockSymbol,
            stockName,
            timeInterval,
            datetime: {
              $gte: `${date}T09:15:00+05:30`,
              $lt: `${date}T09:25:00+05:30`,
            },
          })
            .select('open high low close')
            .lean();

          if (!firstCandle) {
            console.warn(`No first candle found for ${stockSymbol} on ${date}`);
            continue;
          }

          console.log(`First candle data:`, firstCandle);
          const { high, low } = firstCandle;
          const breakoutHigh = high + breakoutBuffer;
          const breakoutLow = low - breakoutBuffer;
          const stopLoss = (breakoutHigh - breakoutLow) * stopLossMultiplier;
          const target = (breakoutHigh - breakoutLow) * targetMultiplier;

          let tradeDirection = null;
          let entryPrice = null;
          let exitPrice = null;
          let profitLoss = 0;
          let entryTime = null;
          let exitTimeFinal = null;

          const priceData = await HistoricalIndicesData.find({
            stockSymbol,
            stockName,
            timeInterval: 'M1',
            datetime: {
              $gte: moment(entryTimeStr).format(),
              $lte: moment(entryTimeStr).add(10, 'minutes').format(),
            },
          })
            .sort({ datetime: 1 })
            .select('datetime close')
            .lean();

          console.log(
            `Checking breakout conditions for ${stockSymbol} on ${date}`
          );
          for (const candle of priceData) {
            console.log(`Time: ${candle.datetime}, Close: ${candle.close}`);
            if (!tradeDirection) {
              if (candle.close >= breakoutHigh) {
                tradeDirection = 'Long';
                entryPrice = breakoutHigh;
                entryTime = candle.datetime;
                console.log(`Entered Long at ${entryTime} for ${stockSymbol}`);
                break;
              } else if (candle.close <= breakoutLow) {
                tradeDirection = 'Short';
                entryPrice = breakoutLow;
                entryTime = candle.datetime;
                console.log(`Entered Short at ${entryTime} for ${stockSymbol}`);
                break;
              }
            }
          }

          if (tradeDirection && enableIndicators) {
            const closingPrices = priceData.map((candle) => candle.close);
            const indicators = await calculateIndicators(closingPrices);

            for (const candle of priceData) {
              if (tradeDirection === 'Long') {
                if (
                  indicators.rsi > 70 ||
                  candle.close >= entryPrice + target
                ) {
                  exitPrice = candle.close;
                  exitTimeFinal = candle.datetime;
                  console.log(
                    `Exited Long at ${exitTimeFinal} for ${stockSymbol}`
                  );
                  break;
                } else if (candle.close <= entryPrice - stopLoss) {
                  exitPrice = candle.close;
                  exitTimeFinal = candle.datetime;
                  console.log(
                    `Stop-Loss Hit for Long at ${exitTimeFinal} for ${stockSymbol}`
                  );
                  break;
                }
              } else if (tradeDirection === 'Short') {
                if (
                  indicators.rsi < 30 ||
                  candle.close <= entryPrice - target
                ) {
                  exitPrice = candle.close;
                  exitTimeFinal = candle.datetime;
                  console.log(
                    `Exited Short at ${exitTimeFinal} for ${stockSymbol}`
                  );
                  break;
                } else if (candle.close >= entryPrice + stopLoss) {
                  exitPrice = candle.close;
                  exitTimeFinal = candle.datetime;
                  console.log(
                    `Stop-Loss Hit for Short at ${exitTimeFinal} for ${stockSymbol}`
                  );
                  break;
                }
              }
            }
          }

          if (tradeDirection && entryPrice && !exitPrice) {
            exitPrice = priceData[priceData.length - 1]?.close;
            exitTimeFinal = priceData[priceData.length - 1]?.datetime;
          }

          if (entryPrice && exitPrice && entryTime) {
            if (
              !exitTimeFinal ||
              moment(exitTimeFinal).isBefore(moment(entryTime))
            ) {
              console.warn(
                `Fixing invalid exit time: ${exitTimeFinal} for ${stockSymbol} on ${date}`
              );
              exitTimeFinal = moment(entryTime).add(1, 'minute').format();
            }

            profitLoss =
              tradeDirection === 'Long'
                ? (exitPrice - entryPrice) * lotSize
                : (entryPrice - exitPrice) * lotSize;
            cumulativeProfit += profitLoss;
            totalTrades++;
            if (profitLoss > 0) {
              profitableTrades++;
            }
          }

          allResults.push({
            date,
            stockSymbol,
            tradeDirection,
            entryPrice,
            exitPrice,
            profitLoss,
            stopLoss,
            target,
            entryTime,
            exitTime: exitTimeFinal,
          });
        } catch (error) {
          console.error(`Error processing ${date}:`, error.message);
        }
      }

      res.status(200).json({
        status: 'success',
        results: allResults,
        cumulativeProfit,
        totalTrades,
        profitableTrades,
      });
    } catch (error) {
      console.error('Error creating first candle strategy:', error.message);
      next(error);
    }
  }
);
