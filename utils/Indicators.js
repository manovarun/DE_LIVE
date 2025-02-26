// utils/indicators.js
const { RSI, SMA, MACD } = require('technicalindicators');

const calculateIndicators = async (closingPrices) => {
  if (closingPrices.length < 20) {
    return { rsi: null, sma: null, macd: null };
  }

  // RSI Calculation
  const rsi = RSI.calculate({ values: closingPrices, period: 14 });
  const latestRSI = rsi[rsi.length - 1] ?? null;

  // Simple Moving Average (SMA)
  const sma = SMA.calculate({ values: closingPrices, period: 20 });
  const latestSMA = sma[sma.length - 1] ?? null;

  // MACD Calculation
  const macd = MACD.calculate({
    values: closingPrices,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const latestMACD = macd[macd.length - 1] ?? null;

  return {
    rsi: latestRSI,
    sma: latestSMA,
    macd: latestMACD ? latestMACD.MACD : null,
    signal: latestMACD ? latestMACD.signal : null,
    histogram: latestMACD ? latestMACD.histogram : null,
  };
};

module.exports = { calculateIndicators };
