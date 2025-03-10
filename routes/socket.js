const express = require('express');

const {
  getLiveSocketData,
  getBankNiftyOptionTokens,
  getLiveNSEMarketData,
} = require('../controllers/SocketController');

const router = express.Router();

router.route('/option-tokens').post(getBankNiftyOptionTokens);
router.route('/websocket').post(getLiveSocketData);
router.route('/live-nse-market').post(getLiveNSEMarketData);
module.exports = router;
