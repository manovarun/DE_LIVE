const express = require('express');
const { breakout15m } = require('../controllers/BacktestController');

const router = express.Router();

router.route('/breakout-15').get(breakout15m);

module.exports = router;
