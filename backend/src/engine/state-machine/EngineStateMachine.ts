import { EngineState } from '../dto/EngineState';

export class EngineStateMachine {
  private currentState: EngineState = EngineState.INITIALIZING;

  public transition(newState: EngineState): void {
    if (this.canTransition(newState)) {
      console.log(`[FSM] State transition: ${this.currentState} -> ${newState}`);
      this.currentState = newState;
    } else {
      console.warn(`[FSM] Invalid state transition attempted: ${this.currentState} -> ${newState}`);
      // In a strict environment, we might throw here, but for now we'll just log and force ERROR
      this.currentState = EngineState.ERROR;
    }
  }

  public getState(): EngineState {
    return this.currentState;
  }

  private canTransition(newState: EngineState): boolean {
    switch (this.currentState) {
      case EngineState.INITIALIZING:
        return newState === EngineState.COLLECTING_DATA || newState === EngineState.ERROR;
      case EngineState.COLLECTING_DATA:
        return newState === EngineState.EVALUATING || newState === EngineState.ERROR;
      case EngineState.EVALUATING:
        return newState === EngineState.WAITING || newState === EngineState.ERROR;
      case EngineState.WAITING:
        return newState === EngineState.COLLECTING_DATA || newState === EngineState.ERROR;
      case EngineState.ERROR:
        // From ERROR, we might allow a re-initialization in the future
        return newState === EngineState.INITIALIZING;
      default:
        return false;
    }
  }
}
