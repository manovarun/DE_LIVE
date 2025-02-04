const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalIndicesData = require('../models/Indices');

exports.ShortSellingStrategy = expressAsyncHandler(async (req, res, next) => {
  try {
    const {
      timeInterval,
      fromDate,
      toDate,
      stockSymbol,
      smaPeriod,
      rsiPeriod,
      rsiOverbought,
    } = req.body;

    if (
      !timeInterval ||
      !fromDate ||
      !toDate ||
      !stockSymbol ||
      !smaPeriod ||
      !rsiPeriod ||
      !rsiOverbought
    ) {
      return next(
        new Error('Invalid input. Please provide all required fields.', 400)
      );
    }

    const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
    const toDateMoment = moment(toDate, 'YYYY-MM-DD');

    if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
      return next(new Error('Invalid date format provided.', 400));
    }

    const allResults = [];

    for (
      let currentDate = fromDateMoment.clone();
      currentDate.isSameOrBefore(toDateMoment);
      currentDate.add(1, 'day')
    ) {
      const date = currentDate.format('YYYY-MM-DD');

      console.log(date);

      console.log(`Processing date: ${date}`);

      const historicalData = await HistoricalIndicesData.find({
        datetime: {
          $gte: moment.tz(`${date} 00:00:00`, 'Asia/Kolkata').toISOString(),
          $lte: moment.tz(`${date} 23:59:59`, 'Asia/Kolkata').toISOString(),
        },
        stockSymbol,
      }).sort({ datetime: 1 });

      if (historicalData.length === 0) {
        console.warn(`No historical data found for ${date}. Skipping.`);
        continue;
      }

      const closes = historicalData.map((d) => d.close);

      console.log(`Closes: ${closes}`);

      // Calculate SMA
      const sma = require('technicalindicators').SMA.calculate({
        period: smaPeriod,
        values: closes,
      });

      // Calculate RSI
      const rsi = require('technicalindicators').RSI.calculate({
        period: rsiPeriod,
        values: closes,
      });

      let cumulativeProfit = 0;

      for (
        let i = Math.max(smaPeriod, rsiPeriod);
        i < historicalData.length;
        i++
      ) {
        const price = historicalData[i].close;

        if (price < sma[i - smaPeriod] && rsi[i - rsiPeriod] > rsiOverbought) {
          // Execute short sell
          const entryPrice = price;
          const exitPrice = historicalData[i + 1]?.close || entryPrice; // Exit next candle

          const profitLoss = entryPrice - exitPrice;
          cumulativeProfit += profitLoss;

          allResults.push({
            date,
            entryPrice,
            exitPrice,
            profitLoss,
            cumulativeProfit,
            reason: `Price below SMA(${smaPeriod}) and RSI(${rsiPeriod}) > ${rsiOverbought}`,
          });
        }
      }
    }

    // await ShortSellingStrategy.updateOne(
    //   { strategyId: `ShortSelling-${stockSymbol}-${fromDate}-${toDate}` },
    //   { $set: { allResults } },
    //   { upsert: true }
    // );

    res.status(200).json({
      status: 'success',
      data: allResults,
    });
  } catch (error) {
    console.error('Error during backtest:', error.message);
    next(error);
  }
});
