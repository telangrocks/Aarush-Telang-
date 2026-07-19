import { Timeframe } from '../market-data';

export interface MACDResult {
  macdLine: number;
  signalLine: number;
  histogram: number;
}

export interface VolumeResult {
  averageVolume: number;
  volumeChangePercent: number;
}

export interface TimeframeIndicators {
  rsi: Record<number, number[]>; // key: period -> array of values aligned with candles
  sma: Record<number, number[]>;
  ema: Record<number, number[]>;
  macd: Record<string, MACDResult[]>; // key: "fast,slow,signal"
  atr: Record<number, number[]>;
  volume: VolumeResult[];
}

export interface IndicatorSnapshot {
  timestamp: number;
  timeframes: Record<string, TimeframeIndicators>;
}

export interface IndicatorConfig {
  rsiPeriods: number[];
  smaPeriods: number[];
  emaPeriods: number[];
  macdParams: { fast: number; slow: number; signal: number }[];
  atrPeriods: number[];
  volumeAveragePeriod: number;
}
