const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const InstrumentData = require('../../models/Instrument');
const MarketData = require('../../models/MarketData');
const PaperTradeLog = require('../../models/PaperTrade');
const HistoricalOptionData = require('../../models/Option');
const HistoricalIndicesData = require('../../models/Indices');
const AppError = require('../../utils/AppError');
const HistoricalFuturesData = require('../../models/Futures');
const { ATR } = require('technicalindicators');
function calculateSupertrendWithATR(
  candleData,
  atrPeriod = 10,
  multiplier = 3
) {
  const highs = candleData.map((c) => c.high);
  const lows = candleData.map((c) => c.low);
  const closes = candleData.map((c) => c.close);

  const atrValues = ATR.calculate({
    period: atrPeriod,
    high: highs,
    low: lows,
    close: closes,
  });

  const result = [];
  let trend = null;
  let finalUpperBand = null;
  let finalLowerBand = null;
  let prevFinalUpperBand = null;
  let prevFinalLowerBand = null;
  let prevClose = null;

  for (let i = 0; i < candleData.length; i++) {
    const candle = candleData[i];

    if (i < atrPeriod - 1) {
      result.push({ ...candle, supertrend: null, supertrendLine: null });
      continue;
    }

    const atr = atrValues[i - (atrPeriod - 1)];
    const hl2 = (candle.high + candle.low) / 2;
    const basicUpperBand = hl2 + multiplier * atr;
    const basicLowerBand = hl2 - multiplier * atr;

    // Band carry-forward logic like TradingView
    if (
      prevFinalUpperBand != null &&
      (basicUpperBand < prevFinalUpperBand || prevClose > prevFinalUpperBand)
    ) {
      finalUpperBand = basicUpperBand;
    } else {
      finalUpperBand = prevFinalUpperBand ?? basicUpperBand;
    }

    if (
      prevFinalLowerBand != null &&
      (basicLowerBand > prevFinalLowerBand || prevClose < prevFinalLowerBand)
    ) {
      finalLowerBand = basicLowerBand;
    } else {
      finalLowerBand = prevFinalLowerBand ?? basicLowerBand;
    }

    // Supertrend trend logic
    if (trend === null) {
      trend = candle.close <= finalUpperBand ? 'red' : 'green';
    } else if (trend === 'red' && candle.close > finalUpperBand) {
      trend = 'green';
    } else if (trend === 'green' && candle.close < finalLowerBand) {
      trend = 'red';
    }

    const supertrendLine = trend === 'green' ? finalLowerBand : finalUpperBand;

    result.push({
      ...candle,
      supertrend: trend,
      supertrendLine: supertrendLine,
    });

    prevFinalUpperBand = finalUpperBand;
    prevFinalLowerBand = finalLowerBand;
    prevClose = candle.close;
  }

  return result;
}

exports.backtestBuyFuturesWithSupertrend = expressAsyncHandler(
  async (req, res, next) => {
    const {
      fromDate,
      toDate,
      stockSymbol,
      stockName,
      startTime,
      endTime,
      minEntryTime,
      maxEntryTime,
      hardExitTime,
      lotSize,
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
    let cumulativePnL = 0;

    for (
      let date = fromDateMoment.clone();
      date.isSameOrBefore(toDateMoment);
      date.add(1, 'day')
    ) {
      const currentDate = date.format('YYYY-MM-DD');
      const start = moment.tz(`${currentDate} 09:15`, 'Asia/Kolkata');
      const end = moment.tz(`${currentDate} ${endTime}`, 'Asia/Kolkata');
      const minEntry = moment.tz(
        `${currentDate} ${minEntryTime}`,
        'Asia/Kolkata'
      );
      const maxEntry = moment.tz(
        `${currentDate} ${maxEntryTime}`,
        'Asia/Kolkata'
      );
      const hardExit = moment.tz(
        `${currentDate} ${hardExitTime}`,
        'Asia/Kolkata'
      );

      const candleData = await HistoricalFuturesData.find({
        stockSymbol,
        stockName,
        timeInterval: 'M3',
        datetime: {
          $gte: start.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lte: end.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      })
        .sort({ datetime: 1 })
        .lean();

      if (!candleData.length) continue;

      const supertrendSeries = calculateSupertrendWithATR(candleData);

      console.log(supertrendSeries);

      candleData.forEach((candle, index) => {
        candle.supertrend = supertrendSeries[index]?.supertrend || 'green';
        candle.supertrendLine = supertrendSeries[index]?.supertrendLine;
      });

      let entryCandle = null;
      for (const candle of candleData) {
        const candleTime = moment(candle.datetime);
        if (
          candleTime.isBefore(minEntry) ||
          candleTime.isAfter(maxEntry) ||
          candle.supertrendLine == null
        )
          continue;

        if (
          candle.supertrend === 'green' &&
          candle.close > candle.supertrendLine
        ) {
          entryCandle = candle;
          break;
        }
      }

      if (!entryCandle) continue;

      let exitCandle = null;
      for (const candle of candleData) {
        const candleTime = moment(candle.datetime);
        if (
          candleTime.isSameOrAfter(entryCandle.datetime) &&
          ((candle.supertrend === 'red' &&
            candle.close < candle.supertrendLine) ||
            candleTime.isSameOrAfter(hardExit))
        ) {
          exitCandle = candle;
          break;
        }
      }

      if (!exitCandle) exitCandle = candleData[candleData.length - 1];

      const entryPrice = entryCandle.close;
      const exitPrice = exitCandle.close;
      const pnl = (exitPrice - entryPrice) * lotSize;

      cumulativePnL += pnl;
      totalTrades++;
      pnl > 0 ? winTrades++ : lossTrades++;

      allResults.push({
        date: currentDate,
        entryPrice,
        exitPrice,
        entryTime: entryCandle.datetime,
        exitTime: exitCandle.datetime,
        direction: 'BUY FUT',
        instrument: stockSymbol,
        lotSize,
        pnl,
        status: 'CLOSED',
      });
    }

    const winRate = totalTrades
      ? ((winTrades / totalTrades) * 100).toFixed(2)
      : 0;

    res.status(200).json({
      success: true,
      summary: {
        totalTrades,
        winTrades,
        lossTrades,
        winRate: `${winRate}%`,
        cumulativePnL,
      },
      results: allResults,
    });
  }
);
