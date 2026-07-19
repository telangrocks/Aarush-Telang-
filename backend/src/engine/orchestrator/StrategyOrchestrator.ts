import { EngineStateMachine } from '../state-machine/EngineStateMachine';
import { EngineState } from '../dto/EngineState';
import { StrategyContext } from '../context/StrategyContext';
import { IStrategy } from '../interfaces/IStrategy';
import { EvaluationResult } from '../dto/EvaluationResult';

export class StrategyOrchestrator {
  private stateMachine: EngineStateMachine;
  private registeredStrategies: Map<string, IStrategy> = new Map();

  constructor() {
    this.stateMachine = new EngineStateMachine();
  }

  public registerStrategy(id: string, strategy: IStrategy): void {
    this.registeredStrategies.set(id, strategy);
  }

  public async executeCycle(): Promise<EvaluationResult[]> {
    try {
      if (this.stateMachine.getState() === EngineState.INITIALIZING || this.stateMachine.getState() === EngineState.WAITING) {
        this.stateMachine.transition(EngineState.COLLECTING_DATA);
      }

      // Simulate data collection phase (to be implemented in Sprint 2)
      console.log('[Orchestrator] Collecting Data...');
      
      this.stateMachine.transition(EngineState.EVALUATING);
      
      const context = new StrategyContext();
      const frozenContext = context.freeze();

      const results: EvaluationResult[] = [];
      for (const [id, strategy] of this.registeredStrategies) {
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
