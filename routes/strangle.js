const express = require('express');
const {
  createOTMShortStrangle,
  createOTMShortStrangleMultiDayMultiExitStrikeIronCondor,
  createOTMShortStrangleMultiExpiry,
  createOTMShortStrangleMultiExpiryStopLoss,
  OTMShortStrangle,
} = require('../controllers/StrangleController');

const router = express.Router();

router.route('/otm-strangle').post(OTMShortStrangle);
router.route('/create-otm-strangle').post(createOTMShortStrangle);
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
