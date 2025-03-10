const express = require('express');
const {
  createFirstCandleStrategy,
  createFirstCandleStrategyATR,
} = require('../controllers/LongStraddleController');

const router = express.Router();

router.route('/first-long').post(createFirstCandleStrategy);
// router.route('/first-long-atr').post(createFirstCandleStrategyATR);

module.exports = router;
