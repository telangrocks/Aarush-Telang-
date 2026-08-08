import { ConditionResult, TimeframeConditionResult } from '../condition';
import { ConfidenceScore, TimeframeConfidence, ConfidenceLevel } from './ConfidenceScore';
import { ConfidenceWeights, DEFAULT_WEIGHTS } from './ConfidenceWeights';
import { ConfidenceFactors } from './ConfidenceFactors';

export class ConfidenceEngine {
  constructor(private weights: ConfidenceWeights = DEFAULT_WEIGHTS) {}

  public evaluate(conditionResult: ConditionResult): ConfidenceScore {
    const timeframes: Record<string, TimeframeConfidence> = {};
    let totalScore = 0;
    let timeframeCount = 0;

    for (const [tf, conditions] of Object.entries(conditionResult.timeframes)) {
      const tfConfidence = this.evaluateTimeframe(conditions);
      timeframes[tf] = tfConfidence;
      totalScore += tfConfidence.score;
      timeframeCount++;
    }

    const overallScore = timeframeCount > 0 ? Math.round(totalScore / timeframeCount) : 0;
    const overallLevel = this.determineLevel(overallScore);

    return {
      timestamp: conditionResult.timestamp,
      overallScore,
      overallLevel,
      timeframes
    };
  }

  private evaluateTimeframe(conditions: TimeframeConditionResult): TimeframeConfidence {
    const explanation: string[] = [];
    
    // Trend Scoring
    let trendScore = 0;
    if (conditions.trend.priceAboveEMA && conditions.trend.emaCrossoverState === 'BULLISH') {
      trendScore = 100;
      explanation.push('Price is above EMA with Bullish Crossover.');
    } else if (conditions.trend.priceAboveEMA && conditions.trend.trendDirection === 'UP') {
      trendScore = 75;
      explanation.push('Price is above EMA with UP trend.');
    } else if (conditions.trend.priceAboveEMA) {
      trendScore = 50;
      explanation.push('Price is above EMA.');
    } else {
      explanation.push('Trend is Bearish or Sideways.');
    }

    // Momentum Scoring
    let momentumScore = 0;
    if (conditions.momentum.macdDirection === 'BULLISH' && (conditions.momentum.rsiState === 'NEUTRAL' || conditions.momentum.rsiState === 'OVERBOUGHT')) {
      momentumScore = 100;
      explanation.push('Strong Bullish Momentum (MACD & RSI aligned).');
    } else if (conditions.momentum.macdDirection === 'BULLISH' || conditions.momentum.rsiState === 'OVERBOUGHT') {
      momentumScore = 50;
      explanation.push('Partial Bullish Momentum.');
    } else {
      explanation.push('Momentum is Neutral or Bearish.');
    }

    // Volatility Scoring
    let volatilityScore = 0;
    if (conditions.volatility.atrState === 'EXPANDING') {
      volatilityScore = 100;
      explanation.push('Volatility is EXPANDING.');
    } else {
      explanation.push('Volatility is Contracting or Neutral.');
    }

    // Volume Scoring
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
      trendScore,
      momentumScore,
      volatilityScore,
      volumeScore
    };

    const weightedScore = (
      (trendScore * this.weights.trend / 100) +
      (momentumScore * this.weights.momentum / 100) +
      (volatilityScore * this.weights.volatility / 100) +
      (volumeScore * this.weights.volume / 100)
    );

    const score = Math.round(weightedScore);
    const level = this.determineLevel(score);

    return {
      score,
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
