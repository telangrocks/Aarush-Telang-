export interface EngineStatusDTO {
  state: string; // FSM state
  activeStrategy: string;
  lastEvaluationTimestamp: number;
  nextEvaluationTime: number | null;
  health: 'OK' | 'DEGRADED' | 'ERROR';
}
