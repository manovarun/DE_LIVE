const moment = require('moment');
const HistoricalSwingData = require('../models/Swing');

const getHistoricalData = async ({
  stockSymbol,
  interval,
  fromDate,
  toDate,
}) => {
  try {
    // Format dates directly in IST without timezone conversion
    const parsedFromDate = moment(fromDate, 'YYYY-MM-DD HH:mm').format(
      'YYYY-MM-DD HH:mm:ss'
    );
    const parsedToDate = moment(toDate, 'YYYY-MM-DD HH:mm').format(
      'YYYY-MM-DD HH:mm:ss'
    );

    const query = {
      stockSymbol: stockSymbol.toUpperCase(),
      timeInterval: interval,
      datetime: {
        $gte: parsedFromDate,
        $lte: parsedToDate,
      },
    };

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
