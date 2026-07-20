import { StrategyContext } from '../context/StrategyContext';
import { EvaluationResult } from '../dto/EvaluationResult';
import { StrategyManifest } from '../strategies/StrategyManifest';

export interface IStrategy {
  /**
   * Evaluates the immutable strategy context and returns an evaluation result.
   * This function must be side-effect free.
   */
  evaluate(context: Readonly<StrategyContext>): EvaluationResult;
  
  /**
   * The manifest metadata for this strategy plugin.
   */
  readonly manifest: StrategyManifest;
}

