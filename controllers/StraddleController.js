const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');

// exports.createShortStraddleSingleDay = expressAsyncHandler(
//   async (req, res, next) => {
//     try {
//       const { timeInterval, date, expiry, lotSize, stopLossPercentage } =
//         req.body;

//       // Validate input
//       if (
//         !timeInterval ||
//         !date ||
//         !expiry ||
//         !lotSize ||
//         !stopLossPercentage
//       ) {
//         return next(new AppError('Please provide valid inputs', 400));
//       }

//       // Define entry and exit times in IST
//       const entryTimeIST = moment.tz(
//         `${date} 09:20`,
//         'YYYY-MM-DD HH:mm',
//         'Asia/Kolkata'
//       );
//       const exitTimeIST = moment.tz(
//         `${date} 15:10`,
//         'YYYY-MM-DD HH:mm',
//         'Asia/Kolkata'
//       );

//       const entryTimeStr = entryTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');
//       const exitTimeStr = exitTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');

//       // Fetch BankNIFTY Spot Price
//       const bankNiftySpot = await HistoricalIndicesData.findOne({
//         timeInterval,
//         datetime: entryTimeStr,
//         stockSymbol: 'Nifty Bank',
//       });

//       if (!bankNiftySpot) {
//         return next(new AppError('BankNIFTY spot data not found.', 404));
//       }

//       const spotPrice = bankNiftySpot.open;
//       const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

//       // Fetch CE and PE Options
//       const entryOptions = await HistoricalOptionData.find({
//         timeInterval,
//         datetime: entryTimeStr,
//         strikePrice: nearestStrikePrice,
//         expiry,
//       });

//       const callOptionEntry = entryOptions.find(
//         (opt) => opt.optionType === 'CE'
//       );
//       const putOptionEntry = entryOptions.find(
//         (opt) => opt.optionType === 'PE'
//       );

//       if (!callOptionEntry || !putOptionEntry) {
//         return next(
//           new AppError(
//             `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}`,
//             404
//           )
//         );
//       }

//       const ceEntryPrice = callOptionEntry.open;
//       const peEntryPrice = putOptionEntry.open;

//       const ceStopLoss =
//         ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
//       const peStopLoss =
//         peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

//       let ceExitPrice = ceEntryPrice; // Default to entry price
//       let peExitPrice = peEntryPrice;

//       // Fetch price movements for stop loss and exit conditions
//       const ceExitData = await HistoricalOptionData.find({
//         timeInterval,
//         strikePrice: nearestStrikePrice,
//         expiry,
//         optionType: 'CE',
//         datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
//       }).sort({ datetime: 1 });

//       const peExitData = await HistoricalOptionData.find({
//         timeInterval,
//         strikePrice: nearestStrikePrice,
//         expiry,
//         optionType: 'PE',
//         datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
//       }).sort({ datetime: 1 });

//       for (const candle of ceExitData) {
//         if (candle.high >= ceStopLoss) {
//           ceExitPrice = ceStopLoss; // Stop loss hit
//           break;
//         }
//         ceExitPrice = candle.close; // Update to latest close
//       }

//       for (const candle of peExitData) {
//         if (candle.high >= peStopLoss) {
//           peExitPrice = peStopLoss; // Stop loss hit
//           break;
//         }
//         peExitPrice = candle.close; // Update to latest close
//       }

//       // Calculate P&L
//       const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
//       const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
//       const totalProfitLoss = ceProfitLoss + peProfitLoss;

//       // Create Result Object
//       const shortStraddle = {
//         date,
//         entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//         exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//         spotPrice,
//         strikePrice: nearestStrikePrice,
//         expiry,
//         lotSize,
//         stopLossPercentage,
//         entryPrice: ceEntryPrice + peEntryPrice,
//         exitPrice: ceExitPrice + peExitPrice,
//         profitLoss: totalProfitLoss,
//         callOption: {
//           symbol: callOptionEntry.stockSymbol,
//           entryPrice: ceEntryPrice,
//           exitPrice: ceExitPrice,
//           stopLoss: ceStopLoss,
//         },
//         putOption: {
//           symbol: putOptionEntry.stockSymbol,
//           entryPrice: peEntryPrice,
//           exitPrice: peExitPrice,
//           stopLoss: peStopLoss,
//         },
//       };

