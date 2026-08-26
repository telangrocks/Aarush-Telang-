import { describe, it, expect } from 'vitest';
import { TradeValidator } from './TradeValidator';
import { SymbolTradingRules, ValidationErrorReason } from '../exchanges/types';

describe('Entry Intent & Dynamic Price-Band Architecture Tests (T-01 to T-12)', () => {
  const btcRules: SymbolTradingRules = {
    schemaVersion: '2.0',
    symbol: 'BTC/USDT',
    exchange: 'bybit',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    minNotional: 5,
    minQty: 0.001,
    maxQty: 100,
    stepSize: 0.001,
    tickSize: 0.5,
    minPrice: 1,
    maxPrice: 200000,
    contractSize: 1,
    priceLimitRatioX: 0.10, // 10% upper price limit
    priceLimitRatioY: 0.10, // 10% lower price limit
    markPrice: 50000,
    lastUpdated: Date.now()
  };

  const penguRules: SymbolTradingRules = {
    schemaVersion: '2.0',
    symbol: 'PENGU/USDT',
    exchange: 'bybit',
    baseAsset: 'PENGU',
    quoteAsset: 'USDT',
    minNotional: 5,
    minQty: 1,
    maxQty: 10000000,
    stepSize: 1,
    tickSize: 0.000001,
    minPrice: 0.000001,
    maxPrice: 20,
    contractSize: 1,
    priceLimitRatioX: 0.10, // 10% upper limit (e.g. max .010610 when mark is .009647)
    priceLimitRatioY: 0.10,
    markPrice: 0.009647,
    lastUpdated: Date.now()
  };

  // T-01: BUY + WAIT_FOR_PRICE (Dip entry below market) -> Valid Resting Limit
  it('T-01: BUY + WAIT_FOR_PRICE with entry below market passes validation', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'BUY',
      orderType: 'LIMIT',
      entryIntent: 'WAIT_FOR_PRICE',
      entryPrice: 48000,
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(true);
    expect(res.quantizedQuantity).toBeGreaterThan(0);
  });

  // T-02: BUY + WAIT_FOR_PRICE (Entry above dynamic price band) -> Rejected
  it('T-02: BUY + WAIT_FOR_PRICE with entry exceeding dynamic price band is rejected', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'BUY',
      orderType: 'LIMIT',
      entryIntent: 'WAIT_FOR_PRICE',
      entryPrice: 56000, // > 50000 * 1.10 = 55000
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.PRICE_ABOVE_MAXIMUM);
    expect(res.errorMessage).toContain('exceeds exchange dynamic price band');
  });

  // T-03: BUY + TRIGGER (Breakout trigger above market) -> Valid
  it('T-03: BUY + TRIGGER with trigger price above market passes validation', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'BUY',
      orderType: 'MARKET',
      entryIntent: 'TRIGGER',
      entryPrice: 52000,
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(true);
  });

  // T-04: BUY + TRIGGER (Dip bounce trigger below market) -> Valid
  it('T-04: BUY + TRIGGER with trigger price below market passes validation', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'BUY',
      orderType: 'MARKET',
      entryIntent: 'TRIGGER',
      entryPrice: 48000,
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(true);
  });

  // T-05: BUY + IMMEDIATE (Immediate fill at prevailing market price) -> Valid
  it('T-05: BUY + IMMEDIATE executes as immediate market order', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'BUY',
      orderType: 'MARKET',
      entryIntent: 'IMMEDIATE',
      entryPrice: 50000,
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(true);
  });

  // T-06: SELL + WAIT_FOR_PRICE (Rally entry above market) -> Valid Resting Limit
  it('T-06: SELL + WAIT_FOR_PRICE with entry above market passes validation', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'SELL',
      orderType: 'LIMIT',
      entryIntent: 'WAIT_FOR_PRICE',
      entryPrice: 52000,
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(true);
    expect(res.quantizedQuantity).toBeGreaterThan(0);
  });

  // T-07: SELL + WAIT_FOR_PRICE (Entry below dynamic price band) -> Rejected
  it('T-07: SELL + WAIT_FOR_PRICE with entry below dynamic price band is rejected', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'SELL',
      orderType: 'LIMIT',
      entryIntent: 'WAIT_FOR_PRICE',
      entryPrice: 44000, // < 50000 * 0.90 = 45000
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.PRICE_BELOW_MINIMUM);
    expect(res.errorMessage).toContain('below exchange dynamic price band');
  });

  // T-08: SELL + TRIGGER (Breakdown trigger below market) -> Valid
  it('T-08: SELL + TRIGGER with trigger price below market passes validation', () => {
    const res = TradeValidator.validate({
      symbol: 'BTC/USDT',
      side: 'SELL',
      orderType: 'MARKET',
      entryIntent: 'TRIGGER',
      entryPrice: 48000,
      currentMarketPrice: 50000,
      markPrice: 50000,
      tradeValueUsdt: 100
    }, btcRules);

    expect(res.isValid).toBe(true);
  });

  // T-09: Micro-Cap Token Precision (PENGU 6-decimal tickSize)
  it('T-09: Micro-cap PENGU aligns with 6-decimal tick size correctly', () => {
    const res = TradeValidator.validate({
      symbol: 'PENGU/USDT',
      side: 'BUY',
      orderType: 'LIMIT',
      entryIntent: 'WAIT_FOR_PRICE',
      entryPrice: 0.009647,
      currentMarketPrice: 0.009647,
      markPrice: 0.009647,
      tradeValueUsdt: 10
    }, penguRules);

    expect(res.isValid).toBe(true);
    expect(res.quantizedQuantity).toBeGreaterThan(0);
  });

  // T-10: Stale .00 entry price on PENGU correctly triggers Dynamic Price Band rejection
  it('T-10: Stale .00 entry price on PENGU is rejected by Dynamic Price Band guard', () => {
    const res = TradeValidator.validate({
      symbol: 'PENGU/USDT',
      side: 'BUY',
      orderType: 'LIMIT',
      entryIntent: 'WAIT_FOR_PRICE',
      entryPrice: 5.0, // Stale price from another coin
      currentMarketPrice: 0.009647,
      markPrice: 0.009647,
      tradeValueUsdt: 10
    }, penguRules);

    expect(res.isValid).toBe(false);
    expect(res.errorCode).toBe(ValidationErrorReason.PRICE_ABOVE_MAXIMUM);
    expect(res.errorMessage).toContain('exceeds exchange dynamic price band');
  });
});
