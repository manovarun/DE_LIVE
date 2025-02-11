const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');
const ShortStrangleStrategy = require('../models/Strangle');

// Create OTM Short Strangle Multi-Day Multi-Entry Exit at the same time, updated with the new strike price calculation
exports.createOTMShortStrangleMultiDayMultiExitStrike = expressAsyncHandler(
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

      const allResults = [];
      let strategy = [];

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
                  `No spot data found for ${stockSymbol} on ${date}. Skipping entry at ${entryTime}.`
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

              const adjustedStrikePrice =
                baseStrikePrice + (callOptionBase.close - putOptionBase.close);

              const nearestStrikePrice =
                Math.round(adjustedStrikePrice / strikePriceInterval) *
                strikePriceInterval;

              const otmCEStrikePrice = nearestStrikePrice + otmOffset;
              const otmPEStrikePrice = nearestStrikePrice - otmOffset;

              const entryOptionsNearest = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                expiry,
                $or: [
                  { strikePrice: otmCEStrikePrice, optionType: 'CE' },
                  { strikePrice: otmPEStrikePrice, optionType: 'PE' },
                ],
              });

              console.log(entryOptionsNearest);
              const callOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'CE'
              );

              const putOptionNearest = entryOptionsNearest.find(
                (opt) => opt.optionType === 'PE'
              );

              if (!callOptionNearest || !putOptionNearest) {
                console.warn(
                  `Options data not found for CE: ${otmCEStrikePrice}, PE: ${otmPEStrikePrice}, expiry: ${expiry}. Skipping entry at ${entryTime}.`
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
                strikePrice: otmCEStrikePrice,
                expiry,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const peExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: otmPEStrikePrice,
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
                    otmCEStrikePrice,
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
                    otmPEStrikePrice,
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
              console.error(
                `Error processing date ${date} for entry ${entryTime}:`,
                error.message
              );
            }

            totalTradeDays = results.length;
            noOfProfitableDays = results.filter(
              (day) => day.profitLoss > 0
            ).length;

            strategy = {
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

            await ShortStrangleStrategy.updateOne(
              { strategyId },
              { $set: strategy },
              { upsert: true }
            );
          }
        }
      }

      res.status(200).json({
        status: 'success',
        strategy,
      });
    } catch (error) {
      console.error(
        'Error creating multi-day OTM short strangle with multiple entries and exits:',
        error.message
      );
      next(error);
    }
  }
);

