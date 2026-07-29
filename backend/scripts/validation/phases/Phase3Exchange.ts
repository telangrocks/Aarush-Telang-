/**
 * Phase 3: Exchange Connectivity & Permissions Audit (Functional & Non-Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";
import { ProviderFactory } from "../../../src/exchanges/ProviderFactory";

export class Phase3Exchange implements ValidationPhase {
  public readonly phaseId = 3;
  public readonly phaseName = "Exchange Connectivity & Permissions Audit";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = true;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";
    let apiLatency = 0;

    // 1. Diagnostic Environment Variable Presence Report
    const keyPresence = context.exchangeApiKey ? `PRESENT (len: ${context.exchangeApiKey.length})` : "MISSING";
    const secretPresence = context.exchangeApiSecret ? `PRESENT (len: ${context.exchangeApiSecret.length})` : "MISSING";
    const passphrasePresence = context.exchangePassphrase ? `PRESENT (len: ${context.exchangePassphrase.length})` : "MISSING / OPTIONAL";

    const envDiagnostic = {
      EXCHANGE_API_KEY: keyPresence,
      EXCHANGE_API_SECRET: secretPresence,
      EXCHANGE_PASSPHRASE: passphrasePresence,
      validationLevel: context.level,
    };

    assertions.push({
      name: "Credential Pipeline Environment Diagnostic",
      passed: true,
      details: `API Key: ${keyPresence} | API Secret: ${secretPresence} | Passphrase: ${passphrasePresence}`,
      empiricalData: envDiagnostic,
    });

    // 2. Instantiation of Exchange Provider
    let provider: any = null;
    try {
      provider = ProviderFactory.create("binance");
      const instantiated = Boolean(provider);
      assertions.push({
        name: "Exchange Provider Instantiation",
        passed: instantiated,
        details: instantiated ? "CcxtProvider instantiated for Binance" : "ProviderFactory returned null",
        failureCategory: instantiated ? undefined : "APPLICATION_DEFECT",
      });
      if (!instantiated) status = "FAIL";
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Exchange Provider Instantiation",
        passed: false,
        details: `Instantiation exception: ${e.message}`,
        failureCategory: "APPLICATION_DEFECT",
      });
    }

    // 3. Exchange REST API Ping & Connection
    if (provider) {
      try {
        const pStart = performance.now();
        await provider.connect({
          apiKey: context.exchangeApiKey,
          secret: context.exchangeApiSecret,
          passphrase: context.exchangePassphrase,
          environment: context.level === "level2_testnet" ? "testnet" : "mainnet",
        });
        apiLatency = Math.round(performance.now() - pStart);
        const slaOk = apiLatency <= context.config.maxExchangeApiLatencyMs;

        assertions.push({
          name: "Exchange REST API Connectivity & Ping SLA",
          passed: slaOk,
          details: `Connected in ${apiLatency}ms (SLA <= ${context.config.maxExchangeApiLatencyMs}ms)`,
          empiricalData: { latencyMs: apiLatency, environment: context.level === "level2_testnet" ? "testnet" : "mainnet" },
          failureCategory: slaOk ? undefined : "THIRD_PARTY_SERVICE_FAILURE",
        });
        if (!slaOk) status = "FAIL";

        context.recordEvidence({
          phaseId: 3,
          label: "Exchange connect ping",
          latencyMs: apiLatency,
          payload: { connected: true, exchangeId: "binance" },
        });
      } catch (e: any) {
        status = "FAIL";
        assertions.push({
          name: "Exchange REST API Connectivity & Ping SLA",
          passed: false,
          details: `Exchange connection exception: ${e.message}`,
          failureCategory: "THIRD_PARTY_SERVICE_FAILURE",
        });
      }
    }

    // 4. Authenticated Balances & Key Permissions Check (Level 2 / Level 3 only)
    if (context.level !== "level1_public") {
      if (!context.exchangeApiKey || !context.exchangeApiSecret) {
        assertions.push({
          name: "Authenticated Balance & Permission Check",
          passed: false,
          details: `Missing required exchange credentials in environment (Key: ${keyPresence}, Secret: ${secretPresence}). Check GitHub Secrets -> Workflow Env mapping.`,
          empiricalData: envDiagnostic,
          failureCategory: "INFRASTRUCTURE_DEFECT",
        });
        status = "FAIL";
      } else {
        try {
          const bStart = performance.now();
          const balances = await provider.fetchBalance();
          const bLatency = Math.round(performance.now() - bStart);
          const hasBalances = Array.isArray(balances);

          assertions.push({
            name: "Authenticated Balance & Permission Check",
            passed: hasBalances,
            details: hasBalances ? `Retrieved ${balances.length} currency balances in ${bLatency}ms` : "Failed to fetch balances",
            empiricalData: { balanceCount: balances?.length || 0, fetchLatencyMs: bLatency, balancesSample: balances?.slice(0, 3) },
            failureCategory: hasBalances ? undefined : "THIRD_PARTY_SERVICE_FAILURE",
          });
          if (!hasBalances) status = "FAIL";

          context.recordEvidence({
            phaseId: 3,
            label: "Exchange fetchBalance query",
            latencyMs: bLatency,
            payload: { balanceCount: balances?.length || 0, sample: balances?.slice(0, 3) },
          });
        } catch (e: any) {
          status = "FAIL";
          const rawErrorDetails = {
            errorName: e?.name || "ExchangeAuthError",
            errorMessage: e?.message || String(e),
            ccxtCode: e?.code,
            stack: e?.stack,
          };
          assertions.push({
            name: "Authenticated Balance & Permission Check",
            passed: false,
            details: `Raw Exchange Auth Failure: ${e.message}`,
            empiricalData: rawErrorDetails,
            failureCategory: "THIRD_PARTY_SERVICE_FAILURE",
          });

          context.recordEvidence({
            phaseId: 3,
            label: "Exchange fetchBalance raw error",
            payload: rawErrorDetails,
          });
        }
      }
    } else {
      assertions.push({
        name: "Authenticated Balance & Permission Check",
        passed: true,
        details: `Skipped in Level 1 Public mode (Credentials Diagnostic: Key: ${keyPresence}, Secret: ${secretPresence})`,
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
        apiLatencyMs: apiLatency,
      },
    };
  }
}
