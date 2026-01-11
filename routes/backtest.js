const express = require('express');

const {
  SuperTrendBearCallSpreadPaperTradeBTCController,
} = require('../controllers/SuperTrendBearCallSpreadPaperTradeBTCController');

const router = express.Router();

router.post('/st-bcs-paper', SuperTrendBearCallSpreadPaperTradeBTCController);

module.exports = router;
