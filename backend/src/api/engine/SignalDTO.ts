export interface SignalDTO {
  type: 'BUY' | 'SELL' | 'HOLD';
  entryContext: string;
  signalPrice?: number | null;
  targetEntryPrice?: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  riskClassification: string;
  reasoning: string[];
}
