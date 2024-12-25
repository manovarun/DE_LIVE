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
        searchType = 'DAY',
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
      let totalTradeDays = 0;
      let profitableDaysCount = 0;

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

              if (totalProfitLoss > 0) {
                profitableDaysCount++;
              }
              totalTradeDays++;
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
            searchType, // Save search type
            entryTime,
            exitTime,
            totalTradeDays, // Save total trade days
            noOfProfitableDays: profitableDaysCount, // Save number of profitable days
            cumulativeProfit: overallCumulativeProfit,
            results: results.reverse(),
          };

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
        totalTradeDays,
        noOfProfitableDays: profitableDaysCount,
        data: allResults,
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
