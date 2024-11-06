const axios = require('axios');
const fs = require('fs');
const moment = require('moment');
const expressAsyncHandler = require('express-async-handler');
const AppError = require('../utils/AppError');
const HistoricalSwingData = require('../models/Swing');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const { MAX_DAYS, INTERVAL_MAP } = require('../utils/constants');

exports.getNifty50Tokens = expressAsyncHandler(async (req, res, next) => {
  // List of NIFTY 50 symbols
  const nifty50Symbols = [
    'ADANIENT-EQ',
    'ADANIPORTS-EQ',
    'APOLLOHOSP-EQ',
    'ASIANPAINT-EQ',
    'AXISBANK-EQ',
    'BAJAJ-AUTO-EQ',
    'BAJAJFINSV-EQ',
    'BAJFINANCE-EQ',
    'BHARTIARTL-EQ',
    'BPCL-EQ',
    'BRITANNIA-EQ',
    'CIPLA-EQ',
    'COALINDIA-EQ',
    'DIVISLAB-EQ',
    'DRREDDY-EQ',
    'EICHERMOT-EQ',
    'GRASIM-EQ',
    'HCLTECH-EQ',
    'HDFCBANK-EQ',
    'HDFCLIFE-EQ',
    'HEROMOTOCO-EQ',
    'HINDALCO-EQ',
    'HINDUNILVR-EQ',
    'ICICIBANK-EQ',
    'INDUSINDBK-EQ',
    'INFY-EQ',
    'ITC-EQ',
    'JSWSTEEL-EQ',
    'KOTAKBANK-EQ',
    'LT-EQ',
    'M&M-EQ',
    'MARUTI-EQ',
    'NESTLEIND-EQ',
    'NTPC-EQ',
    'ONGC-EQ',
    'POWERGRID-EQ',
    'RELIANCE-EQ',
    'SBILIFE-EQ',
    'SBIN-EQ',
    'SUNPHARMA-EQ',
    'TATACONSUM-EQ',
    'TATAMOTORS-EQ',
    'TATASTEEL-EQ',
    'TCS-EQ',
    'TECHM-EQ',
    'TITAN-EQ',
    'ULTRACEMCO-EQ',
    'UPL-EQ',
    'WIPRO-EQ',
  ];

  // Read the JSON file
  fs.readFile('./OpenAPIScripMaster.json', 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading JSON file:', err);
      return res.status(500).json({ error: 'Failed to read data' });
    }

    // Parse JSON data
    const jsonData = JSON.parse(data);
    const result = [];

    // Search for each NIFTY 50 symbol in the JSON data
    jsonData.forEach((item) => {
      if (nifty50Symbols.includes(item.symbol)) {
        result.push({
          token: item.token,
          symbol: item.symbol,
          name: item.name,
        });
      }
    });

    // Send the response with the formatted result
    res.json(result);
  });
});

exports.getLiveMarketData = expressAsyncHandler(async (req, res, next) => {
  try {
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    const clientCode = process.env.SMARTAPI_CLIENT_CODE;

    const profileData = await smartApi.getProfile();

    const nifty50Tokens = ['3045'];

    const MarketData = await smartApi.marketData({
      mode: 'FULL',
      exchangeTokens: {
        NSE: [...nifty50Tokens],
      },
    });

    res.status(200).json({
      status: 'success',
      // profileData,
      MarketData,
    });
  } catch (error) {
    console.error('Error checking filter conditions:', error);
    next(new AppError('Failed to check filter conditions', 500));
  }
});

// Controller to backtest Nifty50 stock or index using token, symbol, or name
exports.HistoSwing = expressAsyncHandler(async (req, res, next) => {
  try {
    // Step 1: Get session and feed token
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    // Step 2: Extract parameters from req.body (token, symbol, name, fromdate, todate, interval)
    const { token, symbol, name, fromdate, todate, interval } = req.body;

    // Ensure that fromdate, todate, and interval are provided
    if (!fromdate || !todate || !interval) {
      return next(
        new AppError('Please provide valid fromdate, todate, and interval', 400)
      );
    }

    // Step 3: Read the OpenAPIScripMaster.json file to get stock/index token details
    const filePath = './OpenAPIScripMaster.json'; // Adjust the path as needed
    const scripMasterData = fs.readFileSync(filePath, 'utf8');
    const scripMaster = JSON.parse(scripMasterData);

    let stockDetails;

    // Step 4: Search for stock/index by token, symbol, or name
    if (token) {
      stockDetails = scripMaster.find((item) => item.token === token);
    } else if (symbol) {
      stockDetails = scripMaster.find(
        (item) => item.symbol.toUpperCase() === symbol.toUpperCase()
      );
    } else if (name) {
      stockDetails = scripMaster.find(
        (item) => item.name.toUpperCase() === name.toUpperCase()
      );
    }

    // If no stock or index is found, return a 404 error
    if (!stockDetails) {
      return next(
        new AppError('Stock/Index not found in OpenAPIScripMaster.json', 404)
      );
    }

    const stockToken = stockDetails.token;

    // Step 5: Make a request to the Historical API for fetching the stock/index's historical data
    const histoData = await smartApi.getCandleData({
      exchange: 'NSE',
      symboltoken: stockToken, // Use the token from OpenAPIScripMaster
      interval, // Pass the interval dynamically
      fromdate, // Pass the fromdate dynamically
      todate, // Pass the todate dynamically
    });

    // Step 6: Ensure the data is valid
    if (!histoData || !histoData.status) {
      return next(
        new AppError('Error fetching historical data for the stock/index', 400)
      );
    }

    // Step 7: Return the historical data for the specified stock/index and time period
    res.status(200).json({
      status: 'success',
      stock: stockDetails,
      historicalData: histoData.data, // Array of candle data
    });
  } catch (error) {
    console.error('Error during stock/index backtest:', error);
    next(new AppError('Failed to backtest the stock/index', 500));
  }
});

