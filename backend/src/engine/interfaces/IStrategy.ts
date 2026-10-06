import { StrategyContext } from '../context/StrategyContext';
import { EvaluationResult } from '../dto/EvaluationResult';
import { StrategyManifest } from '../strategies/StrategyManifest';
import { Timeframe } from '../market-data/Timeframe';

export interface IStrategy {
  /**
   * Evaluates the immutable strategy context and returns an evaluation result for the target timeframe.
   * This function must be side-effect free.
   */
  evaluate(context: Readonly<StrategyContext>, targetTimeframe: Timeframe): EvaluationResult;
  
  /**
   * The manifest metadata for this strategy plugin.
   */
  readonly manifest: StrategyManifest;
}

