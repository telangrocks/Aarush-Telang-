import { BybitAdapter } from './src/infrastructure/exchange/adapters/BybitAdapter';
import { analyzeMarket } from './src/market-analysis';

async function runE2E(environment: 'demo' | 'mainnet', apiKey: string, secret: string) {
  console.log(`\n=== E2E TEST: ${environment.toUpperCase()} ===`);
  const adapter = new BybitAdapter();
  
  try {
    // 1. Validate
    const startTime = Date.now();
    await adapter.connect({
      environment,
      apiKey,
      secret
    });
    
    // Test validation
    // const valStart = Date.now();
    // const balance = await adapter.fetchBalance(); // basic validation
    // console.log(`[VALIDATION] Success. Latency: ${Date.now() - valStart}ms`);
    
    // 2. Market Candidates 
    console.log(`[CANDIDATES] Fetching markets...`);
    const marketStart = Date.now();
    const markets = await adapter.fetchMarkets();
    const marketLatency = Date.now() - marketStart;
    console.log(`[CANDIDATES] Markets fetched: ${markets.length} in ${marketLatency}ms`);

    console.log(`[CANDIDATES] Fetching bulk tickers...`);
    const tickerStart = Date.now();
    const tickers = await adapter.fetchTickers(markets.map(m => m.symbol));
    const tickerLatency = Date.now() - tickerStart;
    console.log(`[CANDIDATES] Tickers fetched: ${tickers.length} in ${tickerLatency}ms`);
    
    // Mimic exchange.ts mapping
    const tickerMap = new Map<string, any>(tickers.map((t: any) => [t.symbol, t]));
    const mappedCandidates: any[] = [];
    
    for (const m of markets) {
        const t = tickerMap.get(m.symbol);
        if (!t) continue;
        
        let chg = 0;
        if (typeof (t as any)?.percentage === 'number' && !isNaN((t as any).percentage)) {
          chg = (t as any).percentage;
        } else if (typeof t.info?.price24hPcnt === 'string') {
          chg = parseFloat(t.info.price24hPcnt) * 100;
        }
        
        mappedCandidates.push({
          symbol: m.symbol,
          pairName: m.symbol,
          price: t.last,
          currentMarketPrice: t.last,
          highPrice24h: t.high,
          lowPrice24h: t.low,
          volume24h: t.volume,
          quoteVolume24h: t.quoteVolume,
          priceChangePercent24h: chg,
          minNotional: m.limits?.cost?.min || (m.info as any)?.minNotionalValue || 0,
          minOrderQty: m.limits?.amount?.min || (m.info as any)?.minOrderQty || 0,
          qtyStep: (m.info as any)?.qtyStep || 0,
          tickSize: (m.info as any)?.tickSize || 0
        });
    }
    
    console.log(`[CANDIDATES] Mapped ${mappedCandidates.length} potential candidates.`);
    
    // Ensure we don't spam API with 5 requests for 1h/15m klines since this is just a quick E2E script
    // Mock the adapter's fetchKlines just for this test so we don't hit rate limits or timeout
    adapter.fetchKlines = async (symbol: string, interval: string, limit: number = 200) => {
        const candles = [];
        for (let i = 0; i < 50; i++) { candles.push({ close: 100 + (i * (symbol === 'BTC/USDT' ? 1 : -1)) }); }
        return candles;
    };
    
    const analyzed = await analyzeMarket(mappedCandidates, adapter as any);
    
    console.log(`[CANDIDATES] Technical Analysis Complete. Total Shortlisted: ${analyzed.length}`);
    if (analyzed.length > 0) {
      const top = analyzed[0];
      console.log(`--- TOP CANDIDATE DATA CHAIN ---`);
      console.log(`Symbol: ${top.symbol}`);
      console.log(`Price: ${top.price}`);
      console.log(`24h Change %: ${top.priceChangePercent24h}`);
      console.log(`Technical Score: ${top.score}`);
      console.log(`Trade Side: ${top.tradeSide}`);
      console.log(`Min Notional: ${top.minNotional}`);
      console.log(`Min Order Qty: ${top.minOrderQty}`);
      console.log(`Qty Step: ${top.qtyStep}`);
      console.log(`Tick Size: ${top.tickSize}`);
    }
    
  } catch (e: any) {
    console.error(`[ERROR] E2E failed: ${e.message}`);
  }
}

async function main() {
  await runE2E('demo', '', '');
  await runE2E('mainnet', '', '');
}

main();
