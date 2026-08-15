import { analyzeMarket } from './src/market-analysis';
import { BaseExchangeAdapter } from './src/infrastructure/exchange/adapters/BaseExchangeAdapter';

class MockAdapter extends BaseExchangeAdapter {
  readonly exchangeId = 'mock';
  fetchMarkets = async () => [];
  fetchBalance = async () => [];
  fetchTicker = async () => ({} as any);
  fetchTickers = async () => [];
  fetchPositions = async () => [];
  createOrder = async () => ({} as any);
  cancelOrder = async () => true;
  fetchOrder = async () => ({} as any);
  fetchOpenOrders = async () => [];
  fetchClosedOrders = async () => [];
  fetchMyTrades = async () => [];
  
  // We mock fetchKlines to return specific data
  public async fetchKlines(symbol: string, interval: string, limit: number = 200): Promise<any[]> {
    if (symbol === 'VALID/USDT') {
      // Return 51 candles with an obvious uptrend to trigger BUY
      // ema20 will be > ema50, RSI will be > 50
      const candles = [];
      for (let i = 0; i < 51; i++) {
        candles.push({ close: 100 + i }); // Increasing prices
      }
      return candles;
    }
    
    if (symbol === 'INCONCLUSIVE/USDT') {
      // Return insufficient candles to trigger the fallback
      return [{ close: 100 }];
    }
    
    return [];
  }
}

async function main() {
  console.log("=== PHASE 2 TEST ===");
  const adapter = new MockAdapter();
  
  const candidates: any[] = [
    { symbol: 'VALID/USDT', priceChangePercent24h: -10 }, // Negative 24h change to prove it doesn't just fallback to SELL
    { symbol: 'INCONCLUSIVE/USDT', priceChangePercent24h: 5 }, // Positive 24h change to prove it doesn't just fallback to BUY
  ];
  
  const results = await analyzeMarket(candidates, adapter as any);
  
  for (const res of results) {
    console.log(`Symbol: ${res.symbol}`);
    console.log(`tradeSide: ${res.tradeSide}`);

    console.log('---');
  }
}

main();
