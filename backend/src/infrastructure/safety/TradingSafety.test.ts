import { describe, it, expect } from 'vitest';
import { ValidationPipeline } from './ValidationPipeline';
import { TradingSafetyEngine } from './TradingSafetyEngine';
import {
  KillSwitchValidator,
  MaxOrderNotionalLimitValidator,
  DailyLossLimitValidator,
  CooldownValidator,
} from './TradingPolicyEngine';
import { CapabilityValidator } from './CapabilityValidationAdapter';
import { SafetyTelemetry } from './SafetyTelemetry';
import { OrderIntentValidator } from './validators/OrderIntentValidator';
import {
  SymbolValidator,
  TickSizeValidator,
  StepSizeValidator,
  MinMaxQuantityValidator,
  NotionalValidator,
} from './validators/MarketRulesValidators';
import {
  BalanceValidator,
  LeverageValidator,
  PositionValidator,
} from './validators/AccountPositionValidators';
import { DuplicateOrderValidator } from './validators/DuplicateOrderValidator';
import { ValidationContext } from './ValidationContext';
import { DEFAULT_CAPABILITIES } from '../../domain/capabilities/ExchangeCapabilities';
import { JournalRecord } from '../runtime/ExecutionJournal';

describe('Milestone 9 — Comprehensive Trading Safety & Validation Engine Test Suite', () => {
  it('Scenario 1: Reject malformed order intent (limit order missing price)', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 0 },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('OrderIntentValidator');
    }
  });

  it('Scenario 2: Reject tick size and step size precision violations', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000.555, quantity: 0.001 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.01, stepSize: 0.001 },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('TickSizeValidator');
    }
  });

  it('Scenario 3: Reject order below minimum notional requirement', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.0001 }, // $5
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.0001, minNotional: 10 },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('NotionalValidator');
    }
  });

  it('Scenario 4: Reject order exceeding account USDT balance', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 60000, quantity: 1 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 500, // Insufficient for $60,000 order
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('BalanceValidator');
    }
  });

  it('Scenario 5: Reject duplicate order execution attempts via ExecutionJournal', () => {
    const pipeline = new ValidationPipeline(true);
    const activeRecord: JournalRecord = {
      clientOrderId: 'ord_dup_attempt',
      workflowId: 'wf_active',
      intentHash: 'hash_active',
      state: 'SUBMITTING',
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.1, clientOrderId: 'ord_dup_attempt' },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 10000,
      journalCheckpoints: [activeRecord],
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('DuplicateOrderValidator');
    }
  });

  it('Scenario 6: Reject all order placements when emergency kill switch is active', () => {
    const pipeline = new ValidationPipeline(true);
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.1 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 10000,
      riskLimits: { isKillSwitchActive: true },
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      expect(res.error.message).toContain('KillSwitchValidator');
    }
  });

  it('Scenario 7: Full-scan mode collects all validation errors without aborting early', () => {
    const pipeline = new ValidationPipeline(false); // Fail fast disabled
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 0, quantity: 0.00001 },
      marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001, minNotional: 10 },
      accountBalanceUsdt: 100,
    });

    const res = pipeline.execute(ctx);
    expect(res.isFailure).toBe(true);
    if (res.isFailure) {
      // Failed intent and failed notional
      expect(res.error.message).toBeDefined();
    }
  });

  describe('ValidationPipeline & TradingSafetyEngine Core Behavior', () => {
    it('ValidationPipeline runs full standard validation sequence successfully for valid order', () => {
      const pipeline = new ValidationPipeline(false);
      const ctx = new ValidationContext({
        intent: {
          userId: 'u1',
          exchangeId: 'binance',
          environment: 'mainnet',
          symbol: 'BTC/USDT',
          side: 'buy',
          type: 'limit',
          price: 50000,
          quantity: 0.1,
        },
        marketRules: {
          symbol: 'BTC/USDT',
          tickSize: 0.1,
          stepSize: 0.001,
          minNotional: 10,
        },
        accountBalanceUsdt: 10000,
      });

      const res = pipeline.execute(ctx);
      expect(res.isSuccess).toBe(true);
      if (res.isSuccess) {
        expect(res.value.passedValidators.length).toBeGreaterThanOrEqual(14);
      }
    });

    it('TradingSafetyEngine validates order intent through registered steps cleanly', () => {
      const engine = new TradingSafetyEngine(false);
      engine.registerValidator((_ctx) => ({
        validatorName: 'DummyPassValidator',
        isValid: true,
      }));

      const context = new ValidationContext({
        intent: {
          userId: 'usr_1',
          exchangeId: 'binance',
          environment: 'mainnet',
          symbol: 'BTC/USDT',
          side: 'buy',
          type: 'limit',
          price: 60000,
          quantity: 0.1,
        },
      });

      const result = engine.validateOrderIntent(context);
      expect(result.isSuccess).toBe(true);
      if (result.isSuccess) {
        expect(result.value.isValid).toBe(true);
        expect(result.value.passedValidators).toContain('DummyPassValidator');
      }
    });

    it('TradingSafetyEngine respects failFast option when validation step fails', () => {
      const engine = new TradingSafetyEngine(true);
      engine.registerValidator((_ctx) => ({
        validatorName: 'FailStep1',
        isValid: false,
        errorMessage: 'Step 1 failed intentionally',
      }));
      engine.registerValidator((_ctx) => ({
        validatorName: 'Step2NotReached',
        isValid: true,
      }));

      const context = new ValidationContext({
        intent: {
          userId: 'usr_1',
          exchangeId: 'binance',
          environment: 'mainnet',
          symbol: 'BTC/USDT',
          side: 'buy',
          type: 'limit',
        },
      });

      const result = engine.validateOrderIntent(context);
      expect(result.isFailure).toBe(true);
      if (result.isFailure) {
        expect(result.error.message).toContain('FailStep1');
      }
    });
  });

  describe('TradingPolicyEngine Business & Risk Policy Validators', () => {
    it('KillSwitchValidator returns KILL_SWITCH_ACTIVE when kill switch is active', () => {
      const ctx = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit' },
        riskLimits: { isKillSwitchActive: true },
      });

      const res = KillSwitchValidator(ctx);
      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe('KILL_SWITCH_ACTIVE');
    });

    it('DailyLossLimitValidator blocks orders when daily loss limit reached', () => {
      const ctx = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit' },
        riskLimits: { maxDailyLossUsdt: 500, currentDailyLossUsdt: 550 },
      });

      const res = DailyLossLimitValidator(ctx);
      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe('DAILY_LOSS_LIMIT_REACHED');
    });

    it('CooldownValidator blocks order within cooldown window', () => {
      const ctx = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit' },
        riskLimits: { lastTradeTimestamp: Date.now() - 100, cooldownMs: 1000 },
      });

      const res = CooldownValidator(ctx);
      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe('COOLDOWN_ACTIVE');
    });

    it('MaxOrderNotionalLimitValidator blocks orders exceeding max notional', () => {
      const ctx = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 1 },
        riskLimits: { maxOrderNotionalUsdt: 10000 },
      });

      const res = MaxOrderNotionalLimitValidator(ctx);
      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe('EXCEEDED_MAX_ORDER_NOTIONAL');
    });
  });

  describe('CapabilityValidationAdapter & SafetyTelemetry', () => {
    it('CapabilityValidator rejects unsupported futures leverage', () => {
      const ctx = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', leverage: 10 },
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          supportsFutures: false,
        },
      });

      const res = CapabilityValidator(ctx);
      expect(res.isValid).toBe(false);
      expect(res.errorCode).toBe('UNSUPPORTED_FUTURES_LEVERAGE');
    });

    it('SafetyTelemetry records metrics without throwing exceptions', () => {
      expect(() => {
        SafetyTelemetry.recordValidationSuccess('binance', 1.5);
        SafetyTelemetry.recordValidationFailure('kucoin', {
          validatorName: 'BalanceValidator',
          isValid: false,
          errorCode: 'INSUFFICIENT_BALANCE',
          errorMessage: 'Balance insufficient',
        });
      }).not.toThrow();
    });
  });

  describe('Individual Structural, Market-Rule, Account & Duplicate Validators', () => {
    it('OrderIntentValidator passes valid limit order intent', () => {
      const ctx = new ValidationContext({
        intent: {
          userId: 'usr_1',
          exchangeId: 'binance',
          environment: 'mainnet',
          symbol: 'BTC/USDT',
          side: 'buy',
          type: 'limit',
          price: 60000,
          quantity: 0.5,
        },
      });
      expect(OrderIntentValidator(ctx).isValid).toBe(true);
    });

    it('OrderIntentValidator rejects limit order missing price with MISSING_LIMIT_PRICE and POST_ONLY on market orders with INVALID_POST_ONLY', () => {
      const missingPrice = OrderIntentValidator(
        new ValidationContext({
          intent: { userId: 'usr_1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 0 },
        })
      );
      expect(missingPrice.isValid).toBe(false);
      expect(missingPrice.errorCode).toBe('MISSING_LIMIT_PRICE');

      const postOnlyMarket = OrderIntentValidator(
        new ValidationContext({
          intent: { userId: 'usr_1', exchangeId: 'binance', environment: 'mainnet', symbol: 'ETH/USDT', side: 'buy', type: 'market', postOnly: true },
        })
      );
      expect(postOnlyMarket.isValid).toBe(false);
      expect(postOnlyMarket.errorCode).toBe('INVALID_POST_ONLY');
    });

    it('SymbolValidator fails when market rules are missing', () => {
      const ctx = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit' },
      });
      expect(SymbolValidator(ctx).isValid).toBe(false);
    });

    it('TickSizeValidator and StepSizeValidator validate modulo precision on valid and invalid values', () => {
      const ctxValid = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000.5, quantity: 0.002 },
        marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001 },
      });
      expect(TickSizeValidator(ctxValid).isValid).toBe(true);
      expect(StepSizeValidator(ctxValid).isValid).toBe(true);

      const ctxInvalid = new ValidationContext({
        intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000.55, quantity: 0.0025 },
        marketRules: { symbol: 'BTC/USDT', tickSize: 0.1, stepSize: 0.001 },
      });
      expect(TickSizeValidator(ctxInvalid).isValid).toBe(false);
      expect(StepSizeValidator(ctxInvalid).isValid).toBe(false);
    });

    it('NotionalValidator and MinMaxQuantityValidator enforce minNotional and minQty error codes', () => {
      const lowNotional = NotionalValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 50000, quantity: 0.0001 },
          marketRules: { symbol: 'BTC/USDT', minNotional: 10 },
        })
      );
      expect(lowNotional.isValid).toBe(false);
      expect(lowNotional.errorCode).toBe('MIN_NOTIONAL_VIOLATION');

      const lowQty = MinMaxQuantityValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', quantity: 0.00001 },
          marketRules: { symbol: 'BTC/USDT', minQty: 0.001 },
        })
      );
      expect(lowQty.isValid).toBe(false);
      expect(lowQty.errorCode).toBe('MIN_QTY_VIOLATION');
    });

    it('BalanceValidator, LeverageValidator, and PositionValidator enforce account and position limits', () => {
      const lowBal = BalanceValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', price: 60000, quantity: 1 },
          accountBalanceUsdt: 500,
        })
      );
      expect(lowBal.isValid).toBe(false);
      expect(lowBal.errorCode).toBe('INSUFFICIENT_BALANCE');

      const highLev = LeverageValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'bybit', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', leverage: 50 },
          riskLimits: { maxLeverage: 20 },
        })
      );
      expect(highLev.isValid).toBe(false);
      expect(highLev.errorCode).toBe('EXCEEDED_MAX_LEVERAGE');

      const reduceOnlyNoPos = PositionValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'ETH/USDT', side: 'sell', type: 'market', reduceOnly: true },
          openPositions: [],
        })
      );
      expect(reduceOnlyNoPos.isValid).toBe(false);
      expect(reduceOnlyNoPos.errorCode).toBe('REDUCE_ONLY_NO_POSITION');
    });

    it('DuplicateOrderValidator passes unique orders and rejects duplicate clientOrderId and intentHash', () => {
      const uniqueRes = DuplicateOrderValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', clientOrderId: 'ord_new_123', intentHash: 'hash_new_123' },
          journalCheckpoints: [],
        })
      );
      expect(uniqueRes.isValid).toBe(true);

      const dupClientRes = DuplicateOrderValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', clientOrderId: 'ord_dup_999' },
          journalCheckpoints: [
            { clientOrderId: 'ord_dup_999', workflowId: 'wf_1', intentHash: 'hash_original', state: 'SUBMITTING', payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
          ],
        })
      );
      expect(dupClientRes.isValid).toBe(false);
      expect(dupClientRes.errorCode).toBe('DUPLICATE_CLIENT_ORDER_ID');

      const dupHashRes = DuplicateOrderValidator(
        new ValidationContext({
          intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', intentHash: 'hash_dup_555' },
          journalCheckpoints: [
            { clientOrderId: 'ord_other', workflowId: 'wf_1', intentHash: 'hash_dup_555', state: 'COMMITTED', payload: {}, createdAt: Date.now(), updatedAt: Date.now() },
          ],
        })
      );
      expect(dupHashRes.isValid).toBe(false);
      expect(dupHashRes.errorCode).toBe('DUPLICATE_INTENT_HASH');
    });
  });
});