// Controller to fetch and save historical data iteratively
exports.saveHistoSwingData = expressAsyncHandler(async (req, res, next) => {
  try {
    // Step 1: Get session and feed token
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    // Step 2: Extract parameters from req.body (token, symbol, name, fromDate, endDate, interval)
    const { token, symbol, name, fromDate, endDate, interval } = req.body;

    if (!interval) {
      return next(new AppError('Please provide a valid interval', 400));
    }

    // Ensure interval is valid
    if (!MAX_DAYS[interval]) {
      return next(new AppError('Invalid interval provided', 400));
    }

    const maxDays = MAX_DAYS[interval];
    const timeInterval = INTERVAL_MAP[interval];

    // Set the initial fromDate and endDate using moment.js
    let fromDateMoment = moment(fromDate, 'YYYY-MM-DD HH:mm', true);
    const endDateMoment = moment(endDate, 'YYYY-MM-DD HH:mm', true);

    // Validate the dates after parsing
    if (!fromDateMoment.isValid() || !endDateMoment.isValid()) {
      return next(new AppError('Invalid date format provided', 400));
    }

    const stockToken = token || symbol || name; // Fetch token from req.body
    if (!stockToken) {
      return next(
        new AppError('Please provide a valid token, symbol, or name', 400)
      );
    }

    // Loop to fetch data until we reach the end date
    while (fromDateMoment.isBefore(endDateMoment)) {
      let toDateMoment = moment(fromDateMoment).add(maxDays, 'days');
      if (toDateMoment.isAfter(endDateMoment)) {
        toDateMoment = endDateMoment;
      }

      // Fetch historical data for the current chunk
      const histoData = await smartApi.getCandleData({
        exchange: 'NSE',
        symboltoken: stockToken,
        interval,
        fromdate: fromDateMoment.format('YYYY-MM-DD HH:mm'),
        todate: toDateMoment.format('YYYY-MM-DD HH:mm'),
      });

      // Ensure the data is valid
      if (!histoData || !histoData.status || !histoData.data.length) {
        return next(new AppError('Error fetching historical data', 400));
      }

      const candles = histoData.data.map((candle) => ({
        datetime: candle[0], // Store the datetime as a string to preserve the timezone
        timeInterval,
        stockSymbol: symbol,
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
      }));

      // Save data without duplicating entries
      for (const record of candles) {
        await HistoricalSwingData.updateOne(
          {
            datetime: record.datetime,
            timeInterval: record.timeInterval,
            stockSymbol: record.stockSymbol,
          },
          { $setOnInsert: record },
          { upsert: true } // Insert if not existing
        );
      }

      // Move to the next chunk
      fromDateMoment = toDateMoment.add(1, 'minute'); // Move fromDate to one minute after the current toDate
    }

    res.status(200).json({
      status: 'success',
      message: `Historical data fetched for ${symbol} with ${timeInterval}  and saved successfully`,
    });
  } catch (error) {
    console.error('Error during saving historical data:', error);
    next(new AppError('Failed to save the historical data', 500));
  }
});

