import { BybitAdapter } from './src/infrastructure/exchange/adapters/BybitAdapter';

async function main() {
  console.log("=== BYBIT ADAPTER PHASE 4 TEST ===");
  const adapter = new BybitAdapter();
  
  await adapter.connect({
    environment: 'demo',
    apiKey: '',
    secret: ''
  });

  try {
    const markets = await adapter.fetchMarkets();
    console.log(`Total markets fetched: ${markets.length}`);
    const linearMarket = markets.find(m => m.symbol === 'BTC/USDT');
    console.log("--- fetchMarkets() LINEAR BTC/USDT ---");
    console.log("Price Step (tickSize):", linearMarket?.precision.price);
    console.log("Amount Step (qtyStep):", linearMarket?.precision.amount);
    console.log("Min Amount (minOrderQty):", linearMarket?.limits.amount.min.toString());
    console.log("Min Cost (minNotionalValue):", linearMarket?.limits.cost.min.toString());
  } catch (e: any) {
    console.error("Error fetching markets:", e.message);
  }
}

main();
