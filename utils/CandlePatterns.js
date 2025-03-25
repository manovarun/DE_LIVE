// utils/candlePatterns.js

function isHangingMan(candle) {
  const { open, high, low, close } = candle;
  const body = Math.abs(open - close);
  const lowerWick = Math.min(open, close) - low;
  const upperWick = high - Math.max(open, close);
  const totalRange = high - low;

  return body / totalRange < 0.3 && lowerWick > body * 2 && upperWick < body;
}

function isDragonflyDoji(candle) {
  const { open, high, low, close } = candle;
  const body = Math.abs(open - close);
  const lowerWick = Math.min(open, close) - low;
  const upperWick = high - Math.max(open, close);
  const totalRange = high - low;

  return (
    body / totalRange < 0.1 &&
    lowerWick / totalRange > 0.6 &&
    upperWick / totalRange < 0.1
  );
}

module.exports = {
  isHangingMan,
  isDragonflyDoji,
};
