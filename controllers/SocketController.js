const expressAsyncHandler = require('express-async-handler');
const { generateSessionAndFeedToken } = require('../utils/AppSession');
const AppError = require('../utils/AppError');
let { WebSocket, WebSocketV2 } = require('smartapi-javascript');

exports.getLiveSocketData = expressAsyncHandler(async (req, res, next) => {
  try {
    const { feedToken, smartApi } = await generateSessionAndFeedToken();

    const clientCode = process.env.SMARTAPI_CLIENT_CODE;
    const apiKey = process.env.SMARTAPI_KEY;

    // const profileData = await smartApi.getProfile();

    // Validate that all tokens are not empty
    if (!feedToken || !apiKey || !clientCode) {
      next(
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
          tokens: ['3045'], // Replace with actual tokens for stocks
        };

        // Fetch and start receiving data
        webSocket.fetchData(jsonReq);

        // Handle the received data (ticks)
        webSocket.on('tick', (data) => {
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
