import { describe, it, expect } from 'vitest';
import { isExcludedAsset, extractBaseAsset, COMMODITY_BASE_ASSETS } from './AssetClassification';

describe('Canonical AssetClassification', () => {
  describe('extractBaseAsset', () => {
    it('extracts base asset from slash, dash, underscore, and concatenated formats', () => {
      expect(extractBaseAsset('BTC/USDT')).toBe('BTC');
      expect(extractBaseAsset('ETH-USDC')).toBe('ETH');
      expect(extractBaseAsset('SOL_USDT')).toBe('SOL');
      expect(extractBaseAsset('BTCUSDT')).toBe('BTC');
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

  describe('isExcludedAsset - Eligible Crypto & ETF Perpetuals', () => {
    it('allows native crypto perpetuals (dynamic discovery preserved, no whitelist)', () => {
      expect(isExcludedAsset('BTCUSDT')).toBe(false);
      expect(isExcludedAsset('BTC/USDT')).toBe(false);
      expect(isExcludedAsset('ETHUSDT')).toBe(false);
      expect(isExcludedAsset('SOLUSDT')).toBe(false);
      expect(isExcludedAsset('DOGEUSDT')).toBe(false);
      expect(isExcludedAsset('PEPEUSDT')).toBe(false);
      expect(isExcludedAsset('SUIUSDT')).toBe(false);
    });

    it('allows ETF / equity perpetuals such as SOXL', () => {
      expect(isExcludedAsset('SOXLUSDT')).toBe(false);
      expect(isExcludedAsset('SOXL/USDT')).toBe(false);
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
