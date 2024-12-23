const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');
const ShortStraddleStrategy = require('../models/Straddle');

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

//Working
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
        stockSymbol, // Added stockSymbol dynamically
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
        !stockSymbol // Validate stockSymbol
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, and non-empty entryTimes and exitTimes arrays.',
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

          const strategyId = `${stockSymbol.replace(
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

            let ceExitTime, peExitTime;

            try {
              const spotData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol, // Use the dynamic stockSymbol
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
            stockSymbol,
            expiry,
            lotSize,
            stopLossPercentage,
            stockSymbol,
            entryTime,
            exitTime,
            cumulativeProfit: overallCumulativeProfit,
            results: results.reverse(),
          };

          allResults.push(strategy);

          // Save to database using upsert
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
