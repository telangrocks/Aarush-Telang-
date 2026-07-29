/**
 * Production Validation Framework — Phase Interfaces & Types
 */

export type ValidationLevel = "level1_public" | "level2_testnet" | "level3_prod_smoke";

export type FailureCategory = "APPLICATION_DEFECT" | "INFRASTRUCTURE_DEFECT" | "THIRD_PARTY_SERVICE_FAILURE" | "ENVIRONMENT_RESTRICTION";

export interface PhaseMetrics {
  durationMs: number;
  apiLatencyMs?: number;
  dbLatencyMs?: number;
  memoryUsageMb?: number;
}

export interface PhaseAssertion {
  name: string;
  passed: boolean;
  details: string;
  empiricalData?: any;
  failureCategory?: FailureCategory;
}

export interface PhaseResult {
  phaseId: number;
  phaseName: string;
  level: ValidationLevel;
  status: "PASS" | "FAIL" | "SKIP";
  assertions: PhaseAssertion[];
  metrics: PhaseMetrics;
  error?: string;
  failureCategory?: FailureCategory;
}

export interface ValidationPhase {
  readonly phaseId: number;
  readonly phaseName: string;
  readonly minLevel: ValidationLevel;
  readonly isDependentGate: boolean; // If true, failure halts subsequent dependent phases

  execute(context: any): Promise<PhaseResult>;
}
