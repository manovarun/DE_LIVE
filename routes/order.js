const express = require('express');

const {
  placeOrder,
  cancelOrder,
  modifyOrder,
  getOrderBook,
  getTradeBook,
} = require('../controllers/LiveOrderController');
const {
  createShortStraddleAt920,
} = require('../controllers/LiveTradeController/ShortStraddle');
const {
  breakoutCandleNios,
} = require('../controllers/LiveTradeController/BreakoutCandle');

const router = express.Router();

// ORDERS
router.route('/placeorder').post(placeOrder);
router.route('/cancelorder').post(cancelOrder);
router.route('/modifyorder').post(modifyOrder);
router.route('/getorderbook').post(getOrderBook);
router.route('/gettradebook').post(getTradeBook);

//LIVE TRADE
router.route('/shortstraddle').post(createShortStraddleAt920);
router.route('/breakout').post(breakoutCandleNios);

module.exports = router;