//       res.status(200).json({
//         status: 'success',
//         data: shortStraddle,
//       });
//     } catch (error) {
//       console.error('Error creating short straddle:', error.message);
//       next(error);
//     }
//   }
// );

exports.createShortStraddleSingleDay = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const { timeInterval, date, expiry, lotSize, stopLossPercentage } =
        req.body;

      if (
        !timeInterval ||
        !date ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, date, expiry, lotSize, and stopLossPercentage.',
            400
          )
        );
      }

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

      const entryOptions = await HistoricalOptionData.find({
        timeInterval,
        datetime: entryTimeStr,
        strikePrice: nearestStrikePrice,
        expiry,
      });

      const callOptionEntry = entryOptions.find(
        (opt) => opt.optionType === 'CE'
      );
      const putOptionEntry = entryOptions.find(
        (opt) => opt.optionType === 'PE'
      );

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

      const ceStopLoss =
        ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
      const peStopLoss =
        peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

      let ceExitPrice = ceEntryPrice;
      let peExitPrice = peEntryPrice;

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

      const vixData = await HistoricalIndicesData.findOne({
        timeInterval,
        datetime: entryTimeStr,
        stockSymbol: 'India VIX',
      });

      const vixValue = vixData ? vixData.close : null;

      const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
      const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
      const totalProfitLoss = ceProfitLoss + peProfitLoss;

      const transactionLog = [
        {
          date,
          entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
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
          exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
          type: 'PE',
          strikePrice: nearestStrikePrice,
          qty: lotSize,
          entryPrice: peEntryPrice,
          exitPrice: peExitPrice,
          stopLoss: peStopLoss,
          vix: vixValue,
          profitLoss: peProfitLoss,
        },
      ];

      res.status(200).json({
        status: 'success',
        data: {
          date,
          strikePrice: nearestStrikePrice,
          expiry,
          lotSize,
          stopLossPercentage,
          entryPrice: ceEntryPrice + peEntryPrice,
          exitPrice: ceExitPrice + peExitPrice,
          profitLoss: totalProfitLoss,
          transactions: transactionLog,
        },
      });
    } catch (error) {
      console.error('Error creating short straddle:', error.message);
      next(error);
    }
  }
);

//Working without cumulative profit
// exports.createShortStraddleMultiDay = expressAsyncHandler(
//   async (req, res, next) => {
//     try {
//       const {
//         timeInterval,
//         fromDate,
//         toDate,
//         expiry,
//         lotSize,
//         stopLossPercentage,
//       } = req.body;

//       // Validate input
//       if (
//         !timeInterval ||
//         !fromDate ||
//         !toDate ||
//         !expiry ||
//         !lotSize ||
//         !stopLossPercentage
//       ) {
//         return next(
//           new AppError(
//             'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, and stopLossPercentage.',
//             400
//           )
//         );
//       }

//       const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
//       const toDateMoment = moment(toDate, 'YYYY-MM-DD');

//       if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
//         return next(new AppError('Invalid date format provided.', 400));
//       }

//       const results = [];

//       // Loop through each date
//       for (
//         let currentDate = fromDateMoment.clone();
//         currentDate.isSameOrBefore(toDateMoment);
//         currentDate.add(1, 'day')
//       ) {
//         const date = currentDate.format('YYYY-MM-DD');
//         console.log(`Processing date: ${date}`);

//         // Define entry and exit times for the current date in IST
//         const entryTimeIST = moment.tz(
//           `${date} 09:20`,
//           'YYYY-MM-DD HH:mm',
//           'Asia/Kolkata'
//         );

//         console.log('entryTimeIST', entryTimeIST);

//         const exitTimeIST = moment.tz(
//           `${date} 15:10`,
//           'YYYY-MM-DD HH:mm',
//           'Asia/Kolkata'
//         );

//         const entryTimeStr = entryTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');
//         const exitTimeStr = exitTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');

