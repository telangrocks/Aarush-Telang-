import { StrategyManifest } from '../../engine/strategies/StrategyManifest';

export interface StrategyDiscoveryResponseDTO {
  version: string;
  count: number;
  strategies: StrategyManifest[];
}
