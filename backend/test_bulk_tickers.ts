import { BybitAdapter } from './src/infrastructure/exchange/adapters/BybitAdapter';

async function main() {
  console.log("=== BYBIT ADAPTER PHASE 6 TEST ===");
  const adapter = new BybitAdapter();
  
  await adapter.connect({
    environment: 'demo',
    apiKey: '',
    secret: ''
  });

  try {
    const startTimeMarkets = Date.now();
    const markets = await adapter.fetchMarkets();
    const endTimeMarkets = Date.now();
    console.log(`Total markets fetched: ${markets.length} in ${endTimeMarkets - startTimeMarkets}ms`);

    const startTimeTickers = Date.now();
    const tickers = await adapter.fetchTickers(markets.map(m => m.symbol));
    const endTimeTickers = Date.now();
    console.log(`Total bulk tickers fetched: ${tickers.length} in ${endTimeTickers - startTimeTickers}ms`);
    
    const linearMarket = tickers.find(t => t.symbol === 'BTC/USDT');
    console.log("--- fetchTickers() LINEAR BTC/USDT ---");
    console.log("Price (last):", linearMarket?.last?.toString());
    console.log("24h Change % (percentage):", linearMarket?.percentage);
  } catch (e: any) {
    console.error("Error:", e.message);
  }
}

main();