// Controller to fetch and save historical data iteratively
exports.saveHistoSwingMultipleData = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      // Step 2: Extract parameters from req.body
      const { stocks, fromDate, endDate, interval } = req.body;

      if (!interval) {
        return next(new AppError('Please provide a valid interval', 400));
      }

      // Ensure interval is valid
      if (!MAX_DAYS[interval]) {
        return next(new AppError('Invalid interval provided', 400));
      }

      const maxDays = MAX_DAYS[interval];
      const timeInterval = INTERVAL_MAP[interval];

      // Validate that fromDate and endDate are provided
      if (!fromDate || !endDate) {
        return next(
          new AppError('Please provide both fromDate and endDate', 400)
        );
      }

      // Parse the dates
      let fromDateMoment = moment(fromDate, 'YYYY-MM-DD HH:mm', true);
      const endDateMoment = moment(endDate, 'YYYY-MM-DD HH:mm', true);

      // Validate the dates after parsing
      if (!fromDateMoment.isValid() || !endDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided', 400));
      }

      // Ensure stocks array is provided and valid
      if (!Array.isArray(stocks) || stocks.length === 0) {
        return next(
          new AppError('Please provide a valid array of stocks', 400)
        );
      }

      // Iterate over each stock to fetch and save data
      for (const stock of stocks) {
        const { token, symbol, name } = stock;
        const stockToken = token || symbol || name;

        if (!stockToken) {
          console.log(`Skipping stock with missing token/symbol/name:`, stock);
          continue; // Skip if the stockToken is missing
        }

        fromDateMoment = moment(fromDate, 'YYYY-MM-DD HH:mm', true); // Reset fromDate for each stock

        // Loop to fetch data until we reach the end date for the current stock
        while (fromDateMoment.isBefore(endDateMoment)) {
          let toDateMoment = moment(fromDateMoment).add(maxDays, 'days');
          if (toDateMoment.isAfter(endDateMoment)) {
            toDateMoment = endDateMoment;
          }

          // Fetch historical data for the current chunk
          const histoData = await smartApi.getCandleData({
            exchange: 'NSE',
            symboltoken: stockToken,
            interval,
            fromdate: fromDateMoment.format('YYYY-MM-DD HH:mm'),
            todate: toDateMoment.format('YYYY-MM-DD HH:mm'),
          });

          // Ensure the data is valid
          if (!histoData || !histoData.status || !histoData.data.length) {
            console.log(`Error fetching data for ${symbol || stockToken}`);
            continue; // Skip to the next chunk if data fetch failed
          }

          const candles = histoData.data.map((candle) => ({
            datetime: candle[0],
            timeInterval,
            stockSymbol: symbol || stockToken,
            open: candle[1],
            high: candle[2],
            low: candle[3],
            close: candle[4],
            volume: candle[5],
          }));

          // Save data without duplicating entries
          for (const record of candles) {
            await HistoricalSwingData.updateOne(
              {
                datetime: record.datetime,
                timeInterval: record.timeInterval,
                stockSymbol: record.stockSymbol,
              },
              { $setOnInsert: record },
              { upsert: true } // Insert if not existing
            );
          }

          // Move to the next chunk
          fromDateMoment = toDateMoment.add(1, 'minute');
        }
      }

      res.status(200).json({
        status: 'success',
        message: `Historical data fetched and saved successfully for all stocks.`,
      });
    } catch (error) {
      console.error('Error during saving historical data:', error);
      next(new AppError('Failed to save the historical data', 500));
    }
  }
);

exports.getSwingHistoricLive = expressAsyncHandler(async (req, res, next) => {
  try {
    // Step 1: Get session and feed token
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    // Step 2: Extract parameters from req.body (token, symbol, name, fromDate, endDate, interval)
    const { token, symbol, name, fromDate, endDate, interval } = req.body;

    if (!interval) {
      return next(new AppError('Please provide a valid interval', 400));
    }

    // Ensure interval is valid
    if (!MAX_DAYS[interval]) {
      return next(new AppError('Invalid interval provided', 400));
    }

    const maxDays = MAX_DAYS[interval];
    const timeInterval = INTERVAL_MAP[interval];

    // Set the initial fromDate and endDate using moment.js
    let fromDateMoment = moment(fromDate, 'YYYY-MM-DD HH:mm', true);
    const endDateMoment = moment(endDate, 'YYYY-MM-DD HH:mm', true);

    // Validate the dates after parsing
    if (!fromDateMoment.isValid() || !endDateMoment.isValid()) {
      return next(new AppError('Invalid date format provided', 400));
    }

    const stockToken = token || symbol || name; // Fetch token from req.body
    if (!stockToken) {
      return next(
        new AppError('Please provide a valid token, symbol, or name', 400)
      );
    }

    let candles = [];

    // Loop to fetch data until we reach the end date
    while (fromDateMoment.isBefore(endDateMoment)) {
      let toDateMoment = moment(fromDateMoment).add(maxDays, 'days');
      if (toDateMoment.isAfter(endDateMoment)) {
        toDateMoment = endDateMoment;
      }

      // Fetch historical data for the current chunk
      const histoData = await smartApi.getCandleData({
        exchange: 'NSE',
        symboltoken: stockToken,
        interval,
        fromdate: fromDateMoment.format('YYYY-MM-DD HH:mm'),
        todate: toDateMoment.format('YYYY-MM-DD HH:mm'),
      });

      // Ensure the data is valid
      if (!histoData || !histoData.status || !histoData.data.length) {
        return next(new AppError('Error fetching historical data', 400));
      }

      candles = histoData.data.map((candle) => ({
        datetime: candle[0], // Store the datetime as a string to preserve the timezone
        timeInterval,
        stockSymbol: symbol,
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
      }));

      // Move to the next chunk
      fromDateMoment = toDateMoment.add(1, 'minute'); // Move fromDate to one minute after the current endDate
    }

    res.status(200).json({
      status: 'success',
      candles,
      message: 'Historical data fetched and saved successfully',
    });
  } catch (error) {
    console.error('Error during fetching historical data:', error);
    next(new AppError('Failed to save the historical data', 500));
  }
});
