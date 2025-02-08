const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');
const ShortStraddleStrategy = require('../models/Straddle');

exports.gridSearchSellingOptions = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTimes,
        exitTimes,
        stockSymbol,
        searchType,
        optionType, // 'CE' or 'PE'
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage ||
        !Array.isArray(entryTimes) ||
        !Array.isArray(exitTimes) ||
        entryTimes.length === 0 ||
        exitTimes.length === 0 ||
        !stockSymbol ||
        !searchType ||
        !optionType // Must specify whether to short 'CE' or 'PE'
      ) {
        return next(
          new AppError(
            'Please provide valid inputs including optionType (CE or PE).',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      const allResults = [];

      for (const entryTime of entryTimes) {
        for (const exitTime of exitTimes) {
          if (
            moment(exitTime, 'HH:mm').isSameOrBefore(moment(entryTime, 'HH:mm'))
          ) {
            console.warn(
              `Skipping invalid combination: Entry: ${entryTime}, Exit: ${exitTime}`
            );
            continue;
          }

          const strategyId = `${searchType}-${stockSymbol.replace(
            / /g,
            '_'
          )}-${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}-${optionType}`;
          let results = [];
          let overallCumulativeProfit = 0;

          for (
            let currentDate = fromDateMoment.clone();
            currentDate.isSameOrBefore(toDateMoment);
            currentDate.add(1, 'day')
          ) {
            const date = currentDate.format('YYYY-MM-DD');
            console.log(
              `Processing date: ${date} for entry: ${entryTime} and exit: ${exitTime}`
            );

            const entryTimeIST = moment.tz(
              `${date} ${entryTime}`,
              'YYYY-MM-DD HH:mm',
              'Asia/Kolkata'
            );
            const exitTimeIST = moment.tz(
              `${date} ${exitTime}`,
              'YYYY-MM-DD HH:mm',
              'Asia/Kolkata'
            );
            const entryTimeStr = entryTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');
            const exitTimeStr = exitTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');

            try {
              const spotData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol,
              });

              if (!spotData) {
                console.warn(
                  `${stockSymbol} spot data not found for ${date}. Skipping.`
                );
                continue;
              }

              const spotPrice = spotData.close;
              const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
              const strikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              const entryOption = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice,
                expiry,
                optionType,
              });

              if (!entryOption) {
                console.warn(
                  `Option data not found for ${optionType} at strike ${strikePrice}. Skipping.`
                );
                continue;
              }

              const entryPrice = entryOption.close;
              const stopLoss =
                entryPrice + entryPrice * (stopLossPercentage / 100);

              let exitPrice = entryPrice;
              let exitTimeFinal = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

              const exitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice,
                expiry,
                optionType,
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              for (const candle of exitData) {
                if (candle.high >= stopLoss) {
                  exitPrice = stopLoss;
                  exitTimeFinal = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                exitPrice = candle.close;
              }

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;
              const profitLoss = (entryPrice - exitPrice) * lotSize;
              overallCumulativeProfit += profitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                optionType,
                entryPrice,
                exitPrice,
                profitLoss,
                cumulativeProfit: overallCumulativeProfit,
                transaction: {
                  date,
                  entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  exitTime: exitTimeFinal,
                  type: optionType,
                  strikePrice,
                  qty: lotSize,
                  entryPrice,
                  exitPrice,
                  stopLoss,
                  vix: vixValue,
                  profitLoss,
                },
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          const totalTradeDays = results.length;
          const noOfProfitableDays = results.filter(
            (day) => day.profitLoss > 0
          ).length;

          const strategy = {
            strategyId,
            timeInterval,
            fromDate,
            toDate,
            stockSymbol,
            expiry,
            lotSize,
            stopLossPercentage,
            searchType,
            entryTime,
            exitTime,
            optionType,
            totalTradeDays,
            noOfProfitableDays,
            cumulativeProfit: overallCumulativeProfit,
            results: results.reverse(),
          };

          allResults.push(strategy);

          await ShortStraddleStrategy.updateOne(
            { strategyId },
            { $set: strategy },
            { upsert: true }
          );
        }
      }

      res.status(200).json({ status: 'success' });
    } catch (error) {
      console.error(
        'Error performing grid search for single leg short selling:',
        error.message
      );
      next(error);
    }
  }
);
