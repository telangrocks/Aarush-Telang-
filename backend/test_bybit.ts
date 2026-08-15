import { BybitAdapter } from './src/infrastructure/exchange/adapters/BybitAdapter';

async function main() {
  console.log("=== BYBIT ADAPTER PHASE 1 TEST ===");
  const adapter = new BybitAdapter();
  
  // Connect with a dummy config
  await adapter.connect({
    environment: 'demo',
    apiKey: '',
    secret: ''
  });

  try {
    const ticker = await adapter.fetchTicker('BTC/USDT');
    console.log("--- fetchTicker('BTC/USDT') ---");
    console.log("Ticker percentage:", ticker.percentage);
    console.log("Ticker info present:", !!ticker.info);
    console.log("Raw Bybit price24hPcnt:", ticker.info?.price24hPcnt);
    console.log("Ticker last:", ticker.last.toString());
  } catch (e: any) {
    console.error("Error fetching ticker:", e.message);
  }
}

main();