//         try {
//           // Fetch BankNIFTY Spot Price
//           const bankNiftySpot = await HistoricalIndicesData.findOne({
//             timeInterval,
//             datetime: entryTimeStr,
//             stockSymbol: 'Nifty Bank',
//           });

//           if (!bankNiftySpot) {
//             console.warn(
//               `BankNIFTY spot data not found for ${date}. Skipping.`
//             );
//             continue;
//           }

//           const spotPrice = bankNiftySpot.open;
//           const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

//           // Fetch Call and Put Options at Entry Time
//           const entryOptions = await HistoricalOptionData.find({
//             timeInterval,
//             datetime: entryTimeStr,
//             strikePrice: nearestStrikePrice,
//             expiry,
//           });

//           const callOptionEntry = entryOptions.find(
//             (opt) => opt.optionType === 'CE'
//           );
//           const putOptionEntry = entryOptions.find(
//             (opt) => opt.optionType === 'PE'
//           );

//           if (!callOptionEntry || !putOptionEntry) {
//             console.warn(
//               `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
//             );
//             continue;
//           }

//           const ceEntryPrice = callOptionEntry.open;
//           const peEntryPrice = putOptionEntry.open;

//           const ceStopLoss =
//             ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
//           const peStopLoss =
//             peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

//           let ceExitPrice = ceEntryPrice;
//           let peExitPrice = peEntryPrice;

//           // Fetch price movements for stop loss and exit conditions
//           const ceExitData = await HistoricalOptionData.find({
//             timeInterval,
//             strikePrice: nearestStrikePrice,
//             expiry,
//             optionType: 'CE',
//             datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
//           }).sort({ datetime: 1 });

//           const peExitData = await HistoricalOptionData.find({
//             timeInterval,
//             strikePrice: nearestStrikePrice,
//             expiry,
//             optionType: 'PE',
//             datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
//           }).sort({ datetime: 1 });

//           for (const candle of ceExitData) {
//             if (candle.high >= ceStopLoss) {
//               ceExitPrice = ceStopLoss;
//               break;
//             }
//             ceExitPrice = candle.close;
//           }

//           for (const candle of peExitData) {
//             if (candle.high >= peStopLoss) {
//               peExitPrice = peStopLoss;
//               break;
//             }
//             peExitPrice = candle.close;
//           }

//           // Fetch VIX Data at Entry Time
//           const vixData = await HistoricalIndicesData.findOne({
//             timeInterval,
//             datetime: entryTimeStr,
//             stockSymbol: 'India VIX',
//           });

//           const vixValue = vixData ? vixData.close : null;

//           // Calculate P/L
//           const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
//           const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
//           const totalProfitLoss = ceProfitLoss + peProfitLoss;

//           // Create the Transaction Log for the Current Day
//           const transactionLog = [
//             {
//               date,
//               entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               type: 'CE',
//               strikePrice: nearestStrikePrice,
//               qty: lotSize,
//               entryPrice: ceEntryPrice,
//               exitPrice: ceExitPrice,
//               stopLoss: ceStopLoss,
//               vix: vixValue,
//               profitLoss: ceProfitLoss,
//             },
//             {
//               date,
//               entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               type: 'PE',
//               strikePrice: nearestStrikePrice,
//               qty: lotSize,
//               entryPrice: peEntryPrice,
//               exitPrice: peExitPrice,
//               stopLoss: peStopLoss,
//               vix: vixValue,
//               profitLoss: peProfitLoss,
//             },
//           ];

//           results.push({
//             date,
//             strikePrice: nearestStrikePrice,
//             expiry,
//             lotSize,
//             stopLossPercentage,
//             entryPrice: ceEntryPrice + peEntryPrice,
//             exitPrice: ceExitPrice + peExitPrice,
//             profitLoss: totalProfitLoss,
//             transactions: transactionLog,
//           });
//         } catch (error) {
//           console.error(`Error processing date ${date}:`, error.message);
//         }
//       }

//       res.status(200).json({
//         status: 'success',
//         data: results,
//       });
//     } catch (error) {
//       console.error('Error creating multi-day short straddle:', error.message);
//       next(error);
//     }
//   }
// );

