const express = require('express');
const {
  getOptionData1D,
  getSymbolData,
  getHistoricalDataForOption,
  getSymbolDataAndFetchOI,
} = require('../controllers/OptionsController');

const router = express.Router();

router.route('/getoption1d').post(getOptionData1D);
router.route('/saveoptions').post(getHistoricalDataForOption);
router.route('/getsymbol').post(getSymbolData);
router.route('/getoidata').post(getSymbolDataAndFetchOI);

module.exports = router;
