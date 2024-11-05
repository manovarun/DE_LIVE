const { SmartAPI } = require('smartapi-javascript');
const { authenticator } = require('otplib');
const AppError = require('../utils/AppError'); // Adjust this path if needed

// Initialize SmartAPI
const smartApi = new SmartAPI({
  api_key: process.env.SMARTAPI_KEY,
});

// Function to generate session and feed token
const generateSessionAndFeedToken = async () => {
  try {
    const clientCode = process.env.SMARTAPI_CLIENT_CODE;
    const password = process.env.SMARTAPI_PASSWORD;
    const totp = authenticator.generate(process.env.SMARTAPI_TOTP_SECRET);

    // Generate Session
    const sessionData = await smartApi.generateSession(
      clientCode,
      password,
      totp
    );

    if (!sessionData.status) {
      throw new AppError(`Error: ${sessionData.message}`, 400);
    }

    // Return feed token
    const feedToken = sessionData.data.feedToken;
    return { feedToken, smartApi }; // Return the feedToken and smartApi instance
  } catch (error) {
    console.error('Error generating session and feed token:', error);
    throw new AppError('Error generating session and feed token', 400);
  }
};

module.exports = { generateSessionAndFeedToken };
