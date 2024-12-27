const express = require('express');
const {
  createShortStraddleSingleDay,
  createShortStraddleMultiDay,
  createAndSaveShortStraddleMultiDay,
  gridSearchShortStraddle,
  gridSearchShortStraddleProfitOnly,
  gridSearchAndSaveShortStraddle,
  createOTMShortStraddleMultiDay,
  createOTMShortStraddleMultiEntry,
  createOTMShortStraddleMultiDayMultiExit,
  createPremiumBasedShortStraddle,
} = require('../controllers/StraddleController');

const router = express.Router();

router.route('/straddle-single-day').post(createShortStraddleSingleDay);
router.route('/straddle-multi-day').post(createShortStraddleMultiDay);
router
  .route('/straddle-multi-day-save')
  .post(createAndSaveShortStraddleMultiDay);
router.route('/straddle-multi-grid-save').post(gridSearchAndSaveShortStraddle);
router.route('/straddle-multi-grid').post(gridSearchShortStraddle);
router
  .route('/straddle-multi-grid-profit')
  .post(gridSearchShortStraddleProfitOnly);

// OTM ROUTES
router.route('/straddle-otm').post(createOTMShortStraddleMultiDay);
router.route('/straddle-otm-multi').post(createOTMShortStraddleMultiEntry);
router
  .route('/straddle-multi-exit')
  .post(createOTMShortStraddleMultiDayMultiExit);

router.route('/straddle-premium').post(createPremiumBasedShortStraddle);

module.exports = router;
