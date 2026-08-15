import { BybitAdapter } from './src/infrastructure/exchange/adapters/BybitAdapter';
import { analyzeMarket } from './src/market-analysis';

async function audit() {
  const adapter = new BybitAdapter();
  await adapter.connect({ environment: 'demo', apiKey: '', secret: '' });
  
  const symbols = ['2Z/USDT', 'ACE/USDT', 'AEON/USDT', 'AKE/USDT', 'AVAAI/USDT'];
  
  const markets = await adapter.fetchMarkets();
  const targetMarkets = markets.filter(m => symbols.includes(m.symbol));
  
  const tickers = await adapter.fetchTickers(symbols);
  
  const mappedCandidates = targetMarkets.map(m => {
    const t = tickers.find(ticker => ticker.symbol === m.symbol);
    
    let chg = 0;
    if (typeof (t as any)?.percentage === 'number' && !isNaN((t as any).percentage)) {
      chg = (t as any).percentage;
    } else if (typeof t?.info?.price24hPcnt === 'string') {
      chg = parseFloat(t.info.price24hPcnt) * 100;
    }
    
    return {
      symbol: m.symbol,
      pairName: m.symbol,
      price: t?.last,
      currentMarketPrice: t?.last,
      highPrice24h: t?.high,
      lowPrice24h: t?.low,
      volume24h: t?.volume,
      quoteVolume24h: t?.quoteVolume,
      priceChangePercent24h: chg,
      minNotional: m.limits?.cost?.min || (m.info as any)?.minNotionalValue || 0,
      minOrderQty: m.limits?.amount?.min || (m.info as any)?.minOrderQty || 0,
      qtyStep: (m.info as any)?.qtyStep || 0,
      tickSize: (m.info as any)?.tickSize || 0
    };
  });
  
  const analyzed = await analyzeMarket(mappedCandidates, adapter as any);
  
  console.log(JSON.stringify(analyzed, null, 2));
}

audit();
