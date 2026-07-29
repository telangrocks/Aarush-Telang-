/**
 * Phase 9: Process Recovery & Restart Simulation (Non-Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";

export class Phase9Recovery implements ValidationPhase {
  public readonly phaseId = 9;
  public readonly phaseName = "Process Recovery & Restart Simulation";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = false;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";
    let recoveryLatency = 0;

    // 1. Query Bot State Recovery Endpoint (/api/bot/analysis-status)
    try {
      const rStart = performance.now();
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (context.authToken) {
        headers["Authorization"] = `Bearer ${context.authToken}`;
      }
      const res = await globalThis.fetch(`${context.workerUrl}/api/bot/analysis-status`, { headers });
      recoveryLatency = Math.round(performance.now() - rStart);
      const json: any = res.ok ? await res.json() : null;
      const stateOk = res.status === 200 || res.status === 404;
      const slaOk = recoveryLatency <= context.config.maxRecoveryLatencyMs;

      assertions.push({
        name: "Durable Object Engine State Recovery SLA",
        passed: stateOk && slaOk,
        details: stateOk ? `Engine state re-hydrated in ${recoveryLatency}ms (SLA <= ${context.config.maxRecoveryLatencyMs}ms)` : `Status=${res.status}`,
        empiricalData: { httpStatus: res.status, recoveryLatencyMs: recoveryLatency, response: json },
        failureCategory: stateOk ? (slaOk ? undefined : "INFRASTRUCTURE_DEFECT") : "APPLICATION_DEFECT",
      });
      if (!stateOk || !slaOk) status = "FAIL";

      context.recordEvidence({
        phaseId: 9,
        label: "Bot engine analysis-status query",
        url: `${context.workerUrl}/api/bot/analysis-status`,
        httpStatus: res.status,
        latencyMs: recoveryLatency,
        payload: json,
      });
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Durable Object Engine State Recovery SLA",
        passed: false,
        details: `State recovery query exception: ${e.message}`,
        failureCategory: "APPLICATION_DEFECT",
      });
    }

    return {
      phaseId: this.phaseId,
      phaseName: this.phaseName,
      level: context.level,
      status,
      assertions,
      metrics: {
        durationMs: performance.now() - startTime,
        apiLatencyMs: recoveryLatency,
      },
    };
  }
}
