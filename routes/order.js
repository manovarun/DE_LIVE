const express = require('express');

const {
  SuperTrendBearCallSpreadPaperTradeBTCController,
} = require('../controllers/SuperTrendBearCallSpreadPaperTradeBTCController');
const {
  SuperTrendBullPutSpreadPaperTradeBTCController,
} = require('../controllers/SuperTrendBullPutSpreadPaperTradeBTCController');

const router = express.Router();

router.post('/st-bcs-paper', SuperTrendBearCallSpreadPaperTradeBTCController);
router.post('/st-bps-paper', SuperTrendBullPutSpreadPaperTradeBTCController);

module.exports = router;
