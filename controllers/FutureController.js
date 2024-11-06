const axios = require('axios');
const fs = require('fs');
const expressAsyncHandler = require('express-async-handler');
const AppError = require('../utils/AppError');
const { generateSessionAndFeedToken } = require('../utils/AppSession');

exports.getNiftyFuture = expressAsyncHandler(async (req, res, next) => {
  try {
    fs.readFile('OpenAPIScripMaster.json', 'utf8', (err, data) => {
      if (err) {
        console.error('Error reading JSON file:', err);
        return;
      }

      const jsonData = JSON.parse(data);
      const niftyFutures = jsonData.filter(
        (item) =>
          item.symbol.includes('NIFTYFUT') && item.name.includes('NIFTYFUT')
      );

      res.status(200).json({
        status: 'success',
        niftyFutures,
      });
    });
  } catch (error) {
    next(new AppError('Error fetching future data', 400));
  }
});

exports.getHistoricalFutData = expressAsyncHandler(async (req, res, next) => {
  try {
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    // Optional: Get profile data for verification if needed
    const profileData = await smartApi.getProfile();

    const { interval, fromdate, todate } = req.body;

    const niftyFutures = [
      { token: '13', symbol: 'NIFTYFUTURESMIDMONTH', name: 'NIFTYFUTM2' },
      { token: '5', symbol: 'NIFTYFUTURESNEARMONTH', name: 'NIFTYFUTM1' },
      { token: '14', symbol: 'NIFTYFUTURESFARMONTH', name: 'NIFTYFUTM3' },
    ];

    const historicalData = [];

    for (const future of niftyFutures) {
      try {
        const histoData = await smartApi.getCandleData({
          exchange: 'NFO', // Adjusted to 'NSE' for NIFTY futures
          symboltoken: future.token,
          interval: interval,
          fromdate: fromdate,
          todate: todate,
        });

        // Check if data is successfully fetched
        if (
          histoData &&
          histoData.status === 'success' &&
          histoData.data.length > 0
        ) {
          historicalData.push({
            contract: future.name,
            data: histoData.data,
          });
        } else if (histoData.status === false) {
          console.error(
            `Failed to fetch data for ${future.symbol}: ${histoData.message} (Error Code: ${histoData.errorcode})`
          );
        } else {
          console.error(
            `No data available for ${future.symbol}. Response:`,
            histoData
          );
        }
      } catch (fetchError) {
        console.error(
          `Error fetching data for ${future.symbol}:`,
          fetchError.message
        );
      }
    }

    res.status(200).json({
      status: 'success',
      profileData,
      historicalData,
    });
  } catch (error) {
    console.error('Error fetching historical data:', error);
    next(new AppError('Error fetching historical data', 400));
  }
});
