for (
  let currentDate = fromDateMoment.clone();
  currentDate.isSameOrBefore(toDateMoment);
  currentDate.add(1, 'day')
) {
  const date = currentDate.format('YYYY-MM-DD');

  const dayOfWeek = currentDate.format('ddd').toUpperCase(); // Get the day in uppercase (e.g., "MON", "TUE")

  // ✅ Apply weekday filtering
  if (selectedWeekdays.length > 0 && !selectedWeekdays.includes(dayOfWeek)) {
    console.log(
      `Skipping ${date} (${dayOfWeek}), not in selected weekdays: ${selectedWeekdays}`
    );
    continue;
  }

  console.log(
    `Processing date: ${date} (${dayOfWeek}) for entry: ${entryTime} and exit: ${exitTime}`
  );

  // 📌 Select the correct expiry based on the current date
  const activeExpiry =
    expiries.find((exp) =>
      moment(date).isSameOrBefore(moment(exp.validUntil))
    ) || expiries[expiries.length - 1]; // Use last expiry as fallback

  if (!activeExpiry) {
    console.warn(`❌ No valid expiry found for ${date}. Using last expiry.`);
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
        `No spot data found for ${stockSymbol} on ${date}. Skipping entry at ${entryTime}.`
      );
      continue;
    }

    const spotPrice = spotData.close;
    const strikePriceInterval = stockSymbol === 'Nifty 50' ? 50 : 100;

    const nearestStrikePrice =
      Math.round(spotPrice / strikePriceInterval) * strikePriceInterval;

    const otmCEStrikePrice = nearestStrikePrice + otmOffset;
    const otmPEStrikePrice = nearestStrikePrice - otmOffset;

    let entryOptions = await HistoricalOptionData.find({
      timeInterval,
      datetime: entryTimeStr,
      expiry,
      stockName,
      $or: [
        { strikePrice: otmCEStrikePrice, optionType: 'CE' },
        { strikePrice: otmPEStrikePrice, optionType: 'PE' },
      ],
    });

    let hedgeCEStrikePrice, hedgePEStrikePrice, hedgeOptions;

    if (wingWidth > 0) {
      hedgeCEStrikePrice = otmCEStrikePrice + wingWidth;
      hedgePEStrikePrice = otmPEStrikePrice - wingWidth;

      hedgeOptions = await HistoricalOptionData.find({
        timeInterval,
        datetime: entryTimeStr,
        expiry,
        stockName,
        $or: [
          { strikePrice: hedgeCEStrikePrice, optionType: 'CE' },
          { strikePrice: hedgePEStrikePrice, optionType: 'PE' },
        ],
      });

      entryOptions = entryOptions.concat(hedgeOptions);
    }

    const callOptionShort = entryOptions.find(
      (opt) => opt.optionType === 'CE' && opt.strikePrice === otmCEStrikePrice
    );

    const putOptionShort = entryOptions.find(
      (opt) => opt.optionType === 'PE' && opt.strikePrice === otmPEStrikePrice
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

    const ceStopLoss = ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
    const peStopLoss = peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

    // 🟢 Fetch Exit Prices for the main short legs
    const ceExitData = await HistoricalOptionData.find({
      timeInterval,
      strikePrice: otmCEStrikePrice,
      expiry,
      stockName,
      optionType: 'CE',
      datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
    }).sort({ datetime: 1 });

    const peExitData = await HistoricalOptionData.find({
      timeInterval,
      strikePrice: otmPEStrikePrice,
      expiry,
      stockName,
      optionType: 'PE',
      datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
    }).sort({ datetime: 1 });

    let ceExitPrice = ceEntryPrice;
    let peExitPrice = peEntryPrice;

    let ceExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');
    let peExitTime = exitTimeIST.format('YYYY-MM-DD HH:mm:ss');

    // ✅ Apply Stop Loss for Short Call (CE Sell)
    if (ceExitData.length > 0) {
      for (const candle of ceExitData) {
        if (candle.high >= ceStopLoss) {
          ceExitPrice = ceStopLoss; // Exit at stop loss price
          ceExitTime = moment(candle.datetime).format('YYYY-MM-DD HH:mm:ss');
          break;
        }
        ceExitPrice = candle.close; // If stop loss isn't hit, take last price
      }
    }

    // ✅ Apply Stop Loss for Short Put (PE Sell)
    if (peExitData.length > 0) {
      for (const candle of peExitData) {
        if (candle.high >= peStopLoss) {
          peExitPrice = peStopLoss;
          peExitTime = moment(candle.datetime).format('YYYY-MM-DD HH:mm:ss');
          break;
        }
        peExitPrice = candle.close;
      }
    }

    // 🔹 Profit/Loss for Short Legs (Sold options)
    const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
    const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;

    let hedgeCeProfitLoss = 0,
      hedgePeProfitLoss = 0,
      ceHedgeEntryPrice = 0,
      peHedgeEntryPrice = 0,
      hedgeCeExitPrice = 0,
      hedgePeExitPrice = 0;

    if (wingWidth > 0) {
      // 🟢 Fetch Exit Prices for the Hedge Legs
      const hedgeCeExitData = await HistoricalOptionData.find({
        timeInterval,
        strikePrice: hedgeCEStrikePrice,
        expiry,
        stockName,
        optionType: 'CE',
        datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
      }).sort({ datetime: -1 });

      const hedgePeExitData = await HistoricalOptionData.find({
        timeInterval,
        strikePrice: hedgePEStrikePrice,
        expiry,
        stockName,
        optionType: 'PE',
        datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
      }).sort({ datetime: -1 });

      // Ensure callOptionBuy and putOptionBuy are defined
      ceHedgeEntryPrice = callOptionBuy ? callOptionBuy.close : 0;
      peHedgeEntryPrice = putOptionBuy ? putOptionBuy.close : 0;

      // Get hedge exit prices (fallback to entry price if missing)
      hedgeCeExitPrice =
        hedgeCeExitData.length > 0
          ? hedgeCeExitData[0].close
          : ceHedgeEntryPrice;

      hedgePeExitPrice =
        hedgePeExitData.length > 0
          ? hedgePeExitData[0].close
          : peHedgeEntryPrice;

      // 🔹 Profit/Loss for Hedge Legs (Bought options)
      hedgeCeProfitLoss = (hedgeCeExitPrice - ceHedgeEntryPrice) * lotSize;
      hedgePeProfitLoss = (hedgePeExitPrice - peHedgeEntryPrice) * lotSize;
    }

    // 🔹 Net Profit Calculation (Add hedge legs profit/loss only if wingWidth > 0)
    const totalProfitLoss =
      ceProfitLoss + peProfitLoss + hedgeCeProfitLoss + hedgePeProfitLoss;

    overallCumulativeProfit += totalProfitLoss;

    // Track Max Profit and Max Loss
    maxProfit = Math.max(maxProfit, totalProfitLoss);
    maxLoss = Math.min(maxLoss, totalProfitLoss);

    const vixData = await HistoricalIndicesData.findOne({
      timeInterval,
      datetime: entryTimeStr,
      stockSymbol: 'India VIX',
    });

    const vixValue = vixData ? vixData.close : null;

    const transactions = [
      {
        date,
        entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
        exitTime: ceExitTime,
        type: 'CE',
        strikePrice: nearestStrikePrice,
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
        exitTime: peExitTime,
        type: 'PE',
        strikePrice: nearestStrikePrice,
        otmStrikePrice: otmPEStrikePrice,
        qty: lotSize,
        entryPrice: peEntryPrice,
        exitPrice: peExitPrice,
        vix: vixValue,
        profitLoss: peProfitLoss,
      },
    ];

    if (wingWidth > 0) {
      // 🛑 If wingWidth > 0, add hedge legs
      transactions.push(
        {
          date,
          entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          type: 'CE',
          strikePrice: nearestStrikePrice,
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
          strikePrice: nearestStrikePrice,
          otmStrikePrice: hedgePEStrikePrice,
          qty: lotSize,
          entryPrice: peHedgeEntryPrice,
          exitPrice: hedgePeExitPrice,
          vix: vixValue,
          profitLoss: hedgePeProfitLoss,
        }
      );
    }

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
      transactions, // ✅ This dynamically contains only relevant legs
    });
  } catch (error) {
    console.error(
      `Error processing date ${date} for entry ${entryTime}:`,
      error.message
    );
  }

  totalTradeDays = results.length;
  noOfProfitableDays = results.filter((day) => day.profitLoss > 0).length;

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
    maxProfit,
    maxLoss,
    results: results.reverse(),
  };

  allResults.push(strategy);

  await ShortStrangleStrategy.updateOne(
    { strategyId },
    { $set: strategy },
    { upsert: true }
  );
}
