export interface SignalDTO {
  type: 'BUY' | 'SELL' | 'HOLD';
  entryContext: string;
  stopLoss: number | null;
  takeProfit: number | null;
  riskClassification: string;
  reasoning: string[];
}
