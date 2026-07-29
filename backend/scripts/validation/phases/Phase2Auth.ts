/**
 * Phase 2: Authentication & JWT Token Lifecycle (Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";

export class Phase2Auth implements ValidationPhase {
  public readonly phaseId = 2;
  public readonly phaseName = "Authentication & JWT Token Lifecycle";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = true;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";

    const userEmail = `qa.val.${Date.now()}@cryptopulse.dev`;
    const password = "QaPassword!2026";
    context.userEmail = userEmail;

    // 1. User Registration & JWT Generation
    let token: string | null = null;
    let authLatency = 0;
    try {
      const aStart = performance.now();
      const res = await globalThis.fetch(`${context.workerUrl}/api/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userEmail, password, confirmPassword: password }),
      });
      authLatency = Math.round(performance.now() - aStart);
      const json: any = res.ok ? await res.json() : null;
      token = json?.accessToken || json?.token || null;
      context.authToken = token;

      const ok = (res.status === 200 || res.status === 201) && token !== null;
      const slaOk = authLatency <= context.config.maxWorkerLatencyMs;

      assertions.push({
        name: "User Registration & JWT Issuance",
        passed: ok && slaOk,
        details: ok ? `JWT Token issued successfully in ${authLatency}ms` : `Registration failed with status=${res.status}`,
        empiricalData: { httpStatus: res.status, latencyMs: authLatency, hasToken: Boolean(token) },
        failureCategory: ok ? (slaOk ? undefined : "APPLICATION_DEFECT") : "APPLICATION_DEFECT",
      });
      if (!ok || !slaOk) status = "FAIL";

      context.recordEvidence({
        phaseId: 2,
        label: "User registration /api/register",
        url: `${context.workerUrl}/api/register`,
        httpStatus: res.status,
        latencyMs: authLatency,
        payload: json,
      });
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "User Registration & JWT Issuance",
        passed: false,
        details: `Request exception: ${e.message}`,
        failureCategory: "APPLICATION_DEFECT",
      });
    }

    // 2. JWT Claim Signature & Expiry Inspection
    if (token) {
      try {
        const parts = token.split(".");
        const payloadJson = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
        const hasUserId = Boolean(payloadJson.sub || payloadJson.id || payloadJson.userId);
        const hasExp = typeof payloadJson.exp === "number";

        assertions.push({
          name: "JWT Claims & Expiration Structure",
          passed: hasUserId && hasExp,
          details: `Subject/ID=${payloadJson.sub || payloadJson.userId || "present"}, ExpireTimestamp=${payloadJson.exp}`,
          empiricalData: payloadJson,
          failureCategory: hasUserId && hasExp ? undefined : "APPLICATION_DEFECT",
        });
        if (!hasUserId || !hasExp) status = "FAIL";
      } catch (e: any) {
        status = "FAIL";
        assertions.push({
          name: "JWT Claims & Expiration Structure",
          passed: false,
          details: `JWT decoding error: ${e.message}`,
          failureCategory: "APPLICATION_DEFECT",
        });
      }
    }

    // 3. Unauthorized Access Rejection (HTTP 401 on Missing Token)
    try {
      const res = await globalThis.fetch(`${context.workerUrl}/api/user/profile`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });
      const ok = res.status === 401 || res.status === 403;
      assertions.push({
        name: "Unauthorized Access Rejection Check",
        passed: ok,
        details: ok ? `Unauthenticated request correctly rejected with status ${res.status}` : `Unexpected status=${res.status}`,
        empiricalData: { httpStatus: res.status },
        failureCategory: ok ? undefined : "APPLICATION_DEFECT",
      });
      if (!ok) status = "FAIL";
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Unauthorized Access Rejection Check",
        passed: false,
        details: `Request exception: ${e.message}`,
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
        apiLatencyMs: authLatency,
      },
    };
  }
}
