const expressAsyncHandler = require('express-async-handler');
const moment = require('moment-timezone');
const HistoricalOptionData = require('../models/Option');
const HistoricalIndicesData = require('../models/Indices');
const AppError = require('../utils/AppError');
const { calculateIndicators } = require('../utils/Indicators');

exports.createFirstCandleStrategy = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const {
        timeInterval,
        fromDate,
        toDate,
        stockSymbol,
        stockName,
        lotSize,
        breakoutBuffer = 0.5,
        exitTime = '09:35',
        enableIndicators = true,
        stopLossMultiplier = 1.5,
        targetMultiplier = 2,
        expiries,
        totalCapital = 100000,
      } = req.body;

      if (
        !timeInterval ||
        !fromDate ||
        !toDate ||
        !stockSymbol ||
        !stockName ||
        !lotSize ||
        !expiries ||
        expiries.length === 0
      ) {
        return next(new AppError('Invalid input parameters.', 400));
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
      const toDateMoment = moment(toDate, 'YYYY-MM-DD');
      const allResults = [];
      let cumulativeProfit = 0;
      let totalTrades = 0;
      let profitableTrades = 0;

      for (
        let currentDate = fromDateMoment.clone();
        currentDate.isSameOrBefore(toDateMoment);
        currentDate.add(1, 'day')
      ) {
        const date = currentDate.format('YYYY-MM-DD');
        const entryTimeStr = moment
          .tz(`${date} 09:15`, 'Asia/Kolkata')
          .format();
        const exitTimeStr = moment
          .tz(`${date} ${exitTime}`, 'Asia/Kolkata')
          .format();

        try {
          const spotData = await HistoricalIndicesData.findOne({
            stockSymbol,
            stockName,
            timeInterval,
            datetime: entryTimeStr,
          })
            .select('open high low close')
            .lean();

          if (!spotData) {
            console.warn(`No spot data found for ${stockSymbol} on ${date}`);
            continue;
          }

          const { open, high, low, close } = spotData;
          const breakoutHigh = high + breakoutBuffer;
          const breakoutLow = low - breakoutBuffer;

          // Find the closest expiry date that is still valid
          const expiryObj =
            expiries.find((exp) =>
              moment(date).isSameOrBefore(moment(exp.validUntil))
            ) || expiries[expiries.length - 1];

          const expiry = expiryObj.expiry;

          console.log(
            `Spot Price: ${close}, Breakout High: ${breakoutHigh}, Breakout Low: ${breakoutLow}, Expiry: ${expiry}`
          );

          let tradeDirection = null;
          let entryPrice = null;
          let breakoutTime = null;
          let entryTime = null;
          let exitPrice = null;
          let exitTimeFinal = null;
          let profitLoss = 0;

          const priceData = await HistoricalIndicesData.find({
            stockSymbol,
            stockName,
            timeInterval,
            datetime: { $gte: entryTimeStr, $lt: exitTimeStr },
          })
            .select('datetime close')
            .sort({ datetime: 1 })
            .lean();

          console.log('priceData', priceData);

          if (priceData.length === 0) {
            console.warn(`No price data found for ${stockSymbol} on ${date}`);
            continue;
          }

          for (const candle of priceData) {
            if (!tradeDirection) {
              if (candle.close >= breakoutHigh) {
                tradeDirection = 'Long';
                breakoutTime = candle.datetime;
                console.log(`Breakout confirmed at ${breakoutTime}`);
                break;
              } else if (candle.close <= breakoutLow) {
                tradeDirection = 'Short';
                breakoutTime = candle.datetime;
                console.log(`Breakout confirmed at ${breakoutTime}`);
                break;
              }
            }
          }

          if (!tradeDirection) {
            console.log(`No breakout occurred for ${stockSymbol} on ${date}`);
            continue;
          }

          // Fetch latest spot price at breakout time to recalculate nearest strike
          const breakoutSpotData = await HistoricalIndicesData.findOne({
            stockSymbol,
            stockName,
            timeInterval,
            datetime: breakoutTime,
          })
            .select('close')
            .lean();

          if (!breakoutSpotData) {
            console.warn(
              `No latest spot data found for ${stockSymbol} at breakout time on ${date}`
            );
            continue;
          }

          const strikeInterval = 100;
          const nearestStrike =
            Math.round(breakoutSpotData.close / strikeInterval) *
            strikeInterval;
          console.log(
            `Recalculated nearest strike at breakout time: ${nearestStrike}`
          );

          // Fetch ATM Call or Put option based on trade direction
          const selectedOptionType = tradeDirection === 'Long' ? 'CE' : 'PE';

          const optionData = await HistoricalOptionData.findOne({
            stockName,
            expiry,
            strikePrice: nearestStrike,
            optionType: selectedOptionType,
            timeInterval: 'M1',
            datetime: breakoutTime,
          })
            .select('datetime close strikePrice optionType')
            .lean();

          if (!optionData) {
            console.warn(
              `No ${selectedOptionType} option data found for BANKNIFTY at breakout time on ${date}`
            );
            continue;
          }

          entryTime = breakoutTime;
          entryPrice = optionData.close;

          const stopLoss = entryPrice * (1 - stopLossMultiplier / 100);
          const target = entryPrice * (1 + targetMultiplier / 100);
          const rrRatio = (target - entryPrice) / (entryPrice - stopLoss);

          console.log(1 - stopLossMultiplier / 100);

          console.log('stopLoss: ', stopLoss);
          console.log('target: ', target);

          const exitData = await HistoricalOptionData.find({
            stockName,
            expiry,
            strikePrice: nearestStrike,
            optionType: selectedOptionType,
            timeInterval: 'M1',
            datetime: { $gte: entryTime, $lte: exitTimeStr },
          })
            .select('datetime close')
            .sort({ datetime: 1 })
            .lean();

          let exitReason = 'Time Exit';
          for (const candle of exitData) {
            if (candle.datetime !== entryTime) {
              if (candle.close >= target) {
                exitPrice = candle.close;
                exitTimeFinal = candle.datetime;
                exitReason = 'Target Hit';
                break;
              } else if (candle.close <= stopLoss) {
                exitPrice = candle.close;
                exitTimeFinal = candle.datetime;
                exitReason = 'Stop Loss Hit';
                break;
              }
            }
          }

          if (!exitPrice) {
            exitPrice = exitData[exitData.length - 1]?.close;
            exitTimeFinal = exitData[exitData.length - 1]?.datetime;
          }

          if (entryTime === exitTimeFinal) continue;

          profitLoss = (exitPrice - entryPrice) * lotSize;

          const capitalUsed = entryPrice * lotSize;
          const roi = (profitLoss / capitalUsed) * 100;

          cumulativeProfit += profitLoss;
          totalTrades++;
          if (profitLoss > 0) profitableTrades++;

          allResults.push({
            date,
            stockSymbol,
            tradeDirection,
            nearestStrike,
            selectedOptionType,
            entryPrice,
            exitPrice,
            profitLoss,
            stopLoss,
            target,
            rrRatio,
            entryTime,
            exitTime: exitTimeFinal,
            exitReason,
            capitalUsed,
            roi: roi.toFixed(2) + '%',
          });
        } catch (error) {
          console.error(`Error processing ${date}:`, error.message);
        }
      }

      const winRate = ((profitableTrades / totalTrades) * 100).toFixed(2);

      res.status(200).json({
        status: 'success',
        results: allResults,
        cumulativeProfit,
        totalTrades,
        profitableTrades,
        winRate: winRate + '%',
      });
    } catch (error) {
      console.error('Error creating first candle strategy:', error.message);
      next(error);
    }
  }
);

