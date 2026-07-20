import { EngineStatusDTO, MarketAnalysisDTO, SignalDTO, AndroidIntegrationContract, IndicatorSummary, ConditionSummary } from './index';

export class EngineAPIService {
  public transform(
    state: string,
    strategyId: string | null,
    coinId: string | null,
    result?: any // EvaluationResult
  ): AndroidIntegrationContract {
    
    const engineStatus: EngineStatusDTO = {
      state: state,
      activeStrategy: strategyId || 'None',
      lastEvaluationTimestamp: result?.timestamp || Date.now(),
      nextEvaluationTime: (result?.timestamp || Date.now()) + 15000,
      health: 'OK'
    };

    let indicatorSummary: IndicatorSummary[] = [];
    let conditionSummary: ConditionSummary[] = [];
    let confidenceScore = 0;
    let confidenceExplanation: string[] = [];
    let tradingSignal: SignalDTO = {
      type: 'HOLD',
      entryContext: '',
      stopLoss: null,
      takeProfit: null,
      riskClassification: 'LOW',
      reasoning: ['No data evaluated']
    };

    if (result) {
      confidenceScore = result.confidenceScore || 0;
      
      const indSnap = result.metadata?.indicatorSnapshot;
      if (indSnap && Object.keys(indSnap.timeframes).length > 0) {
        // Just take the first available timeframe for the summary
        const tf = Object.keys(indSnap.timeframes)[0];
        const tfData = indSnap.timeframes[tf];
        
        if (tfData.rsi && tfData.rsi[14]) {
          const rsiVal = tfData.rsi[14][tfData.rsi[14].length - 1];
          indicatorSummary.push({
            name: 'RSI(14)',
            value: rsiVal ? rsiVal.toFixed(2) : 'N/A',
            signal: rsiVal > 60 ? 'BULLISH' : rsiVal < 40 ? 'BEARISH' : 'NEUTRAL'
          });
        }
        if (tfData.macd && tfData.macd['12,26,9']) {
          const macd = tfData.macd['12,26,9'][tfData.macd['12,26,9'].length - 1];
          indicatorSummary.push({
            name: 'MACD',
            value: macd && macd.histogram !== undefined ? macd.histogram.toFixed(2) : 'N/A',
            signal: macd && macd.histogram > 0 ? 'BULLISH' : 'BEARISH'
          });
        }
      }

      const condRes = result.metadata?.conditionResult;
      if (condRes && condRes.results) {
        condRes.results.forEach((r: any) => {
          conditionSummary.push({
            id: r.id,
            name: r.id,
            currentValue: String(r.actualValue),
            targetValue: String(r.expectedValue),
            status: r.isMet ? 'PASSED' : 'FAILED'
          });
        });
      }

      const sig = result.metadata?.signal;
      if (sig) {
        tradingSignal = {
          type: sig.type,
          entryContext: `Entry on ${sig.timeframe}`,
          stopLoss: sig.stopLoss,
          takeProfit: sig.takeProfit,
          riskClassification: sig.riskAssessment?.classification || 'UNKNOWN',
          reasoning: sig.reasoning || result.metadata.reasoning
        };
        confidenceExplanation = sig.reasoning || result.metadata.reasoning;
      }
    }

    const marketAnalysis: MarketAnalysisDTO = {
      symbol: coinId || 'UNKNOWN',
      timeframeStatus: 'SYNCED',
      indicatorSummary,
      conditionSummary,
      confidenceScore,
      confidenceExplanation
    };

    return {
      engineStatus,
      marketAnalysis,
      tradingSignal
    };
  }
}
