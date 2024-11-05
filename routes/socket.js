const express = require('express');

const {
  getLiveSocketData,
  getLiveSocketPaperTrade,
} = require('../controllers/SocketController');

const router = express.Router();

router.route('/websocket').post(getLiveSocketData);
router.route('/papertrade').post(getLiveSocketPaperTrade);

module.exports = router;
