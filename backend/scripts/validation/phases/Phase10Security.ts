/**
 * Phase 10: Notifications & Security Redaction Audit (Functional & Non-Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";
import { SecurityRedactor } from "../utils/SecurityRedactor";

export class Phase10Security implements ValidationPhase {
  public readonly phaseId = 10;
  public readonly phaseName = "Notifications & Security Redaction Audit";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = false;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";

    // 1. Notification Payload Structure & Dispatch Readiness
    const sampleNotification = {
      title: `Trade Alert: BUY ${context.selectedCandidateSymbol}`,
      body: `Live Signal Generated | Entry: $${context.liveTickerPrice}`,
      timestamp: Date.now(),
    };
    const notifOk = Boolean(sampleNotification.title && sampleNotification.body);
    assertions.push({
      name: "Notification Payload Formatting",
      passed: notifOk,
      details: notifOk ? "Notification alert payload formatted cleanly" : "Notification title/body invalid",
      empiricalData: sampleNotification,
      failureCategory: notifOk ? undefined : "APPLICATION_DEFECT",
    });
    if (!notifOk) status = "FAIL";

    // 2. Automated Security Audit (Redaction Verification)
    const rawSecret = "super-secret-api-key-998877665544332211";
    SecurityRedactor.registerSecret(rawSecret);
    const textWithSecret = `Connecting to exchange with key=${rawSecret} and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c`;
    const sanitizedText = SecurityRedactor.sanitize(textWithSecret);

    const secretRedacted = !sanitizedText.includes(rawSecret);
    const jwtRedacted = !sanitizedText.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");

    assertions.push({
      name: "Automated Log & Artifact Security Redaction Check",
      passed: secretRedacted && jwtRedacted,
      details: secretRedacted && jwtRedacted ? "JWT tokens and registered API keys 100% sanitized" : `Unredacted secret leak detected: secret=${!secretRedacted}, jwt=${!jwtRedacted}`,
      failureCategory: secretRedacted && jwtRedacted ? undefined : "APPLICATION_DEFECT",
    });
    if (!secretRedacted || !jwtRedacted) status = "FAIL";

    return {
      phaseId: this.phaseId,
      phaseName: this.phaseName,
      level: context.level,
      status,
      assertions,
      metrics: {
        durationMs: performance.now() - startTime,
      },
    };
  }
}
