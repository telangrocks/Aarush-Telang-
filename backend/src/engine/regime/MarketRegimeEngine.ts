import { computeEMA, calculateAtr } from '../../trading-bot';

export interface MarketRegime {
  regime: "TRENDING" | "RANGING" | "VOLATILE";
  score: number;          // 0-100
  allowTrendStrategies: boolean;
  allowMeanReversion: boolean;
}

export class MarketRegimeEngine {
  /**
   * Computes Average Directional Index (ADX) over high, low, close arrays (period 14).
   */
  public static calculateAdx(highs: number[], lows: number[], closes: number[], period: number = 14): number {
    if (highs.length < period * 2) return 20; // Default neutral if insufficient data

    const tr: number[] = [];
    const plusDm: number[] = [];
    const minusDm: number[] = [];

    for (let i = 1; i < highs.length; i++) {
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];

      const pDm = upMove > downMove && upMove > 0 ? upMove : 0;
      const mDm = downMove > upMove && downMove > 0 ? downMove : 0;

      plusDm.push(pDm);
      minusDm.push(mDm);

      const trueRange = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      tr.push(trueRange);
    }

    const smoothedTr = computeEMA(tr, period);
    const smoothedPlusDm = computeEMA(plusDm, period);
    const smoothedMinusDm = computeEMA(minusDm, period);

    const dx: number[] = [];
    for (let i = 0; i < smoothedTr.length; i++) {
      const str = smoothedTr[i] || 1;
      const plusDi = (smoothedPlusDm[i] / str) * 100;
      const minusDi = (smoothedMinusDm[i] / str) * 100;
      const diSum = plusDi + minusDi;
      const diDiff = Math.abs(plusDi - minusDi);
      dx.push(diSum > 0 ? (diDiff / diSum) * 100 : 0);
    }

    const adxValues = computeEMA(dx, period);
    return adxValues.length > 0 ? Math.round(adxValues[adxValues.length - 1]) : 20;
  }

  /**
   * Calculates slope of 20-period EMA normalized as percentage.
   */
  public static calculateEmaSlope(closes: number[], period: number = 20): number {
    if (closes.length < period + 5) return 0;
    const ema = computeEMA(closes, period);
    const last = ema[ema.length - 1];
    const prev = ema[ema.length - 6];
    return prev > 0 ? (Math.abs(last - prev) / prev) * 100 : 0;
  }

  /**
   * Evaluates the current market regime based on ADX, ATR expansion ratio, and EMA slope.
   */
  public static evaluate(
    highs: number[],
    lows: number[],
    closes: number[],
    currentAtr: number
  ): MarketRegime {
    const adx = this.calculateAdx(highs, lows, closes, 14);
    const emaSlope = this.calculateEmaSlope(closes, 20);

    // Calculate long-term average ATR (50 candles) for expansion ratio
    const longTermAtr = calculateAtr(
      highs.slice(-50),
      lows.slice(-50),
      closes.slice(-50),
      14
    ) || currentAtr || 1;

    const atrExpansionRatio = currentAtr > 0 ? currentAtr / longTermAtr : 1.0;

    let regime: "TRENDING" | "RANGING" | "VOLATILE";
    let score = 50;

    if (atrExpansionRatio > 1.35) {
      regime = "VOLATILE";
      score = Math.min(95, Math.round(50 + (atrExpansionRatio - 1.0) * 50));
    } else if (adx >= 25 || emaSlope >= 0.5) {
      regime = "TRENDING";
      score = Math.min(98, Math.round(40 + adx * 1.1 + emaSlope * 5));
    } else {
      regime = "RANGING";
      score = Math.min(90, Math.round(70 - adx + (1.0 - Math.min(1.0, emaSlope)) * 20));
    }

    const allowTrendStrategies = regime === "TRENDING" || (regime === "VOLATILE" && adx > 25);
    const allowMeanReversion = regime === "RANGING" || (regime === "VOLATILE" && adx < 20);

    return {
      regime,
      score,
      allowTrendStrategies,
      allowMeanReversion
    };
  }

  /**
   * Determines whether a given strategy is permitted under the active MarketRegime rules.
   */
  public static isStrategyAllowed(strategy: string | null, regime: MarketRegime): { allowed: boolean; reason?: string } {
    const s = (strategy || 'momentum').toLowerCase();

    if (s === 'breakout' || s === 'momentum') {
      if (!regime.allowTrendStrategies) {
        return { allowed: false, reason: `Strategy '${strategy}' requires TRENDING market (current regime: ${regime.regime}, ADX score: ${regime.score})` };
      }
    } else if (s === 'mean_reversion') {
      if (!regime.allowMeanReversion) {
        return { allowed: false, reason: `Strategy '${strategy}' requires RANGING market (current regime: ${regime.regime}, ADX score: ${regime.score})` };
      }
    } else if (s === 'scalping' || s === 'scalper_v2') {
      if (regime.score < 60) {
        return { allowed: false, reason: `Scalping requires market regime score > 60 (current score: ${regime.score})` };
      }
    } else if (s === 'vwap') {
      // VWAP is allowed in both TRENDING and RANGING, but blocked in low-score VOLATILE environments
      if (regime.regime === 'VOLATILE' && regime.score < 70) {
        return { allowed: false, reason: `VWAP strategy blocked during high volatility regime (score: ${regime.score} < 70)` };
      }
    }

    return { allowed: true };
  }
}
