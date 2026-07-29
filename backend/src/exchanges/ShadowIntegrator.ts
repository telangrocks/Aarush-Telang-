import { ExchangeManager } from './ExchangeManager';
import { ProviderConfig } from './models/ConnectionConfig';

export class ShadowIntegrator {
  public static async compareBalances(exchangeId: string, config: ProviderConfig, legacyBalances: any) {
    try {
      const provider = await ExchangeManager.getProvider(exchangeId, config);
      const start = Date.now();
      const ccxtBalances = await provider.fetchBalance();
      const duration = Date.now() - start;

      let differences = 0;
      // Quick comparison for total balances
      const legacyMap = new Map();
      if (Array.isArray(legacyBalances?.balances)) {
        for (const b of legacyBalances.balances) {
           legacyMap.set(b.currency || b.asset, Number(b.total || b.balance || 0));
        }
      }

      for (const b of ccxtBalances) {
        const legTotal = legacyMap.get(b.currency);
        if (legTotal !== undefined) {
           const diff = Math.abs(legTotal - b.total.toNumber());
           if (diff > 0.0001) differences++; // Floating point tolerance
        }
      }

      console.log(`[shadow] Balance parity for ${exchangeId}: ${differences === 0 ? 'PASS' : 'WARN - diffs found'} (${duration}ms)`);
    } catch (e: any) {
      console.error(`[shadow] Error in CCXT fetchBalance for ${exchangeId}:`, e.message);
    }
  }

  public static async compareTicker(exchangeId: string, config: ProviderConfig, symbol: string, legacyTicker: any) {
    try {
      const provider = await ExchangeManager.getProvider(exchangeId, config);
      const start = Date.now();
      const ccxtTicker = await provider.fetchTicker(symbol);
      const duration = Date.now() - start;

      // Basic comparison
      let differences = 0;
      if (Math.abs((legacyTicker.price || legacyTicker.last || 0) - ccxtTicker.last.toNumber()) > 0.0001) differences++;

      console.log(`[shadow] Ticker parity for ${exchangeId} ${symbol}: ${differences === 0 ? 'PASS' : 'WARN - diffs found'} (${duration}ms)`);
    } catch (e: any) {
      console.error(`[shadow] Error in CCXT fetchTicker for ${exchangeId}:`, e.message);
    }
  }

  public static async compareMarkets(exchangeId: string, config: ProviderConfig, legacyTickersLength: number) {
    try {
      const provider = await ExchangeManager.getProvider(exchangeId, config);
      const start = Date.now();
      const markets = await provider.fetchMarkets();
      const duration = Date.now() - start;

      console.log(`[shadow] Market count parity for ${exchangeId}: Legacy=${legacyTickersLength}, CCXT=${markets.length} (${duration}ms)`);
    } catch (e: any) {
      console.error(`[shadow] Error in CCXT fetchMarkets for ${exchangeId}:`, e.message);
    }
  }
}
