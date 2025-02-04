const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');
const ShortStraddleStrategy = require('../models/Straddle');
const { RSI, EMA, BollingerBands, ATR } = require('technicalindicators');

exports.createShortStraddleSingleDay = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const { timeInterval, date, expiry, lotSize, stopLossPercentage } =
        req.body;

      if (
        !timeInterval ||
        !date ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, date, expiry, lotSize, and stopLossPercentage.',
            400
          )
        );
      }

      const entryTimeIST = moment.tz(
        `${date} 09:20`,
        'YYYY-MM-DD HH:mm',
        'Asia/Kolkata'
      );
      const exitTimeIST = moment.tz(
        `${date} 15:10`,
        'YYYY-MM-DD HH:mm',
        'Asia/Kolkata'
      );

      const entryTimeStr = entryTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');
      const exitTimeStr = exitTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');

      const bankNiftySpot = await HistoricalIndicesData.findOne({
        timeInterval,
        datetime: entryTimeStr,
        stockSymbol: 'Nifty Bank',
      });

      if (!bankNiftySpot) {
        return next(new AppError('BankNIFTY spot data not found.', 404));
      }

      const spotPrice = bankNiftySpot.open;
      const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

      const entryOptions = await HistoricalOptionData.find({
        timeInterval,
        datetime: entryTimeStr,
        strikePrice: nearestStrikePrice,
        expiry,
      });

      const callOptionEntry = entryOptions.find(
        (opt) => opt.optionType === 'CE'
      );
      const putOptionEntry = entryOptions.find(
        (opt) => opt.optionType === 'PE'
      );

      if (!callOptionEntry || !putOptionEntry) {
        return next(
          new AppError(
            `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}`,
            404
          )
        );
      }

      const ceEntryPrice = callOptionEntry.open;
      const peEntryPrice = putOptionEntry.open;

      const ceStopLoss =
        ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
      const peStopLoss =
        peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

      let ceExitPrice = ceEntryPrice;
      let peExitPrice = peEntryPrice;

      const ceExitData = await HistoricalOptionData.find({
        timeInterval,
        strikePrice: nearestStrikePrice,
        expiry,
        optionType: 'CE',
        datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
      }).sort({ datetime: 1 });

      const peExitData = await HistoricalOptionData.find({
        timeInterval,
        strikePrice: nearestStrikePrice,
        expiry,
        optionType: 'PE',
        datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
      }).sort({ datetime: 1 });

      for (const candle of ceExitData) {
        if (candle.high >= ceStopLoss) {
          ceExitPrice = ceStopLoss;
          break;
        }
        ceExitPrice = candle.close;
      }

      for (const candle of peExitData) {
        if (candle.high >= peStopLoss) {
          peExitPrice = peStopLoss;
          break;
        }
        peExitPrice = candle.close;
      }

      const vixData = await HistoricalIndicesData.findOne({
        timeInterval,
        datetime: entryTimeStr,
        stockSymbol: 'India VIX',
      });

      const vixValue = vixData ? vixData.close : null;

      const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
      const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
      const totalProfitLoss = ceProfitLoss + peProfitLoss;

      const transactionLog = [
        {
          date,
          entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          type: 'CE',
          strikePrice: nearestStrikePrice,
          qty: lotSize,
          entryPrice: ceEntryPrice,
          exitPrice: ceExitPrice,
          stopLoss: ceStopLoss,
          vix: vixValue,
          profitLoss: ceProfitLoss,
        },
        {
          date,
          entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          type: 'PE',
          strikePrice: nearestStrikePrice,
          qty: lotSize,
          entryPrice: peEntryPrice,
          exitPrice: peExitPrice,
          stopLoss: peStopLoss,
          vix: vixValue,
          profitLoss: peProfitLoss,
        },
      ];

      res.status(200).json({
        status: 'success',
        data: {
          date,
          strikePrice: nearestStrikePrice,
          expiry,
          lotSize,
          stopLossPercentage,
          entryPrice: ceEntryPrice + peEntryPrice,
          exitPrice: ceExitPrice + peExitPrice,
          profitLoss: totalProfitLoss,
          transactions: transactionLog,
        },
      });
    } catch (error) {
      console.error('Error creating short straddle:', error.message);
      next(error);
    }
  }
);

//Working with cumulative profit and entry, exit time
exports.createShortStraddleMultiDay = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTime,
        exitTime,
      } = req.body;

      // Validate input
      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage ||
        !entryTime ||
        !exitTime
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTime, and exitTime.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];

      // Loop through each date
      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

        // Define entry and exit times for the current date in IST
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

        let ceExitTime, peExitTime; // Initialize variables for exit times

        try {
          const bankNiftySpot = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'Nifty Bank',
          });

          if (!bankNiftySpot) {
            console.warn(
              `BankNIFTY spot data not found for ${date}. Skipping.`
            );
            continue;
          }

          const spotPrice = bankNiftySpot.open;
          const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

          const entryOptions = await HistoricalOptionData.find({
            timeInterval,
            datetime: entryTimeStr,
            strikePrice: nearestStrikePrice,
            expiry,
          });

          const callOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'CE'
          );
          const putOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'PE'
          );

          if (!callOptionEntry || !putOptionEntry) {
            console.warn(
              `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
            );
            continue;
          }

          const ceEntryPrice = callOptionEntry.open;
          const peEntryPrice = putOptionEntry.open;

          const ceStopLoss =
            ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
          const peStopLoss =
            peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

          let ceExitPrice = ceEntryPrice;
          let peExitPrice = peEntryPrice;

          const ceExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: nearestStrikePrice,
            expiry,
            optionType: 'CE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          const peExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: nearestStrikePrice,
            expiry,
            optionType: 'PE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          for (const candle of ceExitData) {
            if (candle.high >= ceStopLoss) {
              ceExitPrice = ceStopLoss;
              ceExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            ceExitPrice = candle.close;
            ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
          }

          for (const candle of peExitData) {
            if (candle.high >= peStopLoss) {
              peExitPrice = peStopLoss;
              peExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            peExitPrice = candle.close;
            peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
          }

          const vixData = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'India VIX',
          });

          const vixValue = vixData ? vixData.close : null;

          const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
          const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
          const totalProfitLoss = ceProfitLoss + peProfitLoss;

          const transactionLog = [
            {
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: nearestStrikePrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            },
            {
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: nearestStrikePrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            },
          ];

          results.push({
            date,
            spotPrice,
            strikePrice: nearestStrikePrice,
            expiry,
            lotSize,
            stopLossPercentage,
            entryPrice: ceEntryPrice + peEntryPrice,
            exitPrice: ceExitPrice + peExitPrice,
            profitLoss: totalProfitLoss,
            transactions: transactionLog,
          });
        } catch (error) {
          console.error(`Error processing date ${date}:`, error.message);
        }
      }

      results.sort((a, b) => new Date(b.date) - new Date(a.date));

      let cumulativeProfit = 0;
      results = results.reverse().map((entry) => {
        cumulativeProfit += entry.profitLoss;
        return {
          cumulativeProfit,
          ...entry,
        };
      });

      res.status(200).json({
        status: 'success',
        data: results.reverse(),
      });
    } catch (error) {
      console.error('Error creating multi-day short straddle:', error.message);
      next(error);
    }
  }
);

exports.createAndSaveShortStraddleMultiDay = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTime,
        exitTime,
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage ||
        !entryTime ||
        !exitTime
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTime, and exitTime.',
            400
          )
        );
      }

      const strategyId = `${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}`;
      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

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

        let ceExitTime, peExitTime;

        try {
          const bankNiftySpot = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'Nifty Bank',
          });

          if (!bankNiftySpot) {
            console.warn(
              `BankNIFTY spot data not found for ${date}. Skipping.`
            );
            continue;
          }

          const spotPrice = bankNiftySpot.open;
          const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

          const entryOptions = await HistoricalOptionData.find({
            timeInterval,
            datetime: entryTimeStr,
            strikePrice: nearestStrikePrice,
            expiry,
          });

          const callOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'CE'
          );
          const putOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'PE'
          );

          if (!callOptionEntry || !putOptionEntry) {
            console.warn(
              `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
            );
            continue;
          }

          const ceEntryPrice = callOptionEntry.open;
          const peEntryPrice = putOptionEntry.open;

          const ceStopLoss =
            ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
          const peStopLoss =
            peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

          let ceExitPrice = ceEntryPrice;
          let peExitPrice = peEntryPrice;

          const ceExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: nearestStrikePrice,
            expiry,
            optionType: 'CE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          const peExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: nearestStrikePrice,
            expiry,
            optionType: 'PE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          for (const candle of ceExitData) {
            if (candle.high >= ceStopLoss) {
              ceExitPrice = ceStopLoss;
              ceExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            ceExitPrice = candle.close;
            ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
          }

          for (const candle of peExitData) {
            if (candle.high >= peStopLoss) {
              peExitPrice = peStopLoss;
              peExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            peExitPrice = candle.close;
            peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
          }

          const vixData = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'India VIX',
          });

          const vixValue = vixData ? vixData.close : null;

          const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
          const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
          const totalProfitLoss = ceProfitLoss + peProfitLoss;

          overallCumulativeProfit += totalProfitLoss;

          const transactionLog = [
            {
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: nearestStrikePrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            },
            {
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: nearestStrikePrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            },
          ];

          const result = {
            date,
            spotPrice,
            strikePrice: nearestStrikePrice,
            expiry,
            lotSize,
            stopLossPercentage,
            entryPrice: ceEntryPrice + peEntryPrice,
            exitPrice: ceExitPrice + peExitPrice,
            profitLoss: totalProfitLoss,
            transactions: transactionLog,
          };

          results.push(result);
        } catch (error) {
          console.error(`Error processing date ${date}:`, error.message);
        }
      }

      results.sort((a, b) => new Date(b.date) - new Date(a.date));

      let cumulativeProfit = 0;
      results = results.reverse().map((entry) => {
        cumulativeProfit += entry.profitLoss;
        return {
          cumulativeProfit,
          ...entry,
        };
      });

      const strategy = {
        strategyId,
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTime,
        exitTime,
        cumulativeProfit: overallCumulativeProfit,
        results: results.reverse(),
      };

      // Save to database using upsert
      await ShortStraddleStrategy.updateOne(
        { strategyId },
        { $set: strategy },
        { upsert: true }
      );

      res.status(200).json({
        status: 'success',
        data: strategy,
      });
    } catch (error) {
      console.error('Error creating multi-day short straddle:', error.message);
      next(error);
    }
  }
);

