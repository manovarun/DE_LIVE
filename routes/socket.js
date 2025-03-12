const express = require('express');

const {
  getLiveSocketData,
  getBankNiftyOptionTokens,
  getLiveNSEMarketData,
} = require('../controllers/SocketController');
const {
  runLiveBreakoutFromBacktestStrategy,
} = require('../controllers/PaperController');
const {
  simulatePaperTradingFromTickData,
} = require('../controllers/SimulatorController');

const router = express.Router();

router.route('/option-tokens').post(getBankNiftyOptionTokens);
router.route('/websocket').post(getLiveSocketData);
router.route('/live-nse-market').post(getLiveNSEMarketData);
router.route('/paper').post(runLiveBreakoutFromBacktestStrategy);
router.route('/simultor').post(simulatePaperTradingFromTickData);

module.exports = router;
