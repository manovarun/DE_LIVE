// controllers/liveTradeSimulatorController.js
const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const MarketData = require('../models/Socket');
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
    const { smartApi } = await generateSessionAndFeedToken();

    // Fetch real-time BANKNIFTY spot price using SmartAPI Market Data
    const marketDataResponse = await smartApi.marketData({
      mode: 'FULL',
      exchangeTokens: { NSE: ['99926009'] }, // 99926009 = BANKNIFTY spot token
    });

    console.log(marketDataResponse?.data?.fetched);

    const spotPrice = marketDataResponse?.data?.fetched?.['99926009']?.ltp;

    if (!spotPrice) {
      console.log('❌ Failed to fetch BANKNIFTY spot price');
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch BANKNIFTY spot price',
      });
    }

    const strikeInterval = 100;
    const nearestStrike =
      Math.round(spotPrice / strikeInterval) * strikeInterval;
    const expiry = '27MAR2025';

    // const ceOption = await InstrumentData.findOne({
    //   name: 'BANKNIFTY',
    //   expiry,
    //   strike: (nearestStrike * 100).toFixed(6),
    //   symbol: { $regex: 'CE$' },
    // })
    //   .select('symbol token')
    //   .lean();

    // const peOption = await InstrumentData.findOne({
    //   name: 'BANKNIFTY',
    //   expiry,
    //   strike: (nearestStrike * 100).toFixed(6),
    //   symbol: { $regex: 'PE$' },
    // })
    //   .select('symbol token')
    //   .lean();

    // if (!ceOption || !peOption) {
    //   console.log('❌ ATM options not found');
    //   return res
    //     .status(404)
    //     .json({ success: false, message: 'ATM CE/PE options not found' });
    // }

    // const ceOrderPayload = {
    //   variety: 'NORMAL',
    //   tradingsymbol: ceOption.symbol,
    //   symboltoken: ceOption.token,
    //   transactiontype: 'SELL',
    //   exchange: 'NFO',
    //   ordertype: 'MARKET',
    //   producttype: 'INTRADAY',
    //   duration: 'DAY',
    //   price: '0',
    //   squareoff: '0',
    //   stoploss: '0',
    //   quantity: 15,
    // };

    // const peOrderPayload = {
    //   variety: 'NORMAL',
    //   tradingsymbol: peOption.symbol,
    //   symboltoken: peOption.token,
    //   transactiontype: 'SELL',
    //   exchange: 'NFO',
    //   ordertype: 'MARKET',
    //   producttype: 'INTRADAY',
    //   duration: 'DAY',
    //   price: '0',
    //   squareoff: '0',
    //   stoploss: '0',
    //   quantity: 15,
    // };

    // const ceResponse = await smartApi.placeOrder(ceOrderPayload);
    // const peResponse = await smartApi.placeOrder(peOrderPayload);

    // console.log('✅ Short Straddle Created using Live Spot Price');
    // console.log('CE Order:', ceResponse);
    // console.log('PE Order:', peResponse);

    res.status(200).json({
      success: true,
      message: 'Short Straddle executed',
      // ceOrder: ceResponse,
      // peOrder: peResponse,
    });
  } catch (err) {
    console.error('❌ Short Straddle Execution Failed:', err);
    res.status(500).json({ success: false, error: err.message || err });
  }
});

module.exports = { simulateLiveTradingFromTickData, createShortStraddleAt920 };
