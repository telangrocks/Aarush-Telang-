import { describe, it, expect } from 'vitest';
import { Symbol } from './value-objects/Symbol';
import { Price } from './value-objects/Price';
import { Quantity } from './value-objects/Quantity';
import { Money } from './value-objects/Money';
import { Percentage } from './value-objects/Percentage';
import { ExchangeId } from './value-objects/Identifiers';
import { PnLCalculator } from './services/PnLCalculator';
import { PositionSizer } from './services/PositionSizer';

describe('Domain Layer Architecture Unit Tests', () => {
  it('Symbol VO parses base/quote assets correctly', () => {
    const symRes = Symbol.create('BTC/USDT');
    expect(symRes.isSuccess).toBe(true);
    if (symRes.isSuccess) {
      expect(symRes.value.baseAsset).toBe('BTC');
      expect(symRes.value.quoteAsset).toBe('USDT');
      expect(symRes.value.raw).toBe('BTCUSDT');
      expect(symRes.value.toString()).toBe('BTC/USDT');
    }
  });

  it('Price & Quantity quantization operates deterministically', () => {
    const pRes = Price.create(50000.1234);
    const tickRes = Price.create(0.01);
    expect(pRes.isSuccess && tickRes.isSuccess).toBe(true);
    if (pRes.isSuccess && tickRes.isSuccess) {
      const quantized = pRes.value.quantizeToTickSize(tickRes.value);
      expect(quantized.toNumber()).toBe(50000.12);
    }

    const qRes = Quantity.create(1.234567);
    const stepRes = Quantity.create(0.001);
    expect(qRes.isSuccess && stepRes.isSuccess).toBe(true);
    if (qRes.isSuccess && stepRes.isSuccess) {
      const quantizedQ = qRes.value.quantizeToStepSize(stepRes.value);
      expect(quantizedQ.toNumber()).toBe(1.234);
    }
  });

  it('ExchangeId VO enforces supported exchanges', () => {
    expect(ExchangeId.create('binance').isSuccess).toBe(true);
    expect(ExchangeId.create('kucoin').isSuccess).toBe(true);
    expect(ExchangeId.create('bybit').isSuccess).toBe(true);
    expect(ExchangeId.create('delta').isSuccess).toBe(true);
    expect(ExchangeId.create('unsupported_exchange').isFailure).toBe(true);
  });

  it('PnLCalculator computes long/short unrealized PnL', () => {
    const entryRes = Price.create(50000);
    const currentRes = Price.create(55000);
    const qtyRes = Quantity.create(2);
    expect(entryRes.isSuccess && currentRes.isSuccess && qtyRes.isSuccess).toBe(true);

    if (entryRes.isSuccess && currentRes.isSuccess && qtyRes.isSuccess) {
      const longPnl = PnLCalculator.calculateUnrealizedPnL('long', entryRes.value, currentRes.value, qtyRes.value);
      expect(longPnl.toNumber()).toBe(10000);

      const shortPnl = PnLCalculator.calculateUnrealizedPnL('short', entryRes.value, currentRes.value, qtyRes.value);
      expect(shortPnl.toNumber()).toBe(-10000);
    }
  });

  it('PositionSizer calculates risk-adjusted position sizing', () => {
    const balanceRes = Money.create(10000);
    const riskPctRes = Percentage.create(1); // 1% risk = $100
    const entryRes = Price.create(50000);
    const stopRes = Price.create(48000); // $2000 price risk
    expect(balanceRes.isSuccess && riskPctRes.isSuccess && entryRes.isSuccess && stopRes.isSuccess).toBe(true);

    if (balanceRes.isSuccess && riskPctRes.isSuccess && entryRes.isSuccess && stopRes.isSuccess) {
      const qty = PositionSizer.calculatePositionSize(balanceRes.value, riskPctRes.value, entryRes.value, stopRes.value);
      expect(qty.toNumber()).toBe(0.05); // $100 / $2000 = 0.05 BTC
    }
  });
});
