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
                optionType: 'CE',
              });

              const peExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: otmPEStrikePrice,
                optionType: 'PE',
              });

              // 🟢 Fetch Exit Prices for the Hedge Legs
              const hedgeCeExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
                strikePrice: hedgeCEStrikePrice,
                optionType: 'CE',
              });

              const hedgePeExitData = await HistoricalOptionData.findOne({
                timeInterval,
                datetime: exitTimeStr,
                expiry,
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
