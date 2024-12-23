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
      console.error(
        'Error creating multi-day OTM short straddle:',
        error.message
      );
      next(error);
    }
  }
);
