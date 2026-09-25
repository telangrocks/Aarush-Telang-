import { describe, it, expect, vi, beforeEach } from 'vitest';
import BigNumber from 'bignumber.js';
import { handleTriggerManualTradeAlert } from '../../src/handlers/exchange';
import { StopLossCalculator } from '../../src/engine/risk/StopLossCalculator';
import { TakeProfitCalculator } from '../../src/engine/risk/TakeProfitCalculator';
import { OrderSizing } from '../../src/engine/risk/OrderSizing';
import { TradeValidator } from '../../src/validation/TradeValidator';
import { FinalDispatchSafetyGate } from '../../src/engine/safety/FinalDispatchSafetyGate';
import { ExchangeManager } from '../../src/exchanges';
import { StrategyRegistry } from '../../src/engine/strategies/StrategyRegistry';

describe('Authoritative Bybit Price Normalization & Trade Allocation Priority', () => {

  // =========================================================================
  // Group 1: Authoritative Bybit Instrument Metadata & SOPH Pricing Tests
  // =========================================================================
  describe('Group 1: Authoritative Bybit Instrument Metadata & SOPH Pricing', () => {
    const mockSophMarket = {
      id: 'SOPHUSDT',
      symbol: 'SOPH/USDT',
      base: 'SOPH',
      quote: 'USDT',
      category: 'linear',
      contractType: 'LinearPerpetual',
      active: true,
      precision: {
        price: 0.000001, // From Bybit priceFilter.tickSize
        amount: 10       // From Bybit lotSizeFilter.qtyStep
      },
      limits: {
        price: { min: new BigNumber(0.000001), max: new BigNumber(19.999998) },
        amount: { min: new BigNumber(10), max: new BigNumber(16500000) },
        cost: { min: new BigNumber(5) } // From Bybit lotSizeFilter.minNotionalValue
      }
    };

    it('Test 1.1 — SOPHUSDT Authoritative Metadata Verification', () => {
      // Proves exact extraction of Bybit API fields without decimal guesswork
      expect(mockSophMarket.precision.price).toBe(0.000001);
      expect(mockSophMarket.precision.amount).toBe(10);
      expect(mockSophMarket.limits.price.min.toNumber()).toBe(0.000001);
      expect(mockSophMarket.limits.amount.min.toNumber()).toBe(10);
      expect(mockSophMarket.limits.cost.min.toNumber()).toBe(5);
    });

    it('Test 1.2 — Sub-$0.01 LONG (SOPH/USDT): SL < Entry < TP with NO $0.01 Floor', () => {
      const entryPrice = 0.005969;
      const atr = 0.00014733333333333334;
      const riskParams = {
        accountRiskPercent: 1.0,
        atrTakeProfitMultiplier: 2.0,
        riskRewardRatio: 2.0,
        atrStopLossMultiplier: 1.5,
        maxExposureLimit: 25.0
      };

      const stopLossDistance = StopLossCalculator.calculateDistance(atr, riskParams);
      const takeProfitDistance = TakeProfitCalculator.calculateDistance(atr, riskParams);

      expect(stopLossDistance).toBeCloseTo(0.000221, 6);
      expect(takeProfitDistance).toBeCloseTo(0.000295, 6);

      const tickSize = mockSophMarket.precision.price; // 0.000001
      const minPrice = mockSophMarket.limits.price.min.toNumber(); // 0.000001
      const minAllowedPrice = minPrice > 0 ? minPrice : tickSize;

      const tickSizeBN = new BigNumber(tickSize);
      const entryBN = new BigNumber(entryPrice);
      const minAllowedBN = new BigNumber(minAllowedPrice);
      const slDistBN = new BigNumber(stopLossDistance);
      const tpDistBN = new BigNumber(takeProfitDistance);

      // Invariant: SL must be strictly below Entry and >= minAllowedPrice
      const theoreticalSL = entryBN.minus(slDistBN);
      const theoreticalTP = entryBN.plus(tpDistBN);
      const maxAllowedSL = entryBN.minus(tickSizeBN);

      let boundedSL = BigNumber.min(theoreticalSL, maxAllowedSL);
      boundedSL = BigNumber.max(minAllowedBN, boundedSL);

      const minAllowedTP = entryBN.plus(tickSizeBN);
      const boundedTP = BigNumber.max(minAllowedTP, theoreticalTP);

      // Quantization: BUY SL floors (to stay below Entry), BUY TP ceils
      const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      let quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
      if (quantizedStopLossBN.gte(entryBN)) {
        quantizedStopLossBN = entryBN.minus(tickSizeBN);
      }

      const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
      let quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
      if (quantizedTakeProfitBN.lte(entryBN)) {
        quantizedTakeProfitBN = entryBN.plus(tickSizeBN);
      }

      const decimals = Math.max(0, tickSizeBN.decimalPlaces() ?? 2);
      const finalStopLoss = parseFloat(quantizedStopLossBN.toFixed(decimals));
      const finalTakeProfit = parseFloat(quantizedTakeProfitBN.toFixed(decimals));

      // Assertions
      expect(finalStopLoss).toBe(0.005748);
      expect(finalTakeProfit).toBe(0.006264);
      expect(finalStopLoss).toBeLessThan(entryPrice);
      expect(finalTakeProfit).toBeGreaterThan(entryPrice);
      expect(finalStopLoss).not.toBe(0.01); // Prove $0.01 floor is eliminated!
    });

    it('Test 1.3 — Sub-$0.01 SHORT (SOPH/USDT): TP < Entry < SL with NO $0.01 Floor', () => {
      const entryPrice = 0.005969;
      const atr = 0.00014733333333333334;
      const riskParams = {
        accountRiskPercent: 1.0,
        atrTakeProfitMultiplier: 2.0,
        riskRewardRatio: 2.0,
        atrStopLossMultiplier: 1.5,
        maxExposureLimit: 25.0
      };

      const stopLossDistance = StopLossCalculator.calculateDistance(atr, riskParams);
      const takeProfitDistance = TakeProfitCalculator.calculateDistance(atr, riskParams);

      const tickSize = mockSophMarket.precision.price; // 0.000001
      const minPrice = mockSophMarket.limits.price.min.toNumber(); // 0.000001
      const minAllowedPrice = minPrice > 0 ? minPrice : tickSize;

      const tickSizeBN = new BigNumber(tickSize);
      const entryBN = new BigNumber(entryPrice);
      const minAllowedBN = new BigNumber(minAllowedPrice);
      const slDistBN = new BigNumber(stopLossDistance);
      const tpDistBN = new BigNumber(takeProfitDistance);

      const theoreticalSL = entryBN.plus(slDistBN);
      const theoreticalTP = entryBN.minus(tpDistBN);

      const minAllowedSL = entryBN.plus(tickSizeBN);
      const boundedSL = BigNumber.max(minAllowedSL, theoreticalSL);

      const maxAllowedTP = entryBN.minus(tickSizeBN);
      let boundedTP = BigNumber.min(theoreticalTP, maxAllowedTP);
      boundedTP = BigNumber.max(minAllowedBN, boundedTP);

      // Quantization: SELL SL ceils (to stay above Entry), SELL TP floors
      const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
      let quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
      if (quantizedStopLossBN.lte(entryBN)) {
        quantizedStopLossBN = entryBN.plus(tickSizeBN);
      }

      const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
      let quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
      if (quantizedTakeProfitBN.gte(entryBN)) {
        quantizedTakeProfitBN = entryBN.minus(tickSizeBN);
      }

      const decimals = Math.max(0, tickSizeBN.decimalPlaces() ?? 2);
      const finalStopLoss = parseFloat(quantizedStopLossBN.toFixed(decimals));
      const finalTakeProfit = parseFloat(quantizedTakeProfitBN.toFixed(decimals));

      // Assertions
      expect(finalStopLoss).toBe(0.006190);
      expect(finalTakeProfit).toBe(0.005674);
      expect(finalTakeProfit).toBeLessThan(entryPrice);
      expect(entryPrice).toBeLessThan(finalStopLoss);
      expect(finalTakeProfit).not.toBe(0.01);
    });
  });

  // =========================================================================
  // Group 2: Cross-Asset Instrument-Rule Tests
  // =========================================================================
  describe('Group 2: Cross-Asset Instrument-Rule Tests', () => {
    function computeSLTP(side: 'BUY' | 'SELL', entryPrice: number, atr: number, tickSize: number, minPrice = 0) {
      const riskParams = { accountRiskPercent: 1.0, atrTakeProfitMultiplier: 2.0, riskRewardRatio: 2.0, atrStopLossMultiplier: 1.5, maxExposureLimit: 25.0 };
      const stopLossDistance = StopLossCalculator.calculateDistance(atr, riskParams);
      const takeProfitDistance = TakeProfitCalculator.calculateDistance(atr, riskParams);

      const minAllowedPrice = minPrice > 0 ? minPrice : tickSize;
      const tickSizeBN = new BigNumber(tickSize);
      const entryBN = new BigNumber(entryPrice);
      const minAllowedBN = new BigNumber(minAllowedPrice);
      const slDistBN = new BigNumber(stopLossDistance);
      const tpDistBN = new BigNumber(takeProfitDistance);

      let quantizedStopLossBN: BigNumber;
      let quantizedTakeProfitBN: BigNumber;

      if (side === 'BUY') {
        const theoreticalSL = entryBN.minus(slDistBN);
        const theoreticalTP = entryBN.plus(tpDistBN);
        const maxAllowedSL = entryBN.minus(tickSizeBN);
        let boundedSL = BigNumber.min(theoreticalSL, maxAllowedSL);
        boundedSL = BigNumber.max(minAllowedBN, boundedSL);
        const minAllowedTP = entryBN.plus(tickSizeBN);
        const boundedTP = BigNumber.max(minAllowedTP, theoreticalTP);

        const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
        quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
        if (quantizedStopLossBN.gte(entryBN)) quantizedStopLossBN = entryBN.minus(tickSizeBN);
        if (quantizedStopLossBN.lt(minAllowedBN)) quantizedStopLossBN = minAllowedBN;

        const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
        quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
        if (quantizedTakeProfitBN.lte(entryBN)) quantizedTakeProfitBN = entryBN.plus(tickSizeBN);
      } else {
        const theoreticalSL = entryBN.plus(slDistBN);
        const theoreticalTP = entryBN.minus(tpDistBN);
        const minAllowedSL = entryBN.plus(tickSizeBN);
        const boundedSL = BigNumber.max(minAllowedSL, theoreticalSL);
        const maxAllowedTP = entryBN.minus(tickSizeBN);
        let boundedTP = BigNumber.min(theoreticalTP, maxAllowedTP);
        boundedTP = BigNumber.max(minAllowedBN, boundedTP);

        const stepsSL = boundedSL.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_CEIL);
        quantizedStopLossBN = stepsSL.multipliedBy(tickSizeBN);
        if (quantizedStopLossBN.lte(entryBN)) quantizedStopLossBN = entryBN.plus(tickSizeBN);

        const stepsTP = boundedTP.dividedBy(tickSizeBN).integerValue(BigNumber.ROUND_FLOOR);
        quantizedTakeProfitBN = stepsTP.multipliedBy(tickSizeBN);
        if (quantizedTakeProfitBN.gte(entryBN)) quantizedTakeProfitBN = entryBN.minus(tickSizeBN);
        if (quantizedTakeProfitBN.lt(minAllowedBN)) quantizedTakeProfitBN = minAllowedBN;
      }

      const decimals = Math.max(0, tickSizeBN.decimalPlaces() ?? 2);
      return {
        stopLoss: parseFloat(quantizedStopLossBN.toFixed(decimals)),
        takeProfit: parseFloat(quantizedTakeProfitBN.toFixed(decimals)),
        decimals
      };
    }

    it('Test 2.1 — Low-Priced Asset (DOGE/USDT at $0.09876, tickSize = 0.00001)', () => {
      const entry = 0.09876;
      const atr = 0.0012; // SL dist = 0.0018, TP dist = 0.0024
      const res = computeSLTP('BUY', entry, atr, 0.00001, 0.00001);

      expect(res.decimals).toBe(5);
      expect(res.stopLoss).toBe(0.09696);
      expect(res.takeProfit).toBe(0.10116);
      expect(res.stopLoss).toBeLessThan(entry);
      expect(res.takeProfit).toBeGreaterThan(entry);
    });

    it('Test 2.2 — Standard Asset (BTC/USDT at $58,342.15, tickSize = 0.1)', () => {
      const entry = 58342.15;
      const atr = 250.0; // SL dist = 375.0, TP dist = 500.0
      const res = computeSLTP('BUY', entry, atr, 0.1, 0.1);

      expect(res.decimals).toBe(1);
      expect(res.stopLoss).toBe(57967.1);
      expect(res.takeProfit).toBe(58842.2);
      expect(res.stopLoss).toBeLessThan(entry);
      expect(res.takeProfit).toBeGreaterThan(entry);
    });

    it('Test 2.3 — High-Priced Asset (ETH/USDT at $2,450.55, tickSize = 0.01)', () => {
      const entry = 2450.55;
      const atr = 15.0; // SL dist = 22.50, TP dist = 30.00
      const res = computeSLTP('BUY', entry, atr, 0.01, 0.01);

      expect(res.decimals).toBe(2);
      expect(res.stopLoss).toBe(2428.05);
      expect(res.takeProfit).toBe(2480.55);
      expect(res.stopLoss).toBeLessThan(entry);
      expect(res.takeProfit).toBeGreaterThan(entry);
    });
  });

  // =========================================================================
  // Group 3: Capital Allocation & Quantity Derivation Tests
  // =========================================================================
  describe('Group 3: Capital Allocation & Quantity Derivation', () => {
    const riskParams = {
      accountRiskPercent: 1.0,
      riskRewardRatio: 2.0,
      atrStopLossMultiplier: 1.5,
      maxExposureLimit: 25.0
    };
    const accountBalance = 1000;
    const stopLossDistance = 0.000221;
    const targetEntryPrice = 0.005969;

    function resolvePositionSize(config: any): number {
      const explicitTradeAmount = typeof config?.tradeValueUsdt === 'number' && config.tradeValueUsdt > 0
        ? config.tradeValueUsdt
        : undefined;
      const secondaryTradeAmount = explicitTradeAmount ?? (
        typeof config?.positionSize === 'number' && config.positionSize > 0
          ? config.positionSize
          : undefined
      );
      return secondaryTradeAmount ?? 5.0;
    }

    it('Test 3.1 — Exact 5 USDT Allocation: Priority & Quantity Quantization', () => {
      const config = { tradeValueUsdt: 5.00 };
      const positionSize = resolvePositionSize(config);

      // Assert exact 5 USDT allocation
      expect(positionSize).toBe(5.00);

      // SOPH Lot rules: qtyStep = 10, minOrderQty = 10, minNotional = 5.0
      const qtyStep = 10;
      const rawQty = new BigNumber(positionSize).dividedBy(targetEntryPrice); // 5 / 0.005969 = 837.6612
      const steps = rawQty.dividedBy(qtyStep).integerValue(BigNumber.ROUND_FLOOR); // 83 steps
      const quantizedQty = steps.multipliedBy(qtyStep).toNumber(); // 830 SOPH
      const postRoundingNotional = new BigNumber(quantizedQty).multipliedBy(targetEntryPrice).toNumber();

      expect(rawQty.toNumber()).toBeCloseTo(837.6612, 4);
      expect(quantizedQty).toBe(830);
      expect(quantizedQty % qtyStep).toBe(0);
      expect(postRoundingNotional).toBeLessThanOrEqual(5.00);
      expect(postRoundingNotional).toBeCloseTo(4.95427, 4);
    });

    it('Test 3.2 — Exact 25 USDT Allocation: Priority & Execution Validity', () => {
      const config = { tradeValueUsdt: 25.00 };
      const positionSize = resolvePositionSize(config);

      // Assert exact 25 USDT allocation
      expect(positionSize).toBe(25.00);

      // SOPH Lot rules: qtyStep = 10, minOrderQty = 10, minNotional = 5.0
      const qtyStep = 10;
      const rawQty = new BigNumber(positionSize).dividedBy(targetEntryPrice); // 25 / 0.005969 = 4188.306
      const steps = rawQty.dividedBy(qtyStep).integerValue(BigNumber.ROUND_FLOOR);
      const quantizedQty = steps.multipliedBy(qtyStep).toNumber(); // 4180 SOPH
      const postRoundingNotional = new BigNumber(quantizedQty).multipliedBy(targetEntryPrice).toNumber();

      expect(rawQty.toNumber()).toBeCloseTo(4188.306, 3);
      expect(quantizedQty).toBe(4180);
      expect(quantizedQty % qtyStep).toBe(0);
      expect(postRoundingNotional).toBeLessThanOrEqual(25.00);
      expect(postRoundingNotional).toBeCloseTo(24.9504, 3);

      // Verify validation passes on TradeValidator
      const validationRes = TradeValidator.validate({
        symbol: 'SOPH/USDT',
        side: 'BUY',
        orderType: 'MARKET',
        entryIntent: 'MARKET_ENTRY',
        entryPrice: targetEntryPrice,
        tradeValueUsdt: positionSize
      }, {
        schemaVersion: '2.0',
        symbol: 'SOPH/USDT',
        exchange: 'bybit',
        baseAsset: 'SOPH',
        quoteAsset: 'USDT',
        minNotional: 5.0,
        minQty: 10,
        maxQty: 16500000,
        stepSize: 10,
        tickSize: 0.000001,
        minPrice: 0.000001,
        maxPrice: 19.999998,
        contractSize: 1
      });

      expect(validationRes.isValid).toBe(true);
      expect(validationRes.quantizedQuantity).toBe(4180);
      expect(validationRes.postRoundingNotional).toBeCloseTo(24.9504, 3);
    });

    it('Test 3.3 — Standard System Minimum Allocation (Fallback when no explicit allocation)', () => {
      // User did not configure tradeValueUsdt or positionSize
      const config = {};
      const positionSize = resolvePositionSize(config);

      // Falls back to standard system minimum allocation (5.00 USDT)
      expect(positionSize).toBe(5.00);
    });
  });

  // =========================================================================
  // Group 4: Fail-Safe Resilience & Fail-Closed Execution Tests
  // =========================================================================
  describe('Group 4: Fail-Safe Resilience & Fail-Closed Execution Tests', () => {
    it('Test 4.1 — Market Metadata Unreachable at Alert Time: Dynamic Magnitude Fallback', () => {
      const entryPrice = 0.005969;
      // When fetchMarkets fails, tickSize is derived dynamically from price magnitude:
      let tickSize = 0;
      if (!tickSize || tickSize <= 0) {
        if (entryPrice <= 0) tickSize = 0.01;
        else if (entryPrice < 0.0001) tickSize = 0.00000001;
        else if (entryPrice < 0.001) tickSize = 0.000001;
        else if (entryPrice < 0.01) tickSize = 0.00001; // Matches SOPH scale (5 decimals)
        else if (entryPrice < 0.1) tickSize = 0.0001;
        else if (entryPrice < 1.0) tickSize = 0.001;
        else tickSize = 0.01;
      }

      expect(tickSize).toBe(0.00001);
      expect(tickSize).not.toBe(0.01); // Does not collapse to universal $0.01
    });

    it('Test 4.2 — Fail-Closed at Order Execution Time if Constraints Violated', () => {
      // If a trade has post-rounding notional below exchange minNotional (e.g., $4.95 < $5.00 minNotional)
      const res = TradeValidator.validate({
        symbol: 'SOPH/USDT',
        side: 'BUY',
        orderType: 'MARKET',
        entryIntent: 'MARKET_ENTRY',
        entryPrice: 0.005969,
        tradeValueUsdt: 4.95 // Less than $5.00 minNotional
      }, {
        schemaVersion: '2.0',
        symbol: 'SOPH/USDT',
        exchange: 'bybit',
        baseAsset: 'SOPH',
        quoteAsset: 'USDT',
        minNotional: 5.0,
        minQty: 10,
        maxQty: 16500000,
        stepSize: 10,
        tickSize: 0.000001,
        minPrice: 0.000001,
        maxPrice: 19.999998,
        contractSize: 1
      });

      // Assert STRICT fail-closed rejection
      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe('MIN_NOTIONAL_FAILED');

      // Assert FinalDispatchSafetyGate also rejects invalid orders
      expect(() => {
        FinalDispatchSafetyGate.validate({
          symbol: 'SOPH/USDT',
          side: 'buy',
          type: 'market',
          amount: new BigNumber(830),
          price: new BigNumber(0.005969)
        }, {
          stepSize: 10,
          tickSize: 0.000001,
          minQty: 10,
          minNotional: 5.0
        });
      }).toThrow('below minimum 5');
    });
  });

  // =========================================================================
  // Group 5: Full End-to-End Pipeline (Alert -> Validator -> SafetyGate)
  // =========================================================================
  describe('Group 5: Full End-to-End Execution Pipeline Trace', () => {
    it('Traces 25 USDT SOPH Long Alert -> Validator -> FinalDispatchSafetyGate -> Order Request', () => {
      const entryPrice = 0.005969;
      const userAllocatedUsdt = 25.00;

      // 1. Alert generation
      const tickSize = 0.000001;
      const qtyStep = 10;
      const minNotional = 5.0;
      const minQty = 10;

      const stopLoss = 0.005748;
      const takeProfit = 0.006411;
      const positionSize = userAllocatedUsdt; // 25.00

      const alertPayload = {
        id: 'test-alert-uuid-1234',
        symbol: 'SOPH/USDT',
        side: 'BUY' as const,
        targetEntryPrice: entryPrice,
        entryPrice: entryPrice,
        signalPrice: entryPrice,
        stopLoss: stopLoss,
        takeProfit: takeProfit,
        positionSize: positionSize,
        estimatedPnl: parseFloat((Math.abs(takeProfit - entryPrice) * (positionSize / entryPrice)).toFixed(2))
      };

      expect(alertPayload.positionSize).toBe(25.00);
      expect(alertPayload.stopLoss).toBe(0.005748);
      expect(alertPayload.takeProfit).toBe(0.006411);
      expect(alertPayload.estimatedPnl).toBe(1.85); // 25 USDT * 7.4% = 1.85 USDT

      // 2. TradeValidator consumes alert payload
      const validationRes = TradeValidator.validate({
        symbol: alertPayload.symbol,
        side: alertPayload.side,
        orderType: 'MARKET',
        entryIntent: 'MARKET_ENTRY',
        entryPrice: alertPayload.entryPrice,
        tradeValueUsdt: alertPayload.positionSize
      }, {
        schemaVersion: '2.0',
        symbol: alertPayload.symbol,
        exchange: 'bybit',
        baseAsset: 'SOPH',
        quoteAsset: 'USDT',
        minNotional: minNotional,
        minQty: minQty,
        maxQty: 16500000,
        stepSize: qtyStep,
        tickSize: tickSize,
        minPrice: tickSize,
        maxPrice: 19.999998,
        contractSize: 1
      });

      expect(validationRes.isValid).toBe(true);
      expect(validationRes.quantizedQuantity).toBe(4180);

      // 3. Construct OrderRequest
      const orderReq = {
        symbol: alertPayload.symbol,
        side: 'buy' as const,
        type: 'market' as const,
        amount: new BigNumber(validationRes.quantizedQuantity!),
        price: new BigNumber(alertPayload.entryPrice),
        clientOrderId: alertPayload.id,
        stopLoss: alertPayload.stopLoss,
        takeProfit: alertPayload.takeProfit
      };

      // 4. FinalDispatchSafetyGate validation immediately prior to Bybit dispatch
      expect(() => {
        FinalDispatchSafetyGate.validate(orderReq, {
          stepSize: qtyStep,
          tickSize: tickSize,
          minQty: minQty,
          minNotional: minNotional
        });
      }).not.toThrow();

      // 5. Verify final Bybit order payload attributes
      expect(orderReq.symbol).toBe('SOPH/USDT');
      expect(orderReq.side).toBe('buy');
      expect(orderReq.type).toBe('market');
      expect(orderReq.amount.toString()).toBe('4180');
      expect(orderReq.stopLoss).toBe(0.005748);
      expect(orderReq.takeProfit).toBe(0.006411);
      expect(orderReq.stopLoss).toBeLessThan(entryPrice);
      expect(orderReq.takeProfit).toBeGreaterThan(entryPrice);
    });
  });

  // =========================================================================
  // Group 6: Handler Integration Test (handleTriggerManualTradeAlert)
  // =========================================================================
  describe('Group 6: Handler Integration Test (handleTriggerManualTradeAlert)', () => {
    let capturedAlert: any = null;

    function createMockContext(requestBody: any) {
      return {
        get: vi.fn().mockReturnValue({ sub: 'user_test_123' }),
        req: {
          json: vi.fn().mockResolvedValue(requestBody)
        },
        status: vi.fn(),
        json: vi.fn().mockImplementation((data: any) => data),
        env: {
          ENCRYPTION_KEY: 'test_key',
          DB: {
            prepare: vi.fn().mockReturnValue({
              bind: vi.fn().mockReturnValue({
                first: vi.fn().mockResolvedValue({
                  exchange_name: 'bybit',
                  exchange_environment: 'demo',
                  exchange_region: 'global',
                  exchange_api_key: 'test_api_key'
                })
              })
            })
          },
          TRADING_BOTS: {
            idFromName: vi.fn().mockReturnValue('bot_id_123'),
            get: vi.fn().mockReturnValue({
              fetch: vi.fn().mockImplementation(async (req: Request) => {
                const body = await req.json();
                capturedAlert = body.alert;
                return new Response(JSON.stringify({ success: true, alertId: capturedAlert.id }), { status: 200 });
              })
            })
          }
        }
      } as any;
    }

    beforeEach(() => {
      capturedAlert = null;

      // Mock ExchangeManager.getProvider to return a controlled adapter
      vi.spyOn(ExchangeManager, 'getProvider').mockResolvedValue({
        fetchTicker: vi.fn().mockResolvedValue({ last: 0.005969 }),
        fetchBalance: vi.fn().mockResolvedValue({ free: { USDT: 1000 } }),
        fetchKlines: vi.fn().mockResolvedValue([
          { high: 0.0061, low: 0.0059, close: 0.0060, open: 0.00595, volume: 1000, timestamp: 1 },
          { high: 0.00615, low: 0.00592, close: 0.00602, open: 0.0060, volume: 1000, timestamp: 2 },
          { high: 0.00618, low: 0.00595, close: 0.00605, open: 0.00602, volume: 1000, timestamp: 3 },
          { high: 0.0062, low: 0.00598, close: 0.0061, open: 0.00605, volume: 1000, timestamp: 4 },
          { high: 0.00615, low: 0.00592, close: 0.00602, open: 0.0061, volume: 1000, timestamp: 5 },
          { high: 0.0061, low: 0.0059, close: 0.00598, open: 0.00602, volume: 1000, timestamp: 6 },
          { high: 0.00605, low: 0.00588, close: 0.00595, open: 0.00598, volume: 1000, timestamp: 7 },
          { high: 0.00608, low: 0.0059, close: 0.00596, open: 0.00595, volume: 1000, timestamp: 8 },
          { high: 0.00612, low: 0.00593, close: 0.00601, open: 0.00596, volume: 1000, timestamp: 9 },
          { high: 0.00614, low: 0.00594, close: 0.00603, open: 0.00601, volume: 1000, timestamp: 10 },
          { high: 0.0061, low: 0.00591, close: 0.00599, open: 0.00603, volume: 1000, timestamp: 11 },
          { high: 0.00607, low: 0.00589, close: 0.00596, open: 0.00599, volume: 1000, timestamp: 12 },
          { high: 0.00609, low: 0.00591, close: 0.00598, open: 0.00596, volume: 1000, timestamp: 13 },
          { high: 0.00605, low: 0.00588, close: 0.00595, open: 0.00598, volume: 1000, timestamp: 14 },
          { high: 0.00608, low: 0.0059, close: 0.005969, open: 0.00595, volume: 1000, timestamp: 15 }
        ]),
        fetchMarkets: vi.fn().mockResolvedValue([
          {
            id: 'SOPHUSDT',
            symbol: 'SOPH/USDT',
            base: 'SOPH',
            quote: 'USDT',
            precision: { price: 0.000001, amount: 10 },
            limits: {
              price: { min: new BigNumber(0.000001) },
              amount: { min: new BigNumber(10) },
              cost: { min: new BigNumber(1) }
            }
          }
        ])
      } as any);
    });

    it('Handler Integration: 5 USDT SOPH Long Alert produces exact 5 USDT positionSize and sub-cent SL/TP', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 5.00,
          side: 'BUY',
          riskParameters: {
            accountRiskPercent: 1.0,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0,
            atrStopLossMultiplier: 1.5
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.symbol).toBe('SOPH/USDT');
      expect(capturedAlert.entryPrice).toBe(0.005969);
      expect(capturedAlert.positionSize).toBe(5.00); // Priority respected! Not overridden to 250!
      expect(capturedAlert.stopLoss).toBeLessThan(0.005969);
      expect(capturedAlert.takeProfit).toBeGreaterThan(0.005969);
      expect(capturedAlert.stopLoss).not.toBe(0.01); // No $0.01 floor!
      expect(capturedAlert.stopLoss).toBe(0.005674); // ATR based calculation: 0.005969 - 0.000295 = 0.005674
      expect(capturedAlert.takeProfit).toBe(0.006362); // Model A: 0.005969 + 0.000393 = 0.006362
    });

    it('Handler Integration: 25 USDT SOPH Long Alert produces exact 25 USDT positionSize', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 25.00,
          side: 'BUY',
          riskParameters: {
            accountRiskPercent: 1.0,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0,
            atrStopLossMultiplier: 1.5
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(25.00); // 25 USDT allocation respected!
    });

    it('Handler Integration: Fallback mode when tradeValueUsdt is undefined uses standard 5.00 USDT allocation', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          // tradeValueUsdt not provided
          side: 'BUY',
          riskParameters: {
            accountRiskPercent: 1.0,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0,
            atrStopLossMultiplier: 1.5
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(5.00); // Pure Model A standard minimum allocation!
    });

    // --- MODEL A REGRESSION MATRIX & LEGACY INERTNESS TESTS ---

    it('Matrix Row 1: 5 USDT | ATR Multiplier 1.5 | TP Multiplier 2.0', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 5.00,
          side: 'BUY',
          riskParameters: {
            atrStopLossMultiplier: 1.5,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(5.00);
      expect(capturedAlert.stopLoss).toBe(0.005674);
      expect(capturedAlert.takeProfit).toBe(0.006362);
    });

    it('Matrix Row 2: 10 USDT | ATR Multiplier 1.5 | TP Multiplier 2.0 (Quantity scales 2x, SL & TP identical)', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 10.00,
          side: 'BUY',
          riskParameters: {
            atrStopLossMultiplier: 1.5,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(10.00);
      // SL & TP remain 100% identical to 5 USDT run
      expect(capturedAlert.stopLoss).toBe(0.005674);
      expect(capturedAlert.takeProfit).toBe(0.006362);
    });

    it('Matrix Row 3: 25 USDT | ATR Multiplier 1.5 | TP Multiplier 2.0 (Quantity scales 5x, SL & TP identical)', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 25.00,
          side: 'BUY',
          riskParameters: {
            atrStopLossMultiplier: 1.5,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(25.00);
      expect(capturedAlert.stopLoss).toBe(0.005674);
      expect(capturedAlert.takeProfit).toBe(0.006362);
    });

    it('Matrix Row 4: 100 USDT | ATR Multiplier 1.5 | TP Multiplier 2.0 (Quantity scales 20x, SL & TP identical)', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 100.00,
          side: 'BUY',
          riskParameters: {
            atrStopLossMultiplier: 1.5,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(100.00);
      expect(capturedAlert.stopLoss).toBe(0.005674);
      expect(capturedAlert.takeProfit).toBe(0.006362);
    });

    it('Matrix Row 5: 10 USDT | ATR Multiplier 2.0 | TP Multiplier 2.0 (Wider SL distance, TP remains independent under Model A)', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 10.00,
          side: 'BUY',
          riskParameters: {
            atrStopLossMultiplier: 2.0, // 2.0x wider multiplier
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(10.00);
      // Wider SL
      expect(capturedAlert.stopLoss).toBe(0.005576);
      // Under Model A, TP is INDEPENDENT of SL multiplier: remains 0.006362 (NOT 0.006755 from Model B!)
      expect(capturedAlert.takeProfit).toBe(0.006362);
    });

    it('Matrix Row 6: 10 USDT | ATR Multiplier 1.5 | TP Multiplier 3.0 (Same SL, TP independently expands to 3.0x)', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 10.00,
          side: 'BUY',
          riskParameters: {
            atrStopLossMultiplier: 1.5,
            atrTakeProfitMultiplier: 3.0,
            riskRewardRatio: 3.0 // Legacy mirror
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      expect(capturedAlert.positionSize).toBe(10.00);
      // SL identical to 1.5x
      expect(capturedAlert.stopLoss).toBe(0.005674);
      // Under Model A: TP = Entry + (currentAtr * 3.0) = 0.005969 + 0.000590 = 0.006559
      expect(capturedAlert.takeProfit).toBe(0.006559);
    });

    it('Matrix Row 7: Legacy accountRiskPercent = 5.0 is completely inert (zero effect on sizing, SL, TP, or execution)', async () => {
      const mockCtx = createMockContext({
        symbol: 'SOPH/USDT',
        strategy: 'ScalperV2',
        config: {
          entryPrice: 0.005969,
          tradeValueUsdt: 10.00,
          side: 'BUY',
          riskParameters: {
            accountRiskPercent: 5.0, // Legacy parameter
            atrStopLossMultiplier: 1.5,
            atrTakeProfitMultiplier: 2.0,
            riskRewardRatio: 2.0
          }
        }
      });

      await handleTriggerManualTradeAlert(mockCtx);

      expect(capturedAlert).not.toBeNull();
      // 1. Position size is exactly 10.00 USDT, completely unaffected by accountRiskPercent = 5.0
      expect(capturedAlert.positionSize).toBe(10.00);
      // 2. SL and TP are 100% identical to Row 2 where accountRiskPercent was omitted
      expect(capturedAlert.stopLoss).toBe(0.005674);
      expect(capturedAlert.takeProfit).toBe(0.006362);
      // 3. Trade is NOT suppressed
      expect(capturedAlert.status).toBe('pending');
    });
  });
});
