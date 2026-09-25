import { MarketSnapshot, NormalizedCandle } from '../market-data/MarketSnapshot';
import { MarketRegime } from '../regime/MarketRegimeEngine';

/**
 * 1. Market Quality: Evaluates intrinsic instrument tradability, liquidity, and data sanity.
 * Independent of whether a directional opportunity exists.
 */
export type MarketQualityGrade = 'PRIME' | 'ACCEPTABLE' | 'DEGRADED' | 'REJECTED';

export interface MarketQualityAssessment {
  readonly symbol: string;
  readonly grade: MarketQualityGrade;
  readonly turnover24hUsdt: number;
  readonly bidAskSpreadPercent: number;
  readonly orderBookDepthScore: number;       // 0-100 normalized top-of-book depth
  readonly tickSize: number;
  readonly qtyStep?: number;
  readonly minOrderQty: number;
  readonly minNotionalUsdt: number;
  readonly isStablecoinOrLeveraged: boolean;
  readonly priceChangePercent24h?: number;
  readonly dataSanity: {
    readonly isFresh: boolean;
    readonly gapCount: number;
    readonly hasStaleCandles: boolean;
  };
  readonly rejectionReasons: string[];
}

/**
 * 2. Opportunity State Lifecycle
 * Explicit state machine transitions for opportunity discovery and trigger tracking.
 */
export type OpportunityState =
  | 'DISCOVERED'           // Passed hard filters; initial stage
  | 'QUALIFIED'            // Passed multi-timeframe quality and regime compatibility
  | 'HIGH_CONVICTION'      // Exceptional MTF alignment and cost-adjusted edge
  | 'TRIGGER_APPROACHING'  // Setup formed; execution timeframe (1m) near trigger
  | 'SIGNAL_READY'         // Strategy signal engine confirmed active entry setup
  | 'INVALIDATED'          // Structure broken or setup deteriorated (bypasses hysteresis)
  | 'EXPIRED'              // Timed out without trigger confirmation
  | 'DATA_DEGRADED';       // Upstream exchange candle anomaly detected

/**
 * 3. Directional Evaluation
 * Preserved for both LONG and SHORT independently to avoid directional bias.
 */
export interface DirectionalEvaluation {
  readonly direction: 'LONG' | 'SHORT';
  readonly rawScore: number;                 // 0-100 unweighted hypothesis score
  readonly mtfAlignmentScore: number;        // 0-100 alignment across 4h, 1h, 15m, 5m
  readonly momentumScore: number;            // 0-100 RSI/MACD acceleration
  readonly volumeScore: number;              // 0-100 volume breakout/trend
  readonly netEdgeRatio: number;             // Expected move vs total friction
  readonly isViable: boolean;                // Passes minimum edge ratio
  readonly reasons: string[];
  readonly warnings: string[];
}

/**
 * 4. Raw Factor Measurements
 * Preserved in telemetry without weighting for empirical backtesting and validation.
 */
export interface OpportunityFactors {
  readonly mtfAlignmentScore: number;
  readonly regimeScore: number;
  readonly momentumScore: number;
  readonly volumeRatio: number;              // Current vol vs 20 SMA
  readonly spreadPercent: number;
  readonly estimatedSlippagePercent: number;
  readonly roundTripFeePercent: number;
  readonly totalFrictionPercent: number;
  readonly netEdgeRatio: number;
  readonly adx14: number;
  readonly emaSlope20: number;
  readonly atrExpansionRatio: number;
}

/**
 * 5. Strategy Compatibility Vector
 * Compatibility is NOT a trading signal. Indicates structural fit for an authorized strategy.
 */
export interface StrategyCompatibilityVector {
  readonly strategyId: string;
  readonly displayName: string;
  readonly isAllowedInRegime: boolean;
  readonly directionalSupport: 'LONG_ONLY' | 'SHORT_ONLY' | 'LONG_AND_SHORT';
  readonly compatibilityScore: number;      // 0-100
  readonly disqualificationReason?: string;
}

/**
 * 6. Timeframe Analysis Snapshot
 * Summary of technical conditions per hierarchical timeframe.
 */
export interface TimeframeAnalysisSnapshot {
  readonly timeframe: '4h' | '1h' | '15m' | '5m' | '1m';
  readonly trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  readonly momentum: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  readonly closePrice: number;
  readonly ema20?: number;
  readonly ema50?: number;
  readonly rsi14?: number;
  readonly atr14?: number;
  readonly candleTimestamp: number;
  readonly isFresh: boolean;
}

/**
 * 7. Market Opportunity
 * Complete domain entity representing a discovered trading opportunity.
 */
export interface MarketOpportunity {
  readonly opportunityId: string;
  readonly symbol: string;
  readonly timestamp: number;
  readonly state: OpportunityState;
  readonly dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  
  // Tripartite Separation
  readonly marketQuality: MarketQualityAssessment;
  readonly marketRegime: MarketRegime & {
    readonly adx14: number;
    readonly emaSlope20Percent: number;
    readonly atrExpansionRatio: number;
  };
  