//Working Short Straddle Multi-Day Grid Search and Save to database
exports.gridSearchAndSaveShortStraddle = expressAsyncHandler(
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
        !searchType
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, searchType, and non-empty entryTimes and exitTimes arrays.',
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
          )}-${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}`;
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

              const spotPrice = spotData.open;
              const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
              const nearestStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              const entryOptions = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: nearestStrikePrice,
                expiry,
              });

              const callOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionEntry || !putOptionEntry) {
                console.warn(
                  `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const ceEntryPrice = callOptionEntry.open;
              const peEntryPrice = putOptionEntry.open;

              const ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              const peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              for (const candle of ceExitData) {
                if (candle.high >= ceStopLoss) {
                  ceExitPrice = ceStopLoss;
                  ceExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                ceExitPrice = candle.close;
              }

              for (const candle of peExitData) {
                if (candle.high >= peStopLoss) {
                  peExitPrice = peStopLoss;
                  peExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                peExitPrice = candle.close;
              }

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: nearestStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
                transactions: [
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: ceExitTime,
                    type: 'CE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: ceEntryPrice,
                    exitPrice: ceExitPrice,
                    stopLoss: ceStopLoss,
                    vix: vixValue,
                    profitLoss: ceProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: peExitTime,
                    type: 'PE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: peEntryPrice,
                    exitPrice: peExitPrice,
                    stopLoss: peStopLoss,
                    vix: vixValue,
                    profitLoss: peProfitLoss,
                  },
                ],
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          totalTradeDays = results.length;
          noOfProfitableDays = results.filter(
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

      res.status(200).json({
        status: 'success',
      });
    } catch (error) {
      console.error(
        'Error performing grid search for short straddle:',
        error.message
      );
      next(error);
    }
  }
);

//Working Short Straddle Multi-Day Grid Search and Save to database, updated with the new strike price calculation
exports.gridSearchAndSaveShortStraddleStrike = expressAsyncHandler(
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
        !searchType
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, searchType, and non-empty entryTimes and exitTimes arrays.',
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
          )}-${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}`;
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
              const baseStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              // Fetch premiums for the base strike price
              const entryOptionsBase = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: baseStrikePrice,
                expiry,
              });

              const callOptionBase = entryOptionsBase.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionBase = entryOptionsBase.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionBase || !putOptionBase) {
                console.warn(
                  `Options data not found for base strike: ${baseStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              // Calculate adjusted strike price
              const adjustedStrikePrice =
                baseStrikePrice + (callOptionBase.close - putOptionBase.close);

              // Determine nearest strike price
              const nearestStrikePrice =
                Math.round(adjustedStrikePrice / strikePriceInterval) *
                strikePriceInterval;

              // Fetch premiums for the nearest strike price
              const entryOptionsNearest = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: nearestStrikePrice,
                expiry,
              });

              const callOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionNearest || !putOptionNearest) {
                console.warn(
                  `Options data not found for nearest strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const ceEntryPrice = callOptionNearest.close;
              const peEntryPrice = putOptionNearest.close;

              const ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              const peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              for (const candle of ceExitData) {
                if (candle.high >= ceStopLoss) {
                  ceExitPrice = ceStopLoss;
                  ceExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                ceExitPrice = candle.close;
              }

              for (const candle of peExitData) {
                if (candle.high >= peStopLoss) {
                  peExitPrice = peStopLoss;
                  peExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                peExitPrice = candle.close;
              }

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: nearestStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
                transactions: [
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: ceExitTime,
                    type: 'CE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: ceEntryPrice,
                    exitPrice: ceExitPrice,
                    stopLoss: ceStopLoss,
                    vix: vixValue,
                    profitLoss: ceProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: peExitTime,
                    type: 'PE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: peEntryPrice,
                    exitPrice: peExitPrice,
                    stopLoss: peStopLoss,
                    vix: vixValue,
                    profitLoss: peProfitLoss,
                  },
                ],
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          totalTradeDays = results.length;
          noOfProfitableDays = results.filter(
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

      res.status(200).json({
        status: 'success',
      });
    } catch (error) {
      console.error(
        'Error performing grid search for short straddle:',
        error.message
      );
      next(error);
    }
  }
);

exports.gridSearchShortStraddle = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTimes, // Array of potential entry times
        exitTimes, // Array of potential exit times
      } = req.body;

      // Validate input
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
        exitTimes.length === 0
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, and non-empty entryTimes and exitTimes arrays.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let allResults = []; // To store all grid search results

      // Iterate over all combinations of entry and exit times
      for (const entryTime of entryTimes) {
        for (const exitTime of exitTimes) {
          if (
            moment(exitTime, 'HH:mm').isSameOrBefore(moment(entryTime, 'HH:mm'))
          ) {
            // Skip invalid entry-exit combinations
            continue;
          }

          let results = [];
          let overallCumulativeProfit = 0;

          // Loop through each date
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

            let ceExitTime, peExitTime;

            try {
              const bankNiftySpot = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'Nifty Bank',
              });

              if (!bankNiftySpot) {
                console.warn(
                  `BankNIFTY spot data not found for ${date}. Skipping.`
                );
                continue;
              }

              const spotPrice = bankNiftySpot.open;
              const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

              const entryOptions = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: nearestStrikePrice,
                expiry,
              });

              const callOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionEntry || !putOptionEntry) {
                console.warn(
                  `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const ceEntryPrice = callOptionEntry.open;
              const peEntryPrice = putOptionEntry.open;

              const ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              const peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              for (const candle of ceExitData) {
                if (candle.high >= ceStopLoss) {
                  ceExitPrice = ceStopLoss;
                  ceExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                ceExitPrice = candle.close;
                ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              }

              for (const candle of peExitData) {
                if (candle.high >= peStopLoss) {
                  peExitPrice = peStopLoss;
                  peExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                peExitPrice = candle.close;
                peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              }

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: nearestStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          allResults.push({
            entryTime,
            exitTime,
            cumulativeProfit: overallCumulativeProfit,
            results,
          });
        }
      }

      // Find the best and worst combinations
      const maxProfit = allResults.reduce((max, result) =>
        result.cumulativeProfit > max.cumulativeProfit ? result : max
      );

      const minLoss = allResults.reduce((min, result) =>
        result.cumulativeProfit < min.cumulativeProfit ? result : min
      );

      const uniqueResults = {};
      allResults.forEach((result) => {
        const key = `${result.entryTime}-${result.exitTime}`;
        if (!uniqueResults[key]) {
          uniqueResults[key] = result;
        }
      });
      allResults = Object.values(uniqueResults);

      res.status(200).json({
        status: 'success',
        data: {
          allResults,
          maxProfit,
          minLoss,
        },
      });
    } catch (error) {
      console.error(
        'Error performing grid search for short straddle:',
        error.message
      );
      next(error);
    }
  }
);

