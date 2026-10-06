import { describe, it, expect } from 'vitest';

// Pure logic unit testing of portfolio exposure resolution and sizing clamping
describe('Portfolio Exposure Safety Gate & Sizing Limits', () => {
  function resolveMaxPortfolioExposure(
    accountBalance: number,
    strategyConfig?: Record<string, any>,
    setupSnapshot?: any
  ): number {
    // If account balance is unavailable, zero, or non-positive, fail closed immediately
    if (typeof accountBalance !== 'number' || accountBalance <= 0 || isNaN(accountBalance)) {
      return 0;
    }

    const directUsdt = strategyConfig?.maxPortfolioExposureUsdt ??
                       setupSnapshot?.maxPortfolioExposureUsdt ??
                       strategyConfig?.maxPortfolioExposure ??
                       setupSnapshot?.maxPortfolioExposure;
    if (typeof directUsdt === 'number' && directUsdt > 0) {
      return Math.min(directUsdt, accountBalance);
    }

    const percentLimit = strategyConfig?.maxPortfolioExposurePercent ??
                         setupSnapshot?.maxPortfolioExposurePercent ??
                         strategyConfig?.portfolioRiskPercent;
    if (typeof percentLimit === 'number' && percentLimit > 0) {
      return accountBalance * (percentLimit / 100);
    }

    // Default portfolio exposure policy: default to live account balance (solvency bound)
    return accountBalance;
  }

  it('defaults max portfolio exposure to account balance solvency ceiling when account balance is 100,000 USDT', () => {
    const maxExposure = resolveMaxPortfolioExposure(100000);
    expect(maxExposure).toBe(100000);
  });

  it('defaults max portfolio exposure to account balance solvency ceiling when account balance is 450 USDT', () => {
    const maxExposure = resolveMaxPortfolioExposure(450);
    expect(maxExposure).toBe(450);
  });

  it('fails closed with 0 max portfolio exposure when account balance is 0 or negative', () => {
    expect(resolveMaxPortfolioExposure(0)).toBe(0);
    expect(resolveMaxPortfolioExposure(-100)).toBe(0);
    expect(resolveMaxPortfolioExposure(0, { maxPortfolioExposureUsdt: 5000 })).toBe(0);
  });

  it('respects explicit maxPortfolioExposureUsdt configuration when present within balance', () => {
    const maxExposure = resolveMaxPortfolioExposure(100000, { maxPortfolioExposureUsdt: 2500 });
    expect(maxExposure).toBe(2500);
  });

  it('ensures explicit maxPortfolioExposureUsdt cannot bypass solvency ceiling if it exceeds balance', () => {
    const maxExposure = resolveMaxPortfolioExposure(1000, { maxPortfolioExposureUsdt: 5000 });
    expect(maxExposure).toBe(1000);
  });

  it('respects explicit maxPortfolioExposurePercent when present', () => {
    const maxExposure = resolveMaxPortfolioExposure(50000, { maxPortfolioExposurePercent: 10 });
    expect(maxExposure).toBe(5000); // 10% of 50,000
  });

  it('rejects order when current exposure + proposed notional exceeds max portfolio exposure', () => {
    const maxExposure = resolveMaxPortfolioExposure(1000); // 1000 balance
    const currentExposure = 950;
    const proposedNotional = 100;

    const wouldExceed = (currentExposure + proposedNotional) > maxExposure;
    expect(wouldExceed).toBe(true);
  });

  it('allows order when current exposure + proposed notional is within max portfolio exposure', () => {
    const maxExposure = resolveMaxPortfolioExposure(100000); // 100000
    const currentExposure = 0;
    const proposedNotional = 5.0; // 5 USDT individual trade

    const wouldExceed = (currentExposure + proposedNotional) > maxExposure;
    expect(wouldExceed).toBe(false);
  });

  it('allows standard 50 USDT and 100 USDT individual trades when portfolio exposure allows', () => {
    const maxExposure = resolveMaxPortfolioExposure(100000); // 100000
    expect(50 <= maxExposure).toBe(true);
    expect(100 <= maxExposure).toBe(true);
  });

  it('prevents an order allocation of 150,000 USDT from executing when account balance is 100,000 USDT', () => {
    const maxExposure = resolveMaxPortfolioExposure(100000); // 100000
    const singleTradeNotional = 150000;
    const isBlocked = singleTradeNotional > maxExposure;
    expect(isBlocked).toBe(true);
  });

  it('allows high allocation such as 50,000 USDT when account balance is 100,000 USDT', () => {
    const maxExposure = resolveMaxPortfolioExposure(100000); // 100000
    const singleTradeNotional = 50000;
    const isBlocked = singleTradeNotional > maxExposure;
    expect(isBlocked).toBe(false);
  });
});