//Working with cumulative profit
// exports.createShortStraddleMultiDay = expressAsyncHandler(
//   async (req, res, next) => {
//     try {
//       const {
//         timeInterval,
//         fromDate,
//         toDate,
//         expiry,
//         lotSize,
//         stopLossPercentage,
//       } = req.body;

//       // Validate input
//       if (
//         !timeInterval ||
//         !fromDate ||
//         !toDate ||
//         !expiry ||
//         !lotSize ||
//         !stopLossPercentage
//       ) {
//         return next(
//           new AppError(
//             'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, and stopLossPercentage.',
//             400
//           )
//         );
//       }

//       const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
//       const toDateMoment = moment(toDate, 'YYYY-MM-DD');

//       if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
//         return next(new AppError('Invalid date format provided.', 400));
//       }

//       const results = [];
//       let cumulativeProfit = 0; // Initialize cumulative profit

//       // Loop through each date
//       for (
//         let currentDate = fromDateMoment.clone();
//         currentDate.isSameOrBefore(toDateMoment);
//         currentDate.add(1, 'day')
//       ) {
//         const date = currentDate.format('YYYY-MM-DD');
//         console.log(`Processing date: ${date}`);

//         // Define entry and exit times for the current date in IST
//         const entryTimeIST = moment.tz(
//           `${date} 09:20`,
//           'YYYY-MM-DD HH:mm',
//           'Asia/Kolkata'
//         );
//         const exitTimeIST = moment.tz(
//           `${date} 15:10`,
//           'YYYY-MM-DD HH:mm',
//           'Asia/Kolkata'
//         );

//         const entryTimeStr = entryTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');
//         const exitTimeStr = exitTimeIST.format('YYYY-MM-DDTHH:mm:ssZ');

//         try {
//           // Fetch BankNIFTY Spot Price
//           const bankNiftySpot = await HistoricalIndicesData.findOne({
//             timeInterval,
//             datetime: entryTimeStr,
//             stockSymbol: 'Nifty Bank',
//           });

//           if (!bankNiftySpot) {
//             console.warn(
//               `BankNIFTY spot data not found for ${date}. Skipping.`
//             );
//             continue;
//           }

//           const spotPrice = bankNiftySpot.open;
//           const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

//           // Fetch Call and Put Options at Entry Time
//           const entryOptions = await HistoricalOptionData.find({
//             timeInterval,
//             datetime: entryTimeStr,
//             strikePrice: nearestStrikePrice,
//             expiry,
//           });

//           const callOptionEntry = entryOptions.find(
//             (opt) => opt.optionType === 'CE'
//           );
//           const putOptionEntry = entryOptions.find(
//             (opt) => opt.optionType === 'PE'
//           );

//           if (!callOptionEntry || !putOptionEntry) {
//             console.warn(
//               `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
//             );
//             continue;
//           }

//           const ceEntryPrice = callOptionEntry.open;
//           const peEntryPrice = putOptionEntry.open;

//           const ceStopLoss =
//             ceEntryPrice + ceEntryPrice * (stopLossPercentage / 100);
//           const peStopLoss =
//             peEntryPrice + peEntryPrice * (stopLossPercentage / 100);

//           let ceExitPrice = ceEntryPrice;
//           let peExitPrice = peEntryPrice;

//           // Fetch price movements for stop loss and exit conditions
//           const ceExitData = await HistoricalOptionData.find({
//             timeInterval,
//             strikePrice: nearestStrikePrice,
//             expiry,
//             optionType: 'CE',
//             datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
//           }).sort({ datetime: 1 });

//           const peExitData = await HistoricalOptionData.find({
//             timeInterval,
//             strikePrice: nearestStrikePrice,
//             expiry,
//             optionType: 'PE',
//             datetime: { $gte: entryTimeStr, $lte: exitTimeStr },
//           }).sort({ datetime: 1 });

//           for (const candle of ceExitData) {
//             if (candle.high >= ceStopLoss) {
//               ceExitPrice = ceStopLoss;
//               break;
//             }
//             ceExitPrice = candle.close;
//           }

