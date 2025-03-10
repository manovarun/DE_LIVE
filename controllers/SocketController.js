const expressAsyncHandler = require('express-async-handler');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const AppError = require('../utils/AppError');
let { WebSocket, WebSocketV2 } = require('smartapi-javascript');
const MarketData = require('../models/Socket');
const moment = require('moment-timezone');
const InstrumentData = require('../models/Instrument');
const { FUT_OPT_TOKENS } = require('../utils/constants');
const cron = require('node-cron');

exports.getLiveSocketData = expressAsyncHandler(async (req, res, next) => {
  try {
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    const clientCode = process.env.SMARTAPI_CLIENT_CODE;
    const apiKey = process.env.SMARTAPI_KEY;

    // Validate required credentials
    if (!feedToken || !apiKey || !clientCode) {
      return next(
        new AppError(
          'Missing required credentials for WebSocket connection',
          500
        )
      );
    }

    // Create a WebSocket connection using WebSocketV2
    let webSocket = new WebSocketV2({
      jwttoken: feedToken, // JWT Token should be the feedToken generated
      apikey: apiKey,
      clientcode: clientCode,
      feedtype: feedToken, // Use 'stream' or 'mw' based on your requirement
    });

    // Connect to the WebSocket
    webSocket
      .connect()
      .then(() => {
        console.log('WebSocket Connected');

        let jsonReq = {
          correlationID: 'correlation_id_1',
          action: 1, // 1 = subscribe, 0 = unsubscribe
          mode: 1, // 1 = LTP (Last Traded Price), 2 = QUOTE, 3 = SNAPQUOTE, etc.
          exchangeType: 1, // 1 = NSE, 2 = BSE, etc.
          tokens: ['26009'], // Replace with actual tokens for stocks
        };

        // Fetch and start receiving data
        webSocket.fetchData(jsonReq);

        // Handle the received data (ticks)
        webSocket.on('tick', (data) => {
          console.log(data);
          const parsedData = {
            mode: data.subscription_mode,
            exchange: data.exchange_type === '1' ? 'NSE' : 'BSE',
            instrumentToken: data.token
              ? data.token.replace(/"/g, '')
              : 'Unknown', // Check if data.token is defined
            sequence: data.sequence_number,
            timestamp: data.exchange_timestamp
              ? new Date(parseInt(data.exchange_timestamp)).toLocaleString()
              : 'Unknown',
            lastTradedPrice: data.last_traded_price
              ? parseFloat(data.last_traded_price) / 100
              : 'N/A', // Assuming price in paise
          };

          console.log('Parsed Real-time Tick Data:', parsedData);
        });

        // Error handling for WebSocket
        webSocket.on('error', (err) => {
          console.error('WebSocket Error:', err);
        });

        // Handle connection close
        webSocket.on('close', () => {
          console.log('WebSocket Connection Closed');
        });
      })
      .catch((err) => {
        console.error('WebSocket Connection Failed:', err);
        next(new AppError('Failed to connect to WebSocket', 500));
      });
  } catch (error) {
    console.error('Error establishing WebSocket connection:', error);
    next(new AppError('Failed to establish WebSocket connection', 500));
  }
});

exports.getBankNiftyOptionTokens = expressAsyncHandler(
  async (req, res, next) => {
    try {
      const { strikePrices, name, expiry } = req.body;

      if (!strikePrices || !Array.isArray(strikePrices) || !name || !expiry) {
        return res.status(400).json({
          success: false,
          message:
            'Missing required fields: strikePrices (array), name, expiry',
        });
      }

      // Load scrip master data from MongoDB
      const scripMaster = await InstrumentData.find({});

      const optionTokens = [];

      for (const strike of strikePrices) {
        const formattedStrike = (strike * 100).toFixed(6); // Match database format

        // Filter instruments from database
        const instruments = scripMaster.filter(
          (item) =>
            item.name === name &&
            item.expiry === expiry &&
            item.strike === formattedStrike
        );

        if (instruments.length === 0) {
          console.warn(
            `No instruments found for expiry: ${expiry}, strike: ${strike}`
          );
          continue;
        }

        // Find CE (Call) & PE (Put) tokens
        const ceInstrument = instruments.find((item) =>
          item.symbol.endsWith('CE')
        );
        const peInstrument = instruments.find((item) =>
          item.symbol.endsWith('PE')
        );

        if (ceInstrument) {
          optionTokens.push({
            strikePrice: strike,
            ceToken: ceInstrument.token,
          });
        }

        if (peInstrument) {
          optionTokens.push({
            strikePrice: strike,
            peToken: peInstrument.token,
          });
        }
      }

      const tokensArray = optionTokens.flatMap((obj) =>
        obj.ceToken ? [obj.ceToken] : obj.peToken ? [obj.peToken] : []
      );

      // Send Response
      return res.status(200).json({
        success: true,
        tokens: tokensArray,
        detailed: optionTokens,
      });
    } catch (error) {
      console.error('Error fetching tokens from MongoDB:', error);
      return res.status(500).json({
        success: false,
        message: 'Server error',
      });
    }
  }
);

exports.getLiveNSEMarketData = expressAsyncHandler(async (req, res, next) => {
  try {
    // Generate session token
    const { smartApi } = await generateSessionAndFeedToken();

    // Define Market Data Request Payload
    const requestPayload = {
      mode: 'FULL',
      exchangeTokens: {
        NSE: ['99926009'],
        NFO: FUT_OPT_TOKENS,
      },
    };

    // Fetch Live Market Data
    const response = await smartApi.marketData(requestPayload);

    if (!response || !response.data || !response.data.fetched) {
      return next(new AppError('Failed to fetch market data', 500));
    }

    const convertToISTDate = (date) => {
      return moment.tz(date, 'Asia/Kolkata').format('YYYY-MM-DDTHH:mm:ssZ'); // Returns ISO string with IST offset
    };

    const marketDataArray = response.data.fetched.map((data) => {
      return {
        exchange: data.exchange,
        tradingSymbol: data.tradingSymbol,
        symbolToken: data.symbolToken,
        ltp: data.ltp,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        lastTradeQty: data.lastTradeQty,
        exchFeedTime: moment
          .tz(data.exchFeedTime, 'DD-MMM-YYYY HH:mm:ss', 'Asia/Kolkata')
          .format('YYYY-MM-DDTHH:mm:ssZ'),
        exchTradeTime: moment
          .tz(data.exchTradeTime, 'DD-MMM-YYYY HH:mm:ss', 'Asia/Kolkata')
          .format('YYYY-MM-DDTHH:mm:ssZ'),
        netChange: data.netChange,
        percentChange: data.percentChange,
        avgPrice: data.avgPrice,
        tradeVolume: data.tradeVolume,
        opnInterest: data.opnInterest,
        lowerCircuit: data.lowerCircuit,
        upperCircuit: data.upperCircuit,
        totBuyQuan: data.totBuyQuan,
        totSellQuan: data.totSellQuan,
        week52Low: data['52WeekLow'],
        week52High: data['52WeekHigh'],
        depth: {
          buy: data.depth.buy.map((b) => ({
            price: b.price,
            quantity: b.quantity,
            orders: b.orders,
          })),
          sell: data.depth.sell.map((s) => ({
            price: s.price,
            quantity: s.quantity,
            orders: s.orders,
          })),
        },
        timestamp: convertToISTDate(new Date()), // Convert system timestamp to IST
      };
    });

    // **Insert Each Entry as a New Document Instead of Updating**
    await MarketData.insertMany(marketDataArray);

    // Send Response
    res.status(200).json({
      success: true,
    });
  } catch (error) {
    console.error('Error fetching or saving market data:', error);
    next(new AppError('Failed to retrieve and store live market data', 500));
  }
});
