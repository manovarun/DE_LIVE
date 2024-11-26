const axios = require('axios');
const fs = require('fs');
const moment = require('moment-timezone');
const async = require('async');
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
// Controller to fetch and save Open Interest (OI) data
exports.getSymbolDataAndFetchOI = expressAsyncHandler(
  async (req, res, next) => {
    try {
      // Path to the OpenAPIScripMaster.json file
      const filePath = './OpenAPIScripMaster.json';

      // Extract search criteria and data fetching parameters from the request body
      const {
        symbol,
        name,
        expiry,
        strike,
        exch_seg,
        interval,
        fromdate,
        todate,
      } = req.body;

      // Validate required fields
      if (!name || !expiry || !strike || !interval || !fromdate || !todate) {
        return next(
          new AppError(
            'Please provide valid name, expiry, strike, interval, fromdate, and todate',
            400
          )
        );
      }

      // Step 1: Read the OpenAPIScripMaster.json file
      const data = fs.readFileSync(filePath, 'utf8');
      const scripMaster = JSON.parse(data);

      // Step 2: Filter instruments matching the criteria
      const filteredInstruments = scripMaster.filter(
        (item) =>
          (!symbol || item.symbol === symbol) &&
          (!name || item.name === name) &&
          (!expiry || item.expiry === expiry) &&
          (!strike || parseFloat(item.strike) === parseFloat(strike)) &&
          (!exch_seg || item.exch_seg === exch_seg)
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

      // Separate CE and PE instruments
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

      // Step 3: Get session and feed token for SmartAPI
      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      const response = [];

      // Helper function to fetch OI data
      const fetchOIData = async (instrument, type) => {
        console.log(`Fetching ${type} OI data for ${instrument.symbol}`);
        const oiData = await smartApi.getOIData({
          exchange: instrument.exch_seg,
          symboltoken: instrument.token,
          interval,
          fromdate,
          todate,
        });

        if (oiData && oiData.status && oiData.data.length) {
          return oiData.data.map((entry) => ({
            datetime: entry.time,
            stockSymbol: instrument.symbol,
            type,
            openInterest: entry.oi,
          }));
        } else {
          console.error(
            `No OI data found for ${type} symbol: ${instrument.symbol}`
          );
          return [];
        }
      };

      // Fetch OI data for CE and PE
      if (ceInstrument) {
        const ceOIData = await fetchOIData(ceInstrument, 'CE');
        response.push(...ceOIData);
      }

      if (peInstrument) {
        const peOIData = await fetchOIData(peInstrument, 'PE');
        response.push(...peOIData);
      }

      // Step 4: Return the fetched data
      res.status(200).json({
        status: 'success',
        message: 'OI data fetched successfully',
        instruments: filteredInstruments,
        oiData: response,
      });
    } catch (error) {
      console.error('Error fetching OI data:', error);
      next(new AppError('Failed to fetch OI data', 500));
    }
  }
);

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

      // Map verbose interval to abbreviated format
      const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];
      if (!abbreviatedInterval) {
        return next(new AppError('Invalid interval provided', 400));
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

          // Fetch historical price data
          const histoData = await smartApi.getCandleData({
            exchange: instrument.exch_seg,
            symboltoken: instrument.token,
            interval,
            fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
            todate: currentToDate.format('YYYY-MM-DD HH:mm'),
          });

          // Fetch Open Interest (OI) data
          const oiData = await smartApi.getOIData({
            exchange: instrument.exch_seg,
            symboltoken: instrument.token,
            interval,
            fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
            todate: currentToDate.format('YYYY-MM-DD HH:mm'),
          });

          console.log(`OI Data for ${type}:`, oiData);

          if (histoData && histoData.status && histoData.data.length) {
            const candles = histoData.data.map((candle) => {
              // Find the closest OI data timestamp to the candle timestamp
              const candleTime = moment(candle[0]);
              const closestOI = oiData?.data?.reduce((closest, oiEntry) => {
                const oiTime = moment(oiEntry.time);
                const closestTime = closest ? moment(closest.time) : null;

                if (
                  !closest ||
                  Math.abs(candleTime.diff(oiTime)) <
                    Math.abs(candleTime.diff(closestTime))
                ) {
                  return oiEntry;
                }

                return closest;
              }, null);

              const record = {
                datetime: candle[0],
                expiry,
                strike,
                optionType: type,
                timeInterval: abbreviatedInterval, // Store abbreviated interval
                stockSymbol: instrument.symbol,
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5],
                openInterest: closestOI ? closestOI.oi : null, // Assign OI if found
              };

              // Save the record to MongoDB
              HistoricalOptionData.updateOne(
                {
                  datetime: record.datetime,
                  timeInterval: record.timeInterval,
                  stockSymbol: record.stockSymbol,
                  strikePrice: strike,
                  optionType: type,
                },
                { $setOnInsert: record },
                { upsert: true }
              ).catch((err) =>
                console.error(
                  `Error saving record for ${type} symbol: ${instrument.symbol}`,
                  err
                )
              );

              return record;
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

      // Fetch and save data for CE and PE in chunks
      if (ceInstrument) {
        await fetchChunkedData(ceInstrument, 'CE');
      }

      if (peInstrument) {
        await fetchChunkedData(peInstrument, 'PE');
      }

      res.status(200).json({
        status: 'success',
        message: 'Historical data fetched and saved successfully',
      });
    } catch (error) {
      console.error('Error fetching historical data:', error);
      next(new AppError('Failed to fetch and save historical data', 500));
    }
  }
);