exports.gridSearchShortStraddleProfitOnly = expressAsyncHandler(
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
      } = req.body;

      // Validate input
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
        exitTimes.length === 0
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, and non-empty entryTimes and exitTimes arrays.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let allResults = []; // To store all grid search results

      // Iterate over all combinations of entry and exit times
      for (const entryTime of entryTimes) {
        for (const exitTime of exitTimes) {
          if (
            moment(exitTime, 'HH:mm').isSameOrBefore(moment(entryTime, 'HH:mm'))
          ) {
            // Skip invalid entry-exit combinations
            console.warn(
              `Skipping invalid entry-exit combination: Entry: ${entryTime}, Exit: ${exitTime}`
            );
            continue;
          }

          let results = [];
          let overallCumulativeProfit = 0;

          // Loop through each date
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

            let ceExitTime, peExitTime;

            try {
              const bankNiftySpot = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'Nifty Bank',
              });

              if (!bankNiftySpot) {
                console.warn(
                  `BankNIFTY spot data not found for ${date}. Skipping.`
                );
                continue;
              }

              const spotPrice = bankNiftySpot.open;
              const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

              const entryOptions = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: nearestStrikePrice,
                expiry,
              });

              const callOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionEntry || !putOptionEntry) {
                console.warn(
                  `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const ceEntryPrice = callOptionEntry.open;
              const peEntryPrice = putOptionEntry.open;

              const ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              const peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              for (const candle of ceExitData) {
                if (candle.high >= ceStopLoss) {
                  ceExitPrice = ceStopLoss;
                  ceExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                ceExitPrice = candle.close;
                ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              }

              for (const candle of peExitData) {
                if (candle.high >= peStopLoss) {
                  peExitPrice = peStopLoss;
                  peExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                peExitPrice = candle.close;
                peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              }

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: nearestStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          if (overallCumulativeProfit > 0) {
            // Only retain positive cumulative profit combinations
            allResults.push({
              entryTime,
              exitTime,
              cumulativeProfit: overallCumulativeProfit,
              results,
            });
          }
        }
      }

      // Find the best combinations
      const maxProfit = allResults.reduce((max, result) =>
        result.cumulativeProfit > max.cumulativeProfit ? result : max
      );

      // Sort results based on cumulativeProfit descending
      allResults.sort((a, b) => b.cumulativeProfit - a.cumulativeProfit);

      res.status(200).json({
        status: 'success',
        data: {
          allResults,
          maxProfit,
        },
      });
    } catch (error) {
      console.error(
        'Error performing grid search for short straddle:',
        error.message
      );
      next(error);
    }
  }
);

// Create OTM Short Straddle Multi-Day
exports.createOTMShortStraddleMultiDay = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTime,
        exitTime,
        otmOffset = 0, // Default to 0 for ATM calculation
        stockSymbol,
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage ||
        !entryTime ||
        !exitTime ||
        !stockSymbol
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTime, exitTime, stockSymbol, and otmOffset.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;
      let profitableDaysCount = 0; // Count of profitable days
      let totalTradeDays = 0; // Count of total trade days

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

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

        let ceExitTime, peExitTime;

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

          const spotPrice = spotData.open;
          const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
          const atmStrikePrice =
            Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

          const otmCEPrice = atmStrikePrice + otmOffset;
          const otmPEPrice = atmStrikePrice - otmOffset;

          const entryOptions = await HistoricalOptionData.find({
            timeInterval,
            datetime: entryTimeStr,
            strikePrice: { $in: [otmCEPrice, otmPEPrice] },
            expiry,
          });

          const callOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'CE' && opt.strikePrice === otmCEPrice
          );
          const putOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'PE' && opt.strikePrice === otmPEPrice
          );

          if (!callOptionEntry || !putOptionEntry) {
            console.warn(
              `Options data not found for entry at CE: ${otmCEPrice}, PE: ${otmPEPrice}, expiry: ${expiry}. Skipping.`
            );
            continue;
          }

          const ceEntryPrice = callOptionEntry.open;
          const peEntryPrice = putOptionEntry.open;

          const ceStopLoss =
            ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
          const peStopLoss =
            peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

          let ceExitPrice = ceEntryPrice;
          let peExitPrice = peEntryPrice;

          const ceExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: otmCEPrice,
            expiry,
            optionType: 'CE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          const peExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: otmPEPrice,
            expiry,
            optionType: 'PE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          for (const candle of ceExitData) {
            if (candle.high >= ceStopLoss) {
              ceExitPrice = ceStopLoss;
              ceExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            ceExitPrice = candle.close;
            ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
          }

          for (const candle of peExitData) {
            if (candle.high >= peStopLoss) {
              peExitPrice = peStopLoss;
              peExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            peExitPrice = candle.close;
            peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
          }

          const vixData = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'India VIX',
          });

          const vixValue = vixData ? vixData.close : null;

          const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
          const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
          const totalProfitLoss = ceProfitLoss + peProfitLoss;

          overallCumulativeProfit += totalProfitLoss;

          if (totalProfitLoss > 0) {
            profitableDaysCount++;
          }
          totalTradeDays++; // Increment for every processed day

          const transactionLog = [
            {
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: otmCEPrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            },
            {
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: otmPEPrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            },
          ];

          results.push({
            cumulativeProfit: overallCumulativeProfit,
            date,
            spotPrice,
            strikePrice: { CE: otmCEPrice, PE: otmPEPrice },
            expiry,
            lotSize,
            stopLossPercentage,
            entryPrice: ceEntryPrice + peEntryPrice,
            exitPrice: ceExitPrice + peExitPrice,
            profitLoss: totalProfitLoss,
            transactions: transactionLog,
          });
        } catch (error) {
          console.error(`Error processing date ${date}:`, error.message);
        }
      }

      res.status(200).json({
        status: 'success',
        totalTradeDays, // Include total trade days
        noOfProfitableDays: profitableDaysCount, // Include number of profitable days
        data: results.reverse(),
      });
    } catch (error) {
      console.error(
        'Error creating multi-day OTM short straddle:',
        error.message
      );
      next(error);
    }
  }
);

exports.createOTMShortStraddleMultiEntry = expressAsyncHandler(
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
        exitTime,
        otmOffset = 0,
        stockSymbol,
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage ||
        !Array.isArray(entryTimes) ||
        entryTimes.length === 0 ||
        !exitTime ||
        !stockSymbol
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTimes, exitTime, stockSymbol, and otmOffset.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;
      let profitableDaysCount = 0;
      let totalTradeDays = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

        let dailyTransactions = [];
        let dailyProfitLoss = 0;

        for (const entryTime of entryTimes) {
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

          const spotData = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol,
          });

          if (!spotData) {
            console.warn(
              `No spot data found for ${stockSymbol} on ${date}. Skipping.`
            );
            continue;
          }

          const spotPrice = spotData.close;

          try {
            const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
            const baseStrikePrice =
              Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

            const entryOptionsBase = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              strikePrice: baseStrikePrice,
              expiry,
            });

            const callOptionBase = entryOptionsBase.find(
              (opt) => opt.optionType === 'CE'
            );
            const putOptionBase = entryOptionsBase.find(
              (opt) => opt.optionType === 'PE'
            );

            if (!callOptionBase || !putOptionBase) {
              console.warn(
                `Options data not found for base strike: ${baseStrikePrice}, expiry: ${expiry}. Skipping.`
              );
              continue;
            }

            const adjustedStrikePrice =
              baseStrikePrice + (callOptionBase.close - putOptionBase.close);

            const nearestStrikePrice =
              Math.round(adjustedStrikePrice / strikePriceInterval) *
              strikePriceInterval;

            const entryOptionsNearest = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              strikePrice: nearestStrikePrice,
              expiry,
            });

            const callOptionNearest = entryOptionsNearest.find(
              (opt) => opt.optionType === 'CE'
            );
            const putOptionNearest = entryOptionsNearest.find(
              (opt) => opt.optionType === 'PE'
            );

            if (!callOptionNearest || !putOptionNearest) {
              console.warn(
                `Options data not found for nearest strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
              );
              continue;
            }

            const ceEntryPrice = callOptionNearest.close;
            const peEntryPrice = putOptionNearest.close;

            const ceStopLoss =
              ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
            const peStopLoss =
              peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

            let ceExitPrice = ceEntryPrice;
            let peExitPrice = peEntryPrice;

            const ceExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: nearestStrikePrice,
              expiry,
              optionType: 'CE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            const peExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: nearestStrikePrice,
              expiry,
              optionType: 'PE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
            let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

            for (const candle of ceExitData) {
              if (candle.high >= ceStopLoss) {
                ceExitPrice = ceStopLoss;
                ceExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              ceExitPrice = candle.close;
            }

            for (const candle of peExitData) {
              if (candle.high >= peStopLoss) {
                peExitPrice = peStopLoss;
                peExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              peExitPrice = candle.close;
            }

            const vixData = await HistoricalIndicesData.findOne({
              timeInterval,
              datetime: entryTimeStr,
              stockSymbol: 'India VIX',
            });

            const vixValue = vixData ? vixData.close : null;

            const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
            const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
            const totalProfitLoss = ceProfitLoss + peProfitLoss;

            dailyProfitLoss += totalProfitLoss;

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: nearestStrikePrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            });

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: nearestStrikePrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            });
          } catch (error) {
            console.error(
              `Error processing date ${date} for entry ${entryTime}:`,
              error.message
            );
          }
        }

        if (dailyTransactions.length > 0) {
          overallCumulativeProfit += dailyProfitLoss;

          if (dailyProfitLoss > 0) {
            profitableDaysCount++;
          }
          totalTradeDays++;

          results.push({
            cumulativeProfit: overallCumulativeProfit,
            date,
            expiry,
            lotSize,
            stopLossPercentage,
            profitLoss: dailyProfitLoss,
            transactions: dailyTransactions,
          });
        }
      }

      res.status(200).json({
        status: 'success',
        totalTradeDays,
        noOfProfitableDays: profitableDaysCount,
        data: results.reverse(),
      });
    } catch (error) {
      console.error(
        'Error creating multi-day OTM short straddle with multiple entries:',
        error.message
      );
      next(error);
    }
  }
);

