// controllers/liveOrderController.js
const expressAsyncHandler = require('express-async-handler');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const { body, validationResult } = require('express-validator');

const validateOrder = [
  body('tradingsymbol').notEmpty().withMessage('tradingsymbol is required'),
  body('symboltoken').notEmpty().withMessage('symboltoken is required'),
  body('transactiontype').notEmpty().withMessage('transactiontype is required'),
  body('quantity')
    .notEmpty()
    .withMessage('quantity is required')
    .isNumeric()
    .withMessage('quantity must be a number'),
];

const placeOrder = [
  ...validateOrder,
  expressAsyncHandler(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { feedToken, smartApi } = await generateSessionAndFeedToken();

      const clientCode = process.env.SMARTAPI_CLIENT_CODE;
      const apiKey = process.env.SMARTAPI_KEY;

      if (!feedToken || !apiKey || !clientCode) {
        return next(
          new AppError('Missing required credentials for the connection', 500)
        );
      }

      const {
        variety = 'NORMAL',
        tradingsymbol,
        symboltoken,
        transactiontype,
        exchange = 'NSE',
        ordertype = 'MARKET',
        producttype = 'DELIVERY',
        duration = 'DAY',
        price = '0',
        squareoff = '0',
        stoploss = '0',
        quantity,
      } = req.body;

      const sanitizedPrice = ordertype === 'MARKET' ? '0' : price;

      const orderPayload = {
        variety,
        tradingsymbol,
        symboltoken,
        transactiontype,
        exchange,
        ordertype,
        producttype,
        duration,
        price: sanitizedPrice,
        squareoff,
        stoploss,
        quantity,
      };

      const orderResponse = await smartApi.placeOrder(orderPayload);
      console.log('📌 Order Response:', orderResponse);
      res.status(200).json({ success: true, data: orderResponse });
    } catch (error) {
      console.error('❌ Error placing order:', error);
      res.status(500).json({ success: false, error: error.message || error });
    }
  }),
];

const cancelOrder = expressAsyncHandler(async (req, res, next) => {
  try {
    const { smartApi } = await generateSessionAndFeedToken();
    const orderResponse = await smartApi.cancelOrder(req.body);
    console.log('🗑️ Order Cancelled:', orderResponse);
    res.status(200).json({ success: true, data: orderResponse });
  } catch (error) {
    console.error('❌ Error cancelling order:', error);
    res.status(500).json({ success: false, error: error.message || error });
  }
});

const modifyOrder = expressAsyncHandler(async (req, res, next) => {
  try {
    const { smartApi } = await generateSessionAndFeedToken();
    const orderResponse = await smartApi.modifyOrder(req.body);
    console.log('✏️ Order Modified:', orderResponse);
    res.status(200).json({ success: true, data: orderResponse });
  } catch (error) {
    console.error('❌ Error modifying order:', error);
    res.status(500).json({ success: false, error: error.message || error });
  }
});

const getOrderBook = expressAsyncHandler(async (req, res, next) => {
  try {
    const { smartApi } = await generateSessionAndFeedToken();
    const orderBook = await smartApi.getOrderBook();
    res.status(200).json({ success: true, data: orderBook });
  } catch (error) {
    console.error('❌ Error getting order book:', error);
    res.status(500).json({ success: false, error: error.message || error });
  }
});

const getTradeBook = expressAsyncHandler(async (req, res, next) => {
  try {
    const { smartApi } = await generateSessionAndFeedToken();
    const tradeBook = await smartApi.getTradeBook();
    res.status(200).json({ success: true, data: tradeBook });
  } catch (error) {
    console.error('❌ Error getting trade book:', error);
    res.status(500).json({ success: false, error: error.message || error });
  }
});

module.exports = {
  placeOrder,
  modifyOrder,
  cancelOrder,
  getOrderBook,
  getTradeBook,
};
