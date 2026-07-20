import { IStrategy } from '../interfaces/IStrategy';
import { ScalperV2Strategy } from './scalper-v2/ScalperV2Strategy';
import { MomentumStrategy } from './momentum/MomentumStrategy';
import { BreakoutStrategy } from './breakout/BreakoutStrategy';
import { StrategyManifest } from './StrategyManifest';

export class StrategyRegistry {
  private static instance: StrategyRegistry;
  private strategies: Map<string, IStrategy> = new Map();

  private constructor() {
    this.registerDefaults();
  }

  public static getInstance(): StrategyRegistry {
    if (!StrategyRegistry.instance) {
      StrategyRegistry.instance = new StrategyRegistry();
    }
    return StrategyRegistry.instance;
  }

  private registerDefaults(): void {
    this.registerStrategy('ScalperV2', new ScalperV2Strategy());
    this.registerStrategy('Momentum', new MomentumStrategy());
    this.registerStrategy('Breakout', new BreakoutStrategy());
  }


  public registerStrategy(id: string, strategy: IStrategy): void {
    if (this.strategies.has(id)) {
      throw new Error(`Strategy with ID '${id}' is already registered.`);
    }
    this.strategies.set(id, strategy);
  }

  public getStrategy(id: string): IStrategy | undefined {
    return this.strategies.get(id);
  }

  public getManifest(id: string): StrategyManifest | undefined {
    return this.strategies.get(id)?.manifest;
  }

  public getAllManifests(): StrategyManifest[] {
    const manifests: StrategyManifest[] = [];
    for (const strategy of this.strategies.values()) {
      manifests.push(strategy.manifest);
    }
    return manifests;
  }

  public getAvailableStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }
  
  public getAllStrategies(): Map<string, IStrategy> {
    return this.strategies;
  }
}

