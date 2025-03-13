// controllers/liveTradeSimulatorController.js
const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const { generateSessionAndFeedToken } = require('../../utils/AppSession');
const MarketData = require('../../models/MarketData');
const InstrumentData = require('../../models/Instrument');

const createShortStraddleAt920 = expressAsyncHandler(async (req, res, next) => {
  try {
    const now = moment().tz('Asia/Kolkata');
    const latestTick = await MarketData.findOne({
      tradingSymbol: 'Nifty Bank',
      exchange: 'NSE',
    })
      .sort({ exchFeedTime: -1 })
      .lean();

    const spotPrice = latestTick?.ltp;

    if (!spotPrice) {
      console.log('❌ Failed to fetch BANKNIFTY spot price from DB');
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch BANKNIFTY spot price from DB',
      });
    }

    const { smartApi } = await generateSessionAndFeedToken();

    const strikeInterval = 100;
    const nearestStrike =
      Math.round(spotPrice / strikeInterval) * strikeInterval;
    const expiry = '27MAR2025';

    const ceOption = await InstrumentData.findOne({
      name: 'BANKNIFTY',
      expiry,
      strike: (nearestStrike * 100).toFixed(6),
      symbol: { $regex: 'CE$' },
    })
      .select('symbol token')
      .lean();

    const peOption = await InstrumentData.findOne({
      name: 'BANKNIFTY',
      expiry,
      strike: (nearestStrike * 100).toFixed(6),
      symbol: { $regex: 'PE$' },
    })
      .select('symbol token')
      .lean();

    if (!ceOption || !peOption) {
      console.log('❌ ATM options not found');
      return res
        .status(404)
        .json({ success: false, message: 'ATM CE/PE options not found' });
    }

    // PLACE SHORT STRADDLE CE & PE FIRST
    const ceSellPayload = {
      variety: 'NORMAL',
      tradingsymbol: ceOption.symbol,
      symboltoken: ceOption.token,
      transactiontype: 'SELL',
      exchange: 'NFO',
      ordertype: 'MARKET',
      producttype: 'INTRADAY',
      duration: 'DAY',
      price: '0',
      squareoff: '0',
      stoploss: '0',
      quantity: 30,
    };

    const peSellPayload = {
      variety: 'NORMAL',
      tradingsymbol: peOption.symbol,
      symboltoken: peOption.token,
      transactiontype: 'SELL',
      exchange: 'NFO',
      ordertype: 'MARKET',
      producttype: 'INTRADAY',
      duration: 'DAY',
      price: '0',
      squareoff: '0',
      stoploss: '0',
      quantity: 30,
    };

    const ceSellResponse = await smartApi.placeOrder(ceSellPayload);
    const peSellResponse = await smartApi.placeOrder(peSellPayload);

    // FETCH ENTRY LTP FROM DB FOR SL CALCULATION
    const ceEntry = await MarketData.findOne({ symbolToken: ceOption.token })
      .sort({ exchFeedTime: -1 })
      .lean();
    const peEntry = await MarketData.findOne({ symbolToken: peOption.token })
      .sort({ exchFeedTime: -1 })
      .lean();

    const ceLTP = ceEntry?.ltp || 0;
    const peLTP = peEntry?.ltp || 0;

    const ceSLTrigger = +(ceLTP * 1.25).toFixed(2);
    const peSLTrigger = +(peLTP * 1.25).toFixed(2);

    // PLACE SL-M ORDERS
    const ceSLPayload = {
      variety: 'STOPLOSS',
      tradingsymbol: ceOption.symbol,
      symboltoken: ceOption.token,
      transactiontype: 'BUY',
      exchange: 'NFO',
      ordertype: 'STOPLOSS_LIMIT',
      producttype: 'INTRADAY',
      duration: 'DAY',
      price: +(ceSLTrigger + 5).toFixed(2), // limit price slightly above trigger
      triggerprice: ceSLTrigger,
      quantity: 30,
    };

    const peSLPayload = {
      variety: 'STOPLOSS',
      tradingsymbol: peOption.symbol,
      symboltoken: peOption.token,
      transactiontype: 'BUY',
      exchange: 'NFO',
      ordertype: 'STOPLOSS_LIMIT',
      producttype: 'INTRADAY',
      duration: 'DAY',
      price: +(peSLTrigger + 5).toFixed(2), // limit price slightly above trigger
      triggerprice: peSLTrigger,
      quantity: 30,
    };

    const ceSLResponse = await smartApi.placeOrder(ceSLPayload);
    const peSLResponse = await smartApi.placeOrder(peSLPayload);

    console.log('✅ Short Straddle Created with 25% SL');
    console.log('CE Sell:', ceSellResponse);
    console.log('PE Sell:', peSellResponse);
    console.log('CE SL:', ceSLPayload);
    console.log('PE SL:', peSLPayload);

    res.status(200).json({
      success: true,
      message: 'Short Straddle executed with SL',
      ceSellOrder: ceSellResponse,
      peSellOrder: peSellResponse,
      ceSLOrder: ceSLResponse,
      peSLOrder: peSLResponse,
    });
  } catch (err) {
    console.error('❌ Short Straddle Execution Failed:', err);
    res.status(500).json({ success: false, error: err.message || err });
  }
});

module.exports = { createShortStraddleAt920 };