exports.getHistoricalDataForOptionsByStrikePrices = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const filePath = './OpenAPIScripMaster.json'; // Path to the OpenAPIScripMaster.json file

      // Extract parameters from the request body
      const { name, expiry, strikePrices, fromdate, todate, interval } =
        req.body;

      if (
        !name ||
        !expiry ||
        !strikePrices ||
        !fromdate ||
        !todate ||
        !interval
      ) {
        return next(
          new AppError(
            'Please provide valid name, expiry, strikePrices, fromdate, todate, and interval',
            400
          )
        );
      }

      // Map verbose interval to abbreviated format
      const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];
      if (!abbreviatedInterval) {
        return next(new AppError('Invalid interval provided', 400));
      }

      // Step 1: Load the OpenAPIScripMaster.json file
      const data = fs.readFileSync(filePath, 'utf8');
      const scripMaster = JSON.parse(data);

      const maxDays = MAX_DAYS[interval];
      if (!maxDays) {
        return next(new AppError('Invalid interval provided', 400));
      }

      const fromDateMoment = moment(fromdate, 'YYYY-MM-DD HH:mm');
      const toDateMoment = moment(todate, 'YYYY-MM-DD HH:mm');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided', 400));
      }

      const historicalData = [];

      // Loop over each strike price
      for (const strike of strikePrices) {
        // Adjust the strike price to match the required format
        const formattedStrike = (strike * 100).toFixed(6);

        // Filter instruments for the given name, expiry, and strike price
        const filteredInstruments = scripMaster.filter(
          (item) =>
            item.name === name &&
            item.expiry === expiry &&
            item.strike === formattedStrike
        );

        if (filteredInstruments.length === 0) {
          console.warn(`No instruments found for strike: ${formattedStrike}`);
          continue;
        }

        console.log(
          `Found instruments for strike ${strike}:`,
          filteredInstruments
        );

        // Separate CE and PE instruments
        const ceInstrument = filteredInstruments.find((item) =>
          item.symbol.endsWith('CE')
        );
        const peInstrument = filteredInstruments.find((item) =>
          item.symbol.endsWith('PE')
        );

        if (!ceInstrument && !peInstrument) {
          console.warn(
            `No CE or PE instruments found for strike: ${formattedStrike}`
          );
          continue;
        }

        const { feedToken, smartApi } = await generateSessionAndFeedToken();

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

            // Fetch historical price data
            const histoData = await smartApi.getCandleData({
              exchange: instrument.exch_seg,
              symboltoken: instrument.token,
              interval,
              fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
              todate: currentToDate.format('YYYY-MM-DD HH:mm'),
            });

            // Fetch Open Interest (OI) data
            const oiData = await smartApi.getOIData({
              exchange: instrument.exch_seg,
              symboltoken: instrument.token,
              interval,
              fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
              todate: currentToDate.format('YYYY-MM-DD HH:mm'),
            });

            console.log(`OI Data for ${type} at strike ${strike}:`, oiData);

            if (histoData && histoData.status && histoData.data.length) {
              const candles = histoData.data.map((candle) => {
                const candleTime = moment(candle[0]);
                const closestOI = oiData?.data?.reduce((closest, oiEntry) => {
                  const oiTime = moment(oiEntry.time);
                  const closestTime = closest ? moment(closest.time) : null;

                  if (
                    !closest ||
                    Math.abs(candleTime.diff(oiTime)) <
                      Math.abs(candleTime.diff(closestTime))
                  ) {
                    return oiEntry;
                  }

                  return closest;
                }, null);

                const record = {
                  datetime: candle[0],
                  expiry,
                  strike,
                  optionType: type,
                  timeInterval: abbreviatedInterval,
                  stockSymbol: instrument.symbol,
                  open: candle[1],
                  high: candle[2],
                  low: candle[3],
                  close: candle[4],
                  volume: candle[5],
                  openInterest: closestOI ? closestOI.oi : null, // Assign OI if found
                };

                // Save to MongoDB
                HistoricalOptionData.updateOne(
                  {
                    datetime: record.datetime,
                    timeInterval: record.timeInterval,
                    stockSymbol: record.stockSymbol,
                    strikePrice: strike,
                    optionType: type,
                  },
                  { $setOnInsert: record },
                  { upsert: true }
                ).catch((err) =>
                  console.error(
                    `Error saving record for ${type} symbol: ${instrument.symbol}`,
                    err
                  )
                );

                return record;
              });

              instrumentData.push(...candles);
            } else {
              console.warn(
                `No price data fetched for ${type} at strike: ${strike}`
              );
            }

            // Move to the next chunk
            currentFromDate = currentToDate.add(1, 'minute');
          }

          return instrumentData;
        };

        // Fetch and save data for CE and PE in chunks
        if (ceInstrument) {
          await fetchChunkedData(ceInstrument, 'CE');
        }

        if (peInstrument) {
          await fetchChunkedData(peInstrument, 'PE');
        }
      }

      res.status(200).json({
        status: 'success',
        message:
          'Historical data fetched and saved successfully for all strike prices',
      });
    } catch (error) {
      console.error('Error fetching historical data for options:', error);
      next(
        new AppError(
          'Failed to fetch and save historical data for options',
          500
        )
      );
    }
  }
);