// Create OTM Short Straddle Multi-Day Multi-Entry Exit at the same time, updated with the new strike price calculation
exports.createOTMShortStraddleMultiDayMultiExitStrike = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTimes, // Array of entry times
        exitTimes, // Array of exit times
        otmOffset = 0, // Default to 0 for ATM calculation
        stockSymbol,
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
        !stockSymbol
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTimes, exitTimes, stockSymbol, and otmOffset.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;
      let totalTradeDays = 0;
      let noOfProfitableDays = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

        let dailyTransactions = [];
        let dailyProfitLoss = 0;
        let spotPrice = null;

        for (let i = 0; i < entryTimes.length; i++) {
          const entryTime = entryTimes[i];
          const exitTime = exitTimes[i];

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
                `No spot data found for ${stockSymbol} on ${date}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            spotPrice = spotData.close;
            const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
            const baseStrikePrice =
              Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

            const entryOptionsBase = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              strikePrice: baseStrikePrice,
              expiry,
            });

            const callOptionBase = entryOptionsBase.find(
              (opt) => opt.optionType === 'CE'
            );

            const putOptionBase = entryOptionsBase.find(
              (opt) => opt.optionType === 'PE'
            );

            if (!callOptionBase || !putOptionBase) {
              console.warn(
                `Options data not found for base strike: ${baseStrikePrice}, expiry: ${expiry}. Skipping.`
              );
              continue;
            }

            const adjustedStrikePrice =
              baseStrikePrice + (callOptionBase.close - putOptionBase.close);

            const nearestStrikePrice =
              Math.round(adjustedStrikePrice / strikePriceInterval) *
              strikePriceInterval;

            const otmCEPrice = nearestStrikePrice + otmOffset;
            const otmPEPrice = nearestStrikePrice - otmOffset;

            const entryOptionsNearest = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              strikePrice: { $in: [otmCEPrice, otmPEPrice] },
              expiry,
            });

            const callOptionNearest = entryOptionsNearest.find(
              (opt) => opt.optionType === 'CE'
            );

            const putOptionNearest = entryOptionsNearest.find(
              (opt) => opt.optionType === 'PE'
            );

            if (!callOptionNearest || !putOptionNearest) {
              console.warn(
                `Options data not found for CE: ${otmCEPrice}, PE: ${otmPEPrice}, expiry: ${expiry}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            const ceEntryPrice = callOptionNearest.close;
            const peEntryPrice = putOptionNearest.close;

            const ceStopLoss =
              ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
            const peStopLoss =
              peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

            let ceExitPrice = ceEntryPrice;
            let peExitPrice = peEntryPrice;

            const ceExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: nearestStrikePrice,
              expiry,
              optionType: 'CE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            const peExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: nearestStrikePrice,
              expiry,
              optionType: 'PE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
            let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

            for (const candle of ceExitData) {
              if (candle.high >= ceStopLoss) {
                ceExitPrice = ceStopLoss;
                ceExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              ceExitPrice = candle.close;
            }

            for (const candle of peExitData) {
              if (candle.high >= peStopLoss) {
                peExitPrice = peStopLoss;
                peExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              peExitPrice = candle.close;
            }

            const vixData = await HistoricalIndicesData.findOne({
              timeInterval,
              datetime: entryTimeStr,
              stockSymbol: 'India VIX',
            });

            const vixValue = vixData ? vixData.close : null;

            const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
            const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
            const totalProfitLoss = ceProfitLoss + peProfitLoss;

            dailyProfitLoss += totalProfitLoss;

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: nearestStrikePrice,
              otmCEPrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            });

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: nearestStrikePrice,
              otmPEPrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            });
          } catch (error) {
            console.error(
              `Error processing date ${date} for entry ${entryTime}:`,
              error.message
            );
          }
        }

        if (dailyTransactions.length > 0) {
          overallCumulativeProfit += dailyProfitLoss;
          totalTradeDays++;

          if (dailyProfitLoss > 0) {
            noOfProfitableDays++;
          }

          results.push({
            cumulativeProfit: overallCumulativeProfit,
            date,
            spotPrice,
            expiry,
            lotSize,
            stopLossPercentage,
            profitLoss: dailyProfitLoss,
            transactions: dailyTransactions,
          });
        }
      }

      res.status(200).json({
        status: 'success',
        totalTradeDays,
        noOfProfitableDays,
        data: results.reverse(),
      });
    } catch (error) {
      console.error(
        'Error creating multi-day OTM short straddle with multiple entries and exits:',
        error.message
      );
      next(error);
    }
  }
);

// Create OTM Short Straddle Multi-Day Multi-Entry Exit at the same time
exports.createOTMShortStraddleMultiDayMultiExit = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTimes, // Array of entry times
        exitTimes, // Array of exit times
        otmOffset = 0, // Default to 0 for ATM calculation
        stockSymbol,
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
        !stockSymbol
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTimes, exitTimes, stockSymbol, and otmOffset.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;
      let totalTradeDays = 0;
      let noOfProfitableDays = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

        let dailyTransactions = [];
        let dailyProfitLoss = 0;
        let spotPrice = null;

        for (let i = 0; i < entryTimes.length; i++) {
          const entryTime = entryTimes[i];
          const exitTime = exitTimes[i];

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
                `No spot data found for ${stockSymbol} on ${date}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            spotPrice = spotData.close;
            const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
            const atmStrikePrice =
              Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

            const otmCEPrice = atmStrikePrice + otmOffset;
            const otmPEPrice = atmStrikePrice - otmOffset;

            const entryOptions = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              strikePrice: { $in: [otmCEPrice, otmPEPrice] },
              expiry,
            });

            const callOptionEntry = entryOptions.find(
              (opt) => opt.optionType === 'CE' && opt.strikePrice === otmCEPrice
            );
            const putOptionEntry = entryOptions.find(
              (opt) => opt.optionType === 'PE' && opt.strikePrice === otmPEPrice
            );

            if (!callOptionEntry || !putOptionEntry) {
              console.warn(
                `Options data not found for CE: ${otmCEPrice}, PE: ${otmPEPrice}, expiry: ${expiry}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            const ceEntryPrice = callOptionEntry.close;
            const peEntryPrice = putOptionEntry.close;

            const ceStopLoss =
              ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
            const peStopLoss =
              peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

            let ceExitPrice = ceEntryPrice;
            let peExitPrice = peEntryPrice;

            const ceExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: otmCEPrice,
              expiry,
              optionType: 'CE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            const peExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: otmPEPrice,
              expiry,
              optionType: 'PE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
            let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

            for (const candle of ceExitData) {
              if (candle.high >= ceStopLoss) {
                ceExitPrice = ceStopLoss;
                ceExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              ceExitPrice = candle.close;
            }

            for (const candle of peExitData) {
              if (candle.high >= peStopLoss) {
                peExitPrice = peStopLoss;
                peExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              peExitPrice = candle.close;
            }

            const vixData = await HistoricalIndicesData.findOne({
              timeInterval,
              datetime: entryTimeStr,
              stockSymbol: 'India VIX',
            });

            const vixValue = vixData ? vixData.close : null;

            const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
            const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
            const totalProfitLoss = ceProfitLoss + peProfitLoss;

            dailyProfitLoss += totalProfitLoss;

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: otmCEPrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            });

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: otmPEPrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            });
          } catch (error) {
            console.error(
              `Error processing date ${date} for entry ${entryTime}:`,
              error.message
            );
          }
        }

        if (dailyTransactions.length > 0) {
          overallCumulativeProfit += dailyProfitLoss;
          totalTradeDays++;

          if (dailyProfitLoss > 0) {
            noOfProfitableDays++;
          }

          results.push({
            cumulativeProfit: overallCumulativeProfit,
            date,
            spotPrice,
            expiry,
            lotSize,
            stopLossPercentage,
            profitLoss: dailyProfitLoss,
            transactions: dailyTransactions,
          });
        }
      }

      res.status(200).json({
        status: 'success',
        totalTradeDays,
        noOfProfitableDays,
        data: results.reverse(),
      });
    } catch (error) {
      console.error(
        'Error creating multi-day OTM short straddle with multiple entries and exits:',
        error.message
      );
      next(error);
    }
  }
);

// Selling premiums at a specified price for both CE and PE
exports.createPremiumBasedShortStraddle = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTimes, // Array of entry times
        exitTimes, // Array of exit times
        stockSymbol,
        premium, // Desired premium value for CE and PE
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
        !premium
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, premium, and non-empty entryTimes and exitTimes arrays.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;
      let totalTradeDays = 0;
      let noOfProfitableDays = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

        let dailyTransactions = [];
        let dailyProfitLoss = 0;
        let spotPrice = null;

        for (let i = 0; i < entryTimes.length; i++) {
          const entryTime = entryTimes[i];
          const exitTime = exitTimes[i];

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
                `No spot data found for ${stockSymbol} on ${date}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            spotPrice = spotData.open;

            // Fetch the nearest strike prices with the desired premium
            const entryOptions = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              expiry,
              optionType: { $in: ['CE', 'PE'] },
            });

            const callOptionEntry = entryOptions
              .filter((opt) => opt.optionType === 'CE')
              .reduce((nearest, current) => {
                return Math.abs(current.open - premium) <
                  Math.abs(nearest.open - premium)
                  ? current
                  : nearest;
              }, entryOptions[0]);

            const putOptionEntry = entryOptions
              .filter((opt) => opt.optionType === 'PE')
              .reduce((nearest, current) => {
                return Math.abs(current.open - premium) <
                  Math.abs(nearest.open - premium)
                  ? current
                  : nearest;
              }, entryOptions[0]);

            if (!callOptionEntry || !putOptionEntry) {
              console.warn(
                `Options data not found for premium: ${premium}, expiry: ${expiry}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            const ceEntryPrice = callOptionEntry.open;
            const peEntryPrice = putOptionEntry.open;
            const ceStrikePrice = callOptionEntry.strikePrice;
            const peStrikePrice = putOptionEntry.strikePrice;

            const ceStopLoss =
              ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
            const peStopLoss =
              peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

            let ceExitPrice = ceEntryPrice;
            let peExitPrice = peEntryPrice;

            const ceExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: ceStrikePrice,
              expiry,
              optionType: 'CE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            const peExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: peStrikePrice,
              expiry,
              optionType: 'PE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
            let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

            for (const candle of ceExitData) {
              if (candle.high >= ceStopLoss) {
                ceExitPrice = ceStopLoss;
                ceExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              ceExitPrice = candle.close;
            }

            for (const candle of peExitData) {
              if (candle.high >= peStopLoss) {
                peExitPrice = peStopLoss;
                peExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              peExitPrice = candle.close;
            }

            const vixData = await HistoricalIndicesData.findOne({
              timeInterval,
              datetime: entryTimeStr,
              stockSymbol: 'India VIX',
            });

            const vixValue = vixData ? vixData.close : null;

            const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
            const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
            const totalProfitLoss = ceProfitLoss + peProfitLoss;

            dailyProfitLoss += totalProfitLoss;

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: ceStrikePrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            });

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: peStrikePrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            });
          } catch (error) {
            console.error(
              `Error processing date ${date} for entry ${entryTime}:`,
              error.message
            );
          }
        }

        if (dailyTransactions.length > 0) {
          overallCumulativeProfit += dailyProfitLoss;
          totalTradeDays++;

          if (dailyProfitLoss > 0) {
            noOfProfitableDays++;
          }

          results.push({
            cumulativeProfit: overallCumulativeProfit,
            date,
            spotPrice,
            expiry,
            lotSize,
            stopLossPercentage,
            profitLoss: dailyProfitLoss,
            transactions: dailyTransactions,
          });
        }
      }

      res.status(200).json({
        status: 'success',
        totalTradeDays,
        noOfProfitableDays,
        data: results.reverse(),
      });
    } catch (error) {
      console.error(
        'Error creating multi-day premium-based short straddle:',
        error.message
      );
      next(error);
    }
  }
);

