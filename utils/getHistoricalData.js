const moment = require('moment');
const HistoricalSwingData = require('../models/Swing');

// Function to get historical data
const getHistoricalData = async ({
  stockSymbol,
  interval,
  fromDate,
  toDate,
}) => {
  try {
    // Parse the dates with moment.js
    const parsedFromDate = moment(fromDate, 'YYYY-MM-DD HH:mm')
      .utcOffset('+05:30', true)
      .format('YYYY-MM-DD HH:mm:ss');

    const parsedToDate = moment(toDate, 'YYYY-MM-DD HH:mm')
      .utcOffset('+05:30', true)
      .format('YYYY-MM-DD HH:mm:ss');

    // Prepare the query
    const query = {
      stockSymbol: stockSymbol.toUpperCase(),
      timeInterval: interval,
      datetime: {
        $gte: parsedFromDate,
        $lte: parsedToDate,
      },
    };

    // Query the database for historical data
    const historicalData = await HistoricalSwingData.find(query).sort({
      datetime: 1,
    });

    return historicalData;
  } catch (error) {
    console.error('Error fetching historical data:', error);
    throw new Error('Failed to fetch historical data');
  }
};

module.exports = getHistoricalData;
