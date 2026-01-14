const express = require('express');

const {
  SuperTrendBearCallSpreadLiveTradeBTCController,
} = require('../controllers/SuperTrendBearCallSpreadLiveTradeBTCController');
const {
  SuperTrendBullPutSpreadLiveTradeBTCController,
} = require('../controllers/SuperTrendBullPutSpreadLiveTradeBTCController');

const router = express.Router();

router.post('/st-bcs-live', SuperTrendBearCallSpreadLiveTradeBTCController);
router.post('/st-bps-live', SuperTrendBullPutSpreadLiveTradeBTCController);

module.exports = router;
