const express = require('express');
const { createShortStraddle } = require('../controllers/StraddleController');

const router = express.Router();

router.route('/s1').post(createShortStraddle);

module.exports = router;
