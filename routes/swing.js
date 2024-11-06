const express = require('express');

const {
  HistoSwing,
  getSwingHistoricLive,
  getLiveMarketData,
  saveHistoSwingData,
  saveHistoSwingMultipleData,
  getNifty50Tokens,
} = require('../controllers/Swingcontroller');

const router = express.Router();

router.route('/swingtrade').get(HistoSwing);
router.route('/getNifty50Tokens').get(getNifty50Tokens);
router.route('/swingsave').post(saveHistoSwingData);
router.route('/swingmultisave').post(saveHistoSwingMultipleData);
router.route('/liveswing').post(getSwingHistoricLive);
router.route('/livemarket').post(getLiveMarketData);

module.exports = router;
