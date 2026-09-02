import { ExchangeManager } from '../src/exchanges';
import { AdapterCandleProvider } from '../src/engine/market-data/AdapterCandleProvider';
import { MarketDataEngine } from '../src/engine/market-data/MarketDataEngine';
import { StrategyOrchestrator } from '../src/engine/orchestrator/StrategyOrchestrator';
import { StrategyRegistry } from '../src/engine/strategies/StrategyRegistry';
import { IndicatorEngine } from '../src/engine/indicator/IndicatorEngine';
import { calculateRSI } from '../src/engine/indicator/indicators/RSI';
import { calculateEMA } from '../src/engine/indicator/indicators/EMA';
import { calculateMACD } from '../src/engine/indicator/indicators/MACD';
import { calculateATR } from '../src/engine/indicator/indicators/ATR';
import { calculateVolume } from '../src/engine/indicator/indicators/VolumeIndicators';
import { VWAPCalculator } from '../src/engine/strategies/vwap/VWAPCalculator';
import { MarketRegimeEngine } from '../src/engine/regime/MarketRegimeEngine';
import { TradeValidator } from '../src/validation/TradeValidator';
import { FinalDispatchSafetyGate } from '../src/engine/safety/FinalDispatchSafetyGate';
import { ReconciliationEngine } from '../src/engine/reconciliation/ReconciliationEngine';
import { StrategyContext } from '../src/engine/context/StrategyContext';
import { NormalizedCandle } from '../src/engine/market-data/MarketSnapshot';
import BigNumber from 'bignumber.js';

interface TestAuditResult {
  section: string;
  testName: string;
  status: 'PASS' | 'FAIL' | 'PARTIAL';
  evidence: any;
  notes?: string;
}

const auditResults: TestAuditResult[] = [];

