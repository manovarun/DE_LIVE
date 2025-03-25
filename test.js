//FUTURES BASED OPTION BREAKOUTS FIRST MINUTE CANDLE
exports.backtestBreakoutFuturesOptionsCandle = expressAsyncHandler(
  async (req, res, next) => {
    const {
      fromDate,
      toDate,
      startTime = '09:15',
      endTime = '09:50',
      firstCandleMinute,
      breakoutBuffer,
      strikeInterval,
      stopLossMultiplier,
      targetMultiplier,
      lotSize,
      trailingStopLoss = false,
      trailMultiplier = 5,
      enableScalping = true,
      scalpingProfit = 1000,
      scalpingLoss = 1000,
      stockSymbol = 'Nifty Bank',
      stockName = 'BANKNIFTY',
      expiry = '27MAR2025',
      expiries = [],
    } = req.body;

    if (!fromDate || !toDate) {
      return res
        .status(400)
        .json({ success: false, message: 'Missing date range' });
    }

    const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
    const toDateMoment = moment(toDate, 'YYYY-MM-DD');

    const allResults = [];
    let totalTrades = 0;
    let winTrades = 0;
    let lossTrades = 0;
    let maxProfit = Number.NEGATIVE_INFINITY;
    let maxLoss = Number.POSITIVE_INFINITY;
    let cumulativePnL = 0;
    let optionSymbol = '';

    for (
      let date = fromDateMoment.clone();
      date.isSameOrBefore(toDateMoment);
      date.add(1, 'day')
    ) {
      const currentDate = date.format('YYYY-MM-DD');

      const candleStart = moment.tz(
        `${currentDate} ${startTime}`,
        'Asia/Kolkata'
      );
      const breakoutCheckStart = candleStart
        .clone()
        .add(firstCandleMinute, 'minute');
      const backtestEnd = moment.tz(
        `${currentDate} ${endTime}`,
        'Asia/Kolkata'
      );

      const spotData = await HistoricalFuturesData.findOne({
        stockSymbol,
        stockName,
        timeInterval: `M${firstCandleMinute}`,
        datetime: candleStart.format('YYYY-MM-DDTHH:mm:ssZ'),
      })
        .select('open high low close')
        .lean();

      if (!spotData) {
        console.warn(`No spot data found for on ${date}`);
        continue;
      }
      console.log('spotData', spotData);

      if (isDragonflyDoji(spotData)) {
        console.log(
          'Skipping trade due to Dragonfly Doji candle pattern:',
          spotData
        );
        continue;
      }

      const breakoutHigh = spotData.high + breakoutBuffer;
      const breakoutLow = spotData.low - breakoutBuffer;

      console.log(
        `Breakout High: ${breakoutHigh}, Breakout Low: ${breakoutLow}, Expiry: ${expiry}`
      );

      let breakoutTime = null;
      let direction = null;

      const tickData = await HistoricalFuturesData.find({
        stockSymbol,
        stockName,
        timeInterval: 'M1',
        datetime: {
          $gte: breakoutCheckStart.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      })
        .select('datetime close')
        .sort({ datetime: 1 })
        .lean();

      const breakoutTick = tickData.find(
        (tick) => tick.close >= breakoutHigh || tick.close <= breakoutLow
      );

      if (!breakoutTick) continue;

      console.log('breakoutTick', breakoutTick);

      for (const candle of tickData) {
        if (!direction) {
          if (candle.close >= breakoutHigh) {
            direction = 'LONG';
            breakoutTime = candle.datetime;
            break;
          } else if (candle.close <= breakoutLow) {
            direction = 'SHORT';
            breakoutTime = candle.datetime;
            break;
          }
        }
      }

      console.log('direction', direction);

      const nearestStrike =
        Math.round(breakoutTick.close / strikeInterval) * strikeInterval;

      console.log('nearestStrike', nearestStrike);

      const selectedOptionType = direction === 'LONG' ? 'CE' : 'PE';

      console.log('selectedOptionType', selectedOptionType);

      const selectedExpiry = expiry;

      // const optionToken = await InstrumentData.findOne({
      //   name: stockName,
      //   expiry: selectedExpiry,
      //   strike: (nearestStrike * 100).toFixed(6),
      //   symbol: { $regex: selectedOptionType + '$' },
      // })
      //   .select('token symbol expiry')
      //   .lean();

      // if (!optionToken) continue;

      const entryTick = await HistoricalOptionData.findOne({
        stockName,
        expiry,
        strikePrice: nearestStrike,
        optionType: selectedOptionType,
        timeInterval: 'M1',
        datetime: breakoutTime,
      })
        .select('datetime close strikePrice optionType')
        .lean();

      if (!entryTick) continue;

      const entryPrice = entryTick.close;

      console.log('entryPrice', entryPrice);

      let stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(2);
      let target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);
      const rrRatio = +(target - entryPrice) / (entryPrice - stopLoss);

      console.log('stopLoss', stopLoss);
      console.log('target', target);

      const exitTicks = await HistoricalOptionData.find({
        stockName,
        expiry,
        strikePrice: nearestStrike,
        optionType: selectedOptionType,
        timeInterval: 'M1',
        datetime: {
          $gte: breakoutTime,
          $lte: backtestEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      })
        .select('stockSymbol datetime close')
        .sort({ datetime: 1 })
        .lean();

      if (exitTicks.length === 0) continue;

      let exitPrice = entryPrice;
      let exitTime = null;
      let exitReason = 'Time Exit';

      for (const tick of exitTicks) {
        optionSymbol = tick.stockSymbol;
        const currentLTP = tick.close;
        const tickTime = tick.datetime;
        const pnl = (currentLTP - entryPrice) * lotSize;

        if (enableScalping) {
          if (pnl >= scalpingProfit) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Scalping Target Hit';
            break;
          }
          // } else if (pnl <= -scalpingLoss) {
          //   exitPrice = currentLTP;
          //   exitTime = tickTime;
          //   exitReason = 'Scalping Stop Loss';
          //   break;
          // }
        } else {
          if (currentLTP >= target) {
            exitPrice = target;
            exitTime = tickTime;
            exitReason = 'Target Hit';
            break;
          } else if (currentLTP <= stopLoss) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            console.log(exitTime);
            exitReason = 'Stop Loss Triggered';
            break;
          } else if (trailingStopLoss && currentLTP > entryPrice) {
            const newTrailSL = +(
              currentLTP *
              (1 - trailMultiplier / 100)
            ).toFixed(2);
            if (newTrailSL > stopLoss) stopLoss = newTrailSL;
          } else if (moment(tickTime).isSameOrAfter(backtestEnd)) {
            exitPrice = currentLTP;
            exitTime = tickTime;
            exitReason = 'Time Exit';
            break;
          }
        }
      }

      if (!exitTime && exitTicks.length > 0) {
        const lastTick = exitTicks[exitTicks.length - 1];
        exitTime = lastTick.exchTradeTime || lastTick.exchFeedTime;
        exitPrice = lastTick.close;
      }

      const pnl = (exitPrice - entryPrice) * lotSize;
      cumulativePnL += pnl;
      totalTrades++;
      pnl > 0 ? winTrades++ : lossTrades++;

      if (pnl > maxProfit) maxProfit = pnl;
      if (pnl < maxLoss) maxLoss = pnl;

      const tradeResult = {
        date: currentDate,
        firstCandleMinute,
        direction,
        tradingSymbol: optionSymbol,
        // tradingSymbol: optionToken.symbol,
        // symbolToken: optionToken.token,
        nearestStrike,
        selectedOptionType,
        expiry: selectedExpiry,
        entryPrice,
        stopLoss,
        target,
        rrRatio,
        entryTime: breakoutTick.datetime,
        exitPrice,
        exitTime,
        exitReason,
        pnl,
        lotSize,
        status: 'CLOSED',
      };

      // await PaperTradeLog.create(tradeResult);
      allResults.push(tradeResult);
    }

    const winRate = ((winTrades / totalTrades) * 100).toFixed(2);

    res.status(200).json({
      success: true,
      summary: {
        totalTrades,
        winTrades,
        lossTrades,
        winRate: `${winRate}%`,
        cumulativePnL,
        maxProfit: isFinite(maxProfit) ? maxProfit : 0,
        maxLoss: isFinite(maxLoss) ? maxLoss : 0,
      },
      results: allResults,
    });
  }
);
