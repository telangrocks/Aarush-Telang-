import { IStrategy } from '../interfaces/IStrategy';
import { ScalperV2Strategy } from './scalper-v2/ScalperV2Strategy';
import { MomentumStrategy } from './momentum/MomentumStrategy';

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
    this.strategies.set('ScalperV2', new ScalperV2Strategy());
    this.strategies.set('Momentum', new MomentumStrategy());
  }


  public registerStrategy(id: string, strategy: IStrategy): void {
    this.strategies.set(id, strategy);
  }

  public getStrategy(id: string): IStrategy | undefined {
    return this.strategies.get(id);
  }

  public getAvailableStrategies(): string[] {
    return Array.from(this.strategies.keys());
  }
  
  public getAllStrategies(): Map<string, IStrategy> {
    return this.strategies;
  }
}