exports.createOTMShortStrangleMultiDayMultiExitStrikeIronCondor =
  expressAsyncHandler(async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiry,
        lotSize,
        entryTimes,
        exitTimes,
        otmOffset = 0,
        stockSymbol,
        stockName,
        searchType,
        wingWidth = 100,
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !Array.isArray(entryTimes) ||
        !Array.isArray(exitTimes) ||
        entryTimes.length === 0 ||
        exitTimes.length === 0 ||
        !stockSymbol ||
        !stockName ||
        !searchType
      ) {
        return next(new AppError('Missing required fields.', 400));
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format.', 400));
      }

      const allResults = [];

      for (const entryTime of entryTimes) {
        for (const exitTime of exitTimes) {
          if (
            moment(exitTime, 'HH:mm').isSameOrBefore(moment(entryTime, 'HH:mm'))
          ) {
            console.warn(
              `Skipping invalid time: Entry ${entryTime}, Exit ${exitTime}`
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
              `Processing: ${date}, Entry: ${entryTime}, Exit: ${exitTime}`
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
                  `No spot data for ${stockSymbol} on ${date}. Skipping.`
                );
                continue;
              }

              const spotPrice = spotData.close;

              const strikePriceInterval =
                stockSymbol === 'Nifty 50' ||
                stockSymbol === 'Nifty Fin Service'
                  ? 50
                  : 100;

              const baseStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              // 🟢 Define the Strike Prices for the Iron Condor
              const otmCEStrikePrice = baseStrikePrice + otmOffset;
              const otmPEStrikePrice = baseStrikePrice - otmOffset;
              const hedgeCEStrikePrice = otmCEStrikePrice + wingWidth;
              const hedgePEStrikePrice = otmPEStrikePrice - wingWidth;

              // Fetch options data for all 4 legs
              const entryOptions = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                expiry,
                stockName,
                $or: [
                  { strikePrice: otmCEStrikePrice, optionType: 'CE' },
                  { strikePrice: otmPEStrikePrice, optionType: 'PE' },
                  { strikePrice: hedgeCEStrikePrice, optionType: 'CE' },
                  { strikePrice: hedgePEStrikePrice, optionType: 'PE' },
                ],
              });

              const callOptionSell = entryOptions.find(
                (opt) =>
                  opt.optionType === 'CE' &&
                  opt.strikePrice === otmCEStrikePrice
              );
              const putOptionSell = entryOptions.find(
                (opt) =>
                  opt.optionType === 'PE' &&
                  opt.strikePrice === otmPEStrikePrice
              );
              const callOptionBuy = entryOptions.find(
                (opt) =>
                  opt.optionType === 'CE' &&
                  opt.strikePrice === hedgeCEStrikePrice
              );
              const putOptionBuy = entryOptions.find(
                (opt) =>
                  opt.optionType === 'PE' &&
                  opt.strikePrice === hedgePEStrikePrice
              );

              if (
                !callOptionSell ||
                !putOptionSell ||
                !callOptionBuy ||
                !putOptionBuy
              ) {
                console.warn(`Option data missing for ${date}. Skipping.`);
                continue;
              }

              const ceEntryPrice = callOptionSell.close;
              const peEntryPrice = putOptionSell.close;

              const ceHedgeEntryPrice = callOptionBuy.close;
              const peHedgeEntryPrice = putOptionBuy.close;

              // 🟢 Fetch Exit Prices for the main short legs
              const ceExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: otmCEStrikePrice,
                stockName,
                optionType: 'CE',
              });

              const peExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: otmPEStrikePrice,
                stockName,
                optionType: 'PE',
              });

              // 🟢 Fetch Exit Prices for the Hedge Legs
              const hedgeCeExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: hedgeCEStrikePrice,
                stockName,
                optionType: 'CE',
              });

              const hedgePeExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: hedgePEStrikePrice,
                stockName,
                optionType: 'PE',
              });

              const ceExitPrice = ceExitData ? ceExitData.close : ceEntryPrice;
              const peExitPrice = peExitData ? peExitData.close : peEntryPrice;

              const hedgeCeExitPrice = hedgeCeExitData
                ? hedgeCeExitData.close
                : ceHedgeEntryPrice;
              const hedgePeExitPrice = hedgePeExitData
                ? hedgePeExitData.close
                : peHedgeEntryPrice;

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;

              // 🔹 Profit/Loss for Short Legs (Sold options)
              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize; // Sold CE: Profit if price decreases
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize; // Sold PE: Profit if price increases

              // 🔹 Profit/Loss for Hedge Legs (Bought options) - FIXED!
              const hedgeCeProfitLoss =
                (hedgeCeExitPrice - ceHedgeEntryPrice) * lotSize; // Bought CE: Profit if price increases
              const hedgePeProfitLoss =
                (hedgePeExitPrice - peHedgeEntryPrice) * lotSize; // Bought PE: Profit if price decreases

              // 🔹 Net Profit Calculation (Total Credit Received - Exit Costs)
              const totalProfitLoss =
                ceProfitLoss +
                peProfitLoss + // Profit from short legs
                (hedgeCeProfitLoss + hedgePeProfitLoss); // Profit from hedged legs

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: baseStrikePrice,
                expiry,
                lotSize,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
                transactions: [
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'CE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: otmCEStrikePrice,
                    qty: lotSize,
                    entryPrice: ceEntryPrice,
                    exitPrice: ceExitPrice,
                    vix: vixValue,
                    profitLoss: ceProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'PE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: otmPEStrikePrice,
                    qty: lotSize,
                    entryPrice: peEntryPrice,
                    exitPrice: peExitPrice,
                    vix: vixValue,
                    profitLoss: peProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'CE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: hedgeCEStrikePrice,
                    qty: lotSize,
                    entryPrice: ceHedgeEntryPrice,
                    exitPrice: hedgeCeExitPrice,
                    vix: vixValue,
                    profitLoss: hedgeCeProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'PE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: hedgePEStrikePrice,
                    qty: lotSize,
                    entryPrice: peHedgeEntryPrice,
                    exitPrice: hedgePeExitPrice,
                    vix: vixValue,
                    profitLoss: hedgePeProfitLoss,
                  },
                ],
              });
            } catch (error) {
              console.error(
                `Error processing ${date} - ${entryTime}:`,
                error.message
              );
            }
          }

          // 📌 Compute Trade Statistics
          const totalTradeDays = results.length;
          const noOfProfitableDays = results.filter(
            (day) => day.profitLoss > 0
          ).length;

          // 📌 Store the final strategy results
          const strategy = {
            strategyId,
            timeInterval,
            fromDate,
            toDate,
            stockSymbol,
            expiry,
            lotSize,
            searchType,
            entryTime,
            exitTime,
            totalTradeDays,
            noOfProfitableDays,
            cumulativeProfit: overallCumulativeProfit,
            results: results.reverse(),
          };

          await ShortStrangleStrategy.updateOne(
            { strategyId },
            { $set: strategy },
            { upsert: true }
          );

          allResults.push(strategy);
        }
      }

      res.status(200).json({
        status: 'success',
        // strategies: allResults,
      });
    } catch (error) {
      console.error('Error creating strategy:', error.message);
      next(error);
    }
  });

