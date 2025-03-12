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
} = require('../controllers/LiveTradeController');

const router = express.Router();

router.route('/placeorder').post(placeOrder);
router.route('/cancelorder').post(cancelOrder);
router.route('/modifyorder').post(modifyOrder);
router.route('/getorderbook').post(getOrderBook);
router.route('/gettradebook').post(getTradeBook);

router.route('/shortstraddle').post(createShortStraddleAt920);

module.exports = router;
