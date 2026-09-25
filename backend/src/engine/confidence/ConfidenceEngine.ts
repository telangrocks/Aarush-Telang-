import { ConditionResult, TimeframeConditionResult } from '../condition';
import { ConfidenceScore, TimeframeConfidence, ConfidenceLevel } from './ConfidenceScore';
import { ConfidenceWeights, DEFAULT_WEIGHTS } from './ConfidenceWeights';
import { ConfidenceFactors } from './ConfidenceFactors';

export class ConfidenceEngine {
  constructor(private weights: ConfidenceWeights = DEFAULT_WEIGHTS) {}

  public evaluate(conditionResult: ConditionResult): ConfidenceScore {
    const timeframes: Record<string, TimeframeConfidence> = {};
    let totalScore = 0;
    let totalLongScore = 0;
    let totalShortScore = 0;
    let timeframeCount = 0;

    for (const [tf, conditions] of Object.entries(conditionResult.timeframes)) {
      const tfConfidence = this.evaluateTimeframe(conditions);
      timeframes[tf] = tfConfidence;
      totalScore += tfConfidence.score;
      totalLongScore += (tfConfidence.longScore ?? tfConfidence.score);
      totalShortScore += (tfConfidence.shortScore ?? 0);
      timeframeCount++;
    }

    const overallScore = timeframeCount > 0 ? Math.round(totalScore / timeframeCount) : 0;
    const overallLongScore = timeframeCount > 0 ? Math.round(totalLongScore / timeframeCount) : 0;
    const overallShortScore = timeframeCount > 0 ? Math.round(totalShortScore / timeframeCount) : 0;
    const overallLevel = this.determineLevel(overallScore);

    return {
      timestamp: conditionResult.timestamp,
      overallScore,
      overallLongScore,
      overallShortScore,
      overallLevel,
      timeframes
    };
  }

  private evaluateTimeframe(conditions: TimeframeConditionResult): TimeframeConfidence {
    const explanation: string[] = [];
    
    // Long Trend Scoring (Identical to existing trend scoring)
    let longTrendScore = 0;
    if (conditions.trend.priceAboveEMA && conditions.trend.emaCrossoverState === 'BULLISH') {
      longTrendScore = 100;
      explanation.push('Price is above EMA with Bullish Crossover.');
    } else if (conditions.trend.priceAboveEMA && conditions.trend.trendDirection === 'UP') {
      longTrendScore = 75;
      explanation.push('Price is above EMA with UP trend.');
    } else if (conditions.trend.priceAboveEMA) {
      longTrendScore = 50;
      explanation.push('Price is above EMA.');
    } else {
      explanation.push('Trend is Bearish or Sideways.');
    }

    // Short Trend Scoring (Symmetrical counterpart)
    let shortTrendScore = 0;
    if (!conditions.trend.priceAboveEMA && conditions.trend.emaCrossoverState === 'BEARISH') {
      shortTrendScore = 100;
      explanation.push('Price is below EMA with Bearish Crossover.');
    } else if (!conditions.trend.priceAboveEMA && conditions.trend.trendDirection === 'DOWN') {
      shortTrendScore = 75;
      explanation.push('Price is below EMA with DOWN trend.');
    } else if (!conditions.trend.priceAboveEMA && conditions.trend.trendDirection !== 'UP') {
      shortTrendScore = 50;
      explanation.push('Price is below EMA.');
    } else {
      explanation.push('Short trend is Bullish or Sideways.');
    }

    // Long Momentum Scoring (Identical to existing momentum scoring)
    let longMomentumScore = 0;
    if (conditions.momentum.macdDirection === 'BULLISH' && (conditions.momentum.rsiState === 'NEUTRAL' || conditions.momentum.rsiState === 'OVERBOUGHT')) {
      longMomentumScore = 100;
      explanation.push('Strong Bullish Momentum (MACD & RSI aligned).');
    } else if (conditions.momentum.macdDirection === 'BULLISH' || conditions.momentum.rsiState === 'OVERBOUGHT') {
      longMomentumScore = 50;
      explanation.push('Partial Bullish Momentum.');
    } else {
      explanation.push('Momentum is Neutral or Bearish.');
    }

    // Short Momentum Scoring (Symmetrical counterpart)
    let shortMomentumScore = 0;
    if (conditions.momentum.macdDirection === 'BEARISH' && (conditions.momentum.rsiState === 'NEUTRAL' || conditions.momentum.rsiState === 'OVERSOLD')) {
      shortMomentumScore = 100;
      explanation.push('Strong Bearish Momentum (MACD & RSI aligned).');
    } else if (conditions.momentum.macdDirection === 'BEARISH' || conditions.momentum.rsiState === 'OVERSOLD') {
      shortMomentumScore = 50;
      explanation.push('Partial Bearish Momentum.');
    } else {
      explanation.push('Short momentum is Neutral or Bullish.');
    }

    // Volatility Scoring (Direction-neutral shared input)
    let volatilityScore = 0;
    if (conditions.volatility.atrState === 'EXPANDING') {
      volatilityScore = 100;
      explanation.push('Volatility is EXPANDING.');
    } else {
      explanation.push('Volatility is Contracting or Neutral.');
    }

    // Volume Scoring (Direction-neutral shared input)
    let volumeScore = 0;
    if (conditions.volume.volumeConfirmation && conditions.volume.volumeTrend === 'INCREASING') {
      volumeScore = 100;
      explanation.push('Volume breakout confirmed with increasing trend.');
    } else if (conditions.volume.volumeConfirmation) {
      volumeScore = 50;
      explanation.push('Volume breakout confirmed.');
    } else {
      explanation.push('No volume confirmation.');
    }

    const factors: ConfidenceFactors = {
      trendScore: longTrendScore,
      momentumScore: longMomentumScore,
      volatilityScore,
      volumeScore
    };

    const longWeightedScore = (
      (longTrendScore * this.weights.trend / 100) +
      (longMomentumScore * this.weights.momentum / 100) +
      (volatilityScore * this.weights.volatility / 100) +
      (volumeScore * this.weights.volume / 100)
    );

    const shortWeightedScore = (
      (shortTrendScore * this.weights.trend / 100) +
      (shortMomentumScore * this.weights.momentum / 100) +
      (volatilityScore * this.weights.volatility / 100) +
      (volumeScore * this.weights.volume / 100)
    );

    const longScore = Math.round(longWeightedScore);
    const shortScore = Math.round(shortWeightedScore);
    const score = longScore;
    const level = this.determineLevel(score);

    return {
      score,
      longScore,
      shortScore,
      level,
      factors,
      explanation
    };
  }

  private determineLevel(score: number): ConfidenceLevel {
    if (score >= 80) return 'HIGH';
    if (score >= 50) return 'MEDIUM';
    if (score > 0) return 'LOW';
    return 'NONE';
  }
}