exports.createOTMShortStrangle = expressAsyncHandler(async (req, res, next) => {
  try {
    const {
      timeInterval,
      fromDate,
      toDate,
      expiry,
      lotSize,
      entryTimes,
      exitTimes,
      otmOffset = 0,
      stockSymbol,
      stockName,
      searchType,
      wingWidth = 100,
    } = req.body;

    if (
      !timeInterval ||
      !fromDate ||
      !toDate ||
      !expiry ||
      !lotSize ||
      !Array.isArray(entryTimes) ||
      !Array.isArray(exitTimes) ||
      entryTimes.length === 0 ||
      exitTimes.length === 0 ||
      !stockSymbol ||
      !stockName ||
      !searchType
    ) {
      return next(new AppError('Missing required fields.', 400));
    }

    const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
    const toDateMoment = moment(toDate, 'YYYY-MM-DD');

    if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
      return next(new AppError('Invalid date format.', 400));
    }

    const allResults = [];

    for (const entryTime of entryTimes) {
      for (const exitTime of exitTimes) {
        if (
          moment(exitTime, 'HH:mm').isSameOrBefore(moment(entryTime, 'HH:mm'))
        ) {
          console.warn(
            `Skipping invalid time: Entry ${entryTime}, Exit ${exitTime}`
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
            `Processing: ${date}, Entry: ${entryTime}, Exit: ${exitTime}`
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
                `No spot data for ${stockSymbol} on ${date}. Skipping.`
              );
              continue;
            }

            const spotPrice = spotData.close;

            const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;

            const baseStrikePrice =
              Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

            // 🟢 Define the Strike Prices for the Iron Condor
            const otmCEStrikePrice = baseStrikePrice + otmOffset;
            const otmPEStrikePrice = baseStrikePrice - otmOffset;
            const hedgeCEStrikePrice = otmCEStrikePrice + wingWidth;
            const hedgePEStrikePrice = otmPEStrikePrice - wingWidth;

            // Fetch options data for all 4 legs
            const entryOptions = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              expiry,
              stockName,
              $or: [
                { strikePrice: otmCEStrikePrice, optionType: 'CE' },
                { strikePrice: otmPEStrikePrice, optionType: 'PE' },
                { strikePrice: hedgeCEStrikePrice, optionType: 'CE' },
                { strikePrice: hedgePEStrikePrice, optionType: 'PE' },
              ],
            });

            console.log(entryOptions);

            const callOptionSell = entryOptions.find(
              (opt) =>
                opt.optionType === 'CE' && opt.strikePrice === otmCEStrikePrice
            );
            const putOptionSell = entryOptions.find(
              (opt) =>
                opt.optionType === 'PE' && opt.strikePrice === otmPEStrikePrice
            );
            const callOptionBuy = entryOptions.find(
              (opt) =>
                opt.optionType === 'CE' &&
                opt.strikePrice === hedgeCEStrikePrice
            );
            const putOptionBuy = entryOptions.find(
              (opt) =>
                opt.optionType === 'PE' &&
                opt.strikePrice === hedgePEStrikePrice
            );

            if (
              !callOptionSell ||
              !putOptionSell ||
              !callOptionBuy ||
              !putOptionBuy
            ) {
              console.warn(`Option data missing for ${date}. Skipping.`);
              continue;
            }

            const ceEntryPrice = callOptionSell.close;
            const peEntryPrice = putOptionSell.close;

            const ceHedgeEntryPrice = callOptionBuy.close;
            const peHedgeEntryPrice = putOptionBuy.close;

            // 🟢 Fetch Exit Prices for the main short legs
            const ceExitData = await HistoricalOptionData.findOne({
              timeInterval,
              datetime: exitTimeStr,
              expiry,
              stockName,
              strikePrice: otmCEStrikePrice,
              optionType: 'CE',
            });

            const peExitData = await HistoricalOptionData.findOne({
              timeInterval,
              datetime: exitTimeStr,
              expiry,
              stockName,
              strikePrice: otmPEStrikePrice,
              optionType: 'PE',
            });

            // 🟢 Fetch Exit Prices for the Hedge Legs
            const hedgeCeExitData = await HistoricalOptionData.findOne({
              timeInterval,
              datetime: exitTimeStr,
              expiry,
              stockName,
              strikePrice: hedgeCEStrikePrice,
              optionType: 'CE',
            });

            const hedgePeExitData = await HistoricalOptionData.findOne({
              timeInterval,
              datetime: exitTimeStr,
              expiry,
              stockName,
              strikePrice: hedgePEStrikePrice,
              optionType: 'PE',
            });

            const ceExitPrice = ceExitData ? ceExitData.close : ceEntryPrice;
            const peExitPrice = peExitData ? peExitData.close : peEntryPrice;

            const hedgeCeExitPrice = hedgeCeExitData
              ? hedgeCeExitData.close
              : ceHedgeEntryPrice;
            const hedgePeExitPrice = hedgePeExitData
              ? hedgePeExitData.close
              : peHedgeEntryPrice;

            const vixData = await HistoricalIndicesData.findOne({
              timeInterval,
              datetime: entryTimeStr,
              stockSymbol: 'India VIX',
            });

            const vixValue = vixData ? vixData.close : null;

            // 🔹 Profit/Loss for Short Legs (Sold options)
            const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize; // Sold CE: Profit if price decreases
            const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize; // Sold PE: Profit if price increases

            // 🔹 Profit/Loss for Hedge Legs (Bought options) - FIXED!
            const hedgeCeProfitLoss =
              (hedgeCeExitPrice - ceHedgeEntryPrice) * lotSize; // Bought CE: Profit if price increases
            const hedgePeProfitLoss =
              (hedgePeExitPrice - peHedgeEntryPrice) * lotSize; // Bought PE: Profit if price decreases

            // 🔹 Net Profit Calculation (Total Credit Received - Exit Costs)
            const totalProfitLoss =
              ceProfitLoss +
              peProfitLoss + // Profit from short legs
              (hedgeCeProfitLoss + hedgePeProfitLoss); // Profit from hedged legs

            overallCumulativeProfit += totalProfitLoss;

            results.push({
              date,
              spotPrice,
              strikePrice: baseStrikePrice,
              expiry,
              lotSize,
              entryPrice: ceEntryPrice + peEntryPrice,
              exitPrice: ceExitPrice + peExitPrice,
              profitLoss: totalProfitLoss,
              cumulativeProfit: overallCumulativeProfit,
              transactions: [
                {
                  date,
                  entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  type: 'CE',
                  strikePrice: baseStrikePrice,
                  otmStrikePrice: otmCEStrikePrice,
                  qty: lotSize,
                  entryPrice: ceEntryPrice,
                  exitPrice: ceExitPrice,
                  vix: vixValue,
                  profitLoss: ceProfitLoss,
                },
                {
                  date,
                  entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  type: 'PE',
                  strikePrice: baseStrikePrice,
                  otmStrikePrice: otmPEStrikePrice,
                  qty: lotSize,
                  entryPrice: peEntryPrice,
                  exitPrice: peExitPrice,
                  vix: vixValue,
                  profitLoss: peProfitLoss,
                },
                {
                  date,
                  entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  type: 'CE',
                  strikePrice: baseStrikePrice,
                  otmStrikePrice: hedgeCEStrikePrice,
                  qty: lotSize,
                  entryPrice: ceHedgeEntryPrice,
                  exitPrice: hedgeCeExitPrice,
                  vix: vixValue,
                  profitLoss: hedgeCeProfitLoss,
                },
                {
                  date,
                  entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                  type: 'PE',
                  strikePrice: baseStrikePrice,
                  otmStrikePrice: hedgePEStrikePrice,
                  qty: lotSize,
                  entryPrice: peHedgeEntryPrice,
                  exitPrice: hedgePeExitPrice,
                  vix: vixValue,
                  profitLoss: hedgePeProfitLoss,
                },
              ],
            });
          } catch (error) {
            console.error(
              `Error processing ${date} - ${entryTime}:`,
              error.message
            );
          }
        }

        // 📌 Compute Trade Statistics
        const totalTradeDays = results.length;
        const noOfProfitableDays = results.filter(
          (day) => day.profitLoss > 0
        ).length;

        // 📌 Store the final strategy results
        const strategy = {
          strategyId,
          timeInterval,
          fromDate,
          toDate,
          stockSymbol,
          expiry,
          lotSize,
          searchType,
          entryTime,
          exitTime,
          totalTradeDays,
          noOfProfitableDays,
          cumulativeProfit: overallCumulativeProfit,
          results: results.reverse(),
        };

        // await ShortStrangleStrategy.updateOne(
        //   { strategyId },
        //   { $set: strategy },
        //   { upsert: true }
        // );

        allResults.push(strategy);
      }
    }

    res.status(200).json({
      status: 'success',
      strategies: allResults,
    });
  } catch (error) {
    console.error('Error creating strategy:', error.message);
    next(error);
  }
});

