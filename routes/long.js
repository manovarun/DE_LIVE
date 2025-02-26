const express = require('express');
const {
  createFirstCandleStrategy,
} = require('../controllers/LongStraddleController');

const router = express.Router();

router.route('/first-long').post(createFirstCandleStrategy);

module.exports = router;
