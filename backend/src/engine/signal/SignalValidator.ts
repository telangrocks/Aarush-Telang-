import { ConfidenceScore, TimeframeConfidence } from '../confidence';
import { RiskAssessment } from '../risk';

export interface SignalRules {
  minConfidenceScore: number;
  allowedRiskClassifications: string[];
}

export class SignalValidator {
  constructor(private rules: SignalRules) {}

  public validate(tfConfidence: TimeframeConfidence, riskAssessment: RiskAssessment): { isValid: boolean; reasoning: string[] } {
    const reasoning: string[] = [];
    let isValid = true;

    // Validate Confidence
    if (tfConfidence.score < this.rules.minConfidenceScore) {
      isValid = false;
      reasoning.push(`Confidence score (${tfConfidence.score}) is below required minimum (${this.rules.minConfidenceScore}).`);
    } else {
      reasoning.push(`Confidence score (${tfConfidence.score}) passes threshold.`);
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
