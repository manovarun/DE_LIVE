exports.createOTMShortStrangleNSL = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        expiries,
        lotSize,
        entryTimes,
        exitTimes,
        otmOffset = 0,
        wingWidth = 500,
        stockSymbol,
        stockName,
        searchType,
        enableWeekdayCheck = false,
        selectedWeekdays = [],
        useVixCondition = false, // New flag to enable/disable VIX filtering
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        expiries.length === 0 ||
        !lotSize ||
        !entryTimes.length ||
        !exitTimes.length ||
        !stockSymbol ||
        !stockName ||
        !searchType
      ) {
        return next(new AppError('Invalid input parameters.', 400));
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
              `Skipping invalid combination: Entry ${entryTime}, Exit ${exitTime}`
            );
            continue;
          }

          const strategyId = `${searchType}-${stockSymbol.replace(
            / /g,
            '_'
          )}-${fromDate}-${toDate}-${timeInterval}-${entryTime}-${exitTime}`;
          let results = [];
          let overallCumulativeProfit = 0;
          let maxProfit = Number.MIN_SAFE_INTEGER;
          let maxLoss = Number.MAX_SAFE_INTEGER;

          for (
            let currentDate = fromDateMoment.clone();
            currentDate.isSameOrBefore(toDateMoment);
            currentDate.add(1, 'day')
          ) {
            const date = currentDate.format('YYYY-MM-DD');

            if (enableWeekdayCheck) {
              const dayOfWeek = currentDate.format('ddd').toUpperCase();
              if (
                selectedWeekdays.length > 0 &&
                !selectedWeekdays.includes(dayOfWeek)
              ) {
                continue;
              }
            }

            const expiry =
              expiryCache.get(date) ||
              (() => {
                const exp =
                  expiries.find((exp) =>
                    moment(date).isSameOrBefore(moment(exp.validUntil))
                  ) || expiries[expiries.length - 1];
                expiryCache.set(date, exp.expiry);
                return exp.expiry;
              })();

            console.log(
              `Processing: ${date}, Expiry: ${expiry}, Entry: ${entryTime}, Exit: ${exitTime}`
            );

            let previousDate = currentDate.clone().subtract(1, 'day');
            if (currentDate.isoWeekday() === 1) {
              previousDate.subtract(2, 'days'); // Skip weekend if Monday
            }
            const previousDateStr = previousDate.format('YYYY-MM-DD');

            const entryTimeStr = moment
              .tz(`${date} ${entryTime}`, 'Asia/Kolkata')
              .format();
            const exitTimeStr = moment
              .tz(`${date} ${exitTime}`, 'Asia/Kolkata')
              .format();

            try {
              const [vixResults, spotData, vixPreviousHighData] =
                await Promise.all([
                  // Fetch all required India VIX data in one query
                  HistoricalIndicesData.find({
                    timeInterval: 'M5',
                    datetime: {
                      $in: [`${date}T09:15:00+05:30`, entryTimeStr],
                    },
                    stockSymbol: 'India VIX',
                  })
                    .select('datetime close')
                    .lean(),

                  // Fetch current day's stock price
                  HistoricalIndicesData.findOne({
                    timeInterval,
                    datetime: entryTimeStr,
                    stockSymbol,
                  })
                    .select('close')
                    .lean(),

                  // Fetch previous day's India VIX high
                  HistoricalIndicesData.findOne({
                    timeInterval: 'D1',
                    datetime: { $regex: `^${previousDateStr}` }, // Fetches the last available daily high for yesterday
                    stockSymbol: 'India VIX',
                  })
                    .select('datetime high')
                    .lean(),
                ]);

              if (useVixCondition) {
                // Extract VIX Data from Results
                const vix915Data = vixResults.find(
                  (v) => v.datetime === `${date}T09:15:00+05:30`
                );

                // Extract yesterday's VIX high
                const vixPreviousHigh = vixPreviousHighData
                  ? vixPreviousHighData.high
                  : null;

                if (
                  !vix915Data ||
                  !vixPreviousHigh ||
                  vix915Data.close >= vixPreviousHigh
                ) {
                  console.warn(
                    `Skipping trade on ${date} - VIX condition failed (9:15 VIX: ${vix915Data?.close} >= Yesterday's High: ${vixPreviousHigh})`
                  );
                  continue;
                }

                console.log(
                  `✔ Taking trade on ${date} - VIX conditions met! ( 9:15 VIX: ${vix915Data.close} < Yesterday's High: ${vixPreviousHigh})`
                );
              }

              if (!spotData) {
                console.warn(
                  `No spot data found for ${stockSymbol} on ${date}. Skipping.`
                );
                continue;
              }

              const spotPrice = spotData.close;
              const strikeInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
              const nearestStrikePrice =
                Math.round(spotPrice / strikeInterval) * strikeInterval;

              const otmCEStrikePrice = nearestStrikePrice + otmOffset;
              const otmPEStrikePrice = nearestStrikePrice - otmOffset;
              const hedgeCEStrikePrice = otmCEStrikePrice + wingWidth;
              const hedgePEStrikePrice = otmPEStrikePrice - wingWidth;

              const strikePrices = [
                otmCEStrikePrice,
                otmPEStrikePrice,
                hedgeCEStrikePrice,
                hedgePEStrikePrice,
              ];

              // Proceed with fetching options and trade execution
              console.log(`Trading on ${date} without VIX check (if disabled)`);

              // Your existing trade execution logic remains the same...
            } catch (error) {
              console.error(`Error processing ${date}:`, error.message);
            }
          }

          allResults.push({
            strategyId,
            timeInterval,
            fromDate,
            toDate,
            stockSymbol,
            expiry: expiries[expiries.length - 1].expiry,
            lotSize,
            searchType,
            entryTime,
            exitTime,
            totalTradeDays: results.length,
            noOfProfitableDays: results.filter((r) => r.profitLoss > 0).length,
            cumulativeProfit: overallCumulativeProfit,
            maxProfit,
            maxLoss,
            results,
          });

          results = [];
          if (global.gc) global.gc();
        }
      }

      await ShortStrangleStrategy.bulkWrite(
        allResults.map((strategy) => ({
          updateOne: {
            filter: { strategyId: strategy.strategyId },
            update: { $set: strategy },
            upsert: true,
          },
        }))
      );

      res.status(200).json({ status: 'success' });
    } catch (error) {
      console.error(
        'Error creating OTM short strangle with hedge:',
        error.message
      );
      next(error);
    }
  }
);
