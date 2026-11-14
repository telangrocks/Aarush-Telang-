import { EvaluationResult } from '../dto/EvaluationResult';
import { MarketSnapshot, NormalizedCandle } from '../market-data/MarketSnapshot';
import { MarketRegime, MarketRegimeEngine } from '../regime/MarketRegimeEngine';
import { calculateEMA } from '../indicator/indicators/EMA';
import { StrategyRegistry } from '../strategies/StrategyRegistry';
import { CandleValidator } from '../../infrastructure/exchange/CandleValidator';

export type HtfDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'MISSING';

export interface ArbitrationResult {
  passed: boolean;
  gate: 'PASS' | 'HTF_CONFLICT' | 'INSUFFICIENT_HTF_DATA' | 'REGIME_PROHIBITED';
  reasoning: string;
}

const MOMENTUM_SUPPORTED_TIMEFRAMES = new Set(['5m', '15m', '1h', '4h']);

export class DirectionalMtfArbitrator {
  private static getCandleCloseTime(c: NormalizedCandle | undefined, tf: string): number {
    if (!c || typeof c !== 'object') return NaN;
    const rawClose = (c as any).closeTime;
    if (rawClose !== undefined) {
      return typeof rawClose === 'number' && Number.isFinite(rawClose) ? rawClose : NaN;
    }
    const baseTime = c.openTime ?? c.timestamp;
    if (typeof baseTime !== 'number' || !Number.isFinite(baseTime)) {
      return NaN;
    }
    return baseTime + CandleValidator.timeframeToMs(tf);
  }

  private static isValidStrictOhlcCandle(c: NormalizedCandle | undefined): boolean {
    if (!c || typeof c !== 'object') return false;
    if (
      !Number.isFinite(c.open) || c.open <= 0 ||
      !Number.isFinite(c.high) || c.high <= 0 ||
      !Number.isFinite(c.low) || c.low <= 0 ||
      !Number.isFinite(c.close) || c.close <= 0
    ) {
      return false;
    }
    if (c.high < c.low) return false;
    if (c.volume !== undefined && (!Number.isFinite(c.volume) || c.volume < 0)) return false;
    return true;
  }

  private static filterClosedValidatedCandles(
    rawCandles: unknown,
    tf: string,
    referenceTimestamp: number,
    minClosedCount: number
  ): { ok: true; candles: NormalizedCandle[] } | { ok: false; reason: string } {
    if (!Number.isFinite(referenceTimestamp)) {
      return { ok: false, reason: `Invalid or missing evaluation snapshot timestamp for ${tf}.` };
    }
    if (!Array.isArray(rawCandles)) {
      return { ok: false, reason: `Missing or non-array ${tf} candle series.` };
    }

    const closedCandles: NormalizedCandle[] = [];
    for (let i = 0; i < rawCandles.length; i++) {
      const c = rawCandles[i] as NormalizedCandle | undefined;
      const closeTime = this.getCandleCloseTime(c, tf);
      if (!Number.isFinite(closeTime)) {
        return { ok: false, reason: `Invalid candle timestamp in ${tf} series at index ${i}.` };
      }
      if (closeTime <= referenceTimestamp) {
        closedCandles.push(c as NormalizedCandle);
      }
    }

    if (closedCandles.length < minClosedCount) {
      return {
        ok: false,
        reason: `Insufficient closed ${tf} candle data (got ${closedCandles.length}, required >= ${minClosedCount}).`
      };
    }

    for (let i = 0; i < closedCandles.length; i++) {
      if (!this.isValidStrictOhlcCandle(closedCandles[i])) {
        return {
          ok: false,
          reason: `Invalid OHLC candle data in ${tf} closed series at index ${i}.`
        };
      }
    }

    return { ok: true, candles: closedCandles };
  }

