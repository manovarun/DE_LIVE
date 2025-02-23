const express = require('express');
const {
  createOTMShortStrangleMultiDayMultiExitStrikeIronCondor,
  createOTMShortStrangleMultiExpiry,
  createOTMShortStrangleMultiExpiryStopLoss,
  OTMShortStrangle,
  createOTMShortStrangleNSL,
  OTMShortStrangleVix,
} = require('../controllers/StrangleController');

const router = express.Router();

router.route('/otm-strangle').post(OTMShortStrangle);
router.route('/otm-strangle-vix').post(OTMShortStrangleVix);
router.route('/create-otm-strangle').post(createOTMShortStrangleNSL);
router
  .route('/otm-strangle-multi-expiry')
  .post(createOTMShortStrangleMultiExpiry);
router
  .route('/otm-strangle-multi-expiry-stoploss')
  .post(createOTMShortStrangleMultiExpiryStopLoss);
router
  .route('/otm-strangle-iron-condor')
  .post(createOTMShortStrangleMultiDayMultiExitStrikeIronCondor);

module.exports = router;
