const express = require('express');
const {
  backtestBreakoutCandleNios,
} = require('../controllers/BacktestController/BacktestBreakoutCandle');

const router = express.Router();

router.route('/breakout').post(backtestBreakoutCandleNios);

module.exports = router;
