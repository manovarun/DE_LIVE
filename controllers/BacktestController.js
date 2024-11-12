const axios = require('axios');
const fs = require('fs');
const expressAsyncHandler = require('express-async-handler');
const moment = require('moment');
const AppError = require('../utils/AppError');
const getHistoricalData = require('../utils/getHistoricalData');
const HistoricalSwingData = require('../models/Swing');

exports.getSymbolData = expressAsyncHandler(async (req, res, next) => {
  try {
    // URL for the live OpenAPIScripMaster.json file
    const filePath = './OpenAPIScripMaster.json';

    // Extract the search criteria from the request body
    const { symbol, name, expiry, strike, exch_seg } = req.body;

    // Fetch the JSON data from the live URL using Axios
    // const response = await axios.get(url);
    const data = fs.readFileSync(filePath, 'utf8');
    // Parse the response data (it will already be in JSON format)
    const scripMaster = JSON.parse(data);

    // Filter the data based on the provided search criteria
    const filteredInstruments = scripMaster.filter(
      (item) =>
        (!symbol || item.symbol === symbol) &&
        (!name || item.name === name) &&
        (!expiry || item.expiry === expiry) &&
        (!strike || item.strike === strike) &&
        (!exch_seg || item.exch_seg === exch_seg)
    );

    // Return the filtered instruments
    res.status(200).json({
      status: 'success',
      filteredInstruments,
    });
  } catch (error) {
    next(new AppError('Error fetching data from the live URL', 400));
  }
});
// Controller to backtest Nifty50 or Nifty Next 50 stocks using stored database data
exports.breakout15m = expressAsyncHandler(async (req, res, next) => {
  try {
    const interval = 'M15'; // 15-minute timeframe for intraday
    const nifty100Symbols = await HistoricalSwingData.distinct('stockSymbol', {
      timeInterval: interval,
    }); // Fetch distinct Nifty 100 symbols

    if (!nifty100Symbols || nifty100Symbols.length === 0) {
      return next(
        new AppError(
          'No Nifty 100 stocks found in the database for 15-minute interval',
          404
        )
      );
    }

    const backtestResultsAllStocks = [];

    for (const symbol of nifty100Symbols) {
      const stockBacktestResults = [];

      // Loop over each trading day for intraday data (e.g., from January 1, 2023 to December 31, 2023)
      const startDate = moment('2024-11-01'); // Start date for backtesting
      const endDate = moment('2024-11-05'); // End date for backtesting

      while (startDate.isBefore(endDate)) {
        // Set intraday time range (9:15 AM to 3:30 PM for each trading day)

        const fromDate = startDate
          .clone()
          .hour(9)
          .minute(15)
          .second(0)
          .format('YYYY-MM-DD HH:mm');

        const toDate = startDate
          .clone()
          .hour(15)
          .minute(30)
          .second(0)
          .format('YYYY-MM-DD HH:mm');

        console.log(symbol, interval, fromDate, toDate);

        // Fetch historical data for the stock symbol for the intraday time range
        const historicalData = await getHistoricalData({
          stockSymbol: symbol,
          interval,
          fromDate,
          toDate,
        });

        for (let i = 20; i < historicalData.length; i++) {
          const currentCandle = historicalData[i];
          const last20Candles = historicalData.slice(i - 20, i);

          // Condition 1: Current Close > Max(20-period close)
          const maxClose = Math.max(...last20Candles.map((c) => c.close));
          const condition1 = currentCandle.close > maxClose;

          // Condition 2: Current Volume > SMA(20) of Volume
          const smaVolume =
            last20Candles.reduce((sum, c) => sum + c.volume, 0) / 20;
          const condition2 = currentCandle.volume > smaVolume;

          console.log(
            `Date: ${currentCandle.datetime}, Close: ${currentCandle.close}, Max Close: ${maxClose}, SMA Volume: ${smaVolume}, Volume: ${currentCandle.volume}`
          );
          console.log(`Condition 1: ${condition1}, Condition 2: ${condition2}`);

          if (condition1 && condition2) {
            stockBacktestResults.push({
              datetime: currentCandle.datetime,
              close: currentCandle.close,
              volume: currentCandle.volume,
              maxClose,
              smaVolume,
            });
          }
        }
        startDate.add(1, 'day');
      }

      // Add results for each stock if there were signals
      if (stockBacktestResults.length > 0) {
        backtestResultsAllStocks.push({
          stockSymbol: symbol,
          backtestResults: stockBacktestResults,
        });
      }
    }

    // Return the backtest results for all Nifty 100 stocks
    res.status(200).json({
      status: 'success',
      backtestResultsAllStocks,
    });
  } catch (error) {
    console.error('Error during Nifty 100 stock backtest:', error);
    next(new AppError('Failed to backtest Nifty 100 stocks', 500));
  }
});