  private static resolveMomentumHtfDirection(
    rawCandles: unknown,
    tf: '1h' | '4h',
    referenceTimestamp: number
  ): HtfDirection {
    const validated = this.filterClosedValidatedCandles(rawCandles, tf, referenceTimestamp, 50);
    if (!validated.ok) {
      return 'MISSING';
    }

    const candles = validated.candles;
    const fastEma = calculateEMA(candles, 20);
    const slowEma = calculateEMA(candles, 50);

    if (!Array.isArray(fastEma) || !Array.isArray(slowEma) || fastEma.length < 2 || slowEma.length < 2) {
      return 'MISSING';
    }

    const fLast = fastEma[fastEma.length - 1];
    const sLast = slowEma[slowEma.length - 1];
    const fPrev = fastEma[fastEma.length - 2];
    const sPrev = slowEma[slowEma.length - 2];

    if (
      !Number.isFinite(fLast) || fLast <= 0 ||
      !Number.isFinite(sLast) || sLast <= 0 ||
      !Number.isFinite(fPrev) || fPrev <= 0 ||
      !Number.isFinite(sPrev) || sPrev <= 0
    ) {
      return 'MISSING';
    }

    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const adx = MarketRegimeEngine.calculateAdx(highs, lows, closes, 14);
    const emaSepPct = (Math.abs(fLast - sLast) / sLast) * 100;

    if (!Number.isFinite(adx) || !Number.isFinite(emaSepPct)) {
      return 'MISSING';
    }

    if (adx < 20 || (adx < 25 && emaSepPct < 0.25)) {
      return 'NEUTRAL';
    }

    const isBullCrossover = fLast > sLast && fPrev <= sPrev;
    const isBearCrossover = fLast < sLast && fPrev >= sPrev;
    const isUpTrend = fLast > sLast;
    const isDownTrend = fLast < sLast;
    const isUp = isUpTrend || isBullCrossover;
    const isDown = isDownTrend || isBearCrossover;

    if (isUp && !isDown) return 'BULLISH';
    if (isDown && !isUp) return 'BEARISH';
    return 'NEUTRAL';
  }