//           for (const candle of peExitData) {
//             if (candle.high >= peStopLoss) {
//               peExitPrice = peStopLoss;
//               break;
//             }
//             peExitPrice = candle.close;
//           }

//           // Fetch VIX Data at Entry Time
//           const vixData = await HistoricalIndicesData.findOne({
//             timeInterval,
//             datetime: entryTimeStr,
//             stockSymbol: 'India VIX',
//           });

//           const vixValue = vixData ? vixData.close : null;

//           // Calculate P/L
//           const ceProfitLoss = (ceEntryPrice - ceExitPrice) * lotSize;
//           const peProfitLoss = (peEntryPrice - peExitPrice) * lotSize;
//           const totalProfitLoss = ceProfitLoss + peProfitLoss;

//           // Update cumulative profit
//           cumulativeProfit += totalProfitLoss;

//           // Create the Transaction Log for the Current Day
//           const transactionLog = [
//             {
//               date,
//               entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               type: 'CE',
//               strikePrice: nearestStrikePrice,
//               qty: lotSize,
//               entryPrice: ceEntryPrice,
//               exitPrice: ceExitPrice,
//               stopLoss: ceStopLoss,
//               vix: vixValue,
//               profitLoss: ceProfitLoss,
//             },
//             {
//               date,
//               entryTime: entryTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               exitTime: exitTimeIST.format('YYYY-MM-DD HH:mm:ss'),
//               type: 'PE',
//               strikePrice: nearestStrikePrice,
//               qty: lotSize,
//               entryPrice: peEntryPrice,
//               exitPrice: peExitPrice,
//               stopLoss: peStopLoss,
//               vix: vixValue,
//               profitLoss: peProfitLoss,
//             },
//           ];

//           results.push({
//             date,
//             spotPrice,
//             strikePrice: nearestStrikePrice,
//             expiry,
//             lotSize,
//             stopLossPercentage,
//             entryPrice: ceEntryPrice + peEntryPrice,
//             exitPrice: ceExitPrice + peExitPrice,
//             profitLoss: totalProfitLoss,
//             cumulativeProfit, // Include cumulative profit
//             transactions: transactionLog,
//           });
//         } catch (error) {
//           console.error(`Error processing date ${date}:`, error.message);
//         }
//       }

//       res.status(200).json({
//         status: 'success',
//         data: results,
//       });
//     } catch (error) {
//       console.error('Error creating multi-day short straddle:', error.message);
//       next(error);
//     }
//   }
// );

//Working with cumulative profit and entry, exit time
exports.createShortStraddleMultiDay = expressAsyncHandler(
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
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !expiry ||
        !lotSize ||
        !stopLossPercentage
      ) {
        return next(
          new AppError(
            'Please provide valid timeInterval, fromDate, toDate, expiry, lotSize, and stopLossPercentage.',
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

      // Loop through each date
      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        console.log(`Processing date: ${date}`);

        // Define entry and exit times for the current date in IST
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
          const bankNiftySpot = await HistoricalIndicesData.findOne({
            timeInterval,
            datetime: entryTimeStr,
            stockSymbol: 'Nifty Bank',
          });

          if (!bankNiftySpot) {
            console.warn(
              `BankNIFTY spot data not found for ${date}. Skipping.`
            );
            continue;
          }

          const spotPrice = bankNiftySpot.open;
          const nearestStrikePrice = Math.round(spotPrice / 100) * 100;

          const entryOptions = await HistoricalOptionData.find({
            timeInterval,
            datetime: entryTimeStr,
            strikePrice: nearestStrikePrice,
            expiry,
          });

          const callOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'CE'
          );
          const putOptionEntry = entryOptions.find(
            (opt) => opt.optionType === 'PE'
          );

          if (!callOptionEntry || !putOptionEntry) {
            console.warn(
              `Options data not found for entry at strike: ${nearestStrikePrice}, expiry: ${expiry}. Skipping.`
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

          const transactionLog = [
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
          ];

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
          ...entry,
          cumulativeProfit,
        };
      });

      res.status(200).json({
        status: 'success',
        data: results.reverse(),
      });
    } catch (error) {
      console.error('Error creating multi-day short straddle:', error.message);
      next(error);
    }
  }
);