// controller with VIX and OI conditions integrated
exports.createAndSaveShortStraddleWithIndicators = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTime,
        exitTime,
        vixThreshold = { min: 10, max: 17 }, // Example VIX range
        // oiChangeThreshold = 10, // Example threshold for OI change percentage
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage ||
        !entryTime ||
        !exitTime
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTime, and exitTime.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

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
          // Fetch spot data
          const bankNiftySpot = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'Nifty Bank',
          });

          if (!bankNiftySpot) {
            console.warn(
              `BankNIFTY spot data not found for ${date}. Skipping.`
            );
            continue;
          }

          const spotPrice = bankNiftySpot.open;
          const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

          // Fetch options data
          const entryOptions = await HistoricalOptionData.find({
            timeInterval,
            datetime: entryTimeStr,
            strikePrice: nearestStrikePrice,
            expiry,
          });

          const callOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'CE'
          );
          const putOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'PE'
          );

          if (!callOptionEntry || !putOptionEntry) {
            console.warn(
              `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
            );
            continue;
          }

          // Fetch VIX data
          const vixData = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'India VIX',
          });

          const vixValue = vixData ? vixData.close : null;
          if (
            !vixValue ||
            vixValue < vixThreshold.min ||
            vixValue > vixThreshold.max
          ) {
            console.warn(`VIX ${vixValue} out of range on ${date}. Skipping.`);
            continue;
          }

          // Entry prices and conditions
          const ceEntryPrice = callOptionEntry.open;
          const peEntryPrice = putOptionEntry.open;
          const ceStopLoss =
            ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
          const peStopLoss =
            peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

          // Fetch OI data
          // const oiChange = Math.abs(
          //   ((callOptionEntry.openInterest - putOptionEntry.openInterest) /
          //     putOptionEntry.openInterest) *
          //     100
          // );
          // if (oiChange > oiChangeThreshold) {
          //   console.warn(`OI Change ${oiChange}% exceeds threshold. Skipping.`);
          //   continue;
          // }

          // Exit logic
          let ceExitPrice = ceEntryPrice;
          let peExitPrice = peEntryPrice;

          const ceExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: nearestStrikePrice,
            expiry,
            optionType: 'CE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          const peExitData = await HistoricalOptionData.find({
            timeInterval,
            strikePrice: nearestStrikePrice,
            expiry,
            optionType: 'PE',
            datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
          }).sort({ datetime: 1 });

          let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
          let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

          for (const candle of ceExitData) {
            if (candle.high >= ceStopLoss) {
              ceExitPrice = ceStopLoss;
              ceExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            ceExitPrice = candle.close;
          }

          for (const candle of peExitData) {
            if (candle.high >= peStopLoss) {
              peExitPrice = peStopLoss;
              peExitTime = moment(candle.datetime).format(
                'YYYY-MM-DD HH:mm:ss'
              );
              break;
            }
            peExitPrice = candle.close;
          }

          const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
          const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
          const totalProfitLoss = ceProfitLoss + peProfitLoss;

          overallCumulativeProfit += totalProfitLoss;

          results.push({
            cumulativeProfit: overallCumulativeProfit,
            date,
            spotPrice,
            strikePrice: nearestStrikePrice,
            expiry,
            lotSize,
            stopLossPercentage,
            entryPrice: ceEntryPrice + peEntryPrice,
            exitPrice: ceExitPrice + peExitPrice,
            profitLoss: totalProfitLoss,
            transactions: [
              {
                date,
                entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                exitTime: ceExitTime,
                type: 'CE',
                strikePrice: nearestStrikePrice,
                qty: lotSize,
                entryPrice: ceEntryPrice,
                exitPrice: ceExitPrice,
                stopLoss: ceStopLoss,
                vix: vixValue,
                profitLoss: ceProfitLoss,
              },
              {
                date,
                entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                exitTime: peExitTime,
                type: 'PE',
                strikePrice: nearestStrikePrice,
                qty: lotSize,
                entryPrice: peEntryPrice,
                exitPrice: peExitPrice,
                stopLoss: peStopLoss,
                vix: vixValue,
                profitLoss: peProfitLoss,
              },
            ],
          });
        } catch (error) {
          console.error(`Error processing date ${date}:`, error.message);
        }
      }

      res.status(200).json({
        status: 'success',
        data: results.reverse(),
      });
    } catch (error) {
      console.error('Error creating short straddle strategy:', error.message);
      next(error);
    }
  }
);

// controller with Week Days
exports.createOTMShortStraddleMultiDayByDays = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        entryTimes, // Array of entry times
        exitTimes, // Array of exit times
        otmOffset = 0, // Default to 0 for ATM calculation
        stockSymbol,
        selectedDays, // Array of days (e.g., ["MON", "TUE"])
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
        !Array.isArray(selectedDays) ||
        selectedDays.length === 0
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, entryTimes, exitTimes, stockSymbol, otmOffset, and selectedDays.',
            400
          )
        );
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided.', 400));
      }

      let results = [];
      let overallCumulativeProfit = 0;
      let totalTradeDays = 0;
      let noOfProfitableDays = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        const dayOfWeek = currentDate.format('ddd').toUpperCase();

        if (!selectedDays.includes(dayOfWeek)) {
          console.log(
            `Skipping ${date} (${dayOfWeek}) as it's not in selected days.`
          );
          continue;
        }

        console.log(`Processing date: ${date}`);

        let dailyTransactions = [];
        let dailyProfitLoss = 0;
        let spotPrice = null;

        for (let i = 0; i < entryTimes.length; i++) {
          const entryTime = entryTimes[i];
          const exitTime = exitTimes[i];

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
                `No spot data found for ${stockSymbol} on ${date}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            spotPrice = spotData.open;
            const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
            const atmStrikePrice =
              Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

            const otmCEPrice = atmStrikePrice + otmOffset;
            const otmPEPrice = atmStrikePrice - otmOffset;

            const entryOptions = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              strikePrice: { $in: [otmCEPrice, otmPEPrice] },
              expiry,
            });

            const callOptionEntry = entryOptions.find(
              (opt) => opt.optionType === 'CE' && opt.strikePrice === otmCEPrice
            );
            const putOptionEntry = entryOptions.find(
              (opt) => opt.optionType === 'PE' && opt.strikePrice === otmPEPrice
            );

            if (!callOptionEntry || !putOptionEntry) {
              console.warn(
                `Options data not found for CE: ${otmCEPrice}, PE: ${otmPEPrice}, expiry: ${expiry}. Skipping entry at ${entryTime}.`
              );
              continue;
            }

            const ceEntryPrice = callOptionEntry.open;
            const peEntryPrice = putOptionEntry.open;

            const ceStopLoss =
              ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
            const peStopLoss =
              peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

            let ceExitPrice = ceEntryPrice;
            let peExitPrice = peEntryPrice;

            const ceExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: otmCEPrice,
              expiry,
              optionType: 'CE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            const peExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: otmPEPrice,
              expiry,
              optionType: 'PE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
            let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

            for (const candle of ceExitData) {
              if (candle.high >= ceStopLoss) {
                ceExitPrice = ceStopLoss;
                ceExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              ceExitPrice = candle.close;
            }

            for (const candle of peExitData) {
              if (candle.high >= peStopLoss) {
                peExitPrice = peStopLoss;
                peExitTime = moment(candle.datetime).format(
                  'YYYY-MM-DD HH:mm:ss'
                );
                break;
              }
              peExitPrice = candle.close;
            }

            const vixData = await HistoricalIndicesData.findOne({
              timeInterval,
              datetime: entryTimeStr,
              stockSymbol: 'India VIX',
            });

            const vixValue = vixData ? vixData.close : null;

            const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
            const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
            const totalProfitLoss = ceProfitLoss + peProfitLoss;

            dailyProfitLoss += totalProfitLoss;

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: ceExitTime,
              type: 'CE',
              strikePrice: otmCEPrice,
              qty: lotSize,
              entryPrice: ceEntryPrice,
              exitPrice: ceExitPrice,
              stopLoss: ceStopLoss,
              vix: vixValue,
              profitLoss: ceProfitLoss,
            });

            dailyTransactions.push({
              date,
              entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
              exitTime: peExitTime,
              type: 'PE',
              strikePrice: otmPEPrice,
              qty: lotSize,
              entryPrice: peEntryPrice,
              exitPrice: peExitPrice,
              stopLoss: peStopLoss,
              vix: vixValue,
              profitLoss: peProfitLoss,
            });
          } catch (error) {
            console.error(
              `Error processing date ${date} for entry ${entryTime}:`,
              error.message
            );
          }
        }

        if (dailyTransactions.length > 0) {
          overallCumulativeProfit += dailyProfitLoss;
          totalTradeDays++;

          if (dailyProfitLoss > 0) {
            noOfProfitableDays++;
          }

          results.push({
            cumulativeProfit: overallCumulativeProfit,
            date,
            spotPrice,
            expiry,
            lotSize,
            stopLossPercentage,
            profitLoss: dailyProfitLoss,
            transactions: dailyTransactions,
          });
        }
      }

      res.status(200).json({
        status: 'success',
        totalTradeDays,
        noOfProfitableDays,
        data: results.reverse(),
      });
    } catch (error) {
      console.error(
        'Error creating multi-day OTM short straddle with day filtering:',
        error.message
      );
      next(error);
    }
  }
);

// controller with Week Days GRID Search Results
exports.saveGridSearchForSelectedWeekDays = expressAsyncHandler(
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
        selectedDays, // Array of selected weekdays like ["MON", "TUE"]
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
        !Array.isArray(selectedDays) ||
        selectedDays.length === 0
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, searchType, selectedDays, and non-empty entryTimes and exitTimes arrays.',
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
          )}-${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}`;
          let results = [];
          let overallCumulativeProfit = 0;

          for (
            let currentDate = fromDateMoment.clone();
            currentDate.isSameOrBefore(toDateMoment);
            currentDate.add(1, 'day')
          ) {
            const date = currentDate.format('YYYY-MM-DD');
            const dayOfWeek = currentDate.format('ddd').toUpperCase();

            if (!selectedDays.includes(dayOfWeek)) {
              console.log(
                `Skipping ${date} (${dayOfWeek}) as it's not in selected days.`
              );
              continue;
            }

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

              const spotPrice = spotData.open;
              const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
              const nearestStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              const entryOptions = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: nearestStrikePrice,
                expiry,
              });

              const callOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionEntry = entryOptions.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionEntry || !putOptionEntry) {
                console.warn(
                  `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const ceEntryPrice = callOptionEntry.open;
              const peEntryPrice = putOptionEntry.open;

              const ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              const peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              for (const candle of ceExitData) {
                if (candle.high >= ceStopLoss) {
                  ceExitPrice = ceStopLoss;
                  ceExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                ceExitPrice = candle.close;
              }

              for (const candle of peExitData) {
                if (candle.high >= peStopLoss) {
                  peExitPrice = peStopLoss;
                  peExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                peExitPrice = candle.close;
              }

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: nearestStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
                transactions: [
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: ceExitTime,
                    type: 'CE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: ceEntryPrice,
                    exitPrice: ceExitPrice,
                    stopLoss: ceStopLoss,
                    vix: vixValue,
                    profitLoss: ceProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: peExitTime,
                    type: 'PE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: peEntryPrice,
                    exitPrice: peExitPrice,
                    stopLoss: peStopLoss,
                    vix: vixValue,
                    profitLoss: peProfitLoss,
                  },
                ],
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          totalTradeDays = results.length;
          noOfProfitableDays = results.filter(
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

      res.status(200).json({
        status: 'success',
      });
    } catch (error) {
      console.error(
        'Error performing grid search for selected weekdays:',
        error.message
      );
      next(error);
    }
  }
);

exports.saveGridSearchForSelectedWeekDaysStrike = expressAsyncHandler(
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
        selectedDays, // Array of selected weekdays like ["MON", "TUE"]
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
        !Array.isArray(selectedDays) ||
        selectedDays.length === 0
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, searchType, selectedDays, and non-empty entryTimes and exitTimes arrays.',
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
          )}-${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}`;
          let results = [];
          let overallCumulativeProfit = 0;

          for (
            let currentDate = fromDateMoment.clone();
            currentDate.isSameOrBefore(toDateMoment);
            currentDate.add(1, 'day')
          ) {
            const date = currentDate.format('YYYY-MM-DD');
            const dayOfWeek = currentDate.format('ddd').toUpperCase();

            if (!selectedDays.includes(dayOfWeek)) {
              console.log(
                `Skipping ${date} (${dayOfWeek}) as it's not in selected days.`
              );
              continue;
            }

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
              const baseStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              const entryOptionsBase = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: baseStrikePrice,
                expiry,
              });

              const callOptionBase = entryOptionsBase.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionBase = entryOptionsBase.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionBase || !putOptionBase) {
                console.warn(
                  `Options data not found for base strike: ${baseStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const adjustedStrikePrice =
                baseStrikePrice + (callOptionBase.close - putOptionBase.close);

              const nearestStrikePrice =
                Math.round(adjustedStrikePrice / strikePriceInterval) *
                strikePriceInterval;

              const entryOptionsNearest = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: nearestStrikePrice,
                expiry,
              });

              const callOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionNearest || !putOptionNearest) {
                console.warn(
                  `Options data not found for nearest strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const ceEntryPrice = callOptionNearest.close;
              const peEntryPrice = putOptionNearest.close;

              const ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              const peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              for (const candle of ceExitData) {
                if (candle.high >= ceStopLoss) {
                  ceExitPrice = ceStopLoss;
                  ceExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                ceExitPrice = candle.close;
              }

              for (const candle of peExitData) {
                if (candle.high >= peStopLoss) {
                  peExitPrice = peStopLoss;
                  peExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  break;
                }
                peExitPrice = candle.close;
              }

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: nearestStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
                transactions: [
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: ceExitTime,
                    type: 'CE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: ceEntryPrice,
                    exitPrice: ceExitPrice,
                    stopLoss: ceStopLoss,
                    vix: vixValue,
                    profitLoss: ceProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: peExitTime,
                    type: 'PE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: peEntryPrice,
                    exitPrice: peExitPrice,
                    stopLoss: peStopLoss,
                    vix: vixValue,
                    profitLoss: peProfitLoss,
                  },
                ],
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          totalTradeDays = results.length;
          noOfProfitableDays = results.filter(
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

      res.status(200).json({
        status: 'success',
        data: allResults,
      });
    } catch (error) {
      console.error(
        'Error performing grid search for selected weekdays:',
        error.message
      );
      next(error);
    }
  }
);

