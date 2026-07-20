import { EngineStateMachine } from '../state-machine/EngineStateMachine';
import { EngineState } from '../dto/EngineState';
import { StrategyContext } from '../context/StrategyContext';
import { IStrategy } from '../interfaces/IStrategy';
import { EvaluationResult } from '../dto/EvaluationResult';
import { MarketDataEngine } from '../market-data/MarketDataEngine';
import { Timeframe } from '../market-data/Timeframe';

export class StrategyOrchestrator {
  private stateMachine: EngineStateMachine;
  private registeredStrategies: Map<string, IStrategy> = new Map();
  private marketDataEngine: MarketDataEngine | null = null;
  private requiredTimeframes: Timeframe[] = ['5m', '15m', '1h']; // Configurable based on strategies later

  constructor() {
    this.stateMachine = new EngineStateMachine();
  }

  public setMarketDataEngine(engine: MarketDataEngine): void {
    this.marketDataEngine = engine;
  }

  public registerStrategy(id: string, strategy: IStrategy): void {
    this.registeredStrategies.set(id, strategy);
  }

  public async executeCycle(symbol: string, strategyId?: string): Promise<EvaluationResult[]> {
    try {
      if (this.stateMachine.getState() === EngineState.INITIALIZING || this.stateMachine.getState() === EngineState.WAITING) {
        this.stateMachine.transition(EngineState.COLLECTING_DATA);
      }

      console.log('[Orchestrator] Collecting Data...');
      if (!this.marketDataEngine) {
        throw new Error('MarketDataEngine is not configured on the StrategyOrchestrator');
      }

      const snapshot = await this.marketDataEngine.getSnapshot(symbol, this.requiredTimeframes);
      
      this.stateMachine.transition(EngineState.EVALUATING);
      
      const context = new StrategyContext(snapshot);
      const frozenContext = context.freeze();

      const results: EvaluationResult[] = [];
      for (const [id, strategy] of this.registeredStrategies) {
        if (strategyId && id !== strategyId) continue;
        console.log(`[Orchestrator] Evaluating strategy: ${id}`);
        try {
            const result = strategy.evaluate(frozenContext);
            results.push(result);
        } catch (e) {
            console.error(`[Orchestrator] Strategy ${id} evaluation failed`, e);
        }
      }

      this.stateMachine.transition(EngineState.WAITING);
      
      return results;

    } catch (e) {
      console.error('[Orchestrator] Fatal error during cycle execution', e);
      this.stateMachine.transition(EngineState.ERROR);
      throw e;
    }
  }

  public getCurrentState(): EngineState {
    return this.stateMachine.getState();
  }
}
