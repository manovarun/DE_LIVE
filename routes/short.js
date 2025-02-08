const express = require('express');
const { gridSearchSellingOptions } = require('../controllers/ShortController');

const router = express.Router();

router.route('/selling').post(gridSearchSellingOptions);

module.exports = router;
