import { Timeframe } from '../market-data/Timeframe';

export type StrategyStatus = 'ACTIVE' | 'EXPERIMENTAL' | 'DEPRECATED';

export interface StrategyManifest {
  id: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  riskProfile: string;
  supportedMarkets: string[];
  supportedTimeframes: Timeframe[];
  minimumCandles: number;
  defaultConfiguration: Record<string, any>;
  supportsLong: boolean;
  supportsShort: boolean;
  supportsPaperTrading: boolean;
  supportsLiveTrading: boolean;
  status: StrategyStatus;
  author: string;
}
