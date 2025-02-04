const express = require('express');
const { ShortSellingStrategy } = require('../controllers/ShortController');

const router = express.Router();

router.route('/selling').post(ShortSellingStrategy);

module.exports = router;