// exports.createFirstCandleStrategyATR = expressAsyncHandler(
//   async (req, res, next) => {
//     try {
//       const {
//         timeInterval,
//         fromDate,
//         toDate,
//         stockSymbol,
//         stockName,
//         lotSize,
//         breakoutBuffer = 0.5,
//         exitTime = '09:35',
//         enableIndicators = true,
//         stopLossMultiplier = 1.5,
//         targetMultiplier = 2,
//         expiries,
//         totalCapital = 100000,
//       } = req.body;

//       if (
//         !timeInterval ||
//         !fromDate ||
//         !toDate ||
//         !stockSymbol ||
//         !stockName ||
//         !lotSize ||
//         !expiries ||
//         expiries.length === 0
//       ) {
//         return next(new AppError('Invalid input parameters.', 400));
//       }

//       const fromDateMoment = moment(fromDate, 'YYYY-MM-DD');
//       const toDateMoment = moment(toDate, 'YYYY-MM-DD');
//       const allResults = [];
//       let cumulativeProfit = 0;
//       let totalTrades = 0;
//       let profitableTrades = 0;

//       for (
//         let currentDate = fromDateMoment.clone();
//         currentDate.isSameOrBefore(toDateMoment);
//         currentDate.add(1, 'day')
//       ) {
//         const date = currentDate.format('YYYY-MM-DD');
//         const entryTimeStr = moment
//           .tz(`${date} 09:15`, 'Asia/Kolkata')
//           .format();
//         const exitTimeStr = moment
//           .tz(`${date} ${exitTime}`, 'Asia/Kolkata')
//           .format();

