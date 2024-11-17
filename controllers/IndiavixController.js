const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const AppError = require('../utils/AppError');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const { MAX_DAYS, INTERVAL_MAP } = require('../utils/constants');
const HistoricalIndiaVIXData = require('../models/Indiavix');

exports.getHistoricalDataForIndiaVIX = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const filePath = './OpenAPIScripMaster.json';

      const { fromdate, todate, interval } = req.body;

      if (!fromdate || !todate || !interval) {
        return next(
          new AppError(
            'Please provide valid fromdate, todate, and interval',
            400
          )
        );
      }

      const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];
      if (!abbreviatedInterval) {
        return next(new AppError('Invalid interval provided', 400));
      }

      const maxDays = MAX_DAYS[interval];
      if (!maxDays) {
        return next(new AppError('Invalid interval provided', 400));
      }

      const fromDateMoment = moment(fromdate, 'YYYY-MM-DD HH:mm');
      const toDateMoment = moment(todate, 'YYYY-MM-DD HH:mm');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided', 400));
      }

      // Load the OpenAPIScripMaster.json file
      const data = fs.readFileSync(filePath, 'utf8');
      const scripMaster = JSON.parse(data);

      // Filter the instrument for India VIX
      const indiaVIXInstrument = scripMaster.find(
        (item) => item.symbol === 'India VIX' && item.name === 'INDIA VIX'
      );

      if (!indiaVIXInstrument) {
        return next(
          new AppError(
            'India VIX instrument not found in OpenAPIScripMaster.json',
            404
          )
        );
      }

      console.log(`Found India VIX instrument:`, indiaVIXInstrument);

      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      let currentFromDate = moment(fromDateMoment);

      while (currentFromDate.isBefore(toDateMoment)) {
        let currentToDate = moment(currentFromDate).add(maxDays, 'days');
        if (currentToDate.isAfter(toDateMoment)) {
          currentToDate = toDateMoment;
        }

        console.log(
          `Fetching India VIX data from ${currentFromDate.format(
            'YYYY-MM-DD HH:mm'
          )} to ${currentToDate.format('YYYY-MM-DD HH:mm')}`
        );

        // Fetch historical price data
        const vixData = await smartApi
          .getCandleData({
            exchange: indiaVIXInstrument.exch_seg,
            symboltoken: indiaVIXInstrument.token,
            interval,
            fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
            todate: currentToDate.format('YYYY-MM-DD HH:mm'),
          })
          .catch((err) => {
            console.error(`Error fetching India VIX data:`, err);
            return null;
          });

        if (!vixData || !vixData.status || !vixData.data?.length) {
          console.warn(`No India VIX data fetched for the given period.`);
          break;
        }

        // Save the data to MongoDB
        vixData.data.forEach((candle) => {
          const record = {
            datetime: candle[0],
            timeInterval: abbreviatedInterval,
            stockName: 'INDIA VIX',
            stockSymbol: indiaVIXInstrument.symbol,
            open: candle[1],
            high: candle[2],
            low: candle[3],
            close: candle[4],
            volume: 0, // Volume is typically not applicable for India VIX
          };

          HistoricalIndiaVIXData.updateOne(
            {
              datetime: record.datetime,
              timeInterval: record.timeInterval,
              stockName: record.stockName,
            },
            { $setOnInsert: record },
            { upsert: true }
          ).catch((err) => console.error(`Error saving India VIX data:`, err));
        });

        currentFromDate = currentToDate.add(1, 'minute');
      }

      res.status(200).json({
        status: 'success',
        message: 'India VIX data fetched and saved successfully',
      });
    } catch (error) {
      console.error('Error fetching India VIX data:', error);
      next(new AppError('Failed to fetch and save India VIX data', 500));
    }
  }
);
