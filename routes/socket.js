const express = require('express');

const { getLiveSocketData } = require('../controllers/SocketController');

const router = express.Router();

router.route('/websocket').post(getLiveSocketData);
module.exports = router;
