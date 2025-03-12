const express = require('express');

const {
  placeOrder,
  cancelOrder,
} = require('../controllers/LiveOrderController');

const router = express.Router();

router.route('/placeorder').post(placeOrder);
router.route('/cancelorder').post(cancelOrder);

module.exports = router;
