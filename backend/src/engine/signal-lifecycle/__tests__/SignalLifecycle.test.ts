import { describe, it, expect, beforeEach } from 'vitest';
import {
  SignalDataMapper,
  generateObservationId,
  generateOpportunityId,
  ModeAAuthorityPolicy,
  DefaultTimeframeCorrelationPolicy,
  ShadowComparisonEngine,
  SignalLifecycleManager,
  NormalizedObservation,
} from '../index';

describe('CryptoPulse Phase 2.1 — Signal Lifecycle Manager Test Suite', () => {
  const baseValidEvaluation = {
    strategyId: 'ScalperV2',
    confidenceScore: 78,
    hasSignal: true,
    symbol: 'BTCUSDT',
    metadata: {
      signal: {
        type: 'BUY',
        symbol: 'BTCUSDT',
        timeframe: '15m',
        candleTimestamp: 1728000000000,
        signalPrice: 65432.1,
        indicators: { rsi: 28.5, macd: 12.4 },
      },
      targetTimeframe: '15m',
    },
  };

  // --------------------------------------------------------------------------
  // Scenario 1: Invalid timeframe string fails closed and drops observation
  // --------------------------------------------------------------------------
  it('Scenario 1: Invalid primary timeframe string fails closed without fallthrough', () => {
    const invalidTfEval = {
      ...baseValidEvaluation,
      metadata: {
        ...baseValidEvaluation.metadata,
        signal: {
          ...baseValidEvaluation.metadata.signal,
          timeframe: '2m', // Invalid timeframe
        },
        targetTimeframe: '15m', // Valid fallback should NOT be used
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(invalidTfEval);
    expect(obs).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Missing timeframe with valid targetTimeframe falls back cleanly
  // --------------------------------------------------------------------------
  it('Scenario 2: Missing primary timeframe with valid targetTimeframe falls back cleanly', () => {
    const fallbackTfEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          timeframe: undefined, // Genuinely absent
        },
        targetTimeframe: '1h',
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(fallbackTfEval);
    expect(obs).not.toBeNull();
    expect(obs?.timeframe).toBe('1h');
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Missing timeframe and missing targetTimeframe fails closed
  // --------------------------------------------------------------------------
  it('Scenario 3: Missing timeframe and missing targetTimeframe fails closed (never defaults to 5m)', () => {
    const missingAllTfEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          timeframe: undefined,
        },
        targetTimeframe: undefined,
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(missingAllTfEval);
    expect(obs).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Invalid candleTimestamp fails closed without fallthrough
  // --------------------------------------------------------------------------
  it('Scenario 4: Invalid candleTimestamp (<= 0 or NaN) fails closed without fallthrough', () => {
    const invalidTsEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          candleTimestamp: -100, // Invalid
          timestamp: 1728000000000, // Valid secondary should NOT be reached
        },
      },
    };

    const obs1 = SignalDataMapper.mapEvaluationToObservation(invalidTsEval);
    expect(obs1).toBeNull();

    const nanTsEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          candleTimestamp: NaN,
          timestamp: 1728000000000,
        },
      },
    };
    const obs2 = SignalDataMapper.mapEvaluationToObservation(nanTsEval);
    expect(obs2).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Missing candleTimestamp with valid timestamp falls back cleanly
  // --------------------------------------------------------------------------
  it('Scenario 5: Missing candleTimestamp with valid signal.timestamp falls back cleanly', () => {
    const fallbackTsEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          candleTimestamp: undefined, // Genuinely absent
          timestamp: 1728111222000,
        },
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(fallbackTsEval);
    expect(obs).not.toBeNull();
    expect(obs?.closedCandleTimestamp).toBe(1728111222000);
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Missing candleTimestamp and timestamp falls back to trace
  // --------------------------------------------------------------------------
  it('Scenario 6: Missing candleTimestamp and timestamp falls back to trace.latestCandleTimestamp', () => {
    const fallbackTraceEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          candleTimestamp: undefined,
          timestamp: undefined,
        },
        trace: {
          latestCandleTimestamp: 1728333444000,
        },
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(fallbackTraceEval);
    expect(obs).not.toBeNull();
    expect(obs?.closedCandleTimestamp).toBe(1728333444000);
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Missing all candle timestamps fails closed
  // --------------------------------------------------------------------------
  it('Scenario 7: Missing all candle timestamps fails closed (never substitutes Date.now())', () => {
    const missingAllTsEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          candleTimestamp: undefined,
          timestamp: undefined,
        },
        trace: {},
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(missingAllTsEval);
    expect(obs).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 8: Invalid signalPrice fails closed without fallthrough
  // --------------------------------------------------------------------------
  it('Scenario 8: Invalid signalPrice (NaN or <= 0) fails closed without fallthrough', () => {
    const invalidPriceEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          signalPrice: 0, // Invalid
          entryPrice: 65000, // Valid secondary should NOT be reached
        },
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(invalidPriceEval);
    expect(obs).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Missing signalPrice with valid entryPrice falls back cleanly
  // --------------------------------------------------------------------------
  it('Scenario 9: Missing signalPrice with valid entryPrice falls back cleanly', () => {
    const fallbackPriceEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          signalPrice: undefined, // Genuinely absent
          entryPrice: 64999.5,
        },
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(fallbackPriceEval);
    expect(obs).not.toBeNull();
    expect(obs?.entryPrice).toBe(64999.5);
  });

  // --------------------------------------------------------------------------
  // Scenario 10: Missing all price fields fails closed
  // --------------------------------------------------------------------------
  it('Scenario 10: Missing all price fields fails closed', () => {
    const missingAllPriceEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          signalPrice: undefined,
          entryPrice: undefined,
        },
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(missingAllPriceEval);
    expect(obs).toBeNull();
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Missing indicators safely defaults to {} without dropping observation
  // --------------------------------------------------------------------------
  it('Scenario 11: Missing indicators safely defaults to {} without dropping observation', () => {
    const noIndicatorsEval = {
      ...baseValidEvaluation,
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          indicators: undefined,
        },
      },
    };

    const obs = SignalDataMapper.mapEvaluationToObservation(noIndicatorsEval);
    expect(obs).not.toBeNull();
    expect(obs?.indicators).toEqual({});
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Deterministic ObsID format validation
  // --------------------------------------------------------------------------
  it('Scenario 12: Generates exact deterministic ObsID formula', () => {
    const obsId = generateObservationId('btcusdt', '15m', 'ScalperV2', 1728000000000);
    expect(obsId).toBe('OBS_BTCUSDT_15m_ScalperV2_1728000000000');
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Deterministic OppID format validation
  // --------------------------------------------------------------------------
  it('Scenario 13: Generates exact deterministic OppID formula', () => {
    const oppId = generateOpportunityId('ethusdt', 'BUY', 1728000000000);
    expect(oppId).toBe('OPP_ETHUSDT_BUY_1728000000000');
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Mode A authority overrides higher-confidence secondary strategies
  // --------------------------------------------------------------------------
  it('Scenario 14: Mode A authority overrides higher-confidence secondary strategies', () => {
    const committedObs: NormalizedObservation = {
      obsId: 'OBS_BTC_15m_ScalperV2_1',
      symbol: 'BTCUSDT',
      direction: 'BUY',
      strategyId: 'ScalperV2',
      timeframe: '15m',
      closedCandleTimestamp: 1728000000000,
      entryPrice: 65000,
      confidence: 60,
      indicators: {},
      receivedAt: Date.now(),
    };

    const highConfidenceSecondaryObs: NormalizedObservation = {
      obsId: 'OBS_BTC_1h_RsiStrategy_2',
      symbol: 'BTCUSDT',
      direction: 'SELL',
      strategyId: 'RsiStrategy',
      timeframe: '1h',
      closedCandleTimestamp: 1728000000000,
      entryPrice: 65000,
      confidence: 95, // Much higher confidence
      indicators: {},
      receivedAt: Date.now(),
    };

    const selection = ModeAAuthorityPolicy.selectPrimaryObservation(
      [highConfidenceSecondaryObs, committedObs],
      'ScalperV2'
    );

    expect(selection).not.toBeNull();
    expect(selection?.mode).toBe('MODE_A');
    expect(selection?.primary.strategyId).toBe('ScalperV2');
    expect(selection?.primary.direction).toBe('BUY');
  });

  // --------------------------------------------------------------------------
  // Scenario 15: Uncommitted mode selects highest-confidence observation
  // --------------------------------------------------------------------------
  it('Scenario 15: Uncommitted mode selects highest-confidence observation', () => {
    const obs1: NormalizedObservation = {
      obsId: 'OBS_1',
      symbol: 'ETHUSDT',
      direction: 'BUY',
      strategyId: 'EmaCrossover',
      timeframe: '15m',
      closedCandleTimestamp: 1728000000000,
      entryPrice: 3500,
      confidence: 70,
      indicators: {},
      receivedAt: Date.now(),
    };

    const obs2: NormalizedObservation = {
      obsId: 'OBS_2',
      symbol: 'ETHUSDT',
      direction: 'BUY',
      strategyId: 'MacdMomentum',
      timeframe: '15m',
      closedCandleTimestamp: 1728000000000,
      entryPrice: 3500,
      confidence: 88,
      indicators: {},
      receivedAt: Date.now(),
    };

    const selection = ModeAAuthorityPolicy.selectPrimaryObservation([obs1, obs2], null);
    expect(selection).not.toBeNull();
    expect(selection?.mode).toBe('HIGHEST_CONFIDENCE');
    expect(selection?.primary.strategyId).toBe('MacdMomentum');
    expect(selection?.primary.confidence).toBe(88);
  });

  // --------------------------------------------------------------------------
  // Scenario 16: Uncommitted mode tie-breaking adheres strictly to timeframe hierarchy (4h > 1h > 15m > 5m)
  // --------------------------------------------------------------------------
  it('Scenario 16: Uncommitted mode tie-breaking adheres strictly to timeframe hierarchy (4h > 1h > 15m > 5m)', () => {
    const obs5m: NormalizedObservation = {
      obsId: 'OBS_5M',
      symbol: 'SOLUSDT',
      direction: 'BUY',
      strategyId: 'StratA',
      timeframe: '5m',
      closedCandleTimestamp: 1728000000000,
      entryPrice: 150,
      confidence: 80,
      indicators: {},
      receivedAt: Date.now(),
    };

    const obs4h: NormalizedObservation = {
      obsId: 'OBS_4H',
      symbol: 'SOLUSDT',
      direction: 'BUY',
      strategyId: 'StratB',
      timeframe: '4h',
      closedCandleTimestamp: 1728000000000,
      entryPrice: 150,
      confidence: 80, // Equal confidence
      indicators: {},
      receivedAt: Date.now(),
    };

    const obs1h: NormalizedObservation = {
      obsId: 'OBS_1H',
      symbol: 'SOLUSDT',
      direction: 'BUY',
      strategyId: 'StratC',
      timeframe: '1h',
      closedCandleTimestamp: 1728000000000,
      entryPrice: 150,
      confidence: 80, // Equal confidence
      indicators: {},
      receivedAt: Date.now(),
    };

    const selection = ModeAAuthorityPolicy.selectPrimaryObservation([obs5m, obs1h, obs4h], null);
    expect(selection).not.toBeNull();
    expect(selection?.primary.timeframe).toBe('4h');
    expect(selection?.primary.strategyId).toBe('StratB');
  });

  // --------------------------------------------------------------------------
  // Scenario 17: Opposite-direction observation supersedes pending alert but does NOT execute a position flip
  // --------------------------------------------------------------------------
  it('Scenario 17: Opposite-direction observation supersedes opportunity without executing position flip', () => {
    const manager = new SignalLifecycleManager();

    // 1. Initial BUY evaluation
    const buyEval = {
      ...baseValidEvaluation,
      symbol: 'BTCUSDT',
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          type: 'BUY',
          candleTimestamp: 1728000000000,
        },
      },
    };

    const initialSignals = manager.processEvaluations([buyEval], 'ScalperV2');
    expect(initialSignals).toHaveLength(1);
    expect(initialSignals[0].action).toBe('BUY');
    const firstOppId = initialSignals[0].oppId;

    const oppAfterBuy = manager.getOpportunity(firstOppId);
    expect(oppAfterBuy?.state).toBe('ACTIVE');
    expect(oppAfterBuy?.direction).toBe('BUY');

    // 2. Subsequent genuine SELL reversal
    const sellEval = {
      ...baseValidEvaluation,
      symbol: 'BTCUSDT',
      metadata: {
        signal: {
          ...baseValidEvaluation.metadata.signal,
          type: 'SELL',
          candleTimestamp: 1728000060000,
        },
      },
    };

    const reversalSignals = manager.processEvaluations([sellEval], 'ScalperV2');
    expect(reversalSignals).toHaveLength(1);
    expect(reversalSignals[0].action).toBe('SELL');
    const secondOppId = reversalSignals[0].oppId;

    // Prior opportunity is marked SUPERSEDED
    const priorOpp = manager.getOpportunity(firstOppId);
    expect(priorOpp?.state).toBe('SUPERSEDED');
    expect(priorOpp?.supersededBy).toBe(secondOppId);

    // New opportunity is ACTIVE
    const newOpp = manager.getOpportunity(secondOppId);
    expect(newOpp?.state).toBe('ACTIVE');
    expect(newOpp?.direction).toBe('SELL');
  });

  // --------------------------------------------------------------------------
  // Scenario 18: Shadow comparison correctly identifies MATCH, EXPECTED_IMPROVEMENT, and POTENTIAL_REGRESSION
  // --------------------------------------------------------------------------
  it('Scenario 18: Shadow comparison correctly identifies MATCH, EXPECTED_IMPROVEMENT, and POTENTIAL_REGRESSION', () => {
    const shadowSignal: any = {
      oppId: 'OPP_BTCUSDT_BUY_1728000000000',
      symbol: 'BTCUSDT',
      action: 'BUY',
      entryPrice: 65000,
      confidence: 75,
      timeframe: '15m',
      strategy: 'ScalperV2',
      timestamp: Date.now(),
      candleTimestamp: 1728000000000,
      indicators: {},
      regime: 'TRENDING',
      correlationScore: 0.8,
      mode: 'MODE_A',
    };

    // 18A: MATCH (legacy BUY, shadow BUY)
    const matchLegacy = {
      symbol: 'BTCUSDT',
      side: 'BUY',
      strategy: 'ScalperV2_NEW',
      timeframe: '15m',
    };
    const matchResult = ShadowComparisonEngine.compare('BTCUSDT', matchLegacy, shadowSignal);
    expect(matchResult.classification).toBe('MATCH');

    // 18B: EXPECTED_IMPROVEMENT (legacy suppressed by gate, shadow has signal)
    const improvementResult = ShadowComparisonEngine.compare('BTCUSDT', null, shadowSignal, null, {
      isLegacySuppressedByGate: true,
      suppressionGate: 'SAME_TIMEFRAME_ACTIVE_ALERT',
    });
    expect(improvementResult.classification).toBe('EXPECTED_IMPROVEMENT');
    expect(improvementResult.discrepancyReasons[0]).toContain("Legacy suppressed by gate 'SAME_TIMEFRAME_ACTIVE_ALERT'");

    // 18C: POTENTIAL_REGRESSION (legacy had alert, shadow produced nothing)
    const regressionResult = ShadowComparisonEngine.compare('BTCUSDT', matchLegacy, null);
    expect(regressionResult.classification).toBe('POTENTIAL_REGRESSION');
    expect(regressionResult.discrepancyReasons[0]).toContain('Legacy produced BUY alert, but shadow emitted no canonical signal');
  });
});
