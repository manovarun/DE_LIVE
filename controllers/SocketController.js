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

    console.log('Feed Token:', feedToken);
    console.log('API Key:', apiKey);
    console.log('Client Code:', clientCode);

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
      feedtype: 'stream', // Use 'stream' or 'mw' based on your requirement
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
          console.log('Real-time Tick Data:', data);
          // You can add logic here to handle data, e.g., store in DB or return response
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
