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
          'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, stopLossPercentage, stockSymbol, searchType, and non-empty entryTimes and exitTimes arrays.',
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

      if (!entryTimeIST.isValid() || !exitTimeIST.isValid()) {
        return next(new AppError('Invalid time format. Use HH:mm:ss.', 400));
      }

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
            ceExitTime = moment(candle.datetime).format('YYYY-MM-DD HH:mm:ss');
            break;
          }
          ceExitPrice = candle.close;
        }

        for (const candle of peExitData) {
          if (candle.high >= peStopLoss) {
            peExitPrice = peStopLoss;
            peExitTime = moment(candle.datetime).format('YYYY-MM-DD HH:mm:ss');
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
        console.log('totalProfitLoss: ' + totalProfitLoss);

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
    noOfProfitableDays = results.filter((day) => day.profitLoss > 0).length;

    const strategy = {
      timeInterval,
      fromDate,
      toDate,
      stockSymbol,
      expiry,
      lotSize,
      stopLossPercentage,
      entryTime,
      exitTime,
      totalTradeDays,
      noOfProfitableDays,
      cumulativeProfit: overallCumulativeProfit,
      results: results.reverse(),
    };

    allResults.push(strategy);

    res.status(200).json({
      status: 'success',
      data: allResults,
    });
  } catch (error) {
    console.error('❌ Error executing strategy:', error.message);
    next(error);
  }
});
