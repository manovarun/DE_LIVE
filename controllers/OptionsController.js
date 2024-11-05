const axios = require('axios');
const fs = require('fs');
const expressAsyncHandler = require('express-async-handler');
const AppError = require('../utils/AppError');
const { generateSessionAndFeedToken } = require('../utils/AppSession');

const fetchOptionTokens = async (expiry, strike) => {
  try {
    const filePath = './OpenAPIScripMaster.json';
    // Fetch the live OpenAPIScripMaster data
    const data = fs.readFileSync(filePath, 'utf8');

    const scripMaster = JSON.parse(data);

    // Filter for the specific expiry, strike, and Nifty options (CE and PE)
    const ceToken = scripMaster.find(
      (item) =>
        item.expiry === expiry &&
        item.strike === strike &&
        item.symbol.includes('CE') &&
        item.name === 'NIFTY'
    );

    const peToken = scripMaster.find(
      (item) =>
        item.expiry === expiry &&
        item.strike === strike &&
        item.symbol.includes('PE') &&
        item.name === 'NIFTY'
    );

    return { ceToken: ceToken.token, peToken: peToken.token };
  } catch (error) {
    console.error('Error fetching tokens:', error);
    throw new AppError('Unable to fetch option tokens.', 400);
  }
};

//Short Straddle Multiple Expiry Multiple Day
exports.shortStraddleMeMd = expressAsyncHandler(async (req, res, next) => {
  try {
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    // Extract the array of transactions from the request body
    const { transactions } = req.body;

    console.log(transactions);

    let cumulativeProfit = 0;
    const results = [];

    // Loop through each transaction
    for (const transaction of transactions) {
      const { entryTime, exitTime, expiry } = transaction;

      // Fetch Nifty 50 spot price at the entry time
      const niftySpotData = await smartApi.getCandleData({
        exchange: 'NSE',
        symboltoken: '99926000', // Token for Nifty 50 index
        interval: 'ONE_MINUTE',
        fromdate: entryTime,
        todate: entryTime,
      });

      if (!niftySpotData.status || !niftySpotData.data.length) {
        return next(new AppError('Error fetching Nifty 50 data', 400));
      }

      console.log('niftySpotData', niftySpotData);

      // Get the closing price of Nifty 50 at entry time (use the close value from the first candle)
      const niftySpotPrice = niftySpotData.data[0][4];

      // Dynamically calculate the nearest strike price (rounded to the nearest 50 or 100 points)
      const nearestStrikePrice = Math.round(niftySpotPrice / 50) * 50;
      const formattedStrikePrice = (nearestStrikePrice * 100).toFixed(6);

      // Fetch option tokens based on dynamically calculated strike price
      const { ceToken, peToken } = await fetchOptionTokens(
        expiry,
        formattedStrikePrice
      );

      // Default to 25 as the Nifty 50 lot size
      const lotSize = 25;

      // Fetch data for CE and PE tokens using dynamically fetched tokens
      const ceData = await smartApi.getCandleData({
        exchange: 'NFO',
        symboltoken: ceToken,
        interval: 'ONE_MINUTE',
        fromdate: entryTime,
        todate: exitTime,
      });

      const peData = await smartApi.getCandleData({
        exchange: 'NFO',
        symboltoken: peToken,
        interval: 'ONE_MINUTE',
        fromdate: entryTime,
        todate: exitTime,
      });

      // Ensure you handle cases where data is not available
      if (
        ceData.status !== true ||
        peData.status !== true ||
        !ceData.data.length ||
        !peData.data.length
      ) {
        return next(new AppError('Invalid data received for CE or PE', 400));
      }

      // Get Entry Prices (Price at entryTime)
      let entryPriceCE = ceData.data[0][4]; // Closing price at entryTime
      let entryPricePE = peData.data[0][4]; // Closing price at entryTime

      // Set Stop Loss for CE and PE (25% stop loss)
      let stopLossCE = entryPriceCE + entryPriceCE * 0.25;
      let stopLossPE = entryPricePE + entryPricePE * 0.25;

      let exitPriceCE = null;
      let exitPricePE = null;

      // Simulate the price movements and check stop loss for CE and PE
      ceData.data.forEach((candle) => {
        const [timestamp, open, high, low, close] = candle;
        if (high >= stopLossCE && !exitPriceCE) {
          exitPriceCE = stopLossCE; // Exit if stop loss is hit
        }
        if (timestamp === exitTime && !exitPriceCE) {
          exitPriceCE = close; // Exit at exit time if SL wasn't hit
        }
      });

      peData.data.forEach((candle) => {
        const [timestamp, open, high, low, close] = candle;
        if (high >= stopLossPE && !exitPricePE) {
          exitPricePE = stopLossPE; // Exit if stop loss is hit
        }
        if (timestamp === exitTime && !exitPricePE) {
          exitPricePE = close; // Exit at exit time if SL wasn't hit
        }
      });

      // If stop loss wasn't hit, set the exit prices to the close price at exit time
      if (!exitPriceCE) {
        exitPriceCE = ceData.data[ceData.data.length - 1][4]; // Closing price at exitTime
      }
      if (!exitPricePE) {
        exitPricePE = peData.data[peData.data.length - 1][4]; // Closing price at exitTime
      }

      // Calculate P&L
      const profitOrLossCE = (entryPriceCE - exitPriceCE) * lotSize; // For Sell position
      const profitOrLossPE = (entryPricePE - exitPricePE) * lotSize; // For Sell position

      const totalProfitOrLoss = profitOrLossCE + profitOrLossPE;
      cumulativeProfit += totalProfitOrLoss;

      // Add result for this transaction
      results.push({
        entryTime,
        exitTime,
        expiry,
        strikePrice: nearestStrikePrice,
        entryPrices: {
          CE: entryPriceCE,
          PE: entryPricePE,
        },
        exitPrices: {
          CE: exitPriceCE,
          PE: exitPricePE,
        },
        profitOrLoss: {
          PnL_CE: profitOrLossCE,
          PnL_PE: profitOrLossPE,
          totalPnL: totalProfitOrLoss,
        },
        cumulativeProfit,
      });
    }

    // Send the aggregated results for all transactions
    res.status(200).json({
      status: 'success',
      results,
    });
  } catch (error) {
    console.error('Error during backtest:', error);
    next(error);
  }
});
