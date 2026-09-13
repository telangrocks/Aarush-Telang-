export const MEAN_REVERSION_STRATEGY_MANIFEST = {
  id: 'MeanReversion',
  name: 'Mean Reversion Strategy',
  description: 'Identifies conditions where price is significantly separated from its mean with exhausted momentum, taking counter-trend positions back toward the baseline.',
  version: '1.0.0',
  classification: 'Mean Reversion',
  riskProfile: 'Medium',
  supportedTimeframes: ['5m', '15m', '1h', '4h'],
  minimumCandles: 51,
  author: 'System'
};
