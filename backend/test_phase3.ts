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
  
  public async fetchKlines(symbol: string, interval: string, limit: number = 200): Promise<any[]> {
    return [];
  }
}

async function main() {
  console.log("=== PHASE 3 TECHNICAL SCORE CALCULATION TEST ===");
  const adapter = new MockAdapter();
  
  // Create a simulated Bybit V5 output after Phase 1 and Phase 6 fixes.
  // Suppose Bybit raw `price24hPcnt` is "0.05" (5.0%).
  // It flows into `exchange.ts` as percentage = 5.0.
  
  const mockCandidates: any[] = [
    {
      symbol: 'SCORE_TEST/USDT',
      price: 100,
      highPrice24h: 110,
      lowPrice24h: 90,
      quoteVolume24h: 1_000_000,
      priceChangePercent24h: 5.0, // Non-zero 24h change!
    }
  ];
  
  const results = await analyzeMarket(mockCandidates, adapter as any);
  
  // Since we only pass 1 candidate, it will be rank 1.
  for (const res of results) {
    console.log(`Symbol: ${res.symbol}`);
    console.log(`Final Technical Score: ${res.score}`);
    
    // Reverse-engineer the components to prove they work
    const volumeScore = Math.min(Math.log10(1_000_000 + 1) * 5, 30);
    const volatilityScore = Math.min(Math.abs(5.0) * 3, 30);
    const rangePercent = ((110 - 90) / 100) * 100;
    const rangeScore = Math.min(rangePercent * 3, 20);
    const momentumScore = Math.min(Math.abs(5.0) * 3, 30);
    const trendDirectionScore = Math.max(-40, Math.min(40, 5.0 * 4));
    
    console.log(`- Volume Score: ${volumeScore.toFixed(2)} / 30`);
    console.log(`- Volatility Score: ${volatilityScore.toFixed(2)} / 30`);
    console.log(`- Range Score: ${rangeScore.toFixed(2)} / 20`);
    console.log(`- Momentum Score: ${momentumScore.toFixed(2)} / 30`);
    console.log(`- Trend Score: ${trendDirectionScore.toFixed(2)} / (-40 to 40)`);
    console.log(`Calculated Total: ${(volumeScore + volatilityScore + rangeScore + momentumScore + trendDirectionScore).toFixed(2)}`);
  }
}

main();
