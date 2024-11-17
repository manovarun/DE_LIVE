const express = require('express');
const {
  getHistoricalDataForIndiaVIX,
} = require('../controllers/IndiavixController');

const router = express.Router();

router.route('/getindiavix').post(getHistoricalDataForIndiaVIX);

module.exports = router;
