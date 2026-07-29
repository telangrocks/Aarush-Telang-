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

    // 1. Instantiation of Exchange Provider
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

    // 2. Exchange REST API Ping & Connection
    if (provider) {
      try {
        const pStart = performance.now();
        await provider.connect({ environment: "mainnet" });
        apiLatency = Math.round(performance.now() - pStart);
        const slaOk = apiLatency <= context.config.maxExchangeApiLatencyMs;

        assertions.push({
          name: "Exchange REST API Connectivity & Ping SLA",
          passed: slaOk,
          details: `Connected in ${apiLatency}ms (SLA <= ${context.config.maxExchangeApiLatencyMs}ms)`,
          empiricalData: { latencyMs: apiLatency },
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

    // 3. Authenticated Balances & Key Permissions Check (Level 2 / Level 3 only)
    if (context.level !== "level1_public") {
      if (!context.exchangeApiKey || !context.exchangeApiSecret) {
        assertions.push({
          name: "Authenticated Balance & Permission Check",
          passed: false,
          details: "Missing required EXCHANGE_API_KEY / EXCHANGE_API_SECRET environment variables",
          failureCategory: "INFRASTRUCTURE_DEFECT",
        });
        status = "FAIL";
      } else {
        try {
          const balances = await provider.fetchBalance();
          const hasBalances = Array.isArray(balances);
          assertions.push({
            name: "Authenticated Balance & Permission Check",
            passed: hasBalances,
            details: hasBalances ? `Retrieved ${balances.length} currency balances` : "Failed to fetch balances",
            empiricalData: { balanceCount: balances?.length || 0 },
            failureCategory: hasBalances ? undefined : "THIRD_PARTY_SERVICE_FAILURE",
          });
          if (!hasBalances) status = "FAIL";
        } catch (e: any) {
          status = "FAIL";
          assertions.push({
            name: "Authenticated Balance & Permission Check",
            passed: false,
            details: `Balance query failed: ${e.message}`,
            failureCategory: "THIRD_PARTY_SERVICE_FAILURE",
          });
        }
      }
    } else {
      assertions.push({
        name: "Authenticated Balance & Permission Check",
        passed: true,
        details: "Skipped in Level 1 Public mode (no keys required)",
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