//         try {
//           const spotData = await HistoricalIndicesData.findOne({
//             stockSymbol,
//             stockName,
//             timeInterval,
//             datetime: entryTimeStr,
//           })
//             .select('open high low close')
//             .lean();

//           if (!spotData) {
//             console.warn(`No spot data found for ${stockSymbol} on ${date}`);
//             continue;
//           }

//           // Fetch ATM Option Volume Instead of Index Volume
//           const atmOptionVolume = await HistoricalOptionData.findOne({
//             stockName,
//             expiryDate,
//             strikePrice: nearestStrike,
//             optionType: 'CE', // Use CE for volume reference
//             timeInterval: 'M1',
//             datetime: entryTimeStr,
//           })
//             .select('volume')
//             .lean();

//           if (!atmOptionVolume) {
//             console.warn(`No option volume found for BANKNIFTY at ${date}`);
//             continue;
//           }
//             console.warn(`No spot data found for ${stockSymbol} on ${date}`);
//             continue;
//           }

//           const { open, high, low, close } = spotData;
//           const breakoutHigh = high + breakoutBuffer;
//           const breakoutLow = low - breakoutBuffer;

//           // Find the closest expiry date that is still valid
//           const expiryObj =
//             expiries.find((exp) =>
//               moment(date).isSameOrBefore(moment(exp.validUntil))
//             ) || expiries[expiries.length - 1];

//           const expiry = expiryObj.expiry;

//           console.log(
//             `Spot Price: ${close}, Breakout High: ${breakoutHigh}, Breakout Low: ${breakoutLow}, Expiry: ${expiry}`
//           );

//           let tradeDirection = null;
//           let entryPrice = null;
//           let breakoutTime = null;
//           let entryTime = null;
//           let exitPrice = null;
//           let exitTimeFinal = null;
//           let profitLoss = 0;

//           const priceData = await HistoricalIndicesData.find({
//             stockSymbol,
//             stockName,
//             timeInterval,
//             datetime: { $gte: entryTimeStr, $lt: exitTimeStr },
//           })
//             .select('datetime close volume')
//             .sort({ datetime: 1 })
//             .lean();

//           if (priceData.length === 0) {
//             console.warn(`No price data found for ${stockSymbol} on ${date}`);
//             continue;
//           }

//           for (const candle of priceData) {
//             if (!tradeDirection) {
//               if (candle.close >= breakoutHigh) {
//                 tradeDirection = 'Long';
//                 breakoutTime = candle.datetime;
//                 console.log(`Breakout confirmed at ${breakoutTime}`);
//                 break;
//               } else if (candle.close <= breakoutLow) {
//                 tradeDirection = 'Short';
//                 breakoutTime = candle.datetime;
//                 console.log(`Breakout confirmed at ${breakoutTime}`);
//                 break;
//               }
//             }
//           }

