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
    if (conditions.trend.priceAboveEMA) {
      trendScore += 50;
      explanation.push('Price is above EMA.');
    } else {
      explanation.push('Price is below EMA.');
    }

    if (conditions.trend.emaCrossoverState !== 'NONE') {
      trendScore += 50;
      explanation.push(`EMA Crossover is ${conditions.trend.emaCrossoverState}.`);
    } else if (conditions.trend.trendDirection !== 'SIDEWAYS') {
      trendScore += 25;
      explanation.push(`Trend direction is ${conditions.trend.trendDirection}.`);
    } else {
      explanation.push('Trend is SIDEWAYS.');
    }

    // Momentum Scoring
    let momentumScore = 0;
    if (conditions.momentum.rsiState !== 'NEUTRAL') {
      momentumScore += 50;
      explanation.push(`RSI is ${conditions.momentum.rsiState}.`);
    } else {
      explanation.push('RSI is NEUTRAL.');
    }

    if (conditions.momentum.macdDirection !== 'NEUTRAL') {
      momentumScore += 50;
      explanation.push(`MACD direction is ${conditions.momentum.macdDirection}.`);
    } else {
      explanation.push('MACD is NEUTRAL.');
    }

    // Volatility Scoring
    let volatilityScore = 0;
    if (conditions.volatility.atrState === 'EXPANDING') {
      volatilityScore = 100;
      explanation.push('Volatility is EXPANDING.');
    } else if (conditions.volatility.atrState === 'CONTRACTING') {
      volatilityScore = 50;
      explanation.push('Volatility is CONTRACTING.');
    } else {
      explanation.push('Volatility is NEUTRAL.');
    }

    // Volume Scoring
    let volumeScore = 0;
    if (conditions.volume.volumeConfirmation) {
      volumeScore += 50;
      explanation.push('Volume breakout confirmed.');
    } else {
      explanation.push('No volume breakout.');
    }

    if (conditions.volume.volumeTrend !== 'NEUTRAL') {
      volumeScore += 50;
      explanation.push(`Volume is ${conditions.volume.volumeTrend}.`);
    } else {
      explanation.push('Volume trend is NEUTRAL.');
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
