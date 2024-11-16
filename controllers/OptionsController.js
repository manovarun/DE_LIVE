const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const { ATR } = require('technicalindicators');
const AppError = require('../utils/AppError');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const { MAX_DAYS, INTERVAL_MAP } = require('../utils/constants');
const HistoricalOptionData = require('../models/Option');

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

exports.getOptionData1D = expressAsyncHandler(async (req, res, next) => {
  try {
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    // Fetch Candle Data for Nifty 50 to get the underlying spot value
    const { entryTime, exitTime, expiry } = req.body;

    // Fetch Nifty 50 spot price at the entry time
    const niftySpotData = await smartApi.getCandleData({
      exchange: 'NSE',
      symboltoken: '99926000', // Token for Nifty 50 index
      interval: 'TEN_MINUTE',
      fromdate: entryTime,
      todate: entryTime,
    });

    if (!niftySpotData.status || !niftySpotData.data.length) {
      return next(new AppError('Error fetching Nifty 50 data', 400));
    }

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
    let entryPriceCE = ceData.data[0][1]; // open price at entryTime
    let entryPricePE = peData.data[0][1]; // open price at entryTime

    let exitPriceCE = null;
    let exitPricePE = null;

    const formattedExitTime = moment
      .tz(exitTime, 'Asia/Kolkata')
      .utc()
      .format('YYYY-MM-DD HH:mm:ss');

    ceData.data.forEach((candle) => {
      const [timestamp, open, high, low, close] = candle;
      const formattedTimestamp = moment
        .tz(timestamp, 'Asia/Kolkata')
        .utc()
        .format('YYYY-MM-DD HH:mm:ss');
      if (formattedTimestamp === formattedExitTime && !exitPriceCE) {
        exitPriceCE = close;
      }
    });

    peData.data.forEach((candle) => {
      const [timestamp, open, high, low, close] = candle;
      const formattedTimestamp = moment
        .tz(timestamp, 'Asia/Kolkata')
        .utc()
        .format('YYYY-MM-DD HH:mm:ss');
      if (formattedTimestamp === formattedExitTime && !exitPricePE) {
        exitPricePE = close;
      }
    });

    res.status(200).json({
      status: 'success',
      niftySpotPrice: niftySpotPrice,
      nearestStrikePrice: nearestStrikePrice,
      formattedStrikePrice: formattedStrikePrice,
      entryPrices: {
        CE: entryPriceCE,
        PE: entryPricePE,
      },
      exitPrices: {
        CE: exitPriceCE,
        PE: exitPricePE,
      },
      ceToken,
      peToken,
      ceData,
      peData,
    });
  } catch (error) {
    console.error('Error during backtest:', error);
    next(error);
  }
});

// Function to get the earliest listing date for an option
const getEarliestListingDate = async (smartApi, stockToken) => {
  try {
    const earliestData = await smartApi.getCandleData({
      exchange: 'NFO',
      symboltoken: stockToken,
      interval: 'ONE_DAY',
      fromdate: '2000-01-01 00:00',
      todate: moment().format('YYYY-MM-DD HH:mm'), // Current date as end date
    });

    if (earliestData && earliestData.data && earliestData.data.length) {
      return moment(earliestData.data[0][0], 'YYYY-MM-DD HH:mm'); // First available date
    }
  } catch (error) {
    console.error('Error fetching listing date:', error);
  }
  return null;
};

