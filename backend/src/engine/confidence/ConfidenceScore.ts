import { ConfidenceFactors } from './ConfidenceFactors';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface TimeframeConfidence {
  score: number;
  level: ConfidenceLevel;
  factors: ConfidenceFactors;
  explanation: string[];
}

export interface ConfidenceScore {
  timestamp: number;
  overallScore: number;
  overallLevel: ConfidenceLevel;
  timeframes: Record<string, TimeframeConfidence>;
}
