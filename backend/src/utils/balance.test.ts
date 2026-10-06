import { describe, it, expect } from 'vitest';
import BigNumber from 'bignumber.js';
import { extractUsdtBalance } from './balance';

describe('extractUsdtBalance - Semantic Contract', () => {
  it('correctly extracts total USDT balance by default (preference: total)', () => {
    const balances = [
      {
        currency: 'USDT',
        free: new BigNumber(80000),
        used: new BigNumber(20000),
        total: new BigNumber(100000),
      },
      {
        currency: 'BTC',
        free: new BigNumber(1.5),
        used: new BigNumber(0),
        total: new BigNumber(1.5),
      }
    ];

    const result = extractUsdtBalance(balances);
    expect(result).toBe(100000);
  });

  it('correctly extracts free USDT balance when preference is explicitly free', () => {
    const balances = [
      {
        currency: 'USDT',
        free: new BigNumber(80000),
        used: new BigNumber(20000),
        total: new BigNumber(100000),
      }
    ];

    const result = extractUsdtBalance(balances, 1000, 'free');
    expect(result).toBe(80000);
  });

  it('does NOT silently reinterpret free as total when total is missing or zero under preference total', () => {
    const balances = [
      {
        currency: 'USDT',
        free: new BigNumber(50000),
        used: new BigNumber(0),
        total: new BigNumber(0),
      }
    ];

    // Must return safe default fallback (1000), NEVER free balance
    const result = extractUsdtBalance(balances, 1000, 'total');
    expect(result).toBe(1000);
  });

  it('does NOT silently reinterpret total as free when free is missing or zero under preference free', () => {
    const balances = [
      {
        currency: 'USDT',
        free: new BigNumber(0),
        used: new BigNumber(50000),
        total: new BigNumber(50000),
      }
    ];

    // Must return safe default fallback (1000), NEVER total balance
    const result = extractUsdtBalance(balances, 1000, 'free');
    expect(result).toBe(1000);
  });

  it('correctly extracts balance from raw number representations in Balance[] array', () => {
    const balances = [
      {
        currency: 'USDT',
        free: 25000.5,
        used: 0,
        total: 25000.5,
      }
    ];

    const result = extractUsdtBalance(balances);
    expect(result).toBe(25000.5);
  });

  it('correctly extracts balance from legacy CCXT-style object adhering to preferences', () => {
    const legacyBalance = {
      free: { USDT: 75000 },
      total: { USDT: 85000 }
    };

    expect(extractUsdtBalance(legacyBalance, 1000, 'total')).toBe(85000);
    expect(extractUsdtBalance(legacyBalance, 1000, 'free')).toBe(75000);
  });

  it('falls back to default minimum (1000) when array has no USDT', () => {
    const balances = [
      {
        currency: 'ETH',
        free: new BigNumber(5),
        used: new BigNumber(0),
        total: new BigNumber(5),
      }
    ];

    const result = extractUsdtBalance(balances);
    expect(result).toBe(1000);
  });

  it('falls back to default minimum when null or undefined', () => {
    expect(extractUsdtBalance(null)).toBe(1000);
    expect(extractUsdtBalance(undefined)).toBe(1000);
    expect(extractUsdtBalance([])).toBe(1000);
  });
});
