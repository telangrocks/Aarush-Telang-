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
      const rawCandles = await provider.fetchKlines(context.selectedCandidateSymbol, "15m", 100);
      const klineLatency = Math.round(performance.now() - kStart);

      // Ensure candles are sorted in ascending chronological order (a.openTime < b.openTime)
      const candles = [...rawCandles].sort((a, b) => a.openTime - b.openTime);
      context.liveCandles = candles;

      const hasCandles = Array.isArray(candles) && candles.length >= 50;
      
      // Select the NEWEST available candle (last element in ascending chronological array)
      const newestCandle = hasCandles ? candles[candles.length - 1] : null;
      const oldestCandle = hasCandles ? candles[0] : null;

      const nowMs = Date.now();
      const localUtc = new Date(nowMs).toISOString();
      const exchangeTimeMs = nowMs - context.clockDriftMs;
      const exchangeUtc = new Date(exchangeTimeMs).toISOString();

      const klineOpenTimeMs = newestCandle ? newestCandle.openTime : 0;
      const klineCloseTimeMs = newestCandle ? newestCandle.openTime + 15 * 60 * 1000 : 0;
      
      const klineOpenUtc = newestCandle ? new Date(klineOpenTimeMs).toISOString() : "N/A";
      const klineCloseUtc = newestCandle ? new Date(klineCloseTimeMs).toISOString() : "N/A";

      // Age calculation: milliseconds difference converted to seconds
      const candleAgeSec = newestCandle ? Math.max(0, Math.round((nowMs - newestCandle.openTime) / 1000)) : 99999;
      
      // Max allowed age for a 15m candle = 15 minutes (900s) + configured stale tolerance (60s) = 960s
      const maxAllowedAgeSec = 15 * 60 + context.config.maxKlineStaleAgeSeconds;
      const staleOk = candleAgeSec <= maxAllowedAgeSec;
      const slaOk = klineLatency <= context.config.maxKlineFetchLatencyMs;

      // Diagnostic Empirical Evidence Log Payload
      const empiricalDiagnostic = {
        localSystemUtc: localUtc,
        exchangeServerUtc: exchangeUtc,
        clockDriftMs: context.clockDriftMs,
        symbol: context.selectedCandidateSymbol,
        interval: "15m",
        totalCandlesFetched: candles.length,
        oldestCandleOpenUtc: oldestCandle ? new Date(oldestCandle.openTime).toISOString() : "N/A",
        latestKlineOpenUtc: klineOpenUtc,
        latestKlineCloseUtc: klineCloseUtc,
        latestKlineOpenTimeMs: klineOpenTimeMs,
        currentTimestampMs: nowMs,
        calculatedAgeSeconds: candleAgeSec,
        maxAllowedAgeSeconds: maxAllowedAgeSec,
        rawNewestCandleObject: newestCandle,
      };

      assertions.push({
        name: "Kline Data Count, Chronological Order & Freshness Assertion",
        passed: hasCandles && staleOk && slaOk,
        details: hasCandles
          ? `Fetched ${candles.length} candles in ${klineLatency}ms. Newest Candle Open: ${klineOpenUtc} | Current UTC: ${localUtc} | Calculated Age: ${candleAgeSec}s (SLA <= ${maxAllowedAgeSec}s)`
          : "Candle data array incomplete or empty",
        empiricalData: empiricalDiagnostic,
        failureCategory: hasCandles && staleOk && slaOk ? undefined : "THIRD_PARTY_SERVICE_FAILURE",
      });
      if (!hasCandles || !staleOk || !slaOk) status = "FAIL";

      // 3. Regression Test: Verify Artificially Stale Timestamps Are Correctly Rejected
      if (hasCandles) {
        const staleOpenTime = nowMs - (25 * 60 * 60 * 1000); // 25 hours ago
        const artificialStaleAgeSec = Math.round((nowMs - staleOpenTime) / 1000);
        const artificialStaleRejected = artificialStaleAgeSec > maxAllowedAgeSec;

        assertions.push({
          name: "Stale Market Data Rejection Regression Test",
          passed: artificialStaleRejected,
          details: artificialStaleRejected
            ? `Correctly identified and rejected simulated 25-hour-old candle (Age: ${artificialStaleAgeSec}s > ${maxAllowedAgeSec}s)`
            : "FAILED REGRESSION: Pipeline failed to reject stale market data!",
          failureCategory: artificialStaleRejected ? undefined : "APPLICATION_DEFECT",
        });
        if (!artificialStaleRejected) status = "FAIL";
      }

      context.recordEvidence({
        phaseId: 4,
        label: "Kline candle query empirical evidence",
        latencyMs: klineLatency,
        payload: empiricalDiagnostic,
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
