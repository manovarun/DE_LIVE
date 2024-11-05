const express = require('express');

const {
  HistoSwing,
  getSwingHistoricLive,
  getLiveMarketData,
} = require('../controllers/Swingcontroller');

const router = express.Router();

router.route('/swingtrade').get(HistoSwing);

router.route('/liveswing').post(getSwingHistoricLive);
router.route('/livemarket').post(getLiveMarketData);

module.exports = router;
