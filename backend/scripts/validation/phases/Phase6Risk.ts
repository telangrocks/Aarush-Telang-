/**
 * Phase 6: Risk Engine & Bounds Refusal (Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";
import { TradeValidator } from "../../../src/validation/TradeValidator";

export class Phase6Risk implements ValidationPhase {
  public readonly phaseId = 6;
  public readonly phaseName = "Risk Engine & Bounds Refusal";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = false;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";

    const symbolRules = {
      symbol: context.selectedCandidateSymbol,
      exchange: "binance",
      baseAsset: "BTC",
      quoteAsset: "USDT",
      minNotional: 10,
      minQty: 0.0001,
      maxQty: 10,
      stepSize: 0.0001,
      tickSize: 0.01,
      minPrice: 1,
      maxPrice: 1000000,
      contractSize: 1,
      lastUpdated: Date.now(),
      schemaVersion: "2.0" as const,
    };

    // 1. Valid Trade Setup Validation
    const validParams = {
      symbol: context.selectedCandidateSymbol,
      entryPrice: context.liveTickerPrice > 0 ? context.liveTickerPrice : 50000,
      quantity: 0.05,
      stopLoss: 49000,
      takeProfit: 52500,
    };

    const validResult = TradeValidator.validate(validParams, symbolRules);
    const validOk = validResult.isValid === true;
    assertions.push({
      name: "Valid Trade Setup Verification",
      passed: validOk,
      details: validOk ? "Valid trade setup passed risk quantization" : `Validation failed: ${validResult.errorMessage}`,
      empiricalData: validResult,
      failureCategory: validOk ? undefined : "APPLICATION_DEFECT",
    });
    if (!validOk) status = "FAIL";

    // 2. Out-of-Bounds Refusal Assertion (Quantity Below Min Qty)
    const invalidQtyParams = {
      symbol: context.selectedCandidateSymbol,
      entryPrice: 50000,
      quantity: 0.000001, // Below minQty 0.0001
    };
    const invalidQtyResult = TradeValidator.validate(invalidQtyParams, symbolRules);
    const qtyBlocked = invalidQtyResult.isValid === false;
    assertions.push({
      name: "Invalid Quantity Refusal Assertion",
      passed: qtyBlocked,
      details: qtyBlocked ? `Refused invalid order quantity cleanly: ${invalidQtyResult.errorMessage}` : "Failed to block invalid order quantity below minQty",
      empiricalData: invalidQtyResult,
      failureCategory: qtyBlocked ? undefined : "APPLICATION_DEFECT",
    });
    if (!qtyBlocked) status = "FAIL";

    // 3. Out-of-Bounds Refusal Assertion (Notional Below Min Notional)
    const invalidNotionalParams = {
      symbol: context.selectedCandidateSymbol,
      entryPrice: 50000,
      quantity: 0.0001, // 0.0001 * 50000 = $5 USDT (Below minNotional $10)
    };
    const invalidNotionalResult = TradeValidator.validate(invalidNotionalParams, symbolRules);
    const notionalBlocked = invalidNotionalResult.isValid === false;
    assertions.push({
      name: "Invalid Notional Value Refusal Assertion",
      passed: notionalBlocked,
      details: notionalBlocked ? `Refused order below minimum notional: ${invalidNotionalResult.errorMessage}` : "Failed to block order below minNotional",
      empiricalData: invalidNotionalResult,
      failureCategory: notionalBlocked ? undefined : "APPLICATION_DEFECT",
    });
    if (!notionalBlocked) status = "FAIL";

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
