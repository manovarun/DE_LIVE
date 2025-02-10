const express = require('express');
const {
  createOTMShortStrangle,
  createOTMShortStrangleMultiDayMultiExitStrikeIronCondor,
} = require('../controllers/StrangleController');

const router = express.Router();

router.route('/otm-strangle').post(createOTMShortStrangle);
router
  .route('/otm-strangle-iron-condor')
  .post(createOTMShortStrangleMultiDayMultiExitStrikeIronCondor);

module.exports = router;
