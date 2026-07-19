import { SignalType } from './SignalType';
import { RiskAssessment } from '../risk';

export interface SignalContext {
  symbol: string;
  timeframe: string;
  currentPrice: number;
}

export interface TradingSignal {
  symbol: string;
  timeframe: string;
  type: SignalType;
  confidenceScore: number;
  riskAssessment: RiskAssessment | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  reasoning: string[];
  timestamp: number;
}
