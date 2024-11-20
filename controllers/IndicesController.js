const axios = require('axios');
const fs = require('fs');
const moment = require('moment');
const expressAsyncHandler = require('express-async-handler');
const AppError = require('../utils/AppError');
const HistoricalIndicesData = require('../models/Indices');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const { MAX_DAYS, INTERVAL_MAP } = require('../utils/constants');

// Function to introduce delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.saveHistoIndicesMultipleData = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      const { stocks, fromDate, endDate, interval } = req.body;

      if (!interval || !MAX_DAYS[interval]) {
        return next(new AppError('Invalid or missing interval', 400));
      }

      if (!fromDate || !endDate) {
        return next(
          new AppError('Please provide both fromDate and endDate', 400)
        );
      }

      const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];
      if (!abbreviatedInterval) {
        return next(new AppError('Invalid interval provided', 400));
      }

      const fromDateMoment = moment(fromDate, 'YYYY-MM-DD HH:mm', true);
      const endDateMoment = moment(endDate, 'YYYY-MM-DD HH:mm', true);

      if (!fromDateMoment.isValid() || !endDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided', 400));
      }

      if (!Array.isArray(stocks) || stocks.length === 0) {
        return next(
          new AppError('Please provide a valid array of stocks', 400)
        );
      }

      const results = [];
      const MAX_RETRIES = 3;

      for (const stock of stocks) {
        const { token, symbol, name } = stock;
        const stockToken = token || symbol || name;

        if (!stockToken) {
          console.log(`Skipping stock with missing token/symbol/name:`, stock);
          continue;
        }

        let currentFromDate = fromDateMoment.clone();

        while (currentFromDate.isBefore(endDateMoment)) {
          let toDateMoment = currentFromDate
            .clone()
            .add(MAX_DAYS[interval], 'days');
          if (toDateMoment.isAfter(endDateMoment)) {
            toDateMoment = endDateMoment.clone();
          }

          let retryCount = 0;
          let dataFetched = false;

          while (retryCount < MAX_RETRIES && !dataFetched) {
            try {
              const histoData = await smartApi.getCandleData({
                exchange: 'NSE',
                symboltoken: stockToken,
                interval: interval,
                fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
                todate: toDateMoment.format('YYYY-MM-DD HH:mm'),
              });

              if (histoData.status === 403) {
                retryCount++;
                console.log(
                  `403 Forbidden for ${
                    symbol || stockToken
                  }. Retry ${retryCount} in 1 second.`
                );
                await delay(1000); // Wait 1 second before retrying
                continue;
              }

              if (
                !histoData ||
                histoData.status !== true ||
                !histoData.data ||
                !histoData.data.length
              ) {
                console.log(
                  `No data received for ${
                    symbol || stockToken
                  } from ${currentFromDate.format(
                    'YYYY-MM-DD HH:mm'
                  )} to ${toDateMoment.format('YYYY-MM-DD HH:mm')}. Response:`,
                  histoData
                );
                break;
              }

              const candles = histoData.data.map((candle) => ({
                datetime: candle[0],
                timeInterval: abbreviatedInterval,
                stockSymbol: symbol || stockToken,
                stockName: name,
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5],
              }));

              for (const record of candles) {
                await HistoricalIndicesData.updateOne(
                  {
                    datetime: record.datetime,
                    timeInterval: record.timeInterval,
                    stockSymbol: record.stockSymbol,
                  },
                  { $setOnInsert: record },
                  { upsert: true }
                );
              }

              results.push({
                stock: symbol || stockToken,
                status: 'success',
                message: `Data saved successfully for date range: ${currentFromDate.format(
                  'YYYY-MM-DD HH:mm'
                )} to ${toDateMoment.format('YYYY-MM-DD HH:mm')}`,
              });

              dataFetched = true; // Set flag to exit retry loop
            } catch (apiError) {
              console.error(
                `Error fetching data for ${symbol || stockToken}:`,
                apiError
              );
              retryCount++;
              if (retryCount >= MAX_RETRIES) {
                results.push({
                  stock: symbol || stockToken,
                  status: 'fail',
                  message: `Failed after ${MAX_RETRIES} retries for range ${currentFromDate.format(
                    'YYYY-MM-DD HH:mm'
                  )} to ${toDateMoment.format('YYYY-MM-DD HH:mm')}`,
                });
              }
            }
          }

          currentFromDate = toDateMoment.add(1, 'minute');
          await delay(500); // Delay of 500ms between requests to avoid rate limiting
        }
      }

      res.status(200).json({
        status: 'success',
        message: 'Historical data processing completed',
        results,
      });
    } catch (error) {
      console.error('Unexpected error during historical data save:', error);
      next(new AppError('Failed to save the historical data', 500));
    }
  }
);
