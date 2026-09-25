import { ScannerConfig, DEFAULT_SCANNER_CONFIG } from './ScannerTypes';

export interface TradingCostInput {
  readonly price: number;
  readonly bid: number;
  readonly ask: number;
  readonly atr1m?: number;
  readonly expectedTargetPercent: number;     // Strategy-specific expected move (e.g. 2.0% or 1.5x ATR)
  readonly turnover1mUsdt?: number;
  readonly hypotheticalOrderSizeUsdt?: number;
}

export interface TradingCostBreakdown {
  readonly midPrice: number;
  readonly spreadPercent: number;
  readonly roundTripFeePercent: number;
  readonly estimatedSlippagePercent: number;
  readonly totalFrictionPercent: number;
  readonly expectedTargetPercent: number;
  readonly netEdgeRatio: number;              // Expected Move / Total Friction
  readonly feasibilityScore: number;          // 0-100 analytical hypothesis score
  readonly isViable: boolean;                 // netEdgeRatio >= minNetEdgeRatio && spread <= maxSpread
  readonly reasons: string[];
  readonly warnings: string[];
}

/**
 * Pure analytical calculation engine for estimating trading friction and setup feasibility.
 * 
 * INVARIANT: This class is purely analytical. It has ZERO interaction with live execution,
 * order placement, position sizing, SL/TP brackets, or wallet state.
 */
export class TradingCostEngine {
  constructor(private readonly config: ScannerConfig = DEFAULT_SCANNER_CONFIG) {}

  public evaluate(input: TradingCostInput): TradingCostBreakdown {
    const reasons: string[] = [];
    const warnings: string[] = [];

    const price = input.price > 0 ? input.price : 1;
    const bid = input.bid > 0 ? input.bid : price;
    const ask = input.ask >= bid ? input.ask : price;
    const midPrice = (bid + ask) / 2;

    // 1. Bid/Ask Spread Percentage
    const spreadRaw = midPrice > 0 ? ((ask - bid) / midPrice) * 100 : 0;
    const spreadPercent = Math.max(0, Math.min(10.0, spreadRaw)); // clamp against bad ticks

    // 2. Round-trip Taker Fee (Analytical assumption based on exchange tier)
    const roundTripFeePercent = this.config.takerFeePercent * 2;

    // 3. Dynamic Slippage Model
    // Accounts for spread, 1m volatility (ATR), and hypothetical liquidity impact
    const halfSpread = spreadPercent / 2;
    const atr1m = input.atr1m && input.atr1m > 0 ? input.atr1m : price * 0.001;
    const volatilityImpact = (atr1m / price) * 100 * this.config.slippageCoefficient;

    const orderSize = input.hypotheticalOrderSizeUsdt ?? 1_000;
    const minuteTurnover = input.turnover1mUsdt && input.turnover1mUsdt > 0 ? input.turnover1mUsdt : 50_000;
    const liquidityImpactRatio = Math.sqrt(Math.max(0.1, orderSize / minuteTurnover));
    
    // Slippage is bounded between half-spread and volatility-liquidity impact
    const estimatedSlippagePercent = Math.max(
      halfSpread,
      Math.min(1.0, volatilityImpact * liquidityImpactRatio)
    );

    // 4. Total Trading Friction
    const totalFrictionPercent = roundTripFeePercent + spreadPercent + estimatedSlippagePercent;

    // 5. Net Edge Ratio
    const expectedTarget = Math.max(0.01, input.expectedTargetPercent);
    const netEdgeRatio = totalFrictionPercent > 0
      ? Number((expectedTarget / totalFrictionPercent).toFixed(2))
      : 0;

    // 6. Feasibility Score (0-100)
    // Scale: Net edge of 1.0 (breakeven) = 20 pts, 3.0 (viable threshold) = 60 pts, >= 5.0 = 100 pts
    let feasibilityScore = 0;
    if (netEdgeRatio >= 5.0) {
      feasibilityScore = 100;
      reasons.push(`High edge ratio (${netEdgeRatio}x): Expected move substantially exceeds trading friction.`);
    } else if (netEdgeRatio >= this.config.minNetEdgeRatio) {
      feasibilityScore = Math.round(60 + ((netEdgeRatio - this.config.minNetEdgeRatio) / (5.0 - this.config.minNetEdgeRatio)) * 40);
      reasons.push(`Acceptable edge ratio (${netEdgeRatio}x vs ${this.config.minNetEdgeRatio}x threshold).`);
    } else if (netEdgeRatio >= 1.5) {
      feasibilityScore = Math.round(30 + ((netEdgeRatio - 1.5) / (this.config.minNetEdgeRatio - 1.5)) * 30);
      warnings.push(`Marginal edge ratio (${netEdgeRatio}x): High friction relative to expected move.`);
    } else {
      feasibilityScore = Math.max(0, Math.round(netEdgeRatio * 20));
      warnings.push(`Low edge ratio (${netEdgeRatio}x): Expected move (${expectedTarget.toFixed(2)}%) eroded by total friction (${totalFrictionPercent.toFixed(3)}%).`);
    }

    // Spread penalty
    if (spreadPercent > this.config.maxSpreadPercent) {
      warnings.push(`Excessive spread (${spreadPercent.toFixed(3)}% exceeds ${this.config.maxSpreadPercent}% max threshold).`);
    } else if (spreadPercent <= 0.03) {
      reasons.push(`Ultra-tight spread (${spreadPercent.toFixed(3)}%).`);
    }

    const isViable = netEdgeRatio >= this.config.minNetEdgeRatio && spreadPercent <= this.config.maxSpreadPercent;

    return {
      midPrice,
      spreadPercent,
      roundTripFeePercent,
      estimatedSlippagePercent,
      totalFrictionPercent,
      expectedTargetPercent: expectedTarget,
      netEdgeRatio,
      feasibilityScore,
      isViable,
      reasons,
      warnings,
    };
  }
}