// exports.getHistoricalDataForOptionsByExpiryAndStrikePrices =
//   expressAsyncHandler(async (req, res, next) => {
//     try {
//       const filePath = './OpenAPIScripMaster.json'; // Path to the OpenAPIScripMaster.json file

//       // Extract parameters from the request body
//       const { name, expiryDates, strikePrices, fromdate, todate, interval } =
//         req.body;

//       if (
//         !name ||
//         !expiryDates ||
//         !strikePrices ||
//         !fromdate ||
//         !todate ||
//         !interval
//       ) {
//         return next(
//           new AppError(
//             'Please provide valid name, expiryDates, strikePrices, fromdate, todate, and interval',
//             400
//           )
//         );
//       }

//       const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];
//       if (!abbreviatedInterval) {
//         return next(new AppError('Invalid interval provided', 400));
//       }

//       const maxDays = MAX_DAYS[interval];
//       if (!maxDays) {
//         return next(new AppError('Invalid interval provided', 400));
//       }

//       const fromDateMoment = moment(fromdate, 'YYYY-MM-DD HH:mm');
//       const toDateMoment = moment(todate, 'YYYY-MM-DD HH:mm');

//       if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
//         return next(new AppError('Invalid date format provided', 400));
//       }

//       const data = fs.readFileSync(filePath, 'utf8');
//       const scripMaster = JSON.parse(data);

//       const { feedToken, smartApi } = await generateSessionAndFeedToken();

//       const fetchChunkedData = async (instrument, type, strike) => {
//         let currentFromDate = moment(fromDateMoment);
//         const instrumentData = [];

//         while (currentFromDate.isBefore(toDateMoment)) {
//           let currentToDate = moment(currentFromDate).add(maxDays, 'days');
//           if (currentToDate.isAfter(toDateMoment)) {
//             currentToDate = toDateMoment;
//           }

//           console.log(
//             `Fetching ${type} data for ${
//               instrument.symbol
//             } from ${currentFromDate.format(
//               'YYYY-MM-DD HH:mm'
//             )} to ${currentToDate.format('YYYY-MM-DD HH:mm')}`
//           );

//           const histoData = await smartApi
//             .getCandleData({
//               exchange: instrument.exch_seg,
//               symboltoken: instrument.token,
//               interval,
//               fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
//               todate: currentToDate.format('YYYY-MM-DD HH:mm'),
//             })
//             .catch((err) => {
//               console.error(
//                 `Error fetching price data for ${type} at strike: ${strike}`,
//                 err
//               );
//               return null;
//             });

//           if (!histoData || !histoData.status || !histoData.data?.length) {
//             console.warn(
//               `No price data fetched for ${type} at expiry: ${instrument.expiry} and strike: ${strike}`
//             );
//             break;
//           }

//           const oiData = await smartApi
//             .getOIData({
//               exchange: instrument.exch_seg,
//               symboltoken: instrument.token,
//               interval,
//               fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
//               todate: currentToDate.format('YYYY-MM-DD HH:mm'),
//             })
//             .catch((err) => {
//               console.error(
//                 `Error fetching OI data for ${type} at strike: ${strike}`,
//                 err
//               );
//               return { data: [] };
//             });

//           console.log(`OI Data for ${type} at strike ${strike}:`, oiData);

//           const candles = histoData.data.map((candle) => {
//             const candleTime = moment(candle[0]);
//             const closestOI = oiData?.data?.reduce((closest, oiEntry) => {
//               const oiTime = moment(oiEntry.time);
//               const closestTime = closest ? moment(closest.time) : null;

//               if (
//                 !closest ||
//                 Math.abs(candleTime.diff(oiTime)) <
//                   Math.abs(candleTime.diff(closestTime))
//               ) {
//                 return oiEntry;
//               }

//               return closest;
//             }, null);

//             const record = {
//               datetime: candle[0],
//               expiry: instrument.expiry,
//               strike: parseFloat(instrument.strike) / 100,
//               optionType: type,
//               timeInterval: abbreviatedInterval,
//               stockName: instrument.name,
//               stockSymbol: instrument.symbol,
//               open: candle[1],
//               high: candle[2],
//               low: candle[3],
//               close: candle[4],
//               volume: candle[5],
//               openInterest: closestOI ? closestOI.oi : null,
//             };

//             HistoricalOptionData.updateOne(
//               {
//                 datetime: record.datetime,
//                 timeInterval: record.timeInterval,
//                 stockSymbol: record.stockSymbol,
//                 strikePrice: record.strike,
//                 optionType: record.optionType,
//               },
//               { $setOnInsert: record },
//               { upsert: true }
//             ).catch((err) =>
//               console.error(
//                 `Error saving record for ${type} symbol: ${instrument.symbol}`,
//                 err
//               )
//             );

//             return record;
//           });

//           instrumentData.push(...candles);

//           currentFromDate = currentToDate.add(1, 'minute');
//         }

//         return instrumentData;
//       };

//       for (const expiry of expiryDates) {
//         for (const strike of strikePrices) {
//           const formattedStrike = (strike * 100).toFixed(6);

//           const filteredInstruments = scripMaster.filter(
//             (item) =>
//               item.name === name &&
//               item.expiry === expiry &&
//               item.strike === formattedStrike
//           );

//           if (filteredInstruments.length === 0) {
//             console.warn(
//               `No instruments found for expiry: ${expiry} and strike: ${formattedStrike}`
//             );
//             continue;
//           }

//           console.log(
//             `Found instruments for expiry ${expiry} and strike ${strike}:`,
//             filteredInstruments
//           );

