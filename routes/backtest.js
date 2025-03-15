const express = require('express');
const {
  backtestBreakoutCandleNios,
  backtestBreakoutCandleAura,
} = require('../controllers/BacktestController/BacktestBreakoutCandle');

const router = express.Router();

router.route('/breakout').post(backtestBreakoutCandleNios);
router.route('/breakout-candle').post(backtestBreakoutCandleAura);

module.exports = router;
