import { describe, it, expect } from 'vitest';
import { PartialResultContainer } from './PartialFailureFramework';

interface PortfolioOverviewData {
  balances: any[];
  orders: any[];
  ticker: any;
  positions: any[];
}

describe('Milestone 7 — PartialFailureFramework Degraded Mode Unit Tests', () => {
  it('PartialResultContainer aggregates successful and degraded component data cleanly', () => {
    const container = new PartialResultContainer<PortfolioOverviewData>();

    container.setComponentData('balances', [{ currency: 'USDT', free: 1000 }]);
    container.setComponentData('orders', []);
    container.setComponentStatus('ticker', 'DEGRADED', 'Ticker endpoint latency spike');
    container.setComponentStatus('positions', 'FAILED', 'Positions API timeout');

    expect(container.data.balances).toHaveLength(1);
    expect(container.data.orders).toBeDefined();
    expect(container.data.ticker).toBeUndefined(); // Data missing but request succeeds partially!

    expect(container.hasFailures()).toBe(true);

    const summary = container.toSummary();
    expect(summary.isDegraded).toBe(true);
    expect(summary.components['balances'].state).toBe('OK');
    expect(summary.components['ticker'].state).toBe('DEGRADED');
    expect(summary.components['positions'].state).toBe('FAILED');
  });
});
