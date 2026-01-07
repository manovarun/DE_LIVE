const express = require('express');
const {
  SupertrendBullPutSpreadMainSLTPBTCController,
} = require('../controllers/SupertrendBullPutSpreadMainSLTPBTCController');

const router = express.Router();

router.post('/btc-st-pe', SupertrendBullPutSpreadMainSLTPBTCController);

module.exports = router;
