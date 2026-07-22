import { IStrategy } from '../interfaces/IStrategy';
import { ScalperV2Strategy } from './scalper-v2/ScalperV2Strategy';
import { MomentumStrategy } from './momentum/MomentumStrategy';
import { BreakoutStrategy } from './breakout/BreakoutStrategy';
import { MeanReversionStrategy } from './mean-reversion/MeanReversionStrategy';
import { VWAPStrategy } from './vwap/VWAPStrategy';
import { StrategyManifest } from './StrategyManifest';

import { DEFAULT_SCALPER_CONFIG } from './scalper-v2/ScalperV2Config';
import { DEFAULT_MOMENTUM_CONFIG } from './momentum/MomentumConfig';
import { DEFAULT_BREAKOUT_CONFIG } from './breakout/BreakoutConfig';
import { DEFAULT_MEAN_REVERSION_CONFIG } from './mean-reversion/MeanReversionConfig';
import { DEFAULT_VWAP_CONFIG } from './vwap/VWAPConfig';

function applyConfigOverrides<T extends Record<string, any>>(defaultConfig: T, overrides?: Record<string, any>): T {
  if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) {
    return defaultConfig;
  }
  const merged = JSON.parse(JSON.stringify(defaultConfig));
  
  if (overrides.leverage) {
    const lev = Number(overrides.leverage);
    if (!isNaN(lev) && lev > 0) {
      merged.riskParameters = merged.riskParameters || {};
      merged.riskParameters.maxExposureLimit = lev;
    }
  }
  if (overrides.risk_level || overrides.riskLevel) {
    const risk = String(overrides.risk_level || overrides.riskLevel).toUpperCase();
    if (['LOW', 'MEDIUM', 'HIGH'].includes(risk)) {
      merged.signalRules = merged.signalRules || {};
      if (risk === 'LOW') {
        merged.signalRules.allowedRiskClassifications = ['LOW'];
        merged.signalRules.minConfidenceScore = Math.max(merged.signalRules.minConfidenceScore || 70, 80);
      } else if (risk === 'HIGH') {
        merged.signalRules.allowedRiskClassifications = ['LOW', 'MEDIUM', 'HIGH'];
        merged.signalRules.minConfidenceScore = Math.min(merged.signalRules.minConfidenceScore || 70, 60);
      }
    }
  }
  if (overrides.mode) {
    const mode = String(overrides.mode).toUpperCase();
    if (mode === 'CONSERVATIVE') {
      merged.signalRules = merged.signalRules || {};
      merged.signalRules.minConfidenceScore = Math.max(merged.signalRules.minConfidenceScore || 70, 80);
    } else if (mode === 'AGGRESSIVE') {
      merged.signalRules = merged.signalRules || {};
      merged.signalRules.minConfidenceScore = Math.min(merged.signalRules.minConfidenceScore || 70, 65);
    }
  }

  for (const [key, val] of Object.entries(overrides)) {
    if (key in merged && typeof val === typeof (merged as any)[key]) {
      (merged as any)[key] = val;
    }
  }

  return merged;
}

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
    this.registerStrategy('MeanReversion', new MeanReversionStrategy());
    this.registerStrategy('VWAP', new VWAPStrategy());
  }

  public registerStrategy(id: string, strategy: IStrategy): void {
    if (this.strategies.has(id)) {
      throw new Error(`Strategy with ID '${id}' is already registered.`);
    }
    this.strategies.set(id, strategy);
  }

  public normalizeStrategyId(id: string): string {
    if (!id) return 'ScalperV2';
    const clean = id.trim().toLowerCase().replace(/[-_]/g, '');
    switch (clean) {
      case 'scalping':
      case 'scalper':
      case 'scalperv2':
      case 'scalpingv2':
        return 'ScalperV2';
      case 'momentum':
        return 'Momentum';
      case 'breakout':
        return 'Breakout';
      case 'meanreversion':
      case 'reversion':
        return 'MeanReversion';
      case 'vwap':
        return 'VWAP';
      default:
        for (const registeredId of this.strategies.keys()) {
          if (registeredId.toLowerCase() === clean) return registeredId;
        }
        return id;
    }
  }

  public getStrategy(id: string): IStrategy | undefined {
    const normalizedId = this.normalizeStrategyId(id);
    return this.strategies.get(normalizedId) || this.strategies.get(id);
  }

  public getManifest(id: string): StrategyManifest | undefined {
    const normalizedId = this.normalizeStrategyId(id);
    return this.strategies.get(normalizedId)?.manifest || this.strategies.get(id)?.manifest;
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

  public createStrategy(id: string, configOverrides?: any): IStrategy | undefined {
    const normalizedId = this.normalizeStrategyId(id);
    switch (normalizedId) {
      case 'ScalperV2': return new ScalperV2Strategy(applyConfigOverrides(DEFAULT_SCALPER_CONFIG, configOverrides));
      case 'Momentum': return new MomentumStrategy(applyConfigOverrides(DEFAULT_MOMENTUM_CONFIG, configOverrides));
      case 'Breakout': return new BreakoutStrategy(applyConfigOverrides(DEFAULT_BREAKOUT_CONFIG, configOverrides));
      case 'MeanReversion': return new MeanReversionStrategy(applyConfigOverrides(DEFAULT_MEAN_REVERSION_CONFIG, configOverrides));
      case 'VWAP': return new VWAPStrategy(applyConfigOverrides(DEFAULT_VWAP_CONFIG, configOverrides));
      default: return undefined;
    }
  }
}

