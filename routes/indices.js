const express = require('express');
const {
  saveHistoIndicesMultipleData,
} = require('../controllers/IndicesController');

const router = express.Router();

router.route('/getindices').post(saveHistoIndicesMultipleData);

module.exports = router;