// trailing stoploss
exports.TslGridSearchAndSaveShortStraddleStrike = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        stopLossPercentage,
        trailingStopLossPercentage,
        entryTimes,
        exitTimes,
        stockSymbol,
        searchType,
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage ||
        !trailingStopLossPercentage ||
        !Array.isArray(entryTimes) ||
        !Array.isArray(exitTimes) ||
        entryTimes.length === 0 ||
        exitTimes.length === 0 ||
        !stockSymbol ||
        !searchType
      ) {
        return next(
          new AppError(
            'Please provide valid input parameters, including trailingStopLossPercentage.',
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
          )}-${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}`;
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
              const baseStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              const entryOptionsNearest = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: baseStrikePrice,
                expiry,
              });

              const callOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionNearest || !putOptionNearest) {
                console.warn(
                  `Options data not found for nearest strike: ${baseStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              const ceEntryPrice = callOptionNearest.close;
              const peEntryPrice = putOptionNearest.close;

              const ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              const peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let trailingCeStopLoss = ceStopLoss;
              let trailingPeStopLoss = peStopLoss;

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: baseStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: baseStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              let ceHitStopLoss = false;
              let peHitStopLoss = false;

              for (
                let i = 0;
                i < ceExitData.length || i < peExitData.length;
                i++
              ) {
                if (ceExitData[i] && !ceHitStopLoss) {
                  const candle = ceExitData[i];
                  if (candle.high >= trailingCeStopLoss) {
                    ceExitPrice = trailingCeStopLoss;
                    ceExitTime = moment(candle.datetime).format(
                      'YYYY-MM-DD HH:mm:ss'
                    );
                    ceHitStopLoss = true;
                  } else {
                    trailingCeStopLoss = Math.min(
                      trailingCeStopLoss,
                      candle.close +
                        candle.close * (trailingStopLossPercentage / 100)
                    );
                    ceExitPrice = candle.close;
                  }
                }

                if (peExitData[i] && !peHitStopLoss) {
                  const candle = peExitData[i];
                  if (candle.high >= trailingPeStopLoss) {
                    peExitPrice = trailingPeStopLoss;
                    peExitTime = moment(candle.datetime).format(
                      'YYYY-MM-DD HH:mm:ss'
                    );
                    peHitStopLoss = true;
                  } else {
                    trailingPeStopLoss = Math.min(
                      trailingPeStopLoss,
                      candle.close +
                        candle.close * (trailingStopLossPercentage / 100)
                    );
                    peExitPrice = candle.close;
                  }
                }

                if (ceHitStopLoss && peHitStopLoss) {
                  break; // Both legs hit stop-loss, exit loop
                }
              }

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: baseStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                trailingStopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          totalTradeDays = results.length;
          noOfProfitableDays = results.filter(
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
            trailingStopLossPercentage,
            searchType,
            entryTime,
            exitTime,
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

      res.status(200).json({
        status: 'success',
      });
    } catch (error) {
      console.error(
        'Error performing grid search for short straddle:',
        error.message
      );
      next(error);
    }
  }
);