//           if (!tradeDirection) {
//             console.log(`No breakout occurred for ${stockSymbol} on ${date}`);
//             continue;
//           }

//           // Fetch latest spot price at breakout time to recalculate nearest strike
//           const breakoutSpotData = await HistoricalIndicesData.findOne({
//             stockSymbol,
//             stockName,
//             timeInterval,
//             datetime: breakoutTime,
//           })
//             .select('close')
//             .lean();

//           if (!breakoutSpotData) {
//             console.warn(
//               `No latest spot data found for ${stockSymbol} at breakout time on ${date}`
//             );
//             continue;
//           }

//           const strikeInterval = 100;
//           const nearestStrike =
//             Math.round(breakoutSpotData.close / strikeInterval) *
//             strikeInterval;
//           console.log(
//             `Recalculated nearest strike at breakout time: ${nearestStrike}`
//           );

//           // Fetch ATM Call or Put option based on trade direction
//           const selectedOptionType = tradeDirection === 'Long' ? 'CE' : 'PE';

//           const optionData = await HistoricalOptionData.findOne({
//             stockName,
//             expiry,
//             strikePrice: nearestStrike,
//             optionType: selectedOptionType,
//             timeInterval: 'M1',
//             datetime: breakoutTime,
//           })
//             .select('datetime close strikePrice')
//             .lean();

//           if (!optionData) {
//             console.warn(
//               `No ${selectedOptionType} option data found for BANKNIFTY at breakout time on ${date}`
//             );
//             continue;
//           }

//           entryTime = breakoutTime;
//           entryPrice = optionData.close;

//           const stopLoss = entryPrice * (1 - stopLossMultiplier / 100);
//           const target = entryPrice * (1 + targetMultiplier / 100);

//           const exitData = await HistoricalOptionData.find({
//             stockName,
//             expiry,
//             strikePrice: nearestStrike,
//             optionType: selectedOptionType,
//             timeInterval: 'M1',
//             datetime: { $gte: entryTime, $lte: exitTimeStr },
//           })
//             .select('datetime close')
//             .sort({ datetime: 1 })
//             .lean();

//           for (const candle of exitData) {
//             if (candle.datetime !== entryTime) {
//               if (
//                 tradeDirection === 'Long' &&
//                 (candle.close >= target || candle.close <= stopLoss)
//               ) {
//                 exitPrice = candle.close;
//                 exitTimeFinal = candle.datetime;
//                 break;
//               } else if (
//                 tradeDirection === 'Short' &&
//                 (candle.close <= target || candle.close >= stopLoss)
//               ) {
//                 exitPrice = candle.close;
//                 exitTimeFinal = candle.datetime;
//                 break;
//               }
//             }
//           }

//           if (!exitPrice) {
//             exitPrice = exitData[exitData.length - 1]?.close;
//             exitTimeFinal = exitData[exitData.length - 1]?.datetime;
//           }

//           if (entryTime === exitTimeFinal) continue;

//           profitLoss = (exitPrice - entryPrice) * lotSize;
//           cumulativeProfit += profitLoss;
//           totalTrades++;
//           if (profitLoss > 0) profitableTrades++;

//           allResults.push({
//             date,
//             stockSymbol,
//             tradeDirection,
//             entryPrice,
//             exitPrice,
//             profitLoss,
//             stopLoss,
//             target,
//             entryTime,
//             exitTime: exitTimeFinal,
//           });
//         } catch (error) {
//           console.error(`Error processing ${date}:`, error.message);
//         }
//       }

//       res.status(200).json({
//         status: 'success',
//         results: allResults,
//         cumulativeProfit,
//         totalTrades,
//         profitableTrades,
//       });
//     } catch (error) {
//       console.error('Error creating first candle strategy:', error.message);
//       next(error);
//     }
//   }
// );
