const express = require('express');
const {
  createOTMShortStrangleMultiDayMultiExitStrike,
} = require('../controllers/StrangleController');

const router = express.Router();

router
  .route('/otm-strangle')
  .post(createOTMShortStrangleMultiDayMultiExitStrike);

module.exports = router;