// Controller to save historical options data for multiple intervals and symbols
exports.getHistoricalDataForOption = expressAsyncHandler(
  async (req, res, next) => {
    try {
      // Path to the OpenAPIScripMaster.json file
      const filePath = './OpenAPIScripMaster.json';

      // Extract parameters from the request body
      const { name, expiry, strike, fromdate, todate, interval } = req.body;

      if (!name || !expiry || !strike || !fromdate || !todate || !interval) {
        return next(
          new AppError(
            'Please provide valid name, expiry, strike, fromdate, todate, and interval',
            400
          )
        );
      }

      // Step 1: Load the OpenAPIScripMaster.json file
      const data = fs.readFileSync(filePath, 'utf8');
      const scripMaster = JSON.parse(data);

      // Step 2: Filter instruments matching the name, expiry, and strike
      const filteredInstruments = scripMaster.filter(
        (item) =>
          item.name === name &&
          item.expiry === expiry &&
          parseFloat(item.strike) === parseFloat(strike)
      );

      if (filteredInstruments.length === 0) {
        return next(
          new AppError(
            `No instruments found for name: ${name}, expiry: ${expiry}, strike: ${strike}`,
            404
          )
        );
      }

      console.log(`Found instruments: ${JSON.stringify(filteredInstruments)}`);

      // Step 3: Separate CE and PE instruments
      const ceInstrument = filteredInstruments.find((item) =>
        item.symbol.endsWith('CE')
      );
      const peInstrument = filteredInstruments.find((item) =>
        item.symbol.endsWith('PE')
      );

      if (!ceInstrument && !peInstrument) {
        return next(
          new AppError(
            `No CE or PE instruments found for name: ${name}, expiry: ${expiry}, strike: ${strike}`,
            404
          )
        );
      }

      // Step 4: Get session and feed token for SmartAPI
      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      const historicalData = [];

      const maxDays = MAX_DAYS[interval];
      if (!maxDays) {
        return next(new AppError('Invalid interval provided', 400));
      }

      const fromDateMoment = moment(fromdate, 'YYYY-MM-DD HH:mm');
      const toDateMoment = moment(todate, 'YYYY-MM-DD HH:mm');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided', 400));
      }

      // Helper function to fetch data in chunks
      const fetchChunkedData = async (instrument, type) => {
        let currentFromDate = moment(fromDateMoment);
        const instrumentData = [];

        while (currentFromDate.isBefore(toDateMoment)) {
          let currentToDate = moment(currentFromDate).add(maxDays, 'days');
          if (currentToDate.isAfter(toDateMoment)) {
            currentToDate = toDateMoment;
          }

          console.log(
            `Fetching ${type} data for ${
              instrument.symbol
            } from ${currentFromDate.format(
              'YYYY-MM-DD HH:mm'
            )} to ${currentToDate.format('YYYY-MM-DD HH:mm')}`
          );

          // Fetch historical data for the current chunk
          const histoData = await smartApi.getCandleData({
            exchange: instrument.exch_seg,
            symboltoken: instrument.token,
            interval,
            fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
            todate: currentToDate.format('YYYY-MM-DD HH:mm'),
          });

          // Fetch open interest (OI) data for the current chunk
          const oiData = await smartApi.getOIData({
            exchange: instrument.exch_seg,
            symboltoken: instrument.token,
            interval,
            fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
            todate: currentToDate.format('YYYY-MM-DD HH:mm'),
          });

          console.log('IO Data', oiData);

          // Combine price data and OI data
          if (histoData && histoData.status && histoData.data.length) {
            const candles = histoData.data.map((candle, index) => {
              const oiValue = oiData?.data[index]?.openInterest || null; // Get OI if available
              return {
                datetime: candle[0],
                expiry,
                strike,
                type,
                interval,
                stockSymbol: instrument.symbol,
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5],
                openInterest: oiValue, // Add OI to the data
              };
            });
            instrumentData.push(...candles);
          } else {
            console.error(
              `No price data fetched for ${type} symbol: ${instrument.symbol}`
            );
          }

          // Move to the next chunk
          currentFromDate = currentToDate.add(1, 'minute'); // Start next chunk 1 minute after the last chunk
        }

        return instrumentData;
      };

      // Fetch data for CE and PE in chunks
      if (ceInstrument) {
        const ceData = await fetchChunkedData(ceInstrument, 'CE');
        historicalData.push(...ceData);
      }

      if (peInstrument) {
        const peData = await fetchChunkedData(peInstrument, 'PE');
        historicalData.push(...peData);
      }

      // Step 7: Return aggregated historical data for both CE and PE
      res.status(200).json({
        status: 'success',
        message: 'Historical data fetched successfully',
        ceInstrument,
        peInstrument,
        historicalData,
      });
    } catch (error) {
      console.error('Error fetching historical data:', error);
      next(new AppError('Failed to fetch historical data', 500));
    }
  }
);
