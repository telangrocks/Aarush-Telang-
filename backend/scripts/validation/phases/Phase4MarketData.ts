/**
 * Phase 4: Market Data Freshness & Timestamps (Functional)
 */

import { ValidationPhase, PhaseResult, ValidationLevel } from "../models/ValidationPhase";
import { ValidationContext } from "../models/ValidationContext";
import { ProviderFactory } from "../../../src/exchanges/ProviderFactory";

export class Phase4MarketData implements ValidationPhase {
  public readonly phaseId = 4;
  public readonly phaseName = "Market Data Freshness & Timestamps";
  public readonly minLevel: ValidationLevel = "level1_public";
  public readonly isDependentGate = true;

  public async execute(context: ValidationContext): Promise<PhaseResult> {
    const startTime = performance.now();
    const assertions = [];
    let status: "PASS" | "FAIL" = "PASS";
    let fetchLatency = 0;

    const provider = ProviderFactory.create("binance");
    await provider.connect({ environment: "mainnet" });

    // 1. Fetch Ticker & Verify Non-Zero Price
    try {
      const tStart = performance.now();
      const ticker = await provider.fetchTicker(context.selectedCandidateSymbol);
      fetchLatency = Math.round(performance.now() - tStart);
      const price = ticker.last.toNumber();
      context.liveTickerPrice = price;

      const priceOk = price > 0;
      assertions.push({
        name: "Live Market Ticker & Price Assertion",
        passed: priceOk,
        details: priceOk ? `Live ${context.selectedCandidateSymbol} Price = $${price}` : "Ticker price is 0 or invalid",
        empiricalData: { symbol: context.selectedCandidateSymbol, price, timestamp: ticker.timestamp },
        failureCategory: priceOk ? undefined : "THIRD_PARTY_SERVICE_FAILURE",
      });
      if (!priceOk) status = "FAIL";

      context.recordEvidence({
        phaseId: 4,
        label: "Live ticker query",
        latencyMs: fetchLatency,
        payload: { symbol: context.selectedCandidateSymbol, price, timestamp: ticker.timestamp },
      });
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Live Market Ticker & Price Assertion",
        passed: false,
        details: `Ticker fetch exception: ${e.message}`,
        failureCategory: "THIRD_PARTY_SERVICE_FAILURE",
      });
    }

    // 2. Fetch 15m Candles & Verify Freshness SLA (<60s)
    try {
      const kStart = performance.now();
      const candles = await provider.fetchKlines(context.selectedCandidateSymbol, "15m", 100);
      const klineLatency = Math.round(performance.now() - kStart);
      context.liveCandles = candles;

      const hasCandles = Array.isArray(candles) && candles.length >= 50;
      const latestCandle = hasCandles ? candles[candles.length - 1] : null;
      const candleAgeSec = latestCandle ? Math.round((Date.now() - latestCandle.openTime) / 1000) : 9999;
      const staleOk = candleAgeSec <= (15 * 60 + context.config.maxKlineStaleAgeSeconds);
      const slaOk = klineLatency <= context.config.maxKlineFetchLatencyMs;

      assertions.push({
        name: "Kline Data Count & Timeliness SLA",
        passed: hasCandles && staleOk && slaOk,
        details: hasCandles
          ? `Fetched ${candles.length} candles in ${klineLatency}ms (Age: ${candleAgeSec}s, SLA <= ${context.config.maxKlineFetchLatencyMs}ms)`
          : "Candle data array incomplete or empty",
        empiricalData: { candleCount: candles?.length || 0, latestOpenTime: latestCandle?.openTime, candleAgeSec, klineLatency },
        failureCategory: hasCandles && staleOk && slaOk ? undefined : "THIRD_PARTY_SERVICE_FAILURE",
      });
      if (!hasCandles || !staleOk || !slaOk) status = "FAIL";

      context.recordEvidence({
        phaseId: 4,
        label: "Kline candle query",
        latencyMs: klineLatency,
        payload: { candleCount: candles?.length || 0, latestOpenTime: latestCandle?.openTime },
      });
    } catch (e: any) {
      status = "FAIL";
      assertions.push({
        name: "Kline Data Count & Timeliness SLA",
        passed: false,
        details: `Kline fetch exception: ${e.message}`,
        failureCategory: "THIRD_PARTY_SERVICE_FAILURE",
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
        apiLatencyMs: fetchLatency,
      },
    };
  }
}