  /**
   * Evaluates the authoritative directional bias of a higher timeframe (1h or 4h).
   * Requires at least 50 valid closed candles for reliable EMA(50) calculation.
   * Insufficient or invalid candles fail closed to 'MISSING'.
   */
  public static resolveHtfDirection(candles: NormalizedCandle[] | undefined): HtfDirection {
    if (!Array.isArray(candles) || candles.length < 50) {
      return 'MISSING';
    }

    // Verify candle numeric validity across the entire series
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!c || typeof c.close !== 'number' || !Number.isFinite(c.close) || c.close <= 0) {
        return 'MISSING';
      }
    }

    const fastEma = calculateEMA(candles, 20);
    const slowEma = calculateEMA(candles, 50);

    if (!Array.isArray(fastEma) || !Array.isArray(slowEma) || fastEma.length < 2 || slowEma.length < 2) {
      return 'MISSING';
    }

    const fLast = fastEma[fastEma.length - 1];
    const sLast = slowEma[slowEma.length - 1];
    const fPrev = fastEma[fastEma.length - 2];
    const sPrev = slowEma[slowEma.length - 2];

    if (
      typeof fLast !== 'number' || !Number.isFinite(fLast) ||
      typeof sLast !== 'number' || !Number.isFinite(sLast) ||
      typeof fPrev !== 'number' || !Number.isFinite(fPrev) ||
      typeof sPrev !== 'number' || !Number.isFinite(sPrev)
    ) {
      return 'MISSING';
    }

    const isBullCrossover = fLast > sLast && fPrev <= sPrev;
    const isBearCrossover = fLast < sLast && fPrev >= sPrev;
    const isUpTrend = fLast > sLast;
    const isDownTrend = fLast < sLast;

    // Require genuine trend strength on HTF: weak ADX (< 20) or non-trending ADX (< 25)
    // combined with negligible EMA(20)/EMA(50) separation (< 0.25%) resolves to NEUTRAL.
    const highs = candles.map(c => (typeof c.high === 'number' && Number.isFinite(c.high) && c.high > 0) ? c.high : c.close);
    const lows = candles.map(c => (typeof c.low === 'number' && Number.isFinite(c.low) && c.low > 0) ? c.low : c.close);
    const closes = candles.map(c => c.close);
    const adx = MarketRegimeEngine.calculateAdx(highs, lows, closes, 14);
    const emaSepPct = sLast > 0 ? (Math.abs(fLast - sLast) / sLast) * 100 : 0;

    if (!Number.isFinite(adx) || !Number.isFinite(emaSepPct)) {
      return 'MISSING';
    }

    if (adx < 20 || (adx < 25 && emaSepPct < 0.25)) {
      return 'NEUTRAL';
    }

    const isUp = isUpTrend || isBullCrossover;
    const isDown = isDownTrend || isBearCrossover;

    if (isUp && !isDown) return 'BULLISH';
    if (isDown && !isUp) return 'BEARISH';
    return 'NEUTRAL';
  }

  /**
   * Evaluates a candidate strategy signal against:
   * 1. Mandatory MarketRegimeEngine permissions (Mandatory Safety Conditions A & B)
   * 2. Authoritative 1h and 4h Multi-Timeframe Directional alignment
   */
  public static evaluateCandidate(
    candidate: EvaluationResult,
    snapshot: MarketSnapshot,
    regime: MarketRegime | null | undefined
  ): ArbitrationResult {
    const sig = candidate?.metadata?.signal;
    if (!sig || !sig.type) {
      return {
        passed: false,
        gate: 'INSUFFICIENT_HTF_DATA',
        reasoning: 'Missing or invalid candidate signal metadata'
      };
    }

    const side = sig.type as 'BUY' | 'SELL';
    const rawStrategyId = candidate.strategyId;
    if (!rawStrategyId || typeof rawStrategyId !== 'string') {
      return {
        passed: false,
        gate: 'INSUFFICIENT_HTF_DATA',
        reasoning: 'Missing or invalid candidate strategyId'
      };
    }

    const strategyId = StrategyRegistry.getInstance().normalizeStrategyId(rawStrategyId);
    const isTrendStrategy = ['ScalperV2', 'Momentum', 'Breakout'].includes(strategyId);
    const isMeanReversion = strategyId === 'MeanReversion';
    const isVwap = strategyId === 'VWAP';

    // Fail closed explicitly if the strategy ID is unknown
    if (!isTrendStrategy && !isMeanReversion && !isVwap) {
      return {
        passed: false,
        gate: 'REGIME_PROHIBITED',
        reasoning: `Unknown strategy ID '${rawStrategyId}' (normalized: '${strategyId}'); fail-closed rejection.`
      };
    }

    // -------------------------------------------------------------------------
    // MANDATORY SAFETY CONDITION A: Missing Regime Fails Closed
    // -------------------------------------------------------------------------
    if (!regime) {
      return {
        passed: false,
        gate: 'REGIME_PROHIBITED',
        reasoning: `Market regime unavailable for ${strategyId}; fail-closed safety gate rejects candidate.`
      };
    }

    // -------------------------------------------------------------------------
    // MANDATORY SAFETY CONDITION B: Regime Authorization Check
    // -------------------------------------------------------------------------
    const regimeCheck = MarketRegimeEngine.isStrategyAllowed(strategyId, regime);
    if (!regimeCheck.allowed) {
      return {
        passed: false,
        gate: 'REGIME_PROHIBITED',
        reasoning: regimeCheck.reason || `Strategy '${strategyId}' disallowed in ${regime.regime} regime`
      };
    }

    // -------------------------------------------------------------------------
    // HIGHER-TIMEFRAME DIRECTIONAL ARBITRATION
    // -------------------------------------------------------------------------
    let momentumEntryTf: '5m' | '15m' | '1h' | '4h' | null = null;
    let momentumEntryAdx = NaN;
    let htf1h: HtfDirection;
    let htf4h: HtfDirection;

    if (strategyId === 'Momentum') {
      if (side !== 'BUY' && side !== 'SELL') {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Momentum rejected: Invalid signal side '${String(side)}'.`
        };
      }

      const rawTargetTf = candidate?.metadata?.targetTimeframe;
      const rawSignalTf = sig?.timeframe;
      const hasTargetTf = rawTargetTf !== undefined && rawTargetTf !== null && rawTargetTf !== '';
      const hasSignalTf = rawSignalTf !== undefined && rawSignalTf !== null && rawSignalTf !== '';

      if (!hasTargetTf && !hasSignalTf) {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Momentum ${side} rejected: Missing required entry timeframe metadata.`
        };
      }

      if (hasTargetTf && hasSignalTf && rawTargetTf !== rawSignalTf) {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Momentum ${side} rejected: Inconsistent targetTimeframe (${String(rawTargetTf)}) and signal.timeframe (${String(rawSignalTf)}).`
        };
      }

      const resolvedTf = hasTargetTf ? rawTargetTf : rawSignalTf;
      if (typeof resolvedTf !== 'string' || !MOMENTUM_SUPPORTED_TIMEFRAMES.has(resolvedTf)) {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Momentum ${side} rejected: Unsupported entry timeframe '${String(resolvedTf)}'.`
        };
      }
      momentumEntryTf = resolvedTf as '5m' | '15m' | '1h' | '4h';

      const evalRefTs = snapshot?.timestamp;
      if (typeof evalRefTs !== 'number' || !Number.isFinite(evalRefTs)) {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Momentum ${side} rejected on ${momentumEntryTf}: Invalid or missing evaluation snapshot timestamp.`
        };
      }

      const validatedEntry = this.filterClosedValidatedCandles(
        snapshot?.candles?.[momentumEntryTf],
        momentumEntryTf,
        evalRefTs,
        35
      );
      if (!validatedEntry.ok) {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Momentum ${side} rejected on ${momentumEntryTf}: ${validatedEntry.reason}`
        };
      }

      const closedEntry = validatedEntry.candles;
      const eHighs = closedEntry.map(c => c.high);
      const eLows = closedEntry.map(c => c.low);
      const eCloses = closedEntry.map(c => c.close);
      momentumEntryAdx = MarketRegimeEngine.calculateAdx(eHighs, eLows, eCloses, 14);
      if (!Number.isFinite(momentumEntryAdx)) {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Momentum ${side} rejected on ${momentumEntryTf}: Non-finite entry ADX output.`
        };
      }

      htf1h = this.resolveMomentumHtfDirection(snapshot?.candles?.['1h'], '1h', evalRefTs);
      htf4h = this.resolveMomentumHtfDirection(snapshot?.candles?.['4h'], '4h', evalRefTs);
    } else {
      htf1h = this.resolveHtfDirection(snapshot?.candles?.['1h']);
      htf4h = this.resolveHtfDirection(snapshot?.candles?.['4h']);
    }

    // Complete HTF Blackout: Fail closed across all strategies
    if (htf1h === 'MISSING' && htf4h === 'MISSING') {
      return {
        passed: false,
        gate: 'INSUFFICIENT_HTF_DATA',
        reasoning: `Both 1h and 4h higher-timeframe candle data are missing for ${strategyId}; fail-closed.`
      };
    }

    const opposingDir: HtfDirection = side === 'BUY' ? 'BEARISH' : 'BULLISH';
    const confirmingDir: HtfDirection = side === 'BUY' ? 'BULLISH' : 'BEARISH';

    // Rule 1: Trend Strategies (ScalperV2, Momentum, Breakout)
    if (isTrendStrategy) {
      // 1A. Any active opposing HTF trend strictly rejects
      if (htf1h === opposingDir || htf4h === opposingDir) {
        return {
          passed: false,
          gate: 'HTF_CONFLICT',
          reasoning: `Trend ${side} rejected for ${strategyId}: Opposing HTF direction detected (1h=${htf1h}, 4h=${htf4h}).`
        };
      }

      // 1B. Partial data with zero confirmation fails closed
      const hasConfirming = htf1h === confirmingDir || htf4h === confirmingDir;
      if (!hasConfirming && (htf1h === 'MISSING' || htf4h === 'MISSING')) {
        return {
          passed: false,
          gate: 'INSUFFICIENT_HTF_DATA',
          reasoning: `Trend ${side} rejected for ${strategyId}: Incomplete HTF data with zero confirming timeframe (1h=${htf1h}, 4h=${htf4h}).`
        };
      }

      // 1C. Both higher timeframes NEUTRAL provides zero directional trend confirmation
      if (!hasConfirming) {
        return {
          passed: false,
          gate: 'HTF_CONFLICT',
          reasoning: `Trend ${side} rejected for ${strategyId}: Lacks higher-timeframe directional confirmation (1h=${htf1h}, 4h=${htf4h}).`
        };
      }

      // 1D. ScalperV2 entry-timeframe trend-strength verification when entry candles are present
      if (strategyId === 'ScalperV2') {
        const entryTf = (candidate?.metadata?.targetTimeframe || sig?.timeframe || '5m') as keyof MarketSnapshot['candles'];
        const entryCandles = snapshot?.candles?.[entryTf];
        if (Array.isArray(entryCandles) && entryCandles.length >= 35) {
          const eHighs = entryCandles.map(c => (typeof c.high === 'number' && !isNaN(c.high) && c.high > 0) ? c.high : c.close);
          const eLows = entryCandles.map(c => (typeof c.low === 'number' && !isNaN(c.low) && c.low > 0) ? c.low : c.close);
          const eCloses = entryCandles.map(c => c.close);
          const entryAdx = MarketRegimeEngine.calculateAdx(eHighs, eLows, eCloses, 14);
          const ema9 = calculateEMA(entryCandles, 9);
          const ema21 = calculateEMA(entryCandles, 21);
          const f9 = ema9[ema9.length - 1] || 0;
          const s21 = ema21[ema21.length - 1] || 0;
          const entryEmaSepPct = s21 > 0 ? (Math.abs(f9 - s21) / s21) * 100 : 0;

          if (entryAdx < 20 || (entryAdx < 25 && entryEmaSepPct < 0.25)) {
            return {
              passed: false,
              gate: 'REGIME_PROHIBITED',
              reasoning: `ScalperV2 ${side} rejected on ${String(entryTf)}: Insufficient entry trend strength (ADX=${entryAdx}, EMA9/21 separation=${entryEmaSepPct.toFixed(4)}%).`
            };
          }
        }
      }

      // 1E. Momentum entry-timeframe trend-strength & self-HTF verification across 5m, 15m, 1h, and 4h
      if (strategyId === 'Momentum') {
        if (!momentumEntryTf || !Number.isFinite(momentumEntryAdx)) {
          return {
            passed: false,
            gate: 'INSUFFICIENT_HTF_DATA',
            reasoning: `Momentum ${side} rejected: Entry timeframe verification state unavailable.`
          };
        }

        if (momentumEntryTf === '1h' && htf1h !== confirmingDir) {
          return {
            passed: false,
            gate: htf1h === 'MISSING' ? 'INSUFFICIENT_HTF_DATA' : 'HTF_CONFLICT',
            reasoning: `Momentum ${side} rejected on 1h: Entry timeframe 1h does not confirm ${confirmingDir} direction (1h=${htf1h}, 4h=${htf4h}).`
          };
        }
        if (momentumEntryTf === '4h' && htf4h !== confirmingDir) {
          return {
            passed: false,
            gate: htf4h === 'MISSING' ? 'INSUFFICIENT_HTF_DATA' : 'HTF_CONFLICT',
            reasoning: `Momentum ${side} rejected on 4h: Entry timeframe 4h does not confirm ${confirmingDir} direction (1h=${htf1h}, 4h=${htf4h}).`
          };
        }

        if (momentumEntryAdx < 20) {
          return {
            passed: false,
            gate: 'REGIME_PROHIBITED',
            reasoning: `Momentum ${side} rejected on ${momentumEntryTf}: Insufficient entry trend strength (ADX=${momentumEntryAdx} < 20).`
          };
        }
      }

      return {
        passed: true,
        gate: 'PASS',
        reasoning: `Trend ${side} confirmed for ${strategyId} (1h=${htf1h}, 4h=${htf4h}, regime=${regime.regime}).`
      };
    }

    // Rule 2: MeanReversion Strategy
    if (isMeanReversion) {
      // 2A. Double opposing HTF trend represents runaway trend risk (falling knife / freight train)
      if (htf1h === opposingDir && htf4h === opposingDir) {
        return {
          passed: false,
          gate: 'HTF_CONFLICT',
          reasoning: `MeanReversion ${side} rejected: Double opposing HTF trend (1h=${htf1h}, 4h=${htf4h}) represents runaway trend risk.`
        };
      }

      // 2B. Counter-trend bounce into 4h downtrend / dip into 4h uptrend
      if (side === 'BUY' && htf1h === 'BULLISH' && htf4h === 'BEARISH') {
        return {
          passed: false,
          gate: 'HTF_CONFLICT',
          reasoning: 'MeanReversion BUY rejected: 1h bounce into dominant 4h downtrend resistance.'
        };
      }
      if (side === 'SELL' && htf1h === 'BEARISH' && htf4h === 'BULLISH') {
        return {
          passed: false,
          gate: 'HTF_CONFLICT',
          reasoning: 'MeanReversion SELL rejected: 1h pullback into dominant 4h uptrend support.'
        };
      }

      return {
        passed: true,
        gate: 'PASS',
        reasoning: `MeanReversion ${side} confirmed (1h=${htf1h}, 4h=${htf4h}, regime=${regime.regime}).`
      };
    }

    // Rule 3: VWAP Strategy (Fair Value & Session Volume)
    if (isVwap) {
      if (htf1h === opposingDir && htf4h === opposingDir) {
        return {
          passed: false,
          gate: 'HTF_CONFLICT',
          reasoning: `VWAP ${side} rejected: Double opposing HTF trend (1h=${htf1h}, 4h=${htf4h}).`
        };
      }

      return {
        passed: true,
        gate: 'PASS',
        reasoning: `VWAP ${side} confirmed (1h=${htf1h}, 4h=${htf4h}, regime=${regime.regime}).`
      };
    }

    return {
      passed: false,
      gate: 'REGIME_PROHIBITED',
      reasoning: `Strategy '${rawStrategyId}' could not be arbitrated; fail-closed.`
    };
  }
}
