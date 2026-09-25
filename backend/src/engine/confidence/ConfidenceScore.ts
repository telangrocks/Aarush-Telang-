import { ConfidenceFactors } from './ConfidenceFactors';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export interface TimeframeConfidence {
  score: number;
  longScore?: number;
  shortScore?: number;
  level: ConfidenceLevel;
  factors: ConfidenceFactors;
  explanation: string[];
}

export interface ConfidenceScore {
  timestamp: number;
  overallScore: number;
  overallLongScore?: number;
  overallShortScore?: number;
  overallLevel: ConfidenceLevel;
  timeframes: Record<string, TimeframeConfidence>;
}