//           const ceInstrument = filteredInstruments.find((item) =>
//             item.symbol.endsWith('CE')
//           );
//           const peInstrument = filteredInstruments.find((item) =>
//             item.symbol.endsWith('PE')
//           );

//           if (ceInstrument) {
//             await fetchChunkedData(ceInstrument, 'CE', strike);
//           }

//           if (peInstrument) {
//             await fetchChunkedData(peInstrument, 'PE', strike);
//           }
//         }
//       }

//       res.status(200).json({
//         status: 'success',
//         message:
//           'Historical data fetched and saved successfully for all expiry dates and strike prices',
//       });
//     } catch (error) {
//       console.error(
//         'Error fetching historical data for options by expiries and strike prices:',
//         error
//       );
//       next(
//         new AppError(
//           'Failed to fetch and save historical data for options',
//           500
//         )
//       );
//     }
//   });

exports.getHistoricalDataForOptionsByExpiryAndStrikePrices =
  expressAsyncHandler(async (req, res, next) => {
    try {
      const filePath = './OpenAPIScripMaster.json'; // Path to the OpenAPIScripMaster.json file

      // Extract parameters from the request body
      const { name, expiryDates, strikePrices, fromdate, todate, interval } =
        req.body;

      // Validate input
      if (
        !name ||
        !expiryDates ||
        !strikePrices ||
        !fromdate ||
        !todate ||
        !interval
      ) {
        return next(
          new AppError(
            'Please provide valid name, expiryDates, strikePrices, fromdate, todate, and interval',
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

      const data = fs.readFileSync(filePath, 'utf8');
      const scripMaster = JSON.parse(data);

      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      // Function to fetch and save data for a given instrument
      const fetchChunkedData = async (instrument, type, strike) => {
        let currentFromDate = moment(fromDateMoment);
        const bulkOperations = [];

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

          try {
            const histoData = await smartApi.getCandleData({
              exchange: instrument.exch_seg,
              symboltoken: instrument.token,
              interval,
              fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
              todate: currentToDate.format('YYYY-MM-DD HH:mm'),
            });

            if (!histoData || !histoData.data?.length) {
              console.warn(
                `No price data fetched for ${type} at expiry: ${instrument.expiry} and strike: ${strike}`
              );
              break;
            }

            const oiData = await smartApi
              .getOIData({
                exchange: instrument.exch_seg,
                symboltoken: instrument.token,
                interval,
                fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
                todate: currentToDate.format('YYYY-MM-DD HH:mm'),
              })
              .catch(() => ({ data: [] }));

            const candles = histoData.data.map((candle) => {
              const candleTime = moment(candle[0]);
              const closestOI = oiData?.data?.reduce((closest, oiEntry) => {
                const oiTime = moment(oiEntry.time);
                const closestTime = closest ? moment(closest.time) : null;

                if (
                  !closest ||
                  Math.abs(candleTime.diff(oiTime)) <
                    Math.abs(candleTime.diff(closestTime))
                ) {
                  return oiEntry;
                }
                return closest;
              }, null);

              return {
                updateOne: {
                  filter: {
                    datetime: candle[0],
                    timeInterval: abbreviatedInterval,
                    stockSymbol: instrument.symbol,
                    strikePrice: parseFloat(instrument.strike) / 100,
                    optionType: type,
                  },
                  update: {
                    $setOnInsert: {
                      datetime: candle[0],
                      expiry: instrument.expiry,
                      strike: parseFloat(instrument.strike) / 100,
                      optionType: type,
                      timeInterval: abbreviatedInterval,
                      stockName: instrument.name,
                      stockSymbol: instrument.symbol,
                      open: candle[1],
                      high: candle[2],
                      low: candle[3],
                      close: candle[4],
                      volume: candle[5],
                      openInterest: closestOI ? closestOI.oi : null,
                    },
                  },
                  upsert: true,
                },
              };
            });

            bulkOperations.push(...candles);
          } catch (error) {
            console.error(
              `Error fetching data for ${type} at strike: ${strike}`,
              error
            );
          }

          // currentFromDate = currentToDate.add(1, 'minute');
          currentFromDate = currentToDate.clone().add(1, 'minute');
        }

        // Perform bulkWrite to save all fetched data
        if (bulkOperations.length > 0) {
          await HistoricalOptionData.bulkWrite(bulkOperations).catch((err) =>
            console.error(
              `Error saving records for ${type} symbol: ${instrument.symbol}`,
              err
            )
          );
        }
      };

      for (const expiry of expiryDates) {
        for (const strike of strikePrices) {
          const formattedStrike = (strike * 100).toFixed(6);

          const filteredInstruments = scripMaster.filter(
            (item) =>
              item.name === name &&
              item.expiry === expiry &&
              item.strike === formattedStrike
          );

          if (filteredInstruments.length === 0) {
            console.warn(
              `No instruments found for expiry: ${expiry} and strike: ${formattedStrike}`
            );
            continue;
          }

          console.log(
            `Found instruments for expiry ${expiry} and strike ${strike}:`,
            filteredInstruments
          );

          const ceInstrument = filteredInstruments.find((item) =>
            item.symbol.endsWith('CE')
          );
          const peInstrument = filteredInstruments.find((item) =>
            item.symbol.endsWith('PE')
          );

          if (ceInstrument) {
            await fetchChunkedData(ceInstrument, 'CE', strike);
          }

          if (peInstrument) {
            await fetchChunkedData(peInstrument, 'PE', strike);
          }
        }
      }

      res.status(200).json({
        status: 'success',
        message:
          'Historical data fetched and saved successfully for all expiry dates and strike prices',
      });
    } catch (error) {
      console.error(
        'Error fetching historical data for options by expiries and strike prices:',
        error
      );
      next(
        new AppError(
          'Failed to fetch and save historical data for options',
          500
        )
      );
    }
  });

// exports.getHistoricalDataForOptionsByExpiryAndStrikePrices =
//   expressAsyncHandler(async (req, res, next) => {
//     try {
//       const filePath = './OpenAPIScripMaster.json'; // Path to the OpenAPIScripMaster.json file

//       // Extract parameters from the request body
//       const { name, expiryDates, strikePrices, fromdate, todate, interval } =
//         req.body;

//       // Validate input
//       if (
//         !name ||
//         !expiryDates ||
//         !strikePrices ||
//         !fromdate ||
//         !todate ||
//         !interval
//       ) {
//         return next(
//           new AppError(
//             'Please provide valid name, expiryDates, strikePrices, fromdate, todate, and interval',
//             400
//           )
//         );
//       }

//       const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];
//       if (!abbreviatedInterval) {
//         return next(new AppError('Invalid interval provided', 400));
//       }

//       const maxDays = MAX_DAYS[interval];
//       if (!maxDays) {
//         return next(new AppError('Invalid interval provided', 400));
//       }

//       const fromDateMoment = moment(fromdate, 'YYYY-MM-DD HH:mm');
//       const toDateMoment = moment(todate, 'YYYY-MM-DD HH:mm');

//       if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
//         return next(new AppError('Invalid date format provided', 400));
//       }

//       const data = fs.readFileSync(filePath, 'utf8');
//       const scripMaster = JSON.parse(data);

//       const { feedToken, smartApi } = await generateSessionAndFeedToken();

//       // Delay function
//       const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//       // Function to fetch and save data for a given instrument
//       const fetchChunkedData = async (instrument, type, strike) => {
//         let currentFromDate = moment(fromDateMoment);
//         const bulkOperations = [];
//         const MAX_RETRIES = 3;

//         while (currentFromDate.isBefore(toDateMoment)) {
//           let currentToDate = moment(currentFromDate).add(maxDays, 'days');
//           if (currentToDate.isAfter(toDateMoment)) {
//             currentToDate = toDateMoment;
//           }

//           console.log(
//             `Fetching ${type} data for ${
//               instrument.symbol
//             } from ${currentFromDate.format(
//               'YYYY-MM-DD HH:mm'
//             )} to ${currentToDate.format('YYYY-MM-DD HH:mm')}`
//           );

//           let attempts = 0;
//           let fetchedData = null;

//           while (attempts < MAX_RETRIES && !fetchedData) {
//             try {
//               const histoData = await smartApi.getCandleData({
//                 exchange: instrument.exch_seg,
//                 symboltoken: instrument.token,
//                 interval,
//                 fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
//                 todate: currentToDate.format('YYYY-MM-DD HH:mm'),
//               });

//               if (!histoData || !histoData.data?.length) {
//                 console.warn(
//                   `No data fetched for ${type} at expiry: ${instrument.expiry} and strike: ${strike}`
//                 );
//                 attempts++;
//                 await delay(1000); // Wait before retrying
//               } else {
//                 fetchedData = histoData;
//               }
//             } catch (error) {
//               console.error(
//                 `Error fetching data for ${type} at strike: ${strike}, Attempt: ${
//                   attempts + 1
//                 }`,
//                 error
//               );
//               attempts++;
//               await delay(1000); // Wait before retrying
//             }
//           }

//           if (!fetchedData) {
//             console.error(
//               `Failed to fetch data for ${type} at expiry: ${instrument.expiry} and strike: ${strike} after ${MAX_RETRIES} attempts.`
//             );
//             currentFromDate = currentToDate.add(1, 'minute');
//             continue;
//           }

//           const candles = fetchedData.data.map((candle) => ({
//             updateOne: {
//               filter: {
//                 datetime: candle[0],
//                 timeInterval: abbreviatedInterval,
//                 stockSymbol: instrument.symbol,
//                 strikePrice: parseFloat(instrument.strike) / 100,
//                 optionType: type,
//               },
//               update: {
//                 $setOnInsert: {
//                   datetime: candle[0],
//                   expiry: instrument.expiry,
//                   strike: parseFloat(instrument.strike) / 100,
//                   optionType: type,
//                   timeInterval: abbreviatedInterval,
//                   stockName: instrument.name,
//                   stockSymbol: instrument.symbol,
//                   open: candle[1],
//                   high: candle[2],
//                   low: candle[3],
//                   close: candle[4],
//                   volume: candle[5],
//                 },
//               },
//               upsert: true,
//             },
//           }));

//           bulkOperations.push(...candles);

//           console.log(
//             `Fetched ${candles.length} records for this chunk (Expiry: ${instrument.expiry}, Strike: ${strike}, Type: ${type}).`
//           );

//           currentFromDate = currentToDate.add(1, 'minute');
//           await delay(2000); // Add delay between chunks
//         }

//         if (bulkOperations.length > 0) {
//           await HistoricalOptionData.bulkWrite(bulkOperations).catch((err) =>
//             console.error(
//               `Error saving records for ${type} symbol: ${instrument.symbol}`,
//               err
//             )
//           );
//         }
//       };

//       for (const expiry of expiryDates) {
//         for (const strike of strikePrices) {
//           const formattedStrike = (strike * 100).toFixed(6);

//           const filteredInstruments = scripMaster.filter(
//             (item) =>
//               item.name === name &&
//               item.expiry === expiry &&
//               item.strike === formattedStrike
//           );

//           if (filteredInstruments.length === 0) {
//             console.warn(
//               `No instruments found for expiry: ${expiry} and strike: ${formattedStrike}`
//             );
//             continue;
//           }

//           console.log(
//             `Found instruments for expiry ${expiry} and strike ${strike}:`,
//             filteredInstruments
//           );

//           const ceInstrument = filteredInstruments.find((item) =>
//             item.symbol.endsWith('CE')
//           );
//           const peInstrument = filteredInstruments.find((item) =>
//             item.symbol.endsWith('PE')
//           );

//           if (ceInstrument) {
//             await fetchChunkedData(ceInstrument, 'CE', strike);
//           }

//           if (peInstrument) {
//             await fetchChunkedData(peInstrument, 'PE', strike);
//           }
//         }
//       }

//       res.status(200).json({
//         status: 'success',
//         message:
//           'Historical data fetched and saved successfully for all expiry dates and strike prices',
//       });
//     } catch (error) {
//       console.error(
//         'Error fetching historical data for options by expiries and strike prices:',
//         error
//       );
//       next(
//         new AppError(
//           'Failed to fetch and save historical data for options',
//           500
//         )
//       );
//     }
//   });

// Working
exports.getHistoricalDataForOptionsByExpiryAndStrikePricesIntervals =
  expressAsyncHandler(async (req, res, next) => {
    try {
      const filePath = './OpenAPIScripMaster.json'; // Path to the OpenAPIScripMaster.json file

      // Extract parameters from the request body
      const { name, expiryDates, strikePrices, intervals, fromdate, todate } =
        req.body;

      // Validate input
      if (
        !name ||
        !expiryDates ||
        !strikePrices ||
        !intervals ||
        !fromdate ||
        !todate
      ) {
        return next(
          new AppError(
            'Please provide valid name, expiryDates, strikePrices, intervals, fromdate, and todate',
            400
          )
        );
      }

      const fromDateMoment = moment(fromdate, 'YYYY-MM-DD HH:mm');
      const toDateMoment = moment(todate, 'YYYY-MM-DD HH:mm');

      if (!fromDateMoment.isValid() || !toDateMoment.isValid()) {
        return next(new AppError('Invalid date format provided', 400));
      }

      const data = fs.readFileSync(filePath, 'utf8');
      const scripMaster = JSON.parse(data);

      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      // Map of intervals to their maximum allowed days
      const MAX_DAYS = {
        ONE_MINUTE: 30,
        THREE_MINUTE: 60,
        FIVE_MINUTE: 100,
        TEN_MINUTE: 100,
        FIFTEEN_MINUTE: 200,
        THIRTY_MINUTE: 200,
        ONE_HOUR: 400,
        ONE_DAY: 2000,
      };

      // Map of intervals to their database-stored forms
      const INTERVAL_MAP = {
        ONE_MINUTE: 'M1',
        THREE_MINUTE: 'M3',
        FIVE_MINUTE: 'M5',
        TEN_MINUTE: 'M10',
        FIFTEEN_MINUTE: 'M15',
        THIRTY_MINUTE: 'M30',
        ONE_HOUR: 'H1',
        ONE_DAY: 'D1',
      };

      // Function to fetch and save data for a given instrument
      const fetchChunkedData = async (
        instrument,
        type,
        strike,
        interval,
        maxDays
      ) => {
        let currentFromDate = moment(fromDateMoment);
        const bulkOperations = [];

        while (currentFromDate.isBefore(toDateMoment)) {
          let currentToDate = moment(currentFromDate).add(maxDays, 'days');
          if (currentToDate.isAfter(toDateMoment)) {
            currentToDate = toDateMoment;
          }

          console.log(
            `Fetching ${type} data for ${
              instrument.symbol
            } (${interval}) from ${currentFromDate.format(
              'YYYY-MM-DD HH:mm'
            )} to ${currentToDate.format('YYYY-MM-DD HH:mm')}`
          );

          try {
            const histoData = await smartApi.getCandleData({
              exchange: instrument.exch_seg,
              symboltoken: instrument.token,
              interval,
              fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
              todate: currentToDate.format('YYYY-MM-DD HH:mm'),
            });

            if (!histoData || !histoData.data?.length) {
              console.warn(
                `No price data fetched for ${type} at expiry: ${instrument.expiry} and strike: ${strike}`
              );
              break;
            }

            const oiData = await smartApi
              .getOIData({
                exchange: instrument.exch_seg,
                symboltoken: instrument.token,
                interval,
                fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
                todate: currentToDate.format('YYYY-MM-DD HH:mm'),
              })
              .catch(() => ({ data: [] }));

            const candles = histoData.data.map((candle) => {
              const candleTime = moment(candle[0]);
              const closestOI = oiData?.data?.reduce((closest, oiEntry) => {
                const oiTime = moment(oiEntry.time);
                const closestTime = closest ? moment(closest.time) : null;

                if (
                  !closest ||
                  Math.abs(candleTime.diff(oiTime)) <
                    Math.abs(candleTime.diff(closestTime))
                ) {
                  return oiEntry;
                }
                return closest;
              }, null);

              // Use the abbreviated interval only for storing in the database
              const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];

              return {
                updateOne: {
                  filter: {
                    datetime: candle[0],
                    timeInterval: abbreviatedInterval,
                    stockSymbol: instrument.symbol,
                    strikePrice: parseFloat(instrument.strike) / 100,
                    optionType: type,
                  },
                  update: {
                    $setOnInsert: {
                      datetime: candle[0],
                      expiry: instrument.expiry,
                      strikePrice: parseFloat(instrument.strike) / 100,
                      optionType: type,
                      timeInterval: abbreviatedInterval,
                      stockName: instrument.name,
                      stockSymbol: instrument.symbol,
                      open: candle[1],
                      high: candle[2],
                      low: candle[3],
                      close: candle[4],
                      volume: candle[5],
                      openInterest: closestOI ? closestOI.oi : null,
                    },
                  },
                  upsert: true,
                },
              };
            });

            bulkOperations.push(...candles);
          } catch (error) {
            console.error(
              `Error fetching data for ${type} at strike: ${strike} (${interval})`,
              error
            );
          }

          currentFromDate = currentToDate.clone().add(1, 'minute');
        }

        // Perform bulkWrite to save all fetched data
        if (bulkOperations.length > 0) {
          await HistoricalOptionData.bulkWrite(bulkOperations).catch((err) =>
            console.error(
              `Error saving records for ${type} symbol: ${instrument.symbol} (${interval})`,
              err
            )
          );
        }
      };

      // Iterate over each expiry, strike, and interval
      for (const expiry of expiryDates) {
        for (const strike of strikePrices) {
          for (const interval of intervals) {
            const maxDays = MAX_DAYS[interval.toUpperCase()];
            if (!maxDays) {
              console.warn(
                `Invalid interval ${interval} provided, skipping...`
              );
              continue;
            }

            const formattedStrike = (strike * 100).toFixed(6);

            const filteredInstruments = scripMaster.filter(
              (item) =>
                item.name === name &&
                item.expiry === expiry &&
                item.strike === formattedStrike
            );

            if (filteredInstruments.length === 0) {
              console.warn(
                `No instruments found for expiry: ${expiry}, strike: ${strike}, and interval: ${interval}`
              );
              continue;
            }

            console.log(
              `Found instruments for expiry ${expiry}, strike ${strike}, and interval ${interval}:`,
              filteredInstruments
            );

            const ceInstrument = filteredInstruments.find((item) =>
              item.symbol.endsWith('CE')
            );
            const peInstrument = filteredInstruments.find((item) =>
              item.symbol.endsWith('PE')
            );

            if (ceInstrument) {
              await fetchChunkedData(
                ceInstrument,
                'CE',
                strike,
                interval,
                maxDays
              );
            }

            if (peInstrument) {
              await fetchChunkedData(
                peInstrument,
                'PE',
                strike,
                interval,
                maxDays
              );
            }
          }
        }
      }

      res.status(200).json({
        status: 'success',
        message:
          'Historical data fetched and saved successfully for all expiry dates, strike prices, and intervals',
      });
    } catch (error) {
      console.error(
        'Error fetching historical data for options by expiry dates, strike prices, and intervals:',
        error
      );
      next(
        new AppError(
          'Failed to fetch and save historical data for options',
          500
        )
      );
    }
  });

exports.getHistoricalDataForOptionsByExpiryAndStrikePricesIntervalsIndices =
  expressAsyncHandler(async (req, res, next) => {
    try {
      const filePath = './OpenAPIScripMaster.json'; // Path to the OpenAPIScripMaster.json file

      // Extract parameters from the request body
      const { requests } = req.body;

      if (!Array.isArray(requests) || requests.length === 0) {
        return next(
          new AppError(
            'Please provide an array of requests with name, expiryDates, strikePrices, intervals, fromdate, and todate for each instrument',
            400
          )
        );
      }

      const data = fs.readFileSync(filePath, 'utf8');
      const scripMaster = JSON.parse(data);

      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      // Map of intervals to their maximum allowed days
      const MAX_DAYS = {
        ONE_MINUTE: 30,
        THREE_MINUTE: 60,
        FIVE_MINUTE: 100,
        TEN_MINUTE: 100,
        FIFTEEN_MINUTE: 200,
        THIRTY_MINUTE: 200,
        ONE_HOUR: 400,
        ONE_DAY: 2000,
      };

      // Map of intervals to their database-stored forms
      const INTERVAL_MAP = {
        ONE_MINUTE: 'M1',
        THREE_MINUTE: 'M3',
        FIVE_MINUTE: 'M5',
        TEN_MINUTE: 'M10',
        FIFTEEN_MINUTE: 'M15',
        THIRTY_MINUTE: 'M30',
        ONE_HOUR: 'H1',
        ONE_DAY: 'D1',
      };

      // Function to fetch and save data for a given instrument
      const fetchChunkedData = async (
        instrument,
        type,
        strike,
        interval,
        maxDays,
        fromDateMoment,
        toDateMoment
      ) => {
        let currentFromDate = moment(fromDateMoment);
        const bulkOperations = [];

        while (currentFromDate.isBefore(toDateMoment)) {
          let currentToDate = moment(currentFromDate).add(maxDays, 'days');
          if (currentToDate.isAfter(toDateMoment)) {
            currentToDate = toDateMoment;
          }

          console.log(
            `Fetching ${type} data for ${
              instrument.symbol
            } (${interval}) from ${currentFromDate.format(
              'YYYY-MM-DD HH:mm'
            )} to ${currentToDate.format('YYYY-MM-DD HH:mm')}`
          );

          try {
            const histoData = await smartApi.getCandleData({
              exchange: instrument.exch_seg,
              symboltoken: instrument.token,
              interval,
              fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
              todate: currentToDate.format('YYYY-MM-DD HH:mm'),
            });

            if (!histoData || !histoData.data?.length) {
              console.warn(
                `No price data fetched for ${type} at expiry: ${instrument.expiry} and strike: ${strike}`
              );
              break;
            }

            const oiData = await smartApi
              .getOIData({
                exchange: instrument.exch_seg,
                symboltoken: instrument.token,
                interval,
                fromdate: currentFromDate.format('YYYY-MM-DD HH:mm'),
                todate: currentToDate.format('YYYY-MM-DD HH:mm'),
              })
              .catch(() => ({ data: [] }));

            const candles = histoData.data.map((candle) => {
              const candleTime = moment(candle[0]);
              const closestOI = oiData?.data?.reduce((closest, oiEntry) => {
                const oiTime = moment(oiEntry.time);
                const closestTime = closest ? moment(closest.time) : null;

                if (
                  !closest ||
                  Math.abs(candleTime.diff(oiTime)) <
                    Math.abs(candleTime.diff(closestTime))
                ) {
                  return oiEntry;
                }
                return closest;
              }, null);

              // Use the abbreviated interval only for storing in the database
              const abbreviatedInterval = INTERVAL_MAP[interval.toUpperCase()];

              return {
                updateOne: {
                  filter: {
                    datetime: candle[0],
                    timeInterval: abbreviatedInterval,
                    stockSymbol: instrument.symbol,
                    strikePrice: parseFloat(instrument.strike) / 100,
                    optionType: type,
                  },
                  update: {
                    $setOnInsert: {
                      datetime: candle[0],
                      expiry: instrument.expiry,
                      strikePrice: parseFloat(instrument.strike) / 100,
                      optionType: type,
                      timeInterval: abbreviatedInterval,
                      stockName: instrument.name,
                      stockSymbol: instrument.symbol,
                      open: candle[1],
                      high: candle[2],
                      low: candle[3],
                      close: candle[4],
                      volume: candle[5],
                      openInterest: closestOI ? closestOI.oi : null,
                    },
                  },
                  upsert: true,
                },
              };
            });

            bulkOperations.push(...candles);
          } catch (error) {
            console.error(
              `Error fetching data for ${type} at strike: ${strike} (${interval})`,
              error
            );
          }

          currentFromDate = currentToDate.clone().add(1, 'minute');
        }

        // Perform bulkWrite to save all fetched data
        if (bulkOperations.length > 0) {
          await HistoricalOptionData.bulkWrite(bulkOperations).catch((err) =>
            console.error(
              `Error saving records for ${type} symbol: ${instrument.symbol} (${interval})`,
              err
            )
          );
        }
      };

      // Process each request in parallel
      await Promise.all(
        requests.map(async (request) => {
          const {
            name,
            expiryDates,
            strikePrices,
            intervals,
            fromdate,
            todate,
          } = request;

          const fromDateMoment = moment(fromdate, 'YYYY-MM-DD HH:mm', true);
          const toDateMoment = moment(todate, 'YYYY-MM-DD HH:mm', true);

          for (const expiry of expiryDates) {
            for (const strike of strikePrices) {
              for (const interval of intervals) {
                const maxDays = MAX_DAYS[interval.toUpperCase()];
                if (!maxDays) {
                  console.warn(
                    `Invalid interval ${interval} provided, skipping...`
                  );
                  continue;
                }

                const formattedStrike = (strike * 100).toFixed(6);

                const filteredInstruments = scripMaster.filter(
                  (item) =>
                    item.name === name &&
                    item.expiry === expiry &&
                    item.strike === formattedStrike
                );

                if (filteredInstruments.length === 0) {
                  console.warn(
                    `No instruments found for expiry: ${expiry}, strike: ${strike}, and interval: ${interval}`
                  );
                  continue;
                }

                console.log(
                  `Found instruments for expiry ${expiry}, strike ${strike}, and interval ${interval}:`,
                  filteredInstruments
                );

                const ceInstrument = filteredInstruments.find((item) =>
                  item.symbol.endsWith('CE')
                );
                const peInstrument = filteredInstruments.find((item) =>
                  item.symbol.endsWith('PE')
                );

                if (ceInstrument) {
                  await fetchChunkedData(
                    ceInstrument,
                    'CE',
                    strike,
                    interval,
                    maxDays,
                    fromDateMoment,
                    toDateMoment
                  );
                }

                if (peInstrument) {
                  await fetchChunkedData(
                    peInstrument,
                    'PE',
                    strike,
                    interval,
                    maxDays,
                    fromDateMoment,
                    toDateMoment
                  );
                }
              }
            }
          }
        })
      );

      res.status(200).json({
        status: 'success',
        message:
          'Historical data fetched and saved successfully for all instruments, expiry dates, strike prices, and intervals',
      });
    } catch (error) {
      console.error(
        'Error fetching historical data for options by expiry dates, strike prices, and intervals:',
        error
      );
      next(
        new AppError(
          'Failed to fetch and save historical data for options',
          500
        )
      );
    }
  });
