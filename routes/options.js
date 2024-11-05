const express = require('express');
const { shortStraddleMeMd } = require('../controllers/OptionsController');

const router = express.Router();

//Short Straddle Multiple Expiry Multiple Day
router.route('/shortstraddlememd').get(shortStraddleMeMd);

module.exports = router;
