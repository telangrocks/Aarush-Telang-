import { SignalType } from './SignalType';
import { RiskAssessment } from '../risk';

export interface SignalContext {
  symbol: string;
  timeframe: string;
  currentPrice: number;
  targetEntryPrice?: number | null;
}

export interface TradingSignal {
  symbol: string;
  timeframe: string;
  type: SignalType;
  confidenceScore: number;
  riskAssessment: RiskAssessment | null;
  /**
   * Primary market price at exact second signal was generated.
   */
  signalPrice: number | null;
  /**
   * Optional planned entry price specified by user during Trade Setup.
   */
  targetEntryPrice?: number | null;
  /**
   * @deprecated Retained for v1.0 backward compatibility. Use `signalPrice` instead.
   */
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reasoning: string[];
  timestamp: number;
}
