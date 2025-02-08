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
              expiry,
              $or: [
                { strikePrice: otmCEPrice, optionType: 'CE' },
                { strikePrice: otmPEPrice, optionType: 'PE' },
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
