import { describe, it, expect } from 'vitest';
import { OpportunityRanker } from './OpportunityRanker';
import { MarketOpportunity, DEFAULT_SCANNER_CONFIG } from './ScannerTypes';

function createMockOpportunity(
  symbol: string,
  score: number,
  direction: 'LONG' | 'SHORT' = 'LONG',
  state: MarketOpportunity['state'] = 'QUALIFIED',
  invalidationReason?: string
): MarketOpportunity {
  return {
    opportunityId: `opp_${symbol}`,
    symbol,
    timestamp: Date.now(),
    state,
    dominantDirection: direction,
    marketQuality: {
      symbol,
      grade: 'PRIME',
      turnover24hUsdt: 10_000_000,
      bidAskSpreadPercent: 0.02,
      orderBookDepthScore: 90,
      tickSize: 0.01,
      minOrderQty: 0.001,
      minNotionalUsdt: 5,
      isStablecoinOrLeveraged: false,
      dataSanity: { isFresh: true, gapCount: 0, hasStaleCandles: false },
      rejectionReasons: [],
    },
    marketRegime: {
      regime: 'TRENDING',
      score: 85,
      allowTrendStrategies: true,
      allowMeanReversion: false,
      adx14: 32,
      emaSlope20Percent: 0.8,
      atrExpansionRatio: 1.2,
    },
    mtfState: 'ALIGNED',
    timeframes: {},
    longEvaluation: {
      direction: 'LONG',
      rawScore: score,
      mtfAlignmentScore: 85,
      momentumScore: 80,
      volumeScore: 75,
      netEdgeRatio: 4.5,
      isViable: true,
      reasons: ['Strong alignment'],
      warnings: [],
    },
    shortEvaluation: {
      direction: 'SHORT',
      rawScore: 20,
      mtfAlignmentScore: 20,
      momentumScore: 20,
      volumeScore: 20,
      netEdgeRatio: 1.0,
      isViable: false,
      reasons: [],
      warnings: ['Against trend'],
    },
    strategyCompatibility: [],
    rawFactors: {
      mtfAlignmentScore: 85,
      regimeScore: 85,
      momentumScore: 80,
      volumeRatio: 1.5,
      spreadPercent: 0.02,
      estimatedSlippagePercent: 0.03,
      roundTripFeePercent: 0.11,
      totalFrictionPercent: 0.16,
      netEdgeRatio: 4.5,
      adx14: 32,
      emaSlope20: 0.8,
      atrExpansionRatio: 1.2,
    },
    opportunityScore: score,
    reasons: ['High conviction setup'],
    warnings: [],
    currentRank: null,
    previousRank: null,
    lastStateTransitionAt: Date.now(),
    invalidationReason,
  };
}