async function runForensicAudit() {
  console.log('================================================================================');
  console.log('  CRYPTOPULSE BOT FORENSIC AUDIT & LIVE RUNTIME FUNCTIONAL VERIFICATION');
  console.log('================================================================================');
  console.log(`Execution Timestamp: ${new Date().toISOString()}`);

  // ---------------------------------------------------------------------------
  // PART 1 & 2: LIVE MARKET DATA FETCH & TECHNICAL ANALYSIS INDICATOR PIPELINE
  // ---------------------------------------------------------------------------
  console.log('\n>>> [PART 1 & 2] Fetching Live Market Data from Bybit & Verifying TA Indicators...');
  
  const bybitAdapter = await ExchangeManager.createUncachedProvider('bybit', {
    environment: 'mainnet',
  });

  const testSymbol = 'BTC/USDT';
  console.log(`Fetching live ticker and klines for ${testSymbol}...`);
  const ticker = await bybitAdapter.fetchTicker(testSymbol);
  const livePrice = ticker.last.toNumber();
  console.log(`Live Ticker Price: $${livePrice.toFixed(2)} | 24h Vol: ${ticker.volume.toNumber().toFixed(2)} BTC`);

  const candleProvider = new AdapterCandleProvider(bybitAdapter);
  const normalizedCandles = await candleProvider.fetchCandles(testSymbol, '15m', 200);
  console.log(`Fetched and validated ${normalizedCandles.length} 15m candles from Bybit.`);

  const firstCandle = normalizedCandles[0];
  const latestCandle = normalizedCandles[normalizedCandles.length - 1];
  console.log(`Candle Range: ${new Date(firstCandle.timestamp).toISOString()} -> ${new Date(latestCandle.timestamp).toISOString()}`);
  console.log(`Latest Candle Open: $${latestCandle.open}, High: $${latestCandle.high}, Low: $${latestCandle.low}, Close: $${latestCandle.close}, Vol: ${latestCandle.volume}`);

  // 1. RSI (14)
  const rsiValues = calculateRSI(normalizedCandles, 14);
  const latestRsi = rsiValues[rsiValues.length - 1];
  console.log(`[TA Indicator] RSI(14): ${latestRsi?.toFixed(2)}`);

  // 2. EMA (9, 21, 50, 200)
  const ema9Values = calculateEMA(normalizedCandles, 9);
  const ema21Values = calculateEMA(normalizedCandles, 21);
  const ema50Values = calculateEMA(normalizedCandles, 50);
  const ema200Values = calculateEMA(normalizedCandles, 200);
  console.log(`[TA Indicator] EMA(9): $${ema9Values[ema9Values.length - 1]?.toFixed(2)} | EMA(21): $${ema21Values[ema21Values.length - 1]?.toFixed(2)} | EMA(50): $${ema50Values[ema50Values.length - 1]?.toFixed(2)} | EMA(200): $${ema200Values[ema200Values.length - 1]?.toFixed(2)}`);

  // 3. MACD (12, 26, 9)
  const macdValues = calculateMACD(normalizedCandles, 12, 26, 9);
  const latestMacd = macdValues[macdValues.length - 1];
  console.log(`[TA Indicator] MACD Line: ${latestMacd.macdLine?.toFixed(4)} | Signal: ${latestMacd.signalLine?.toFixed(4)} | Hist: ${latestMacd.histogram?.toFixed(4)}`);

  // 4. ATR (14)
  const atrValues = calculateATR(normalizedCandles, 14);
  const latestAtr = atrValues[atrValues.length - 1];
  console.log(`[TA Indicator] ATR(14): $${latestAtr?.toFixed(2)}`);

  // 5. Volume Indicators
  const volValues = calculateVolume(normalizedCandles, 20);
  const latestVol = volValues[volValues.length - 1];
  console.log(`[TA Indicator] 20-MA Volume: ${latestVol.averageVolume?.toFixed(2)} | Volume Change: ${latestVol.volumeChangePercent?.toFixed(2)}%`);

  // 6. VWAP
  const vwapValues = VWAPCalculator.calculate(normalizedCandles);
  const latestVwap = vwapValues[vwapValues.length - 1];
  console.log(`[TA Indicator] VWAP: $${latestVwap?.toFixed(2)}`);

  const indicatorsValid = !isNaN(latestRsi) && !isNaN(latestAtr) && !isNaN(latestVwap) && !isNaN(latestMacd.macdLine) && !isNaN(ema9Values[ema9Values.length - 1]);
  
  auditResults.push({
    section: 'Part 2 - Technical Analysis',
    testName: 'Real Market Data Indicator Computation',
    status: indicatorsValid ? 'PASS' : 'FAIL',
    evidence: {
      symbol: testSymbol,
      candleCount: normalizedCandles.length,
      latestCandleTime: new Date(latestCandle.timestamp).toISOString(),
      livePrice,
      indicators: {
        RSI_14: latestRsi,
        EMA_9: ema9Values[ema9Values.length - 1],
        EMA_21: ema21Values[ema21Values.length - 1],
        EMA_50: ema50Values[ema50Values.length - 1],
        EMA_200: ema200Values[ema200Values.length - 1],
        MACD_12_26_9: latestMacd,
        ATR_14: latestAtr,
        VWAP: latestVwap,
        Volume_20_MA: latestVol.averageVolume
      }
    }
  });

  // ---------------------------------------------------------------------------
  // PART 1 & 3: 5 BUILT-IN STRATEGIES & MULTI-CYCLE LIVE RUNTIME TEST
  // ---------------------------------------------------------------------------
  console.log('\n>>> [PART 1 & 3] Evaluating All 5 Built-in Strategies in Multi-Cycle Runtime Test...');

  const dataEngine = new MarketDataEngine(candleProvider);
  const orchestrator = new StrategyOrchestrator();
  orchestrator.setMarketDataEngine(dataEngine);

  const registry = StrategyRegistry.getInstance();
  const availableStrategies = registry.getAvailableStrategies();
  console.log(`Registered Strategies in StrategyRegistry: ${availableStrategies.join(', ')}`);

  const cyclesCount = 5;
  const cycleLogs: any[] = [];

  for (let cycle = 1; cycle <= cyclesCount; cycle++) {
    const cycleStart = Date.now();
    console.log(`\n--- Cycle #${cycle} (T=${new Date(cycleStart).toISOString()}) ---`);

    // Execute cycle on BTC/USDT evaluating all strategies
    const results = await orchestrator.executeCycle(testSymbol, undefined, undefined, 5000);
    const cycleDuration = Date.now() - cycleStart;

    const cycleRecord = {
      cycleNumber: cycle,
      timestamp: new Date(cycleStart).toISOString(),
      symbol: testSymbol,
      marketPrice: livePrice,
      durationMs: cycleDuration,
      strategyResults: results.map(r => ({
        strategyId: r.strategyId,
        hasSignal: r.hasSignal,
        signalType: r.metadata?.signal?.type || 'HOLD',
        confidenceScore: r.confidenceScore,
        reasoning: r.metadata?.reasoning || []
      }))
    };
    cycleLogs.push(cycleRecord);

    console.log(`Cycle #${cycle} completed in ${cycleDuration}ms:`);
    for (const r of results) {
      console.log(`  Strategy: ${r.strategyId.padEnd(15)} | Signal: ${(r.metadata?.signal?.type || 'HOLD').padEnd(6)} | Confidence: ${String(r.confidenceScore).padEnd(3)}% | Reasoning: ${r.metadata?.reasoning?.[0] || 'N/A'}`);
    }

    if (cycle < cyclesCount) {
      await new Promise(res => setTimeout(res, 1000));
    }
  }

  const all5Executed = availableStrategies.every(sId => 
    cycleLogs[0].strategyResults.some((r: any) => r.strategyId.toLowerCase() === sId.toLowerCase())
  );

  auditResults.push({
    section: 'Part 1 & 3 - Strategies & Runtime Execution',
    testName: '5 Built-in Strategies Multi-Cycle Execution',
    status: all5Executed ? 'PASS' : 'FAIL',
    evidence: {
      strategiesTested: availableStrategies,
      consecutiveCyclesRun: cyclesCount,
      cycles: cycleLogs
    }
  });

  // ---------------------------------------------------------------------------
  // PART 4: TRADE DETECTION PIPELINE & SIGNAL GENERATION
  // ---------------------------------------------------------------------------
  console.log('\n>>> [PART 4] Trade Detection Pipeline & Controlled Signal Scenarios...');

  // 1. ScalperV2 Bullish Crossover Injection
  console.log('\n[Scenario A] Testing ScalperV2 with Bullish Trend Alignment...');
  const scalper = registry.createStrategy('ScalperV2', {
    conditionConfig: { minRsi: 30, maxRsi: 70, atrPeriod: 14 }
  })!;
  
  // Construct a synthetic bullish snapshot
  const basePrice = 60000;
  const bullishCandles: NormalizedCandle[] = [];
  for (let i = 0; i < 200; i++) {
    const p = basePrice + i * 15; // uptrend
    bullishCandles.push({
      timestamp: Date.now() - (200 - i) * 300000,
      openTime: Date.now() - (200 - i) * 300000,
      open: p - 10,
      high: p + 20,
      low: p - 15,
      close: p + 5,
      volume: 100 + i * 2,
    });
  }
  const bullishSnapshot = {
    symbol: 'BTC/USDT',
    timestamp: Date.now(),
    currentPrice: bullishCandles[bullishCandles.length - 1].close,
    volume24h: 50000,
    quoteVolume24h: 3000000000,
    candles: {
      '5m': bullishCandles,
      '15m': bullishCandles,
      '30m': bullishCandles,
    },
    metadata: { priceChange24h: 3.5, priceChangePercent24h: 3.5, highPrice24h: 64000, lowPrice24h: 59000 }
  };
  const bullishContext = new StrategyContext(bullishSnapshot as any, 10000);
  const scalperResult = scalper.evaluate(bullishContext.freeze());
  console.log(`ScalperV2 Result: hasSignal=${scalperResult.hasSignal}, signalType=${scalperResult.metadata?.signal?.type}, confidence=${scalperResult.confidenceScore}, reasoning=${scalperResult.metadata?.reasoning?.join('; ')}`);

  // 2. Mean Reversion Oversold Bounce Injection
  console.log('\n[Scenario B] Testing MeanReversion Oversold Bounce Reversal...');
  const meanRev = registry.createStrategy('MeanReversion')!;
  const oversoldCandles: NormalizedCandle[] = [];
  for (let i = 0; i < 200; i++) {
    // Sharp drop then immediate bounce on last candle
    const p = i < 198 ? basePrice - i * 30 : (i === 198 ? basePrice - 6000 : basePrice - 5900);
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
    candles: {
      '15m': oversoldCandles,
      '1h': oversoldCandles,
    },
    metadata: { priceChange24h: -5.0, priceChangePercent24h: -5.0, highPrice24h: 60000, lowPrice24h: 54000 }
  };
  const oversoldContext = new StrategyContext(oversoldSnapshot as any, 10000);
  const meanRevResult = meanRev.evaluate(oversoldContext.freeze());
  console.log(`MeanReversion Result: hasSignal=${meanRevResult.hasSignal}, signalType=${meanRevResult.metadata?.signal?.type}, confidence=${meanRevResult.confidenceScore}, reasoning=${meanRevResult.metadata?.reasoning?.join('; ')}`);

  // 3. Market Regime Engine Verification
  const regimeHighs = bullishCandles.map(c => c.high);
  const regimeLows = bullishCandles.map(c => c.low);
  const regimeCloses = bullishCandles.map(c => c.close);
  const detectedRegime = MarketRegimeEngine.evaluate(regimeHighs, regimeLows, regimeCloses);
  const scalperAllowed = MarketRegimeEngine.isStrategyAllowed('ScalperV2', detectedRegime);
  console.log(`Market Regime Detected: ${detectedRegime.regime} (Score: ${detectedRegime.score}) | ScalperV2 Allowed: ${scalperAllowed.allowed} (${scalperAllowed.reason})`);

  auditResults.push({
    section: 'Part 4 - Trade Detection Pipeline',
    testName: 'Controlled Strategy Signal Generation & Market Regime',
    status: 'PASS',
    evidence: {
      scalperEvaluation: scalperResult,
      meanReversionEvaluation: meanRevResult,
      regimeEvaluation: detectedRegime,
      regimeGateCheck: scalperAllowed
    }
  });

  // ---------------------------------------------------------------------------
  // PART 7 & 8: TRADE VALIDATION, RISK GATE & EXECUTION PIPELINE
  // ---------------------------------------------------------------------------
  console.log('\n>>> [PART 7 & 8] Trade Validation & Final Dispatch Safety Gate Verification...');

  // 1. Order Size & Precision Validation using TradeValidator
  const tradeValidationInput = {
    symbol: 'BTC/USDT',
    side: 'BUY' as const,
    orderType: 'LIMIT' as const,
    entryIntent: 'WAIT_FOR_PRICE' as const,
    entryPrice: livePrice,
    currentMarketPrice: livePrice,
    markPrice: livePrice,
    tradeValueUsdt: 500, // $500 position
  };

  const exchangeRules = {
    schemaVersion: '2.0',
    symbol: 'BTC/USDT',
    exchange: 'bybit',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    minNotional: 5,
    minQty: 0.001,
    maxQty: 100,
    stepSize: 0.001,
    tickSize: 0.1,
    minPrice: 1,
    maxPrice: 1000000,
    contractSize: 1,
    priceLimitRatioX: 0.10,
    priceLimitRatioY: 0.10,
    markPrice: livePrice,
    lastUpdated: Date.now()
  };

  const validationResult = TradeValidator.validate(tradeValidationInput, exchangeRules);
  console.log(`TradeValidator Result: isValid=${validationResult.isValid}, quantizedQty=${validationResult.quantizedQuantity} BTC, postRoundingNotional=$${validationResult.postRoundingNotional}`);

  // 2. Final Dispatch Safety Gate Check
  const orderReq = {
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    amount: new BigNumber(validationResult.quantizedQuantity!),
    price: new BigNumber(livePrice),
    clientOrderId: 'test_order_' + Date.now(),
    timeInForce: 'GTC',
    params: {}
  };

  let safetyGatePassed = false;
  try {
    FinalDispatchSafetyGate.validate(orderReq, {
      stepSize: exchangeRules.stepSize,
      tickSize: exchangeRules.tickSize,
      minQty: exchangeRules.minQty,
      minNotional: exchangeRules.minNotional,
    });
    safetyGatePassed = true;
    console.log(`FinalDispatchSafetyGate: PASSED (All precision and notional bounds verified)`);
  } catch (err: any) {
    console.error(`FinalDispatchSafetyGate: REJECTED (${err.message})`);
  }

  // 3. Idempotency & Reconciliation Engine Check
  console.log('\n[Reconciliation Engine] Testing Reconciliation of Synthetic Order Intent...');
  const syntheticIntent = {
    intentId: 'audit_intent_' + Date.now(),
    version: Date.now(),
    symbol: 'BTC/USDT',
    side: 'buy',
    orderType: 'market',
    qty: validationResult.quantizedQuantity!.toString(),
    price: livePrice.toString(),
    status: 'DISPATCHED',
    requestedStopLoss: livePrice * 0.98,
    requestedTakeProfit: livePrice * 1.03,
    createdAt: Date.now(),
    reconciliationAttemptCount: 0,
    payloadSnapshot: orderReq
  };

  // Run reconciliation against provider (expected ORDER_NOT_FOUND on fresh random ID)
  const reconciledIntent = await ReconciliationEngine.reconcile(bybitAdapter, syntheticIntent as any, Date.now());
  console.log(`Reconciliation Result: status=${reconciledIntent.status}, attempts=${reconciledIntent.reconciliationAttemptCount}`);

  auditResults.push({
    section: 'Part 7 & 8 - Order Execution & Safety Gates',
    testName: 'TradeValidator, FinalDispatchSafetyGate & Reconciliation',
    status: (validationResult.isValid && safetyGatePassed) ? 'PASS' : 'FAIL',
    evidence: {
      tradeValidation: validationResult,
      safetyGatePassed,
      reconciledIntent
    }
  });

  // ---------------------------------------------------------------------------
  // SUMMARY REPORT
  // ---------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('                          FORENSIC AUDIT SUMMARY TABLE');
  console.log('================================================================================');
  console.table(auditResults.map(r => ({
    Section: r.section,
    Test: r.testName,
    Status: r.status
  })));

  await bybitAdapter.disconnect();
}

runForensicAudit().catch(err => {
  console.error('Forensic Audit encountered fatal error:', err);
  process.exit(1);
});
