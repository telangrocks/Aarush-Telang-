import { StrategyContext } from '../context/StrategyContext';
import { EvaluationResult } from '../dto/EvaluationResult';

export interface IStrategy {
  /**
   * Evaluates the immutable strategy context and returns an evaluation result.
   * This function must be side-effect free.
   */
  evaluate(context: Readonly<StrategyContext>): EvaluationResult;
}
