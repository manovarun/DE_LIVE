const moment = require('moment-timezone');
const expressAsyncHandler = require('express-async-handler');
const cron = require('node-cron');
const axios = require('axios');
const { WebSocketV2 } = require('smartapi-javascript');
const MarketData = require('../../models/MarketData');
const InstrumentData = require('../../models/Instrument');
const { generateSessionAndFeedToken } = require('../../utils/AppSession');
const { isDragonflyDoji } = require('../../utils/CandlePatterns');

let liveTrade = null;

exports.liveBreakoutFuturesOptionsCandle = expressAsyncHandler(
  async (req, res, next) => {
    const {
      startTimeStr,
      endTimeStr,
      firstCandleMinute = 3,
      breakoutBuffer = 13,
      stopLossMultiplier = 22,
      targetMultiplier = 22,
      lotSize = 30,
      strikeInterval = 100,
      stockSymbol = 'BANKNIFTY27MAR25FUT',
      stockName = 'BANKNIFTY',
      expiry = '27MAR2025',
    } = req.body;

    const candleStart = moment.tz(startTimeStr, 'Asia/Kolkata');
    const candleEnd = candleStart.clone().add(firstCandleMinute, 'minute');

    const firstCandleAgg = await MarketData.aggregate([
      {
        $match: {
          tradingSymbol: stockSymbol,
          exchange: 'NFO',
          exchTradeTime: {
            $gte: candleStart.format('YYYY-MM-DDTHH:mm:ssZ'),
            $lt: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
          },
        },
      },
      { $sort: { exchTradeTime: 1 } },
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

    if (!firstCandleAgg.length) {
      return res.status(400).json({
        success: false,
        message: '❌ No First Candle Found from MarketData',
      });
    }

    // ✅ NEW DOJI FILTER BLOCK
    if (isDragonflyDoji(firstCandleAgg[0])) {
      console.log(
        '📛 Skipping trade due to Dragonfly Doji candle pattern:',
        firstCandleAgg[0]
      );
      return res.status(200).json({
        success: true,
        message: 'Skipped trade due to Dragonfly Doji pattern',
      });
    }

    const { high, low } = firstCandleAgg[0];
    const breakoutHigh = high + breakoutBuffer;
    const breakoutLow = low - breakoutBuffer;

    const tickData = await MarketData.find({
      tradingSymbol: stockSymbol,
      exchange: 'NFO',
      exchTradeTime: {
        $gte: candleEnd.format('YYYY-MM-DDTHH:mm:ssZ'),
        $lte: moment
          .tz(endTimeStr, 'Asia/Kolkata')
          .format('YYYY-MM-DDTHH:mm:ssZ'),
      },
    }).sort({ exchTradeTime: 1 });

    const { feedToken, smartApi } = await generateSessionAndFeedToken();
    const clientCode = process.env.SMARTAPI_CLIENT_CODE;
    const apiKey = process.env.SMARTAPI_KEY;

    if (!feedToken || !apiKey || !clientCode) {
      return res.status(500).json({
        success: false,
        message: '❌ Missing SmartAPI credentials',
      });
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
        const optionType = direction === 'LONG' ? 'CE' : 'PE';

        const optionToken = await InstrumentData.findOne({
          name: stockName,
          expiry,
          strike: (nearestStrike * 100).toFixed(6),
          symbol: { $regex: optionType + '$' },
        })
          .select('token symbol expiry')
          .lean();

        if (!optionToken) continue;

        const entryTick = await MarketData.findOne({
          symbolToken: optionToken.token,
        })
          .sort({ exchTradeTime: -1 })
          .lean();

        const entryPrice = entryTick?.ltp || tick.ltp;
        const stopLoss = +(entryPrice * (1 - stopLossMultiplier / 100)).toFixed(
          2
        );
        const target = +(entryPrice * (1 + targetMultiplier / 100)).toFixed(2);
        const rrRatio = (
          (target - entryPrice) /
          (entryPrice - stopLoss)
        ).toFixed(2);

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
          const orderRes = await smartApi.placeOrder(orderPayload);

          console.log('✅ Entry Order Placed:', orderRes);

          let slLimitPrice = +(stopLoss - 1.5).toFixed(2);
          if (slLimitPrice < stopLoss) slLimitPrice = stopLoss;

          const slOrderPayload = {
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

          setTimeout(async () => {
            try {
              const slOrderRes = await smartApi.placeOrder(slOrderPayload);
              console.log('📛 SL Order Placed:', slOrderRes);
              liveTrade.slOrderId = slOrderRes.data?.orderid;
            } catch (slErr) {
              console.error('❌ SL Order Failed:', slErr);
            }
          }, 1500);

          liveTrade = {
            date: moment().tz('Asia/Kolkata').format('YYYY-MM-DD'),
            direction,
            tradingSymbol: optionToken.symbol,
            symbolToken: optionToken.token,
            nearestStrike,
            optionType,
            expiry,
            entryPrice,
            stopLoss,
            target,
            rrRatio,
            entryTime: tick.exchTradeTime,
            lotSize,
            status: 'OPEN',
            entryOrderId: orderRes.data?.orderid,
          };

          // Setup WebSocket monitoring
          const ws = new WebSocketV2({
            jwttoken: feedToken,
            apikey: apiKey,
            clientcode: clientCode,
            feedtype: feedToken,
          });

          ws.connect().then(() => {
            ws.fetchData({
              correlationID: 'LTP_MONITOR',
              action: 1,
              mode: 1,
              exchangeType: 2,
              tokens: [optionToken.token],
            });

            ws.on('tick', async (tickData) => {
              const ltp = tickData.last_traded_price / 100;
              if (liveTrade.status === 'OPEN') {
                let reason = null;
                if (ltp >= liveTrade.target) reason = 'Target Hit';
                else if (ltp <= liveTrade.stopLoss) reason = 'Stop Loss Hit';

                if (reason) {
                  liveTrade.status = 'CLOSED';
                  liveTrade.exitReason = reason;
                  liveTrade.exitPrice = ltp;
                  liveTrade.exitTime = new Date().toISOString();

                  try {
                    const exitOrder = {
                      variety: 'NORMAL',
                      tradingsymbol: optionToken.symbol,
                      symboltoken: optionToken.token,
                      transactiontype: 'SELL',
                      exchange: 'NFO',
                      ordertype: 'MARKET',
                      producttype: 'INTRADAY',
                      duration: 'DAY',
                      price: '0',
                      quantity: lotSize,
                    };

                    const exitRes = await smartApi.placeOrder(exitOrder);
                    if (liveTrade.slOrderId) {
                      await smartApi.cancelOrder({
                        variety: 'STOPLOSS',
                        orderid: liveTrade.slOrderId,
                      });
                      console.log('❎ SL Order Cancelled after exit');
                    }
                    ws.close();
                  } catch (exitErr) {
                    console.error('❌ Exit Order Error:', exitErr);
                  }
                }
              }
            });
          });

          // ✅ TIME-BASED EXIT LOGIC
          const exitTimeout = moment
            .tz(endTimeStr, 'Asia/Kolkata')
            .diff(moment(), 'milliseconds');
          console.log(`⏳ Trade will auto-exit at: ${endTimeStr}`);
          if (exitTimeout > 0) {
            setTimeout(async () => {
              if (liveTrade.status === 'OPEN') {
                console.log('⏰ Time-based Exit Triggered');
                try {
                  const exitOrder = {
                    variety: 'NORMAL',
                    tradingsymbol: optionToken.symbol,
                    symboltoken: optionToken.token,
                    transactiontype: 'SELL',
                    exchange: 'NFO',
                    ordertype: 'MARKET',
                    producttype: 'INTRADAY',
                    duration: 'DAY',
                    price: '0',
                    quantity: lotSize,
                  };

                  const exitRes = await smartApi.placeOrder(exitOrder);
                  liveTrade.status = 'CLOSED';
                  liveTrade.exitReason = 'Time Exit';
                  liveTrade.exitPrice = 'N/A';
                  liveTrade.exitTime = moment().tz('Asia/Kolkata').format();

                  if (liveTrade.slOrderId) {
                    await smartApi.cancelOrder({
                      variety: 'STOPLOSS',
                      orderid: liveTrade.slOrderId,
                    });
                    console.log('❎ SL Order Cancelled on Time Exit');
                  }

                  ws.close();
                } catch (err) {
                  console.error(
                    '❌ Time-based Exit Order Failed:',
                    err.message
                  );
                }
              }
            }, exitTimeout);
          }

          return res.status(200).json({
            success: true,
            message: 'Live Trade Executed with Auto Time Exit Monitoring',
            data: liveTrade,
          });
        } catch (err) {
          console.error('Live Order Placement Error:', err);
          return res.status(500).json({
            success: false,
            message: 'Trade Error',
            error: err.message,
          });
        }
      }
    }

    return res
      .status(200)
      .json({ success: true, message: 'No Breakout Found' });
  }
);

cron.schedule('00 16 09 * * 1-5', async () => {
  const today = moment().tz('Asia/Kolkata').format('YYYY-MM-DD');
  const startTimeStr = `${today} 09:15:00`;
  const endTimeStr = `${today} 09:48:00`; // You can customize this

  try {
    const response = await axios.post(
      'http://localhost:9000/api/order/live-breakout',
      {
        startTimeStr,
        endTimeStr,
      }
    );

    console.log('✅ Cron Triggered Live Trade:', response.data);
  } catch (err) {
    console.error('❌ Cron Live Trade Trigger Failed:', err.message);
  }
});
