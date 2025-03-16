const express = require('express');
const {
  backtestBreakoutCandleNios,
  backtestBreakoutCandleAura,
  backtestBreakoutFuturesNios,
  backtestBreakoutFuturesAura,
} = require('../controllers/BacktestController/BacktestBreakoutCandle');

const router = express.Router();

router.route('/breakout').post(backtestBreakoutCandleNios);
router.route('/breakout-candle').post(backtestBreakoutCandleAura);
router.route('/breakout-fut').post(backtestBreakoutFuturesNios);
router.route('/breakout-future-candle').post(backtestBreakoutFuturesAura);

module.exports = router;
