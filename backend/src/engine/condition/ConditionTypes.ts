import { Timeframe } from '../market-data';

export interface TrendConditionResult {
  priceAboveEMA: boolean;
  emaCrossoverState: 'BULLISH' | 'BEARISH' | 'NONE';
  trendDirection: 'UP' | 'DOWN' | 'SIDEWAYS';
}

export interface MomentumConditionResult {
  rsiState: 'OVERBOUGHT' | 'OVERSOLD' | 'NEUTRAL';
  macdDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

export interface VolatilityConditionResult {
  atrState: 'EXPANDING' | 'CONTRACTING' | 'NEUTRAL';
}

export interface VolumeConditionResult {
  volumeTrend: 'INCREASING' | 'DECREASING' | 'NEUTRAL';
  volumeConfirmation: boolean;
}

export interface TimeframeConditionResult {
  trend: TrendConditionResult;
  momentum: MomentumConditionResult;
  volatility: VolatilityConditionResult;
  volume: VolumeConditionResult;
}

export interface ConditionResult {
  timestamp: number;
  timeframes: Record<string, TimeframeConditionResult>;
}

export interface ConditionConfig {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  macdKey: string; // e.g. "12,26,9"
  atrPeriod: number;
  volumePeriod: number;
}
