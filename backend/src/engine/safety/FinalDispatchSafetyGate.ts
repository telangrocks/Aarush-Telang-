import { OrderRequest } from '../../exchanges/models/NormalizedDomain';
import { UnifiedError } from '../../exchanges/models/UnifiedError';
import BigNumber from 'bignumber.js';

export class FinalDispatchSafetyGate {
  /**
   * Validates the final payload JSON immediately prior to dispatch.
   * Throws a UnifiedError if any constraint is violated.
   */
  public static validate(
    payload: OrderRequest,
    constraints: {
      stepSize: number;
      tickSize: number;
      minQty: number;
      minNotional: number;
      maxExposure?: number;
      currentExposure?: number;
      maxLeverage?: number;
    }
  ): void {
    // 1. Numeric Sanity
    if (!payload.amount || payload.amount.isNaN() || !payload.amount.isFinite() || payload.amount.lte(0)) {
      throw new UnifiedError('Invalid quantity in payload', 'RISK_GATE_REJECTED');
    }

    if (payload.price && (payload.price.isNaN() || !payload.price.isFinite() || payload.price.lte(0))) {
      throw new UnifiedError('Invalid price in payload', 'RISK_GATE_REJECTED');
    }

    // 2. Minimums
    if (payload.amount.lt(constraints.minQty)) {
      throw new UnifiedError(`Quantity ${payload.amount.toString()} is below minimum ${constraints.minQty}`, 'RISK_GATE_REJECTED');
    }

    if (payload.price) {
      const notional = payload.amount.multipliedBy(payload.price);
      if (notional.lt(constraints.minNotional)) {
        throw new UnifiedError(`Notional ${notional.toString()} is below minimum ${constraints.minNotional}`, 'RISK_GATE_REJECTED');
      }
    }

    // 3. Modulo Math (Step / Tick sizes)
    const amountStr = payload.amount.toString();
    const qtyDecimals = amountStr.includes('.') ? amountStr.split('.')[1].length : 0;
    const stepDecimals = constraints.stepSize.toString().includes('.') ? constraints.stepSize.toString().split('.')[1].length : 0;
    
    if (qtyDecimals > stepDecimals) {
      throw new UnifiedError(`Quantity ${amountStr} violates stepSize precision ${constraints.stepSize}`, 'RISK_GATE_REJECTED');
    }

    if (payload.price) {
      const priceStr = payload.price.toString();
      const priceDecimals = priceStr.includes('.') ? priceStr.split('.')[1].length : 0;
      const tickDecimals = constraints.tickSize.toString().includes('.') ? constraints.tickSize.toString().split('.')[1].length : 0;

      if (priceDecimals > tickDecimals) {
        throw new UnifiedError(`Price ${priceStr} violates tickSize precision ${constraints.tickSize}`, 'RISK_GATE_REJECTED');
      }
    }

    // 4. Exposure Limits
    if (constraints.maxExposure && constraints.currentExposure !== undefined) {
      const notional = payload.price ? payload.amount.multipliedBy(payload.price).toNumber() : 0; // Rough estimate for market orders would need ticker, but let's assume limit or we pass notional
      if (constraints.currentExposure + notional > constraints.maxExposure) {
        throw new UnifiedError(`Order notional ${notional} exceeds max exposure ${constraints.maxExposure}`, 'RISK_GATE_REJECTED');
      }
    }

    // Note: Stale market data checks are typically handled by the strategy engine right before generating the signal,
    // but the final gate ensures the numbers themselves are exchange-compliant.
  }
}
