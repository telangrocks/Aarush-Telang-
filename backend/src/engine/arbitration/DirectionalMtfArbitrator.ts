import { EvaluationResult } from '../dto/EvaluationResult';
import { MarketSnapshot, NormalizedCandle } from '../market-data/MarketSnapshot';
import { MarketRegime, MarketRegimeEngine } from '../regime/MarketRegimeEngine';
import { calculateEMA } from '../indicator/indicators/EMA';
import { StrategyRegistry } from '../strategies/StrategyRegistry';

export type HtfDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'MISSING';

export interface ArbitrationResult {
  passed: boolean;
  gate: 'PASS' | 'HTF_CONFLICT' | 'INSUFFICIENT_HTF_DATA' | 'REGIME_PROHIBITED';
  reasoning: string;
}

export class DirectionalMtfArbitrator {
  /**
   * Evaluates the authoritative directional bias of a higher timeframe (1h or 4h).
   * Requires at least 50 valid closed candles for reliable EMA(50) calculation.
   * Insufficient or invalid candles fail closed to 'MISSING'.
   */
  public static resolveHtfDirection(candles: NormalizedCandle[] | undefined): HtfDirection {
    if (!Array.isArray(candles) || candles.length < 50) {
      return 'MISSING';
    }

    // Verify candle numeric validity
    for (let i = candles.length - 50; i < candles.length; i++) {
      const c = candles[i];
      if (!c || typeof c.close !== 'number' || isNaN(c.close) || c.close <= 0) {
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
      typeof fLast !== 'number' || isNaN(fLast) ||
      typeof sLast !== 'number' || isNaN(sLast) ||
      typeof fPrev !== 'number' || isNaN(fPrev) ||
      typeof sPrev !== 'number' || isNaN(sPrev)
    ) {
      return 'MISSING';
    }

    const isBullCrossover = fLast > sLast && fPrev <= sPrev;
    const isBearCrossover = fLast < sLast && fPrev >= sPrev;
    const isUpTrend = fLast > sLast;
    const isDownTrend = fLast < sLast;

    // Require genuine trend strength on HTF: weak ADX (< 20) or non-trending ADX (< 25)
    // combined with negligible EMA(20)/EMA(50) separation (< 0.25%) resolves to NEUTRAL.
    const highs = candles.map(c => (typeof c.high === 'number' && !isNaN(c.high) && c.high > 0) ? c.high : c.close);
    const lows = candles.map(c => (typeof c.low === 'number' && !isNaN(c.low) && c.low > 0) ? c.low : c.close);
    const closes = candles.map(c => c.close);
    const adx = MarketRegimeEngine.calculateAdx(highs, lows, closes, 14);
    const emaSepPct = sLast > 0 ? (Math.abs(fLast - sLast) / sLast) * 100 : 0;

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
    const htf1h = this.resolveHtfDirection(snapshot?.candles?.['1h']);
    const htf4h = this.resolveHtfDirection(snapshot?.candles?.['4h']);

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
