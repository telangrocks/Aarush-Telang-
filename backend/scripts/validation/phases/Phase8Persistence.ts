/**
 * Phase 8: D1 Database & Persistence Audit (Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";

export class Phase8Persistence implements ValidationPhase {
  public readonly phaseId = 8;
  public readonly phaseName = "D1 Database & Persistence Audit";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = false;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";
    let dbLatency = 0;

    // 1. Query D1 Table Schemas & Verify Persistence
    try {
      const qStart = performance.now();
      const res = await globalThis.fetch(`${context.workerUrl}/db-status`, {
        headers: { "Content-Type": "application/json" }
      });
      dbLatency = Math.round(performance.now() - qStart);
      const json: any = res.ok ? await res.json() : null;
      const tablesOk = res.status === 200 && json?.status === "ok";
      const slaOk = dbLatency <= context.config.maxDbLatencyMs;

      assertions.push({
        name: "Cloudflare D1 Table Schema & Query SLA",
        passed: tablesOk && slaOk,
        details: tablesOk ? `D1 database responsive in ${dbLatency}ms (SLA <= ${context.config.maxDbLatencyMs}ms)` : `D1 query status=${res.status}`,
        empiricalData: { httpStatus: res.status, dbLatency, tables: json?.tables || [] },
        failureCategory: tablesOk ? (slaOk ? undefined : "INFRASTRUCTURE_DEFECT") : "INFRASTRUCTURE_DEFECT",
      });
      if (!tablesOk || !slaOk) status = "FAIL";

      context.recordEvidence({
        phaseId: 8,
        label: "D1 database query",
        url: `${context.workerUrl}/db-status`,
        httpStatus: res.status,
        latencyMs: dbLatency,
        payload: json,
      });
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Cloudflare D1 Table Schema & Query SLA",
        passed: false,
        details: `D1 query exception: ${e.message}`,
        failureCategory: "INFRASTRUCTURE_DEFECT",
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
        dbLatencyMs: dbLatency,
      },
    };
  }
}
