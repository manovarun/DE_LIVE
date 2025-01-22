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
  createAndSaveShortStraddleWithIndicators,
  createOTMShortStraddleMultiDayByDays,
  saveGridSearchForSelectedWeekDays,
  gridSearchAndSaveShortStraddleStrike,
  createOTMShortStraddleMultiDayMultiExitStrike,
  saveGridSearchForSelectedWeekDaysStrike,
} = require('../controllers/StraddleController');

const router = express.Router();

router.route('/straddle-single-day').post(createShortStraddleSingleDay);
router.route('/straddle-multi-day').post(createShortStraddleMultiDay);
router
  .route('/straddle-multi-day-save')
  .post(createAndSaveShortStraddleMultiDay);
router.route('/straddle-multi-grid-save').post(gridSearchAndSaveShortStraddle);
router
  .route('/straddle-multi-grid-strike-save')
  .post(gridSearchAndSaveShortStraddleStrike);
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
router
  .route('/straddle-multi-exit-strike')
  .post(createOTMShortStraddleMultiDayMultiExitStrike);

router.route('/straddle-premium').post(createPremiumBasedShortStraddle);
router.route('/straddle-vix-io').post(createAndSaveShortStraddleWithIndicators);
router.route('/straddle-weekdays').post(createOTMShortStraddleMultiDayByDays);
router.route('/straddle-weekdays-grid').post(saveGridSearchForSelectedWeekDays);
router
  .route('/straddle-weekdays-grid-stike')
  .post(saveGridSearchForSelectedWeekDaysStrike);
module.exports = router;
