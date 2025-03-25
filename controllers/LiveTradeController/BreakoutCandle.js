// controllers/breakoutCandleLiveTrade.js
const moment = require('moment-timezone');
const axios = require('axios');
const expressAsyncHandler = require('express-async-handler');
const cron = require('node-cron');
const { WebSocketV2 } = require('smartapi-javascript');
const InstrumentData = require('../../models/Instrument');
const MarketData = require('../../models/MarketData');
const { generateSessionAndFeedToken } = require('../../utils/AppSession');

let liveTrade = null;

const breakoutBuffer = 13;
const stopLossMultiplier = 20;
const targetMultiplier = 20;
const lotSize = 30;
const strikeInterval = 100;
const firstCandleMinute = 1;
const maxWebSocketRetries = 3;
const stopLossLimitBuffer = 1.5;

const breakoutCandleNios = expressAsyncHandler(async (req, res, next) => {
  const { startTimeStr, endTimeStr } = req.body;

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

  if (!firstCandleAgg.length)
    return res
      .status(400)
      .json({ success: false, message: '❌ First Candle Missing' });

  const firstCandle = firstCandleAgg[0];

  console.log(`First ${firstCandleMinute} minute Candle:`, firstCandle);

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

  const { feedToken, smartApi } = await generateSessionAndFeedToken();

  const clientCode = process.env.SMARTAPI_CLIENT_CODE;
  const apiKey = process.env.SMARTAPI_KEY;

  // Validate required credentials
  if (!feedToken || !apiKey || !clientCode) {
    return next(
      new AppError('Missing required credentials for WebSocket connection', 500)
    );
  }

  if (!feedToken) {
    console.error('❌ Feed Token is missing. Session may have failed.');
    return res
      .status(500)
      .json({ success: false, message: 'Feed Token missing' });
  }

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

      console.log('nearestStrike', nearestStrike);

      const optionToken = await InstrumentData.findOne({
        name: 'BANKNIFTY',
        expiry: selectedExpiry,
        strike: (nearestStrike * 100).toFixed(6),
        symbol: { $regex: selectedOptionType + '$' },
      })
        .select('token symbol expiry')
        .lean();

      if (!optionToken) continue;

      const entryTick = await MarketData.findOne({
        symbolToken: optionToken.token,
      })
        .sort({ exchFeedTime: -1 })
        .lean();

      const entryPrice = entryTick?.ltp || tick.ltp;
      const stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(
        2
      );
      const target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);
      const rrRatio = (target - entryPrice) / (entryPrice - stopLoss);

      const orderPayload = {
        variety: 'NORMAL',
        tradingsymbol: optionToken.symbol,
        symboltoken: optionToken.token,
        transactiontype: 'BUY',
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

        let slLimitPrice = +(stopLoss - stopLossLimitBuffer).toFixed(2);
        if (slLimitPrice < stopLoss) {
          slLimitPrice = stopLoss;
        }

        const stopLossOrderPayload = {
          variety: 'STOPLOSS',
          tradingsymbol: optionToken.symbol,
          symboltoken: optionToken.token,
          transactiontype: 'SELL',
          exchange: 'NFO',
          ordertype: 'STOPLOSS_LIMIT',
          producttype: 'INTRADAY',
          duration: 'DAY',
          price: slLimitPrice.toFixed(2),
          triggerprice: stopLoss.toFixed(2),
          quantity: lotSize,
        };

        // Delay SL order slightly to ensure entry executes first
        setTimeout(async () => {
          try {
            const slOrderResponse = await smartApi.placeOrder(
              stopLossOrderPayload
            );
            console.log('📛 Stop Loss Order Placed:', slOrderResponse);

            liveTrade.slOrderId = slOrderResponse.data?.orderid || null;
            liveTrade.slOrderStatus = slOrderResponse.status || 'Unknown';
          } catch (slErr) {
            console.error('❌ SL Order Placement Failed:', slErr);
          }
        }, 1500); // Delay by 1.5 sec

        liveTrade = {
          date: moment().tz('Asia/Kolkata').format('YYYY-MM-DD'),
          firstCandleMinute,
          direction,
          tradingSymbol: optionToken.symbol,
          symbolToken: optionToken.token,
          nearestStrike,
          selectedOptionType,
          expiry: selectedExpiry,
          entryPrice,
          stopLoss,
          target,
          rrRatio,
          entryTime: tick.exchFeedTime,
          lotSize,
          status: 'OPEN',
          entryOrderId: orderResponse.data?.orderid || null,
          retryTimestamps: [],
        };

        console.log('liveTrade', liveTrade);

        const setupWebSocket = (retryCount = 0) => {
          const retryTimestamp = moment().format('YYYY-MM-DD HH:mm:ss');
          liveTrade.retryTimestamps.push(retryTimestamp);

          const webSocket = new WebSocketV2({
            jwttoken: feedToken,
            apikey: apiKey,
            clientcode: clientCode,
            feedtype: feedToken,
          });

          webSocket
            .connect()
            .then(() => {
              console.log('📡 WebSocket Connected for SL/Target Monitoring');

              const jsonReq = {
                correlationID: 'LTP_MONITOR',
                action: 1,
                mode: 1,
                exchangeType: 2,
                tokens: [optionToken.token],
              };

              webSocket.fetchData(jsonReq);

              webSocket.on('tick', async (tickData) => {
                try {
                  const ltp = tickData.last_traded_price / 100;
                  if (liveTrade.status === 'OPEN') {
                    let exitReason = null;
                    if (ltp <= liveTrade.stopLoss) exitReason = 'Stop Loss Hit';
                    else if (ltp >= liveTrade.target) exitReason = 'Target Hit';

                    if (exitReason) {
                      liveTrade.status = 'CLOSED';
                      liveTrade.exitReason = exitReason;
                      liveTrade.exitLtp = ltp;
                      liveTrade.exitTime = new Date().toISOString();

                      const exitOrderPayload = {
                        variety: 'NORMAL',
                        tradingsymbol: liveTrade.tradingSymbol,
                        symboltoken: liveTrade.symbolToken,
                        transactiontype: 'SELL',
                        exchange: 'NFO',
                        ordertype: 'MARKET',
                        producttype: 'INTRADAY',
                        duration: 'DAY',
                        price: '0',
                        quantity: liveTrade.lotSize,
                      };

                      try {
                        const exitRes = await smartApi.placeOrder(
                          exitOrderPayload
                        );
                        console.log(`🔔 Trade Closed: ${exitReason}`);
                        if (liveTrade.slOrderId) {
                          liveTrade.slCancelResponse =
                            await smartApi.cancelOrder({
                              variety: 'NORMAL',
                              orderid: liveTrade.slOrderId,
                            });
                          console.log('❎ SL Order Cancelled after exit');
                        }
                        webSocket.close();
                      } catch (exitErr) {
                        console.error('❌ Exit Order Failed:', exitErr);
                      }
                    }
                  }
                } catch (tickErr) {
                  console.error(
                    '⚠️ Error inside WebSocket Tick Handler:',
                    tickErr
                  );
                }
              });

              webSocket.on('error', (err) =>
                console.error('WebSocket Error:', err)
              );
              webSocket.on('close', () => {
                if (
                  liveTrade.status === 'OPEN' &&
                  retryCount < maxWebSocketRetries
                ) {
                  console.log(`🔁 Retrying WebSocket (${retryCount + 1})...`);
                  setTimeout(() => setupWebSocket(retryCount + 1), 2000);
                }
              });
            })
            .catch((err) => {
              console.error('WebSocket Initial Connection Failed:', err);
              if (retryCount < maxWebSocketRetries) {
                setTimeout(() => setupWebSocket(retryCount + 1), 2000);
              }
            });
        };

        setupWebSocket();

        return res.status(200).json({
          success: true,
          message: 'Live trade and SL order placed',
          data: liveTrade,
        });
      } catch (err) {
        console.error('❌ Live Order Error:', err);
        return res.status(500).json({
          success: false,
          message: 'Order placement failed',
          error: err.message,
        });
      }
    }
  }

  if (!liveTrade)
    return res.status(200).json({
      success: true,
      message: 'No breakout happened in given interval',
    });
});

// Schedule breakout trade at 09:16 AM IST
// cron.schedule('00 16 09 * * 1-5', async () => {
//   const today = moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
//   const startTimeStr = `${today} 09:15:00`;
//   const endTimeStr = `${today} 09:50:00`;

//   try {
//     const response = await axios.post(
//       'http://localhost:9000/api/order/breakout',
//       {
//         startTimeStr,
//         endTimeStr,
//       }
//     );

//     console.log('✅ Cron Triggered Breakout Trade:', response.data);
//   } catch (err) {
//     console.error('❌ Cron Trade Trigger Failed:', err.message);
//   }
// });

module.exports = { breakoutCandleNios };