// exports.vixContinuousSMMAStraddle = expressAsyncHandler(
//   async (req, res, next) => {
//     try {
//       const {
//         timeInterval,
//         smmaPeriod,
//         fromDate,
//         toDate,
//         expiry,
//         lotSize,
//         stopLossPercentage,
//         stockSymbol,
//       } = req.body;

//       // Validate required parameters
//       if (
//         !timeInterval ||
//         !smmaPeriod ||
//         !fromDate ||
//         !toDate ||
//         !expiry ||
//         !lotSize ||
//         !stopLossPercentage ||
//         !stockSymbol
//       ) {
//         return next(new AppError('Missing required parameters', 400));
//       }

//       // Validate date format
//       const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
//       const toDateMoment = moment(toDate, 'YYYY-MM-DD');
//       if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
//         return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
//       }

//       const allResults = [];
//       let cumulativeProfit = 0;
//       let totalTradeDays = 0;
//       let noOfProfitableDays = 0;

//       // Loop through each day in the date range
//       for (
//         let currentDate = fromDateMoment.clone();
//         currentDate.isSameOrBefore(toDateMoment);
//         currentDate.add(1, 'day')
//       ) {
//         const date = currentDate.format('YYYY-MM-DD');
//         console.log(
//           `📅 Processing date: ${date} | SMMA-${smmaPeriod} | Interval: ${timeInterval}`
//         );

//         try {
//           // Fetch VIX historical data for the given date
//           const vixHistoricalData = await HistoricalIndicesData.find({
//             timeInterval,
//             stockSymbol: 'India VIX',
//             datetime: {
//               $gte: currentDate
//                 .clone()
//                 .tz('Asia/Kolkata')
//                 .startOf('day')
//                 .format(),
//               $lte: currentDate
//                 .clone()
//                 .tz('Asia/Kolkata')
//                 .endOf('day')
//                 .format(),
//             },
//           }).sort({ datetime: 1 });

//           console.log(
//             `📊 Fetched ${vixHistoricalData.length} VIX records for ${date}`
//           );

//           // Check if there's enough data for SMMA calculation
//           if (vixHistoricalData.length < smmaPeriod) {
//             console.warn(
//               `⚠️ Not enough VIX data for SMMA-${smmaPeriod}. Skipping ${date}`
//             );
//             continue;
//           }

//           let entryTime = null;
//           let entryPrice = null;
//           let smmaValues = [];
//           let smmaPrev = null;

//           // Calculate SMMA and identify entry point
//           for (let i = 0; i < vixHistoricalData.length; i++) {
//             const currentClose = vixHistoricalData[i].close;

//             if (i < smmaPeriod) {
//               // Calculate initial SMMA as the average of the first `smmaPeriod` values
//               smmaPrev =
//                 vixHistoricalData
//                   .slice(0, smmaPeriod)
//                   .reduce((sum, v) => sum + v.close, 0) / smmaPeriod;
//             } else {
//               // Update SMMA using the formula: SMMA = (Previous SMMA * (Period - 1) + Current Close) / Period
//               smmaPrev =
//                 (smmaPrev * (smmaPeriod - 1) + currentClose) / smmaPeriod;
//             }

//             smmaValues.push({
//               datetime: vixHistoricalData[i].datetime,
//               smma: smmaPrev,
//             });

//             console.log(
//               `🔄 [${vixHistoricalData[i].datetime}] VIX Close: ${currentClose} | SMMA: ${smmaPrev}`
//             );

//             // Entry condition: VIX close < SMMA
//             if (currentClose < smmaPrev) {
//               entryTime = vixHistoricalData[i].datetime;
//               entryPrice = currentClose;
//               console.log(
//                 `✅ Entry Triggered at ${entryTime} (VIX: ${currentClose} < SMMA: ${smmaPrev})`
//               );
//               break;
//             }
//           }

//           // Skip if no entry point is found
//           if (!entryTime) {
//             console.warn(`❌ No entry point found for ${date}. Skipping.`);
//             continue;
//           }

//           // Fetch spot price at entry time
//           const spotData = await HistoricalIndicesData.findOne({
//             timeInterval,
//             datetime: entryTime,
//             stockSymbol,
//           });

//           if (!spotData) {
//             console.warn(`⚠️ No spot price data for ${date}. Skipping.`);
//             continue;
//           }

//           const spotPrice = spotData.close;
//           const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
//           const baseStrikePrice =
//             Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

//           // Fetch option prices at entry time
//           const entryOptions = await HistoricalOptionData.find({
//             timeInterval,
//             datetime: entryTime,
//             strikePrice: baseStrikePrice,
//             expiry,
//           });

//           const callOption = entryOptions.find(
//             (opt) => opt.optionType === 'CE'
//           );
//           const putOption = entryOptions.find((opt) => opt.optionType === 'PE');

//           if (!callOption || !putOption) {
//             console.warn(`⚠️ No option prices found for ${date}. Skipping.`);
//             continue;
//           }

//           const ceEntryPrice = callOption.close;
//           const peEntryPrice = putOption.close;
//           const ceStopLoss = ceEntryPrice * (1 + stopLossPercentage / 100);
//           const peStopLoss = peEntryPrice * (1 + stopLossPercentage / 100);

//           let ceExitPrice = ceEntryPrice;
//           let peExitPrice = peEntryPrice;
//           let ceExitTime = null;
//           let peExitTime = null;

//           console.log(
//             `💰 CE Entry Price: ${ceEntryPrice}, PE Entry Price: ${peEntryPrice}`
//           );

//           // Final exit time (15:10)
//           const exitTime = moment(`${date} 15:10`, 'YYYY-MM-DD HH:mm')
//             .tz('Asia/Kolkata')
//             .format();

//           // Check exit conditions for each candle after entry
//           for (const candle of smmaValues.filter(
//             (c) => c.datetime > entryTime
//           )) {
//             const vixCandle = vixHistoricalData.find(
//               (c) => c.datetime === candle.datetime
//             );
//             if (!vixCandle) continue;

//             console.log(
//               `🔍 Checking exit condition at ${candle.datetime} | VIX: ${vixCandle.close} | SMMA: ${candle.smma}`
//             );

//             // Stop-Loss Check
//             if (
//               vixCandle.close >= ceStopLoss ||
//               vixCandle.close >= peStopLoss
//             ) {
//               console.log(
//                 `⚠️ Stop-Loss Hit at ${candle.datetime}. Exiting Trade.`
//               );
//               ceExitPrice = ceStopLoss;
//               peExitPrice = peStopLoss;
//               ceExitTime = candle.datetime;
//               peExitTime = candle.datetime;
//               break;
//             }

//             // Exit if VIX closes above SMMA
//             if (vixCandle.close > candle.smma) {
//               console.log(
//                 `🚪 Exit triggered at ${candle.datetime} (VIX: ${vixCandle.close} > SMMA: ${candle.smma})`
//               );
//               ceExitPrice = ceEntryPrice;
//               peExitPrice = peEntryPrice;
//               ceExitTime = candle.datetime;
//               peExitTime = candle.datetime;
//               break;
//             }
//           }

//           // Final Exit at 15:10 if no prior exit
//           if (!ceExitTime) {
//             ceExitTime = exitTime;
//             peExitTime = exitTime;
//           }

//           // Calculate profit/loss
//           const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
//           const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
//           const totalProfitLoss = ceProfitLoss + peProfitLoss;

//           cumulativeProfit += totalProfitLoss;
//           totalTradeDays++;
//           if (totalProfitLoss > 0) noOfProfitableDays++;

//           allResults.push({
//             date,
//             entryTime,
//             exitTime,
//             spotPrice,
//             strikePrice: baseStrikePrice,
//             ceEntryPrice,
//             peEntryPrice,
//             ceExitPrice,
//             peExitPrice,
//             ceProfitLoss,
//             peProfitLoss,
//             totalProfitLoss,
//             cumulativeProfit,
//           });

//           console.log(
//             `📈 Trade Completed | Date: ${date} | P/L: ${totalProfitLoss} | Cumulative P/L: ${cumulativeProfit}`
//           );
//         } catch (error) {
//           console.error(`❌ Error processing ${date}:`, error.message);
//         }
//       }

//       res.status(200).json({
//         status: 'success',
//         totalTradeDays,
//         noOfProfitableDays,
//         data: allResults,
//       });
//     } catch (error) {
//       console.error('❌ Error executing strategy:', error.message);
//       next(error);
//     }
//   }
// );