exports.createOTMShortStrangleMultiExpiry = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        lotSize,
        entryTimes,
        exitTimes,
        otmOffset = 0,
        stockSymbol,
        stockName,
        searchType,
        wingWidth = 100,
        expiries, // Array of expiries [{ expiry: "30JAN2025", validUntil: "2025-01-30" }, { expiry: "27FEB2025", validUntil: "2025-02-27" }]
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !lotSize ||
        !Array.isArray(entryTimes) ||
        !Array.isArray(exitTimes) ||
        entryTimes.length === 0 ||
        exitTimes.length === 0 ||
        !stockSymbol ||
        !stockName ||
        !searchType ||
        !Array.isArray(expiries) ||
        expiries.length === 0
      ) {
        return next(new AppError('Missing required fields.', 400));
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format.', 400));
      }

      const allResults = [];

      for (const entryTime of entryTimes) {
        for (const exitTime of exitTimes) {
          if (
            moment(exitTime, 'HH:mm').isSameOrBefore(moment(entryTime, 'HH:mm'))
          ) {
            console.warn(
              `Skipping invalid time: Entry ${entryTime}, Exit ${exitTime}`
            );
            continue;
          }

          const strategyId = `${searchType}-${stockSymbol.replace(
            / /g,
            '_'
          )}-${fromDate}-${toDate}-${timeInterval}-${entryTime}-${exitTime}`;

          let results = [];
          let overallCumulativeProfit = 0;

          for (
            let currentDate = fromDateMoment.clone();
            currentDate.isSameOrBefore(toDateMoment);
            currentDate.add(1, 'day')
          ) {
            const date = currentDate.format('YYYY-MM-DD');

            if (date === fromDate) {
              console.log(`✅ Ensuring ${date} is processed.`);
            }

            // 📌 Select the correct expiry based on the current date
            const activeExpiry =
              expiries.find((exp) =>
                moment(date).isSameOrBefore(moment(exp.validUntil))
              ) || expiries[expiries.length - 1]; // Use last expiry as fallback

            if (!activeExpiry) {
              console.warn(
                `❌ No valid expiry found for ${date}. Using last expiry.`
              );
            }

            const expiry = activeExpiry.expiry;

            console.log(
              `Processing: ${date}, Expiry: ${expiry}, Entry: ${entryTime}, Exit: ${exitTime}`
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
                  `No spot data for ${stockSymbol} on ${date}. Skipping.`
                );
                continue;
              }

              const spotPrice = spotData.close;

              const strikePriceInterval =
                stockSymbol === 'Nifty 50' ||
                stockSymbol === 'Nifty Fin Service'
                  ? 50
                  : 100;

              const baseStrikePrice =
                Math.round(spotPrice / strikePriceInterval) *
                strikePriceInterval;

              // 🟢 Define the Strike Prices for the Iron Condor
              const otmCEStrikePrice = baseStrikePrice + otmOffset;
              const otmPEStrikePrice = baseStrikePrice - otmOffset;
              const hedgeCEStrikePrice = otmCEStrikePrice + wingWidth;
              const hedgePEStrikePrice = otmPEStrikePrice - wingWidth;

              // Fetch options data for all 4 legs
              const entryOptions = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                expiry,
                stockName,
                $or: [
                  { strikePrice: otmCEStrikePrice, optionType: 'CE' },
                  { strikePrice: otmPEStrikePrice, optionType: 'PE' },
                  { strikePrice: hedgeCEStrikePrice, optionType: 'CE' },
                  { strikePrice: hedgePEStrikePrice, optionType: 'PE' },
                ],
              });

              const callOptionSell = entryOptions.find(
                (opt) =>
                  opt.optionType === 'CE' &&
                  opt.strikePrice === otmCEStrikePrice
              );
              const putOptionSell = entryOptions.find(
                (opt) =>
                  opt.optionType === 'PE' &&
                  opt.strikePrice === otmPEStrikePrice
              );
              const callOptionBuy = entryOptions.find(
                (opt) =>
                  opt.optionType === 'CE' &&
                  opt.strikePrice === hedgeCEStrikePrice
              );
              const putOptionBuy = entryOptions.find(
                (opt) =>
                  opt.optionType === 'PE' &&
                  opt.strikePrice === hedgePEStrikePrice
              );

              if (
                !callOptionSell ||
                !putOptionSell ||
                !callOptionBuy ||
                !putOptionBuy
              ) {
                console.warn(`Option data missing for ${date}. Skipping.`);
                continue;
              }

              const ceEntryPrice = callOptionSell.close;
              const peEntryPrice = putOptionSell.close;

              const ceHedgeEntryPrice = callOptionBuy.close;
              const peHedgeEntryPrice = putOptionBuy.close;

              // 🟢 Fetch Exit Prices for the main short legs
              const ceExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: otmCEStrikePrice,
                stockName,
                optionType: 'CE',
              });

              const peExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: otmPEStrikePrice,
                stockName,
                optionType: 'PE',
              });

              // 🟢 Fetch Exit Prices for the Hedge Legs
              const hedgeCeExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: hedgeCEStrikePrice,
                stockName,
                optionType: 'CE',
              });

              const hedgePeExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: hedgePEStrikePrice,
                stockName,
                optionType: 'PE',
              });

              const ceExitPrice = ceExitData ? ceExitData.close : ceEntryPrice;
              const peExitPrice = peExitData ? peExitData.close : peEntryPrice;

              const hedgeCeExitPrice = hedgeCeExitData
                ? hedgeCeExitData.close
                : ceHedgeEntryPrice;
              const hedgePeExitPrice = hedgePeExitData
                ? hedgePeExitData.close
                : peHedgeEntryPrice;

              const vixData = await HistoricalIndicesData.findOne({
                timeInterval,
                datetime: entryTimeStr,
                stockSymbol: 'India VIX',
              });

              const vixValue = vixData ? vixData.close : null;

              // 🔹 Profit/Loss for Short Legs (Sold options)
              const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
              const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;

              // 🔹 Profit/Loss for Hedge Legs (Bought options)
              const hedgeCeProfitLoss =
                (hedgeCeExitPrice - ceHedgeEntryPrice) * lotSize;
              const hedgePeProfitLoss =
                (hedgePeExitPrice - peHedgeEntryPrice) * lotSize;

              // 🔹 Net Profit Calculation
              const totalProfitLoss =
                ceProfitLoss +
                peProfitLoss +
                (hedgeCeProfitLoss + hedgePeProfitLoss);

              overallCumulativeProfit += totalProfitLoss;

              results.push({
                date,
                spotPrice,
                strikePrice: baseStrikePrice,
                expiry,
                lotSize,
                entryPrice: ceEntryPrice + peEntryPrice,
                exitPrice: ceExitPrice + peExitPrice,
                profitLoss: totalProfitLoss,
                cumulativeProfit: overallCumulativeProfit,
                transactions: [
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'CE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: otmCEStrikePrice,
                    qty: lotSize,
                    entryPrice: ceEntryPrice,
                    exitPrice: ceExitPrice,
                    vix: vixValue,
                    profitLoss: ceProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'PE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: otmPEStrikePrice,
                    qty: lotSize,
                    entryPrice: peEntryPrice,
                    exitPrice: peExitPrice,
                    vix: vixValue,
                    profitLoss: peProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'CE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: hedgeCEStrikePrice,
                    qty: lotSize,
                    entryPrice: ceHedgeEntryPrice,
                    exitPrice: hedgeCeExitPrice,
                    vix: vixValue,
                    profitLoss: hedgeCeProfitLoss,
                  },
                  {
                    date,
                    entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
                    type: 'PE',
                    strikePrice: baseStrikePrice,
                    otmStrikePrice: hedgePEStrikePrice,
                    qty: lotSize,
                    entryPrice: peHedgeEntryPrice,
                    exitPrice: hedgePeExitPrice,
                    vix: vixValue,
                    profitLoss: hedgePeProfitLoss,
                  },
                ],
              });
            } catch (error) {
              console.error(
                `Error processing ${date} - ${entryTime}:`,
                error.message
              );
            }
          }

          // 📌 Compute Trade Statistics
          const totalTradeDays = results.length;
          const noOfProfitableDays = results.filter(
            (day) => day.profitLoss > 0
          ).length;

          // 📌 Store the final strategy results
          const strategy = {
            strategyId,
            timeInterval,
            fromDate,
            toDate,
            stockSymbol,
            lotSize,
            searchType,
            entryTime,
            exitTime,
            totalTradeDays,
            noOfProfitableDays,
            cumulativeProfit: overallCumulativeProfit,
            results: results.reverse(),
          };

          await ShortStrangleStrategy.updateOne(
            { strategyId },
            { $set: strategy },
            { upsert: true }
          );

          allResults.push(strategy);
        }
      }

      res.status(200).json({
        status: 'success',
        strategies: allResults,
      });
    } catch (error) {
      console.error('Error creating strategy:', error.message);
      next(error);
    }
  }
);
