const express = require('express');
const {
  createShortStraddleSingleDay,
  createShortStraddleMultiDay,
} = require('../controllers/StraddleController');

const router = express.Router();

router.route('/straddle-single-day').post(createShortStraddleSingleDay);
router.route('/straddle-multi-day').post(createShortStraddleMultiDay);

module.exports = router;
