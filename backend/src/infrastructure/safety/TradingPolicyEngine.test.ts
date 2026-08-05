import { describe, it, expect } from 'vitest';
import {
  KillSwitchValidator,
  MaxOrderNotionalLimitValidator,
  DailyLossLimitValidator,
  CooldownValidator,
} from './TradingPolicyEngine';
import { ValidationContext } from './ValidationContext';

describe('Milestone 6 — TradingPolicyEngine Business & Risk Policy Unit Tests', () => {
  it('KillSwitchValidator blocks all orders when kill switch is active', () => {
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
