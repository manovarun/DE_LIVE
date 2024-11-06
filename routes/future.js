const express = require('express');

const {
  getNiftyFuture,
  getHistoricalFutData,
} = require('../controllers/FutureController');

const router = express.Router();

router.route('/niftyfut').get(getNiftyFuture);
router.route('/niftyfut-histo').get(getHistoricalFutData);

module.exports = router;
