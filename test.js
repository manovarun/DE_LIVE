exports.OTMShortStrangleTest = expressAsyncHandler(async (req, res, next) => {
  try {
    const {
      timeInterval,
      fromDate,
      toDate,
      expiries,
      lotSize,
      stopLossPercentage,
      entryTimes,
      exitTimes,
      otmOffset = 0,
      wingWidth = 500,
      stockSymbol,
      stockName,
      searchType,
      selectedWeekdays = [],
    } = req.body;

    if (
      !timeInterval ||
      !fromDate ||
      !toDate ||
      expiries.length === 0 ||
      !lotSize ||
      !stopLossPercentage ||
      !Array.isArray(entryTimes) ||
      !Array.isArray(exitTimes) ||
      entryTimes.length === 0 ||
      exitTimes.length === 0 ||
      !stockSymbol ||
      !stockName ||
      !searchType
    ) {
      return next(new AppError('Please provide valid parameters.', 400));
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
          const dayOfWeek = currentDate.format('ddd').toUpperCase();

          if (
            selectedWeekdays.length > 0 &&
            !selectedWeekdays.includes(dayOfWeek)
          ) {
            console.log(
              `Skipping ${date} (${dayOfWeek}), not in selected weekdays: ${selectedWeekdays}`
            );
            continue;
          }

          let previousDate = currentDate.clone().subtract(1, 'day');
          if (currentDate.isoWeekday() === 1) {
            previousDate.subtract(2, 'days'); // Skip weekend if Monday
          }
          const previousDateStr = previousDate.format('YYYY-MM-DD');

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
            const [vixResults, spotData, vixPreviousHighData] =
              await Promise.all([
                HistoricalIndicesData.find({
                  timeInterval: 'M5',
                  datetime: { $in: [`${date}T09:15:00+05:30`, entryTimeStr] },
                  stockSymbol: 'India VIX',
                }),
                HistoricalIndicesData.findOne({
                  timeInterval,
                  datetime: entryTimeStr,
                  stockSymbol,
                }),
                HistoricalIndicesData.findOne({
                  timeInterval: 'D1',
                  datetime: { $regex: `^${previousDateStr}` },
                  stockSymbol: 'India VIX',
                }),
              ]);

            const vix915Data = vixResults.find(
              (v) => v.datetime === `${date}T09:15:00+05:30`
            );
            const vixData = vixResults.find((v) => v.datetime === entryTimeStr);
            const vixPreviousHigh = vixPreviousHighData
              ? vixPreviousHighData.high
              : null;

            if (
              !vix915Data ||
              !vixPreviousHigh ||
              vix915Data.close >= vixPreviousHigh
            ) {
              console.warn(
                `Skipping trade on ${date} - 9:15 VIX: ${vix915Data?.close} >= Previous High: ${vixPreviousHigh}`
              );
              continue;
            }

            console.log(
              `✔ VIX conditions met for ${date}: 9:15 VIX (${vix915Data.close}) < Previous High (${vixPreviousHigh})`
            );

            const spotPrice = spotData?.close;
            if (!spotPrice) {
              console.warn(
                `No spot data for ${stockSymbol} on ${date}. Skipping.`
              );
              continue;
            }

            const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;
            const nearestStrikePrice =
              Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

            const otmCEStrikePrice = nearestStrikePrice + otmOffset;
            const otmPEStrikePrice = nearestStrikePrice - otmOffset;

            let entryOptions = await HistoricalOptionData.find({
              timeInterval,
              datetime: entryTimeStr,
              expiry: activeExpiry.expiry,
              stockName,
              $or: [
                { strikePrice: otmCEStrikePrice, optionType: 'CE' },
                { strikePrice: otmPEStrikePrice, optionType: 'PE' },
              ],
            });

            let hedgeOptions = [];
            if (wingWidth > 0) {
              const hedgeCEStrikePrice = otmCEStrikePrice + wingWidth;
              const hedgePEStrikePrice = otmPEStrikePrice - wingWidth;

              hedgeOptions = await HistoricalOptionData.find({
                timeInterval,
                datetime: entryTimeStr,
                expiry: activeExpiry.expiry,
                stockName,
                $or: [
                  { strikePrice: hedgeCEStrikePrice, optionType: 'CE' },
                  { strikePrice: hedgePEStrikePrice, optionType: 'PE' },
                ],
              });

              entryOptions = entryOptions.concat(hedgeOptions);
            }

            const callOptionShort = entryOptions.find(
              (opt) =>
                opt.optionType === 'CE' && opt.strikePrice === otmCEStrikePrice
            );
            const putOptionShort = entryOptions.find(
              (opt) =>
                opt.optionType === 'PE' && opt.strikePrice === otmPEStrikePrice
            );

            const callOptionBuy =
              wingWidth > 0
                ? entryOptions.find(
                    (opt) =>
                      opt.optionType === 'CE' &&
                      opt.strikePrice === otmCEStrikePrice + wingWidth
                  )
                : null;
            const putOptionBuy =
              wingWidth > 0
                ? entryOptions.find(
                    (opt) =>
                      opt.optionType === 'PE' &&
                      opt.strikePrice === otmPEStrikePrice - wingWidth
                  )
                : null;

            if (
              !callOptionShort ||
              !putOptionShort ||
              (wingWidth > 0 && (!callOptionBuy || !putOptionBuy))
            ) {
              console.warn(`Option data missing for ${date}. Skipping.`);
              continue;
            }

            const ceEntryPrice = callOptionShort.close;
            const peEntryPrice = putOptionShort.close;

            const ceStopLoss =
              ceEntryPrice + (ceEntryPrice * stopLossPercentage) / 100;
            const peStopLoss =
              peEntryPrice + (peEntryPrice * stopLossPercentage) / 100;

            const ceExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: otmCEStrikePrice,
              expiry: activeExpiry.expiry,
              stockName,
              optionType: 'CE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            const peExitData = await HistoricalOptionData.find({
              timeInterval,
              strikePrice: otmPEStrikePrice,
              expiry: activeExpiry.expiry,
              stockName,
              optionType: 'PE',
              datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
            }).sort({ datetime: 1 });

            let ceExitPrice = ceEntryPrice;
            let peExitPrice = peEntryPrice;

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

            const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
            const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;

            let hedgeCeProfitLoss = 0,
              hedgePeProfitLoss = 0;
            if (wingWidth > 0) {
              const hedgeCeExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: otmCEStrikePrice + wingWidth,
                expiry: activeExpiry.expiry,
                stockName,
                optionType: 'CE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const hedgePeExitData = await HistoricalOptionData.find({
                timeInterval,
                strikePrice: otmPEStrikePrice - wingWidth,
                expiry: activeExpiry.expiry,
                stockName,
                optionType: 'PE',
                datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
              }).sort({ datetime: 1 });

              const hedgeCeExitPrice =
                hedgeCeExitData.length > 0
                  ? hedgeCeExitData[0].close
                  : callOptionBuy.close;
              const hedgePeExitPrice =
                hedgePeExitData.length > 0
                  ? hedgePeExitData[0].close
                  : putOptionBuy.close;

              hedgeCeProfitLoss =
                (hedgeCeExitPrice - callOptionBuy.close) * lotSize;
              hedgePeProfitLoss =
                (hedgePeExitPrice - putOptionBuy.close) * lotSize;
            }

            const totalProfitLoss =
              ceProfitLoss +
              peProfitLoss +
              hedgeCeProfitLoss +
              hedgePeProfitLoss;
            overallCumulativeProfit += totalProfitLoss;

            maxProfit = Math.max(maxProfit, totalProfitLoss);
            maxLoss = Math.min(maxLoss, totalProfitLoss);

            results.push({
              date,
              spotPrice,
              expiry: activeExpiry.expiry,
              lotSize,
              stopLossPercentage,
              entryPrice: ceEntryPrice + peEntryPrice,
              exitPrice: ceExitPrice + peExitPrice,
              profitLoss: totalProfitLoss,
              cumulativeProfit: overallCumulativeProfit,
              transactions: [
                {
                  type: 'CE',
                  entryPrice: ceEntryPrice,
                  exitPrice: ceExitPrice,
                  profitLoss: ceProfitLoss,
                },
                {
                  type: 'PE',
                  entryPrice: peEntryPrice,
                  exitPrice: peExitPrice,
                  profitLoss: peProfitLoss,
                },
              ],
            });
          } catch (error) {
            console.error(`Error processing date ${date}:`, error.message);
          }
        }

        results.sort((a, b) => new Date(a.date) - new Date(b.date));
        strategy = {
          strategyId,
          timeInterval,
          fromDate,
          toDate,
          stockSymbol,
          expiry: expiries[0].expiry,
          lotSize,
          stopLossPercentage,
          searchType,
          entryTime,
          exitTime,
          totalTradeDays: results.length,
          noOfProfitableDays: results.filter((day) => day.profitLoss > 0)
            .length,
          cumulativeProfit: overallCumulativeProfit,
          maxProfit,
          maxLoss,
          results,
        };

        allResults.push(strategy);
      }
    }

    res.status(200).json({ status: 'success', strategy: allResults });
  } catch (error) {
    console.error('Error running OTM Short Strangle strategy:', error.message);
    next(error);
  }
});
