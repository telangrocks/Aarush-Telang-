import { TimeframeConfidence } from '../confidence';
import { RiskAssessment } from '../risk';
import { SignalType } from './SignalType';

export interface SignalRules {
  minConfidenceScore: number;
  allowedRiskClassifications: string[];
}

export class SignalValidator {
  constructor(private rules: SignalRules) {}

  public validate(
    tfConfidence: TimeframeConfidence,
    riskAssessment: RiskAssessment,
    proposedType?: SignalType | 'BUY' | 'SELL'
  ): { isValid: boolean; reasoning: string[] } {
    const reasoning: string[] = [];
    let isValid = true;

    // --- MODEL C PRODUCTION ARBITRATION PATH ---
    if (proposedType === SignalType.BUY || proposedType === SignalType.SELL || proposedType === 'BUY' || proposedType === 'SELL') {
      const normalizedType = proposedType === 'BUY' ? SignalType.BUY : proposedType === 'SELL' ? SignalType.SELL : proposedType;

      // STRICT FAIL-CLOSED INTEGRITY:
      // Both directional scores must explicitly exist as numbers.
      // Missing directional evidence is NEVER defaulted to 0 or scalar score.
      if (
        typeof tfConfidence.longScore !== 'number' ||
        typeof tfConfidence.shortScore !== 'number'
      ) {
        return {
          isValid: false,
          reasoning: [
            `[FAIL-CLOSED] Timeframe missing explicit directional score (longScore=${tfConfidence.longScore}, shortScore=${tfConfidence.shortScore}). Model C arbitration requires both explicit scores.`
          ]
        };
      }

      const { longScore, shortScore } = tfConfidence;

      if (normalizedType === SignalType.BUY) {
        if (longScore >= this.rules.minConfidenceScore && shortScore < this.rules.minConfidenceScore) {
          reasoning.push(`Model C BUY qualified: LongScore (${longScore}) >= ${this.rules.minConfidenceScore} and ShortScore (${shortScore}) < ${this.rules.minConfidenceScore}.`);
        } else {
          isValid = false;
          reasoning.push(`Model C BUY rejected: LongScore=${longScore}, ShortScore=${shortScore}, MinThreshold=${this.rules.minConfidenceScore}.`);
        }
      } else if (normalizedType === SignalType.SELL) {
        if (shortScore >= this.rules.minConfidenceScore && longScore < this.rules.minConfidenceScore) {
          reasoning.push(`Model C SELL qualified: ShortScore (${shortScore}) >= ${this.rules.minConfidenceScore} and LongScore (${longScore}) < ${this.rules.minConfidenceScore}.`);
        } else {
          isValid = false;
          reasoning.push(`Model C SELL rejected: ShortScore=${shortScore}, LongScore=${longScore}, MinThreshold=${this.rules.minConfidenceScore}.`);
        }
      }
    } else {
      // --- ISOLATED LEGACY VALIDATION PATH (Only for tests/fixtures with no proposedType) ---
      if (tfConfidence.score < this.rules.minConfidenceScore) {
        isValid = false;
        reasoning.push(`Confidence score (${tfConfidence.score}) is below required minimum (${this.rules.minConfidenceScore}).`);
      } else {
        reasoning.push(`Confidence score (${tfConfidence.score}) passes threshold.`);
      }
    }

    // Validate Risk
    if (!this.rules.allowedRiskClassifications.includes(riskAssessment.riskClassification)) {
      isValid = false;
      reasoning.push(`Risk classification ${riskAssessment.riskClassification} is not allowed by signal rules.`);
    } else {
      reasoning.push(`Risk classification ${riskAssessment.riskClassification} is acceptable.`);
    }

    return { isValid, reasoning };
  }
}
