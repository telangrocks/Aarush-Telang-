import { EngineStatusDTO } from './EngineStatusDTO';
import { MarketAnalysisDTO } from './MarketAnalysisDTO';
import { SignalDTO } from './SignalDTO';

export * from './EngineStatusDTO';
export * from './MarketAnalysisDTO';
export * from './SignalDTO';
export * from './EngineAPIService';

export interface AndroidIntegrationContract {
  engineStatus: EngineStatusDTO;
  marketAnalysis: MarketAnalysisDTO;
  tradingSignal: SignalDTO;
}
