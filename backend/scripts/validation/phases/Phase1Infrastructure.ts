/**
 * Phase 1: Infrastructure & Dependency Health (Non-Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";

export class Phase1Infrastructure implements ValidationPhase {
  public readonly phaseId = 1;
  public readonly phaseName = "Infrastructure & Dependency Health";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = true;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";
    let workerLatency = 0;

    // 1. Worker /health Endpoint Audit
    try {
      const hStart = performance.now();
      const res = await globalThis.fetch(`${context.workerUrl}/health`, {
        headers: { "Content-Type": "application/json" }
      });
      workerLatency = Math.round(performance.now() - hStart);
      const json: any = res.ok ? await res.json() : null;
      const ok = res.status === 200 && json?.status === "ok";
      const slaOk = workerLatency <= context.config.maxWorkerLatencyMs;

      assertions.push({
        name: "Worker API Health (/health)",
        passed: ok && slaOk,
        details: ok ? `Status=200, Latency=${workerLatency}ms (SLA <= ${context.config.maxWorkerLatencyMs}ms)` : `HTTP status=${res.status}`,
        empiricalData: { httpStatus: res.status, latencyMs: workerLatency, response: json },
        failureCategory: ok ? (slaOk ? undefined : "INFRASTRUCTURE_DEFECT") : "INFRASTRUCTURE_DEFECT",
      });
      if (!ok || !slaOk) status = "FAIL";

      context.recordEvidence({
        phaseId: 1,
        label: "Worker /health endpoint",
        url: `${context.workerUrl}/health`,
        httpStatus: res.status,
        latencyMs: workerLatency,
        payload: json,
      });
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Worker API Health (/health)",
        passed: false,
        details: `Connection failed: ${e.message}`,
        failureCategory: "INFRASTRUCTURE_DEFECT",
      });
    }

    // 2. D1 Database Connectivity (/db-status)
    try {
      const dStart = performance.now();
      const res = await globalThis.fetch(`${context.workerUrl}/db-status`, {
        headers: { "Content-Type": "application/json" }
      });
      const dbLatency = Math.round(performance.now() - dStart);
      const json: any = res.ok ? await res.json() : null;
      const ok = res.status === 200 && json?.status === "ok";
      const slaOk = dbLatency <= context.config.maxDbLatencyMs;

      assertions.push({
        name: "Cloudflare D1 Database Connectivity (/db-status)",
        passed: ok && slaOk,
        details: ok ? `Status=200, Latency=${dbLatency}ms (SLA <= ${context.config.maxDbLatencyMs}ms)` : `HTTP status=${res.status}`,
        empiricalData: { httpStatus: res.status, latencyMs: dbLatency, response: json },
        failureCategory: ok ? (slaOk ? undefined : "INFRASTRUCTURE_DEFECT") : "INFRASTRUCTURE_DEFECT",
      });
      if (!ok || !slaOk) status = "FAIL";

      context.recordEvidence({
        phaseId: 1,
        label: "Cloudflare D1 /db-status endpoint",
        url: `${context.workerUrl}/db-status`,
        httpStatus: res.status,
        latencyMs: dbLatency,
        payload: json,
      });
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Cloudflare D1 Database Connectivity (/db-status)",
        passed: false,
        details: `Connection failed: ${e.message}`,
        failureCategory: "INFRASTRUCTURE_DEFECT",
      });
    }

    // 3. Node.js Memory Usage SLA Check
    const memUsageMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const memOk = memUsageMb <= context.config.maxMemoryUsageMb;
    assertions.push({
      name: "Runner Heap Memory Usage SLA",
      passed: memOk,
      details: `Heap Used: ${memUsageMb}MB (SLA <= ${context.config.maxMemoryUsageMb}MB)`,
      empiricalData: { heapUsedMb: memUsageMb },
      failureCategory: memOk ? undefined : "INFRASTRUCTURE_DEFECT",
    });
    if (!memOk) status = "FAIL";

    return {
      phaseId: this.phaseId,
      phaseName: this.phaseName,
      level: context.level,
      status,
      assertions,
      metrics: {
        durationMs: performance.now() - startTime,
        apiLatencyMs: workerLatency,
        memoryUsageMb: memUsageMb,
      },
    };
  }
}
