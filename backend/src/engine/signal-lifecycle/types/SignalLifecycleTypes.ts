export type LifecycleState = 'FORMING' | 'ACTIVE' | 'SUPERSEDED' | 'EXPIRED';

export type MarketRegime = 'TRENDING' | 'RANGING' | 'VOLATILE' | 'UNKNOWN';

export const VALID_LIFECYCLE_TIMEFRAMES = ['5m', '15m', '1h', '4h'] as const;
export type LifecycleTimeframe = typeof VALID_LIFECYCLE_TIMEFRAMES[number];

export interface NormalizedObservation {
  obsId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  strategyId: string;
  timeframe: LifecycleTimeframe;
  closedCandleTimestamp: number;
  entryPrice: number;
  confidence: number;
  indicators: Record<string, any>;
  regime?: MarketRegime;
  receivedAt: number;
}

export interface OpportunityRecord {
  oppId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  firstBarClosedTimestamp: number;
  lastUpdatedTimestamp: number;
  state: LifecycleState;
  primaryObservation: NormalizedObservation;
  supportingObservations: NormalizedObservation[];
  conflictingObservations: NormalizedObservation[];
  alertSentAt?: number;
  supersededBy?: string;
}

export interface CanonicalTradeSignal {
  oppId: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  entryPrice: number;
  confidence: number;
  timeframe: LifecycleTimeframe;
  strategy: string;
  timestamp: number;
  candleTimestamp: number;
  indicators: Record<string, any>;
  regime: MarketRegime;
  correlationScore: number;
  mode: 'MODE_A' | 'HIGHEST_CONFIDENCE';
}

export type ShadowClassification = 'MATCH' | 'EXPECTED_IMPROVEMENT' | 'POTENTIAL_REGRESSION';

export interface ShadowComparisonResult {
  symbol: string;
  timestamp: number;
  legacySignal: any | null;
  shadowSignal: CanonicalTradeSignal | null;
  classification: ShadowClassification;
  discrepancyReasons: string[];
  telemetry: Record<string, any>;
}
