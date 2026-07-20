export const MOMENTUM_STRATEGY_MANIFEST = {
  id: 'Momentum',
  name: 'Momentum Trading Strategy',
  version: '1.0.0',
  description: 'A trend-following strategy designed to capture momentum in established directional trends using MACD, RSI, and EMAs.',
  author: 'System',
  requiredIndicators: ['EMA', 'RSI', 'MACD', 'ATR', 'Volume'],
  supportedTimeframes: ['15m', '1h', '4h'],
  classification: 'Trend Following',
  riskProfile: 'Medium-High'
};
