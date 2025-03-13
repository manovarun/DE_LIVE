// controllers/liveTradeSimulatorController.js
const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const MarketData = require('../models/MarketData');
const InstrumentData = require('../models/Instrument');

let liveTrade = null;

const breakoutBuffer = 13;
const stopLossMultiplier = 20;
const targetMultiplier = 20;
const lotSize = 30;
const strikeInterval = 100;
const firstCandleMinute = 1;

const simulateLiveTradingFromTickData = async (startTimeStr, endTimeStr) => {
  const candleStart = moment.tz(startTimeStr, 'Asia/Kolkata');
  const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');

  const firstCandleAgg = await MarketData.aggregate([
    {
      $match: {
        tradingSymbol: 'Nifty Bank',
        exchange: 'NSE',
        exchFeedTime: {
          $gte: candleStart.format('YYYY-MM-DDTHH:mm:ssZ'),
          $lt: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        },
      },
    },
    { $sort: { exchFeedTime: 1 } },
    {
      $group: {
        _id: null,
        open: { $first: '$ltp' },
        high: { $max: '$ltp' },
        low: { $min: '$ltp' },
        close: { $last: '$ltp' },
      },
    },
  ]);

  if (!firstCandleAgg.length) return console.log('❌ First Candle Missing');
  const firstCandle = firstCandleAgg[0];

  const breakoutHigh = firstCandle.high + breakoutBuffer;
  const breakoutLow = firstCandle.low - breakoutBuffer;

  const tickData = await MarketData.find({
    tradingSymbol: 'Nifty Bank',
    exchange: 'NSE',
    exchFeedTime: {
      $gte: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
      $lte: moment
        .tz(endTimeStr, 'Asia/Kolkata')
        .format('YYYY-MM-DDTHH:mm:ssZ'),
    },
  }).sort({ exchFeedTime: 1 });

  for (const tick of tickData) {
    if (!liveTrade) {
      const direction =
        tick.ltp >= breakoutHigh
          ? 'LONG'
          : tick.ltp <= breakoutLow
          ? 'SHORT'
          : null;
      if (!direction) continue;

      const nearestStrike =
        Math.round(tick.ltp / strikeInterval) * strikeInterval;
      const selectedOptionType = direction === 'LONG' ? 'CE' : 'PE';
      const selectedExpiry = '27MAR2025';

      const optionToken = await InstrumentData.findOne({
        name: 'BANKNIFTY',
        expiry: selectedExpiry,
        strike: (nearestStrike * 100).toFixed(6),
        symbol: { $regex: selectedOptionType + '$' },
      })
        .select('token symbol expiry')
        .lean();

      if (!optionToken) continue;

      const { smartApi } = await generateSessionAndFeedToken();

      const orderPayload = {
        variety: 'NORMAL',
        tradingsymbol: optionToken.symbol,
        symboltoken: optionToken.token,
        transactiontype: direction === 'LONG' ? 'BUY' : 'SELL',
        exchange: 'NFO',
        ordertype: 'MARKET',
        producttype: 'INTRADAY',
        duration: 'DAY',
        price: '0',
        quantity: lotSize,
      };

      try {
        const orderResponse = await smartApi.placeOrder(orderPayload);
        console.log('🚀 Live Trade Placed:', orderResponse);
        liveTrade = {
          direction,
          orderDetails: orderResponse,
          entryTime: tick.exchFeedTime,
          tradingSymbol: optionToken.symbol,
          symbolToken: optionToken.token,
          lotSize,
          status: 'OPEN',
        };
      } catch (err) {
        console.error('❌ Live Order Error:', err);
      }
    }
  }
};

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
      variety: 'NORMAL',
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
      variety: 'NORMAL',
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

module.exports = { simulateLiveTradingFromTickData, createShortStraddleAt920 };
