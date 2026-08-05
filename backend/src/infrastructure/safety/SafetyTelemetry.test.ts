import { describe, it, expect } from 'vitest';
import { CapabilityValidator } from './CapabilityValidationAdapter';
import { SafetyTelemetry } from './SafetyTelemetry';
import { ValidationContext } from './ValidationContext';
import { DEFAULT_CAPABILITIES } from '../../domain/capabilities/ExchangeCapabilities';

describe('Milestone 8 — CapabilityValidationAdapter & SafetyTelemetry Unit Tests', () => {
  it('CapabilityValidator rejects unsupported futures leverage', () => {
    const ctx = new ValidationContext({
      intent: { userId: 'u1', exchangeId: 'binance', environment: 'mainnet', symbol: 'BTC/USDT', side: 'buy', type: 'limit', leverage: 10 },
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        supportsFutures: false, // Futures unsupported!
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
