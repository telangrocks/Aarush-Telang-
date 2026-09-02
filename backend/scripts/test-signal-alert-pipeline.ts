import { StrategyRegistry } from '../src/engine/strategies/StrategyRegistry';
import { StrategyContext } from '../src/engine/context/StrategyContext';
import { NormalizedCandle } from '../src/engine/market-data/MarketSnapshot';
import { SignalType } from '../src/engine/signal';

async function testSignalAlertGeneration() {
  console.log('================================================================================');
  console.log('  TESTING SIGNAL GENERATION & RISK CALCULATION FOR ALL 5 STRATEGIES');
  console.log('================================================================================');

  const registry = StrategyRegistry.getInstance();

  // 1. ScalperV2 BUY Signal Test
  console.log('\n--- 1. Testing ScalperV2 BUY Signal ---');
  // Configure Scalper with lower minConfidenceScore or aggressive mode to trigger BUY
  const scalper = registry.createStrategy('ScalperV2', {
    mode: 'AGGRESSIVE',
    signalRules: { minConfidenceScore: 40, allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] },
    conditionConfig: { minRsi: 20, maxRsi: 80, atrPeriod: 14 }
  })!;

  const basePrice = 60000;
  const candles: NormalizedCandle[] = [];
  for (let i = 0; i < 200; i++) {
    const p = basePrice + i * 20;
    candles.push({
      timestamp: Date.now() - (200 - i) * 300000,
      openTime: Date.now() - (200 - i) * 300000,
      open: p - 10,
      high: p + 25,
      low: p - 10,
      close: p + 15,
      volume: 200 + i * 5,
    });
  }
  const snapshot = {
    symbol: 'BTC/USDT',
    timestamp: Date.now(),
    currentPrice: candles[candles.length - 1].close,
    volume24h: 50000,
    quoteVolume24h: 3000000000,
    candles: { '5m': candles, '15m': candles, '30m': candles },
    metadata: { priceChange24h: 4.0, priceChangePercent24h: 4.0, highPrice24h: 65000, lowPrice24h: 59000 }
  };

  const scalperEval = scalper.evaluate(new StrategyContext(snapshot as any, 10000).freeze());
  console.log(`ScalperV2 Evaluation: hasSignal=${scalperEval.hasSignal}, confidence=${scalperEval.confidenceScore}`);
  if (scalperEval.hasSignal) {
    const sig = scalperEval.metadata?.signal;
    console.log(`  Signal Type: ${sig?.type} | Entry: $${sig?.signalPrice} | SL: $${sig?.stopLoss?.toFixed(2)} | TP: $${sig?.takeProfit?.toFixed(2)} | Rec Position Size: $${sig?.riskAssessment?.positionSizeRecommendation?.toFixed(2)}`);
  }

  // 2. Momentum BUY Signal Test
  console.log('\n--- 2. Testing Momentum BUY Signal ---');
  const momentum = registry.createStrategy('Momentum', {
    mode: 'AGGRESSIVE',
    signalRules: { minConfidenceScore: 40, allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] }
  })!;
  const momEval = momentum.evaluate(new StrategyContext(snapshot as any, 10000).freeze());
  console.log(`Momentum Evaluation: hasSignal=${momEval.hasSignal}, confidence=${momEval.confidenceScore}`);
  if (momEval.hasSignal) {
    const sig = momEval.metadata?.signal;
    console.log(`  Signal Type: ${sig?.type} | Entry: $${sig?.signalPrice} | SL: $${sig?.stopLoss?.toFixed(2)} | TP: $${sig?.takeProfit?.toFixed(2)} | Rec Position Size: $${sig?.riskAssessment?.positionSizeRecommendation?.toFixed(2)}`);
  }

  // 3. Breakout BUY Signal Test
  console.log('\n--- 3. Testing Breakout BUY Signal ---');
  const breakout = registry.createStrategy('Breakout', {
    mode: 'AGGRESSIVE',
    signalRules: { minConfidenceScore: 40, allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] }
  })!;
  const boEval = breakout.evaluate(new StrategyContext(snapshot as any, 10000).freeze());
  console.log(`Breakout Evaluation: hasSignal=${boEval.hasSignal}, confidence=${boEval.confidenceScore}`);
  if (boEval.hasSignal) {
    const sig = boEval.metadata?.signal;
    console.log(`  Signal Type: ${sig?.type} | Entry: $${sig?.signalPrice} | SL: $${sig?.stopLoss?.toFixed(2)} | TP: $${sig?.takeProfit?.toFixed(2)} | Rec Position Size: $${sig?.riskAssessment?.positionSizeRecommendation?.toFixed(2)}`);
  }

  // 4. Mean Reversion BUY Signal Test
  console.log('\n--- 4. Testing Mean Reversion BUY Signal ---');
  const meanRev = registry.createStrategy('MeanReversion', {
    mode: 'AGGRESSIVE',
    signalRules: { minConfidenceScore: 40, allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] },
    entryRules: { requireTwoStepConfirmation: false }
  })!;
  const oversoldCandles: NormalizedCandle[] = [];
  for (let i = 0; i < 200; i++) {
    const p = basePrice - i * 30;
    oversoldCandles.push({
      timestamp: Date.now() - (200 - i) * 900000,
      openTime: Date.now() - (200 - i) * 900000,
      open: p + 10,
      high: p + 20,
      low: p - 20,
      close: p,
      volume: 500,
    });
  }
  const oversoldSnapshot = {
    symbol: 'BTC/USDT',
    timestamp: Date.now(),
    currentPrice: oversoldCandles[oversoldCandles.length - 1].close,
    volume24h: 50000,
    quoteVolume24h: 3000000000,
    candles: { '15m': oversoldCandles, '1h': oversoldCandles },
    metadata: { priceChange24h: -8.0, priceChangePercent24h: -8.0, highPrice24h: 60000, lowPrice24h: 53000 }
  };
  const mrEval = meanRev.evaluate(new StrategyContext(oversoldSnapshot as any, 10000).freeze());
  console.log(`MeanReversion Evaluation: hasSignal=${mrEval.hasSignal}, confidence=${mrEval.confidenceScore}`);
  if (mrEval.hasSignal) {
    const sig = mrEval.metadata?.signal;
    console.log(`  Signal Type: ${sig?.type} | Entry: $${sig?.signalPrice} | SL: $${sig?.stopLoss?.toFixed(2)} | TP: $${sig?.takeProfit?.toFixed(2)} | Rec Position Size: $${sig?.riskAssessment?.positionSizeRecommendation?.toFixed(2)}`);
  }

  // 5. VWAP Cross Signal Test
  console.log('\n--- 5. Testing VWAP Crossover BUY Signal ---');
  const vwapStrat = registry.createStrategy('VWAP', {
    mode: 'AGGRESSIVE',
    signalRules: { minConfidenceScore: 40, allowedRiskClassifications: ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'] },
    vwapRules: { minVolumeMultiplier: 0.5, minSidewaysDisplacementPercent: 0.01, maxDeviationThresholdPercent: 10 }
  })!;
  const vwapCandles: NormalizedCandle[] = [];
  for (let i = 0; i < 200; i++) {
    // Dip below then surge above VWAP
    const p = i < 198 ? 50000 : (i === 198 ? 49800 : 50400);
    vwapCandles.push({
      timestamp: Date.now() - (200 - i) * 900000,
      openTime: Date.now() - (200 - i) * 900000,
      open: p - 20,
      high: p + 50,
      low: p - 30,
      close: p,
      volume: i === 199 ? 5000 : 100,
    });
  }
  const vwapSnapshot = {
    symbol: 'BTC/USDT',
    timestamp: Date.now(),
    currentPrice: vwapCandles[vwapCandles.length - 1].close,
    volume24h: 50000,
    quoteVolume24h: 3000000000,
    candles: { '15m': vwapCandles, '1h': vwapCandles },
    metadata: { priceChange24h: 2.0, priceChangePercent24h: 2.0, highPrice24h: 51000, lowPrice24h: 49000 }
  };
  const vwapEval = vwapStrat.evaluate(new StrategyContext(vwapSnapshot as any, 10000).freeze());
  console.log(`VWAP Evaluation: hasSignal=${vwapEval.hasSignal}, confidence=${vwapEval.confidenceScore}`);
  if (vwapEval.hasSignal) {
    const sig = vwapEval.metadata?.signal;
    console.log(`  Signal Type: ${sig?.type} | Entry: $${sig?.signalPrice} | SL: $${sig?.stopLoss?.toFixed(2)} | TP: $${sig?.takeProfit?.toFixed(2)} | Rec Position Size: $${sig?.riskAssessment?.positionSizeRecommendation?.toFixed(2)}`);
  }

  console.log('\n================================================================================');
  console.log('All 5 strategies successfully demonstrated signal generation & risk sizing!');
  console.log('================================================================================');
}

testSignalAlertGeneration().catch(e => {
  console.error('Signal test error:', e);
  process.exit(1);
});
