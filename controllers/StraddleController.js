const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');

exports.createShortStraddle = expressAsyncHandler(async (req, res, next) => {
  try {
    const { timeInterval, date, expiry, lotSize, stopLossPercentage } =
      req.body;

    // Validate input
    if (!timeInterval || !date || !expiry || !lotSize || !stopLossPercentage) {
      return next(new AppError('Please provide valid inputs', 400));
    }

    // Define entry and exit times in IST
    const entryTimeIST = moment.tz(
      `${date} 09:20`,
      'YYYY-MM-DD HH:mm',
      'Asia/Kolkata'
    );
    const exitTimeIST = moment.tz(
      `${date} 15:10`,
      'YYYY-MM-DD HH:mm',
      'Asia/Kolkata'
    );

    const entryTimeStr = entryTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');
    const exitTimeStr = exitTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');

    // Fetch BankNIFTY Spot Price
    const bankNiftySpot = await HistoricalIndicesData.findOne({
      timeInterval,
      datetime: entryTimeStr,
      stockSymbol: 'Nifty Bank',
    });

    if (!bankNiftySpot) {
      return next(new AppError('BankNIFTY spot data not found.', 404));
    }

    const spotPrice = bankNiftySpot.open;
    const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

    // Fetch CE and PE Options
    const entryOptions = await HistoricalOptionData.find({
      timeInterval,
      datetime: entryTimeStr,
      strikePrice: nearestStrikePrice,
      expiry,
    });

    const callOptionEntry = entryOptions.find((opt) => opt.optionType === 'CE');
    const putOptionEntry = entryOptions.find((opt) => opt.optionType === 'PE');

    if (!callOptionEntry || !putOptionEntry) {
      return next(
        new AppError(
          `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}`,
          404
        )
      );
    }

    const ceEntryPrice = callOptionEntry.open;
    const peEntryPrice = putOptionEntry.open;

    const ceStopLoss = ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
    const peStopLoss = peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

    let ceExitPrice = ceEntryPrice; // Default to entry price
    let peExitPrice = peEntryPrice;

    // Fetch price movements for stop loss and exit conditions
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
        ceExitPrice = ceStopLoss; // Stop loss hit
        break;
      }
      ceExitPrice = candle.close; // Update to latest close
    }

    for (const candle of peExitData) {
      if (candle.high >= peStopLoss) {
        peExitPrice = peStopLoss; // Stop loss hit
        break;
      }
      peExitPrice = candle.close; // Update to latest close
    }

    // Calculate P&L
    const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
    const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
    const totalProfitLoss = ceProfitLoss + peProfitLoss;

    // Create Result Object
    const shortStraddle = {
      date,
      entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
      exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
      spotPrice,
      strikePrice: nearestStrikePrice,
      expiry,
      lotSize,
      stopLossPercentage,
      entryPrice: ceEntryPrice + peEntryPrice,
      exitPrice: ceExitPrice + peExitPrice,
      profitLoss: totalProfitLoss,
      callOption: {
        symbol: callOptionEntry.stockSymbol,
        entryPrice: ceEntryPrice,
        exitPrice: ceExitPrice,
        stopLoss: ceStopLoss,
      },
      putOption: {
        symbol: putOptionEntry.stockSymbol,
        entryPrice: peEntryPrice,
        exitPrice: peExitPrice,
        stopLoss: peStopLoss,
      },
    };

    res.status(200).json({
      status: 'success',
      data: shortStraddle,
    });
  } catch (error) {
    console.error('Error creating short straddle:', error.message);
    next(error);
  }
});
