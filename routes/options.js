const express = require('express');
const {
  getOptionData1D,
  getSymbolData,
  getHistoricalDataForOption,
  getSymbolDataAndFetchOI,
  getHistoricalDataForOptionsByStrikePrices,
  getHistoricalDataForOptionsByExpiryAndStrikePrices,
  getHistoricalDataForOptionsByExpiryAndStrikePricesIntervals,
  getHistoricalDataForOptionsByExpiryAndStrikePricesIntervalsIndices,
} = require('../controllers/OptionsController');

const router = express.Router();

router.route('/getoption1d').post(getOptionData1D);
router.route('/saveoptions').post(getHistoricalDataForOption);
router
  .route('/op-multi-strike')
  .post(getHistoricalDataForOptionsByStrikePrices);
router
  .route('/op-multi-strike-expiry')
  .post(getHistoricalDataForOptionsByExpiryAndStrikePrices);
router
  .route('/op-multi-strike-expiry-interval')
  .post(getHistoricalDataForOptionsByExpiryAndStrikePricesIntervals);
router
  .route('/op-multi-strike-expiry-interval-indices')
  .post(getHistoricalDataForOptionsByExpiryAndStrikePricesIntervalsIndices);
router.route('/getsymbol').post(getSymbolData);
router.route('/getoidata').post(getSymbolDataAndFetchOI);

module.exports = router;
