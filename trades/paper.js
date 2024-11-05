// Define initial account state
let initialBalance = 100000; // Starting balance in dollars
let positions = {}; // Track open positions by token
let transactionHistory = []; // Log of all transactions

exports.paperTrade = (data) => {
  // Ensure the data contains a token before proceeding
  if (!data.token) {
    console.log('Received data without a token:', data);
    return;
  }

  const token = data.token.replace(/"/g, ''); // Instrument token
  const lastTradedPrice = parseFloat(data.last_traded_price) / 100; // Price in dollars

  console.log(`Received Tick for ${token}: ${lastTradedPrice}`);

  // Strategy parameters
  const BUY_THRESHOLD = 836; // Buy when price drops to this level
  const SELL_THRESHOLD = 839; // Sell when price rises to this level
  const TRADE_QUANTITY = 10; // Quantity for each trade

  // Buy logic
  if (lastTradedPrice <= BUY_THRESHOLD && !positions[token]) {
    const cost = lastTradedPrice * TRADE_QUANTITY;
    if (initialBalance >= cost) {
      positions[token] = {
        buyPrice: lastTradedPrice,
        quantity: TRADE_QUANTITY,
      };
      initialBalance -= cost;
      transactionHistory.push({
        type: 'BUY',
        token,
        price: lastTradedPrice,
        quantity: TRADE_QUANTITY,
        timestamp: new Date().toLocaleString(),
      });
      console.log(`Bought ${TRADE_QUANTITY} of ${token} at ${lastTradedPrice}`);
    }
  }

  // Sell logic
  if (lastTradedPrice >= SELL_THRESHOLD && positions[token]) {
    const position = positions[token];
    const sellPrice = lastTradedPrice * position.quantity;
    const profit = sellPrice - position.buyPrice * position.quantity;
    initialBalance += sellPrice;
    delete positions[token];
    transactionHistory.push({
      type: 'SELL',
      token,
      price: lastTradedPrice,
      quantity: TRADE_QUANTITY,
      profit,
      timestamp: new Date().toLocaleString(),
    });
    console.log(
      `Sold ${TRADE_QUANTITY} of ${token} at ${lastTradedPrice} for profit of ${profit}`
    );
  }

  // Log current balance and positions
  console.log(`Current Balance: ${initialBalance.toFixed(2)}`);
  console.log(`Open Positions:`, positions);
};