exports.createShortStraddle = expressAsyncHandler(async (req, res, next) => {
  try {
    const {
      stockSymbol,
      timeInterval,
      fromDate,
      toDate,
      entryTime,
      exitTime,
      expiry,
      lotSize,
      stopLossPercentage,
    } = req.body;

    if (!timeInterval || !fromDate || !toDate || !stockSymbol) {
      return next(
        new AppError(
          'Please provide valid timeInterval, fromDate, toDate, stockSymbol, and other required fields.',
          400
        )
      );
    }

    // Validate date format
    const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
    const toDateMoment = moment(toDate, 'YYYY-MM-DD');

    if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
      return next(new AppError('Invalid date format. Use YYYY-MM-DD.', 400));
    }

    const allResults = [];
    let results = [];
    let overallCumulativeProfit = 0;

    for (
      let currentDate = fromDateMoment.clone();
      currentDate.isSameOrBefore(toDateMoment);
      currentDate.add(1, 'day')
    ) {
      const date = currentDate.format('YYYY-MM-DD');

      console.log(`Processing date: ${date}`);

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

      if (!entryTimeIST.isValid() || !exitTimeIST.isValid()) {
        return next(new AppError('Invalid time format. Use HH:mm.', 400));
      }

      const entryTimeStr = entryTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');
      const exitTimeStr = exitTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');

      // Fetch Spot Price Data
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
      const historicalData = await HistoricalIndicesData.find({
        timeInterval,
        datetime: { $lte: entryTimeStr },
        stockSymbol,
      })
        .sort({ datetime: -1 })
        .limit(20); // Fetch last 20 candles for indicators

      if (historicalData.length < 14) {
        console.warn(
          `Not enough historical data for indicators. Skipping ${date}`
        );
        continue;
      }

      const closes = historicalData.map((data) => data.close).reverse();
      const highPrices = historicalData.map((data) => data.high).reverse();
      const lowPrices = historicalData.map((data) => data.low).reverse();

      // Calculate RSI
      const rsiValues = RSI.calculate({ values: closes, period: 14 });
      const rsi = rsiValues[rsiValues.length - 1];

      // Calculate EMA
      const emaValues = EMA.calculate({ values: closes, period: 20 });
      const ema = emaValues[emaValues.length - 1];

      // Calculate Bollinger Bands
      const bbValues = BollingerBands.calculate({
        values: closes,
        period: 20,
        stdDev: 2,
      });
      const bb = bbValues[bbValues.length - 1];

      // Calculate ATR
      const atrValues = ATR.calculate({
        high: highPrices,
        low: lowPrices,
        close: closes,
        period: 14,
      });
      const atr = atrValues[atrValues.length - 1];

      // VIX Data
      const vixData = await HistoricalIndicesData.findOne({
        timeInterval,
        datetime: entryTimeStr,
        stockSymbol: 'India VIX',
      });
      const vixValue = vixData ? vixData.close : null;

      // **Entry Conditions**
      if (rsi < 30 || rsi > 70) {
        console.log(`Skipping trade on ${date} due to RSI filter: ${rsi}`);
        continue;
      }

      if (spotPrice < ema) {
        console.log(
          `Skipping trade on ${date} as spot price is below EMA: ${ema}`
        );
        continue;
      }

      if (bb.upper - bb.lower > 2 * atr) {
        console.log(
          `Skipping trade on ${date} due to high Bollinger Band width.`
        );
        continue;
      }

      console.log(
        `Trade entered on ${date} with RSI: ${rsi}, EMA: ${ema}, ATR: ${atr}`
      );

      // Entry and Exit Price Logic
      const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
      const nearestStrikePrice =
        Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

      const entryOptions = await HistoricalOptionData.find({
        timeInterval,
        datetime: entryTimeStr,
        strikePrice: nearestStrikePrice,
        expiry,
      });

      const ceOption = entryOptions.find((opt) => opt.optionType === 'CE');
      const peOption = entryOptions.find((opt) => opt.optionType === 'PE');

      if (!ceOption || !peOption) {
        console.warn(
          `Options data not found for ${nearestStrikePrice}. Skipping.`
        );
        continue;
      }

      const ceEntryPrice = ceOption.close;
      const peEntryPrice = peOption.close;

      const totalEntryPrice = ceEntryPrice + peEntryPrice;
      const stopLoss = totalEntryPrice + (atr * stopLossPercentage) / 100;

      // Simulated Exit (You can add SL/Target exit logic here)

      const profitLoss = -stopLoss; // Placeholder for now

      overallCumulativeProfit += profitLoss;

      results.push({
        date,
        spotPrice,
        rsi,
        ema,
        atr,
        vix: vixValue,
        profitLoss,
        cumulativeProfit: overallCumulativeProfit,
      });

      console.log(`Trade executed on ${date}, Profit/Loss: ${profitLoss}`);
    }

    res.status(200).json({ status: 'success', data: results });
  } catch (error) {
    console.error('❌ Error executing strategy:', error.message);
    next(error);
  }
});

exports.gridSearchAndSaveShortStraddleStrikeAdjust = expressAsyncHandler(
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
        !searchType
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, searchType, and non-empty entryTimes and exitTimes arrays.',
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
          )}-${fromDate}-${toDate}-${expiry}-${timeInterval}-${entryTime}-${exitTime}`;
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
                  `Spot data NOT FOUND for ${stockSymbol} at ${entryTimeStr}`
                );
                continue;
              } else {
                console.log(
                  `Spot data fetched: ${spotData.close} for ${entryTimeStr}`
                );
              }

              const spotPrice = spotData.close;
              const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
              const baseStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              // Fetch premiums for the base strike price
              const entryOptionsBase = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: baseStrikePrice,
                expiry,
              });

              const callOptionBase = entryOptionsBase.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionBase = entryOptionsBase.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionBase || !putOptionBase) {
                console.warn(
                  `Options data not found for base strike: ${baseStrikePrice}, expiry: ${expiry}. Skipping.`
                );
                continue;
              }

              // Calculate adjusted strike price
              const adjustedStrikePrice =
                baseStrikePrice + (callOptionBase.close - putOptionBase.close);

              // Determine nearest strike price
              const nearestStrikePrice =
                Math.round(adjustedStrikePrice / strikePriceInterval) *
                strikePriceInterval;

              // Fetch premiums for the nearest strike price
              const entryOptionsNearest = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                strikePrice: nearestStrikePrice,
                expiry,
              });

              const callOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'CE'
              );
              const putOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionNearest || !putOptionNearest) {
                console.warn(
                  `Options data NOT FOUND for ${baseStrikePrice}, expiry: ${expiry} at ${entryTimeStr}`
                );
                continue;
              } else {
                console.log(
                  `Option premiums found -> CE: ${callOptionNearest.close}, PE: ${putOptionNearest.close} for ${entryTimeStr}`
                );
              }

              let ceEntryPrice = callOptionNearest.close;
              let peEntryPrice = putOptionNearest.close;

              let ceStopLoss =
                ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
              let peStopLoss =
                peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

              let ceExitPrice = ceEntryPrice;
              let peExitPrice = peEntryPrice;

              let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
              let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

              let ceHitStopLoss = false;
              let peHitStopLoss = false;
              let reEntryCount = 0;

              const ceExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: nearestStrikePrice,
                expiry,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              if (ceExitData.length === 0 || peExitData.length === 0) {
                console.warn(
                  `No exit data found for ${baseStrikePrice}, expiry: ${expiry} between ${entryTimeStr} and ${exitTimeStr}`
                );
                continue;
              }

              for (const candle of ceExitData) {
                if (!ceHitStopLoss && candle.high >= ceStopLoss) {
                  ceExitPrice = ceStopLoss;
                  ceExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  ceHitStopLoss = true;
                } else if (ceHitStopLoss && candle.close >= ceEntryPrice) {
                  reEntryCount++;
                  ceEntryPrice = candle.close;
                  ceStopLoss =
                    ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
                  ceHitStopLoss = false;
                } else {
                  ceExitPrice = candle.close;
                }
              }

              for (const candle of peExitData) {
                if (!peHitStopLoss && candle.high >= peStopLoss) {
                  peExitPrice = peStopLoss;
                  peExitTime = moment(candle.datetime).format(
                    'YYYY-MM-DD HH:mm:ss'
                  );
                  peHitStopLoss = true;
                } else if (peHitStopLoss && candle.close >= peEntryPrice) {
                  reEntryCount++;
                  peEntryPrice = candle.close;
                  peStopLoss =
                    peEntryPrice + peEntryPrice * (stopLossPercentage / 100);
                  peHitStopLoss = false;
                } else {
                  peExitPrice = candle.close;
                }
              }

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;

              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
              const totalProfitLoss = ceProfitLoss + peProfitLoss;

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: nearestStrikePrice,
                expiry,
                lotSize,
                stopLossPercentage,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
                reEntryCount,
                transactions: [
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: ceExitTime,
                    type: 'CE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: ceEntryPrice,
                    exitPrice: ceExitPrice,
                    stopLoss: ceStopLoss,
                    vix: vixValue,
                    profitLoss: ceProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: peExitTime,
                    type: 'PE',
                    strikePrice: nearestStrikePrice,
                    qty: lotSize,
                    entryPrice: peEntryPrice,
                    exitPrice: peExitPrice,
                    stopLoss: peStopLoss,
                    vix: vixValue,
                    profitLoss: peProfitLoss,
                  },
                ],
              });
            } catch (error) {
              console.error(`Error processing date ${date}:`, error.message);
            }
          }

          totalTradeDays = results.length;
          noOfProfitableDays = results.filter(
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
            totalTradeDays,
            noOfProfitableDays,
            cumulativeProfit: overallCumulativeProfit,
            results: results.reverse(),
          };

          allResults.push(strategy);
        }
      }

      res.status(200).json({
        allResults,
        status: 'success',
      });
    } catch (error) {
      console.error(
        'Error performing grid search for short straddle:',
        error.message
      );
      next(error);
    }
  }
);