  // Multi-Timeframe State
  readonly mtfState: 'ALIGNED' | 'TRANSITIONAL' | 'CONFLICTING';
  readonly timeframes: {
    readonly '4h'?: TimeframeAnalysisSnapshot;
    readonly '1h'?: TimeframeAnalysisSnapshot;
    readonly '15m'?: TimeframeAnalysisSnapshot;
    readonly '5m'?: TimeframeAnalysisSnapshot;
    readonly '1m'?: TimeframeAnalysisSnapshot;
  };
  
  // Both directional evaluations preserved
  readonly longEvaluation: DirectionalEvaluation;
  readonly shortEvaluation: DirectionalEvaluation;
  
  // Strategy Compatibility
  readonly strategyCompatibility: StrategyCompatibilityVector[];
  
  // Empirical Observation Factors
  readonly rawFactors: OpportunityFactors;
  
  // Overall Opportunity Score (Hypothesis-based)
  readonly opportunityScore: number;
  readonly reasons: string[];
  readonly warnings: string[];
  
  // Ranking & Hysteresis State
  readonly currentRank: number | null;
  readonly previousRank: number | null;
  readonly lastStateTransitionAt: number;
  readonly invalidationReason?: string;
  
  // Explicit Strategy Signal Separation
  readonly currentStrategySignal?: {
    readonly hasActiveSignal: boolean;
    readonly strategyId?: string;
    readonly signalType?: 'BUY' | 'SELL';
    readonly entryPrice?: number;
    readonly stopLoss?: number;
    readonly takeProfit?: number;
  };
}

/**
 * 8. Configurable Analytical Hypotheses
 * All scoring weights, thresholds, and fee structures are exposed as configuration parameters.
 */
export interface ScannerConfig {
  // Hard Eligibility & Liquidity Thresholds
  readonly minTurnover24hUsdt: number;        // e.g. 1,000,000
  readonly maxSpreadPercent: number;          // e.g. 0.20%
  readonly minRange24hPercent: number;        // e.g. 1.5%
  
  // Fee & Friction Assumptions (Analytical)
  readonly takerFeePercent: number;           // e.g. 0.055% (Bybit standard VIP0)
  readonly makerFeePercent: number;           // e.g. 0.020%
  readonly slippageCoefficient: number;       // e.g. 0.15 (beta coefficient for market impact)
  readonly minNetEdgeRatio: number;           // e.g. 3.0 (Expected Target >= 3x Total Friction)
  
  // Hypothesis Weights (Must sum to 100)
  readonly weights: {
    readonly mtfAlignment: number;            // default: 35
    readonly regimeAndStrategyFit: number;    // default: 25
    readonly momentumAndVolume: number;       // default: 20
    readonly costFeasibility: number;         // default: 20
  };
  
  // Anti-Churn Parameters
  readonly hysteresisScoreBuffer: number;     // default: 3.0 points required to dethrone
  readonly rankLockDurationMs: number;        // default: 45,000 ms (45s)
  readonly staleOpportunityExpiryMs: number;  // default: 90,000 ms (90s)
  
  // Display vs Discovery
  readonly displayLimit: number;              // default: 10 (UI slice; discovery is unconstrained)
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  minTurnover24hUsdt: 1_000_000,
  maxSpreadPercent: 0.20,
  minRange24hPercent: 1.5,
  takerFeePercent: 0.055,
  makerFeePercent: 0.020,
  slippageCoefficient: 0.15,
  minNetEdgeRatio: 3.0,
  weights: {
    mtfAlignment: 35,
    regimeAndStrategyFit: 25,
    momentumAndVolume: 20,
    costFeasibility: 20,
  },
  hysteresisScoreBuffer: 3.0,
  rankLockDurationMs: 45_000,
  staleOpportunityExpiryMs: 90_000,
  displayLimit: 10,
};

/**
 * 9. Factor-Level Observation Record
 * Preserved for empirical backtesting, outcome correlation, and model validation.
 */
export interface ScannerTelemetryRecord {
  readonly cycleId: string;
  readonly timestamp: number;
  readonly executionDurationMs: number;
  readonly universeSize: number;
  readonly eligibleCount: number;
  readonly qualityCount: number;
  readonly screenedCount: number;
  readonly deepScanCount: number;
  readonly qualifiedOpportunityCount: number;
  readonly opportunities: Array<{
    readonly symbol: string;
    readonly rank: number | null;
    readonly dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
    readonly state: OpportunityState;
    readonly opportunityScore: number;
    readonly factorScores: {
      readonly mtfScore: number;
      readonly regimeScore: number;
      readonly momentumScore: number;
      readonly feasibilityScore: number;
    };
    readonly rawMetrics: {
      readonly adx14: number;
      readonly emaSlope20: number;
      readonly atrExpansionRatio: number;
      readonly spreadPercent: number;
      readonly netEdgeRatio: number;
      readonly totalFrictionPercent: number;
    };
    readonly compatibleStrategies: string[];
    readonly hasActiveStrategySignal: boolean;
  }>;
}
