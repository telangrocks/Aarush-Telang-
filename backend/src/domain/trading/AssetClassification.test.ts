import { describe, it, expect } from 'vitest';
import { isExcludedAsset, extractBaseAsset, COMMODITY_BASE_ASSETS, TRADFI_EQUITY_AND_ETF_BASE_ASSETS } from './AssetClassification';

describe('Canonical AssetClassification', () => {
  describe('extractBaseAsset', () => {
    it('extracts base asset from slash, dash, underscore, and concatenated formats', () => {
      expect(extractBaseAsset('BTC/USDT')).toBe('BTC');
      expect(extractBaseAsset('ETH-USDC')).toBe('ETH');
      expect(extractBaseAsset('SOL_USDT')).toBe('SOL');
      expect(extractBaseAsset('BTCUSDT')).toBe('BTC');
      expect(extractBaseAsset('NVDAUSDT')).toBe('NVDA');
      expect(extractBaseAsset('SOXLUSDT')).toBe('SOXL');
      expect(extractBaseAsset('XAUUSDT')).toBe('XAU');
      expect(extractBaseAsset('XAGUSDT')).toBe('XAG');
    });
  });

  describe('isExcludedAsset - Commodity Perpetuals', () => {
    it('excludes gold and silver linear perpetuals', () => {
      expect(isExcludedAsset('XAUUSDT')).toBe(true);
      expect(isExcludedAsset('XAU/USDT')).toBe(true);
      expect(isExcludedAsset('XAGUSDT')).toBe(true);
      expect(isExcludedAsset('XAG/USDT')).toBe(true);
    });

    it('excludes platinum, palladium, and energy contracts', () => {
      expect(isExcludedAsset('XPTUSDT')).toBe(true);
      expect(isExcludedAsset('XPDUSDT')).toBe(true);
      expect(isExcludedAsset('USOILUSDT')).toBe(true);
      expect(isExcludedAsset('BRENTUSDT')).toBe(true);
    });
  });

  describe('isExcludedAsset - TradFi Equities & ETFs', () => {
    it('excludes tokenized equities (both concatenated and slash-formatted)', () => {
      expect(isExcludedAsset('NVDAUSDT')).toBe(true);
      expect(isExcludedAsset('NVDA/USDT')).toBe(true);
      expect(isExcludedAsset('TSLAUSDT')).toBe(true);
      expect(isExcludedAsset('TSLA/USDT')).toBe(true);
      expect(isExcludedAsset('AAPLUSDT')).toBe(true);
      expect(isExcludedAsset('AAPL/USDT')).toBe(true);
      expect(isExcludedAsset('COINUSDT')).toBe(true);
      expect(isExcludedAsset('COIN/USDT')).toBe(true);
      expect(isExcludedAsset('MSTRUSDT')).toBe(true);
      expect(isExcludedAsset('MSTR/USDT')).toBe(true);
    });

    it('excludes traditional ETFs and leveraged index funds (both concatenated and slash-formatted)', () => {
      expect(isExcludedAsset('SOXLUSDT')).toBe(true);
      expect(isExcludedAsset('SOXL/USDT')).toBe(true);
      expect(isExcludedAsset('SOXSUSDT')).toBe(true);
      expect(isExcludedAsset('SOXS/USDT')).toBe(true);
      expect(isExcludedAsset('SPYUSDT')).toBe(true);
      expect(isExcludedAsset('SPY/USDT')).toBe(true);
      expect(isExcludedAsset('QQQUSDT')).toBe(true);
      expect(isExcludedAsset('QQQ/USDT')).toBe(true);
    });
  });

  describe('isExcludedAsset - Eligible Crypto Perpetuals', () => {
    it('allows native crypto perpetuals (dynamic discovery preserved, no whitelist)', () => {
      // Benchmark core assets from manual tests and major crypto universe
      expect(isExcludedAsset('BTCUSDT')).toBe(false);
      expect(isExcludedAsset('BTC/USDT')).toBe(false);
      expect(isExcludedAsset('ETHUSDT')).toBe(false);
      expect(isExcludedAsset('ETH/USDT')).toBe(false);
      expect(isExcludedAsset('SOLUSDT')).toBe(false);
      expect(isExcludedAsset('SOL/USDT')).toBe(false);
      expect(isExcludedAsset('XRPUSDT')).toBe(false);
      expect(isExcludedAsset('XRP/USDT')).toBe(false);
      expect(isExcludedAsset('NEARUSDT')).toBe(false);
      expect(isExcludedAsset('NEAR/USDT')).toBe(false);
      expect(isExcludedAsset('ZECUSDT')).toBe(false);
      expect(isExcludedAsset('ZEC/USDT')).toBe(false);
      // Emerging / high-volatility native crypto
      expect(isExcludedAsset('DOGEUSDT')).toBe(false);
      expect(isExcludedAsset('PEPEUSDT')).toBe(false);
      expect(isExcludedAsset('SUIUSDT')).toBe(false);
      expect(isExcludedAsset('HYPEUSDT')).toBe(false);
      expect(isExcludedAsset('HYPE/USDT')).toBe(false);
    });
  });

  describe('isExcludedAsset - Stablecoins & Leveraged Tokens', () => {
    it('excludes stablecoins', () => {
      expect(isExcludedAsset('USDCUSDT')).toBe(true);
      expect(isExcludedAsset('BUSDUSDT')).toBe(true);
      expect(isExcludedAsset('DAIUSDT')).toBe(true);
      expect(isExcludedAsset('FDUSDUSDT')).toBe(true);
    });

    it('excludes leveraged and inverse tokens', () => {
      expect(isExcludedAsset('BTC3LUSDT')).toBe(true);
      expect(isExcludedAsset('ETH3SUSDT')).toBe(true);
      expect(isExcludedAsset('BTCDOWNUSDT')).toBe(true);
      expect(isExcludedAsset('ETHUPUSDT')).toBe(true);
    });
  });
});
