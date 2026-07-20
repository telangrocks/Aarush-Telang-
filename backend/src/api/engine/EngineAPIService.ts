import { EngineStatusDTO, MarketAnalysisDTO, SignalDTO, AndroidIntegrationContract } from './index';
import { EngineState, EvaluationResult } from '../../engine';

export class EngineAPIService {
  public transform(
    state: EngineState,
    coinId: string,
    result?: EvaluationResult
  ): AndroidIntegrationContract {
    
    const engineStatus: EngineStatusDTO = {
      state: state.toString(),
      activeStrategy: result ? result.strategyId : 'NONE',
      lastEvaluationTimestamp: result ? result.timestamp : Date.now(),
      nextEvaluationTime: null, // Populated by DO logic later if needed
      health: state === EngineState.ERROR ? 'ERROR' : 'OK'
    };

    let indicatorSummary: any[] = [];
    let conditionSummary: any[] = [];
    
    if (result && result.metadata && result.metadata.indicatorSnapshot) {
      // Map indicator snapshots to simple key-value summaries
      const indicators = result.metadata.indicatorSnapshot;
      Object.keys(indicators).forEach(k => {
        indicatorSummary.push({
          name: k,
          value: JSON.stringify(indicators[k]),
          signal: 'NEUTRAL' // Basic rendering mapping; UI handles color
        });
      });
    }

    if (result && result.metadata && result.metadata.conditionResult) {
      // Map condition results
      const conditions = result.metadata.conditionResult;
      Object.keys(conditions).forEach(k => {
        const val = conditions[k];
        conditionSummary.push({
          id: k,
          name: k,
          currentValue: typeof val === 'object' ? JSON.stringify(val) : String(val),
          targetValue: '',
          status: val === true ? 'PASSED' : (val === false ? 'FAILED' : 'WAITING')
        });
      });
    }

    const marketAnalysis: MarketAnalysisDTO = {
      symbol: coinId,
      timeframeStatus: 'SYNCED', // Assumed from successful execution
      indicatorSummary,
      conditionSummary,
      confidenceScore: result ? result.confidenceScore : 0,
      confidenceExplanation: result && result.metadata ? result.metadata.reasoning : []
    };

    const sig = result && result.metadata && result.metadata.signal ? result.metadata.signal : null;

    const tradingSignal: SignalDTO = {
      type: sig ? sig.type : 'HOLD',
      entryContext: sig ? JSON.stringify(sig.entryContext || '') : '',
      signalPrice: sig ? (sig.signalPrice ?? sig.entryPrice ?? null) : null,
      targetEntryPrice: sig ? (sig.targetEntryPrice ?? null) : null,
      stopLoss: sig ? sig.stopLoss : null,
      takeProfit: sig ? sig.takeProfit : null,
      riskClassification: result && result.metadata && result.metadata.riskAssessment ? result.metadata.riskAssessment.classification : 'UNKNOWN',
      reasoning: result && result.metadata ? result.metadata.reasoning : []
    };

    return {
      engineStatus,
      marketAnalysis,
      tradingSignal
    };
  }
}