describe('OpportunityRanker', () => {
  it('enforces quality over quota: returns exactly all qualified candidates without forcing Top 10', () => {
    const ranker = new OpportunityRanker(DEFAULT_SCANNER_CONFIG);

    const candidates = [
      createMockOpportunity('BTCUSDT', 92),
      createMockOpportunity('ETHUSDT', 85),
    ];

    const result = ranker.rank(candidates);
    expect(result.allQualifiedOpportunities.length).toBe(2);
    expect(result.allQualifiedOpportunities[0].symbol).toBe('BTCUSDT');
    expect(result.allQualifiedOpportunities[0].currentRank).toBe(1);
    expect(result.allQualifiedOpportunities[1].symbol).toBe('ETHUSDT');
    expect(result.allQualifiedOpportunities[1].currentRank).toBe(2);
  });

  it('preserves all qualified opportunities beyond display limit in allQualifiedOpportunities', () => {
    const ranker = new OpportunityRanker({ ...DEFAULT_SCANNER_CONFIG, displayLimit: 5 });

    const candidates = Array.from({ length: 12 }, (_, i) =>
      createMockOpportunity(`COIN_${i}`, 80 - i)
    );

    const result = ranker.rank(candidates);
    expect(result.allQualifiedOpportunities.length).toBe(12);
    expect(result.topOpportunities.length).toBe(5);
    expect(result.allQualifiedOpportunities[11].currentRank).toBe(12);
  });

  it('strict invalidation precedence: structural invalidation immediately purges candidate, bypassing hysteresis', () => {
    const ranker = new OpportunityRanker(DEFAULT_SCANNER_CONFIG);
    const now = 1000000;

    const cycle1 = ranker.rank([
      createMockOpportunity('BTCUSDT', 90),
      createMockOpportunity('ETHUSDT', 80),
    ], now);

    expect(cycle1.allQualifiedOpportunities[0].symbol).toBe('BTCUSDT');

    const cycle2 = ranker.rank([
      createMockOpportunity('BTCUSDT', 89, 'LONG', 'INVALIDATED', 'Trend structure breached on 15m'),
      createMockOpportunity('ETHUSDT', 81),
    ], now + 5000);

    expect(cycle2.invalidatedCount).toBe(1);
    expect(cycle2.allQualifiedOpportunities.length).toBe(1);
    expect(cycle2.allQualifiedOpportunities[0].symbol).toBe('ETHUSDT');
    expect(cycle2.allQualifiedOpportunities[0].currentRank).toBe(1);
  });

  it('strict invalidation precedence: data degradation immediately purges candidate, bypassing hysteresis', () => {
    const ranker = new OpportunityRanker(DEFAULT_SCANNER_CONFIG);
    const now = 1000000;

    ranker.rank([createMockOpportunity('SOLUSDT', 95)], now);

    const cycle2 = ranker.rank([
      createMockOpportunity('SOLUSDT', 95, 'LONG', 'DATA_DEGRADED'),
    ], now + 5000);

    expect(cycle2.degradedCount).toBe(1);
    expect(cycle2.allQualifiedOpportunities.length).toBe(0);
  });

  it('directional invalidation clears rank lock immediately', () => {
    const ranker = new OpportunityRanker(DEFAULT_SCANNER_CONFIG);
    const now = 1000000;

    ranker.rank([createMockOpportunity('AVAXUSDT', 85, 'LONG')], now);
    expect(ranker.getIncumbent('AVAXUSDT')?.direction).toBe('LONG');

    ranker.rank([createMockOpportunity('AVAXUSDT', 82, 'SHORT')], now + 5000);
    expect(ranker.getIncumbent('AVAXUSDT')?.direction).toBe('SHORT');
  });

  it('applies hysteresis buffer to prevent UI rank churn on minor score fluctuations', () => {
    const ranker = new OpportunityRanker({
      ...DEFAULT_SCANNER_CONFIG,
      hysteresisScoreBuffer: 3.0,
      rankLockDurationMs: 45_000,
    });
    const now = 1000000;

    const c1 = ranker.rank([
      createMockOpportunity('COIN_A', 85.0),
      createMockOpportunity('COIN_B', 84.5),
    ], now);

    expect(c1.allQualifiedOpportunities[0].symbol).toBe('COIN_A');
    expect(c1.allQualifiedOpportunities[1].symbol).toBe('COIN_B');

    // CoinB ticks up to 86.0 (+1.0 above CoinA). Hysteresis buffer requires >= 3.0 to displace.
    const c2 = ranker.rank([
      createMockOpportunity('COIN_A', 85.0),
      createMockOpportunity('COIN_B', 86.0),
    ], now + 10_000);

    expect(c2.allQualifiedOpportunities[0].symbol).toBe('COIN_A');
    expect(c2.allQualifiedOpportunities[1].symbol).toBe('COIN_B');

    // CoinB surges to 89.5 (> 85.0 + 3.0 buffer)
    const c3 = ranker.rank([
      createMockOpportunity('COIN_A', 85.0),
      createMockOpportunity('COIN_B', 89.5),
    ], now + 20_000);

    expect(c3.allQualifiedOpportunities[0].symbol).toBe('COIN_B');
    expect(c3.allQualifiedOpportunities[1].symbol).toBe('COIN_A');
  });

  it('deduplicates identical opportunity identities (instrument + strategy + direction)', () => {
    const ranker = new OpportunityRanker(DEFAULT_SCANNER_CONFIG);
    const opp1 = {
      ...createMockOpportunity('ETH/USDT', 91, 'LONG'),
      opportunityId: 'ETH/USDT:ScalperV2:LONG',
      strategyCompatibility: [{ strategyId: 'ScalperV2', displayName: 'ScalperV2', isAllowedInRegime: true, directionalSupport: 'LONG_ONLY' as const, compatibilityScore: 90 }],
    };
    // Duplicate identical opportunity
    const opp2 = {
      ...createMockOpportunity('ETH/USDT', 91, 'LONG'),
      opportunityId: 'ETH/USDT:ScalperV2:LONG',
      strategyCompatibility: [{ strategyId: 'ScalperV2', displayName: 'ScalperV2', isAllowedInRegime: true, directionalSupport: 'LONG_ONLY' as const, compatibilityScore: 90 }],
    };
    const btcOpp = {
      ...createMockOpportunity('BTC/USDT', 93, 'LONG'),
      opportunityId: 'BTC/USDT:ScalperV2:LONG',
      strategyCompatibility: [{ strategyId: 'ScalperV2', displayName: 'ScalperV2', isAllowedInRegime: true, directionalSupport: 'LONG_ONLY' as const, compatibilityScore: 90 }],
    };

    const result = ranker.rank([btcOpp, opp1, opp2]);
    expect(result.allQualifiedOpportunities.length).toBe(2);
    expect(result.allQualifiedOpportunities[0].symbol).toBe('BTC/USDT');
    expect(result.allQualifiedOpportunities[0].currentRank).toBe(1);
    expect(result.allQualifiedOpportunities[1].symbol).toBe('ETH/USDT');
    expect(result.allQualifiedOpportunities[1].currentRank).toBe(2);
  });

  it('preserves legitimate different opportunities on the same instrument (e.g. ScalperV2 LONG vs Momentum SHORT)', () => {
    const ranker = new OpportunityRanker(DEFAULT_SCANNER_CONFIG);
    const ethLong = {
      ...createMockOpportunity('ETH/USDT', 91, 'LONG'),
      opportunityId: 'ETH/USDT:ScalperV2:LONG',
      strategyCompatibility: [{ strategyId: 'ScalperV2', displayName: 'ScalperV2', isAllowedInRegime: true, directionalSupport: 'LONG_ONLY' as const, compatibilityScore: 90 }],
    };
    const ethShort = {
      ...createMockOpportunity('ETH/USDT', 88, 'SHORT'),
      opportunityId: 'ETH/USDT:Momentum:SHORT',
      dominantDirection: 'SHORT' as const,
      strategyCompatibility: [{ strategyId: 'Momentum', displayName: 'Momentum', isAllowedInRegime: true, directionalSupport: 'SHORT_ONLY' as const, compatibilityScore: 85 }],
    };

    const result = ranker.rank([ethLong, ethShort]);
    expect(result.allQualifiedOpportunities.length).toBe(2);
    expect(result.allQualifiedOpportunities[0].opportunityId).toBe('ETH/USDT:ScalperV2:LONG');
    expect(result.allQualifiedOpportunities[0].currentRank).toBe(1);
    expect(result.allQualifiedOpportunities[1].opportunityId).toBe('ETH/USDT:Momentum:SHORT');
    expect(result.allQualifiedOpportunities[1].currentRank).toBe(2);
  });
});
