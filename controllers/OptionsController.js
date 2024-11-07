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

exports.shortStraddleMeMd = expressAsyncHandler(async (req, res, next) => {
  try {
    const { feedToken, smartApi } = await generateSessionAndFeedToken();
    const { transactions } = req.body;
    let cumulativeProfit = 0;

    const results = await Promise.all(
      transactions.map(async (transaction) => {
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
          throw new AppError('Error fetching Nifty 50 data', 400);
        }

        const niftySpotPrice = niftySpotData.data[0][4];
        const nearestStrikePrice = Math.round(niftySpotPrice / 50) * 50;
        const formattedStrikePrice = (nearestStrikePrice * 100).toFixed(6);

        // Fetch option tokens based on calculated strike price
        const { ceToken, peToken } = await fetchOptionTokens(
          expiry,
          formattedStrikePrice
        );

        // Retry mechanism for fetching CE and PE data
        async function fetchWithRetry(symboltoken) {
          let attempts = 0;
          const maxAttempts = 5;

          while (attempts < maxAttempts) {
            const data = await smartApi.getCandleData({
              exchange: 'NFO',
              symboltoken,
              interval: 'ONE_MINUTE',
              fromdate: entryTime,
              todate: exitTime,
            });

            if (data.status === true && data.data.length) {
              return data;
            }

            console.log(
              `Retrying data fetch for token ${symboltoken}, attempt ${
                attempts + 1
              }`
            );
            attempts += 1;
          }
          throw new AppError(
            `Invalid data received for token ${symboltoken} after ${maxAttempts} attempts`,
            400
          );
        }

        // Fetch data for CE and PE tokens with retry logic
        const ceData = await fetchWithRetry(ceToken);
        const peData = await fetchWithRetry(peToken);

        let entryPriceCE = ceData.data[0][4];
        let entryPricePE = peData.data[0][4];
        let stopLossCE = entryPriceCE + entryPriceCE * 0.25;
        let stopLossPE = entryPricePE + entryPricePE * 0.25;

        let exitPriceCE = null;
        let exitPricePE = null;

        ceData.data.forEach((candle) => {
          const [timestamp, , high, , close] = candle;
          if (high >= stopLossCE && !exitPriceCE) exitPriceCE = stopLossCE;
          if (timestamp === exitTime && !exitPriceCE) exitPriceCE = close;
        });

        peData.data.forEach((candle) => {
          const [timestamp, , high, , close] = candle;
          if (high >= stopLossPE && !exitPricePE) exitPricePE = stopLossPE;
          if (timestamp === exitTime && !exitPricePE) exitPricePE = close;
        });

        if (!exitPriceCE) exitPriceCE = ceData.data[ceData.data.length - 1][4];
        if (!exitPricePE) exitPricePE = peData.data[peData.data.length - 1][4];

        const profitOrLossCE = (entryPriceCE - exitPriceCE) * 25;
        const profitOrLossPE = (entryPricePE - exitPricePE) * 25;
        const totalProfitOrLoss = profitOrLossCE + profitOrLossPE;
        cumulativeProfit += totalProfitOrLoss;

        return {
          entryTime,
          exitTime,
          expiry,
          strikePrice: nearestStrikePrice,
          entryPrices: { CE: entryPriceCE, PE: entryPricePE },
          exitPrices: { CE: exitPriceCE, PE: exitPricePE },
          profitOrLoss: {
            PnL_CE: profitOrLossCE,
            PnL_PE: profitOrLossPE,
            totalPnL: totalProfitOrLoss,
          },
          cumulativeProfit,
        };
      })
    );

    res.status(200).json({
      status: 'success',
      results,
    });
  } catch (error) {
    console.error('Error during backtest:', error);
    next(error);
  }
});
