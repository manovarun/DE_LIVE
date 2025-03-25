const express = require('express');
const {
  backtestBreakoutFuturesTick,
  backtestBreakoutFuturesCandle,
  backtestBreakoutFuturesOptionsTick,
  backtestBreakoutFuturesOptionsCandle,
} = require('../controllers/BacktestController/BacktestBreakoutCandle');
const {
  backtestBuyFuturesWithSupertrend,
} = require('../controllers/BacktestController/SpreadController');

const router = express.Router();

router.route('/breakout-fut-tick').post(backtestBreakoutFuturesTick);
router.route('/breakout-fut-candle').post(backtestBreakoutFuturesCandle);
router
  .route('/breakout-fut-opt-candle')
  .post(backtestBreakoutFuturesOptionsCandle);

router.route('/breakout-fut-opt-tick').post(backtestBreakoutFuturesOptionsTick);

router.route('/buy-fut').post(backtestBuyFuturesWithSupertrend);

module.exports = router;
