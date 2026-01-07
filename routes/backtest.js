const express = require('express');
const {
  SupertrendBullPutSpreadMainSLTPBTCController,
} = require('../controllers/SupertrendBullPutSpreadMainSLTPBTCController');
const {
  SupertrendBearCallSpreadMainSLTPBTCController,
} = require('../controllers/SupertrendBearCallSpreadMainSLTPBTCController');

const router = express.Router();

router.post('/btc-st-ce', SupertrendBearCallSpreadMainSLTPBTCController);
router.post('/btc-st-pe', SupertrendBullPutSpreadMainSLTPBTCController);

module.exports = router;
