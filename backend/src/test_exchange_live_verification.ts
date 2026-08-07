import { BybitAdapter } from './infrastructure/exchange/adapters/BybitAdapter';
import { BinanceAdapter } from './infrastructure/exchange/adapters/BinanceAdapter';
import { KucoinAdapter } from './infrastructure/exchange/adapters/KucoinAdapter';
import { MarketDataEngine, AdapterCandleProvider } from './engine/market-data';

async function runLiveVerification() {
  console.log('================================================================');
  console.log('STARTING END-TO-END EXCHANGE LAYER RUNTIME VERIFICATION');
  console.log('================================================================\n');

  // -------------------------------------------------------------------------
  // 1. BYBIT TESTNET & MAINNET VERIFICATION
  // -------------------------------------------------------------------------
  console.log('----------------------------------------------------------------');
  console.log('[1/3] VERIFYING BYBIT ADAPTER (V5 API)');
  console.log('----------------------------------------------------------------');

  const bybitTestnet = new BybitAdapter();
  await bybitTestnet.connect({
    environment: 'testnet',
    apiKey: 't9XdpdQslLE1Nso87v',
    secret: 'D0KZaIt3hmtR5oB30HineZPXzTVhdPThkzv0',
  });

  console.log(`[Bybit Testnet] Hostname: ${bybitTestnet.getHost()}`);
  
  try {
    const startTicker = Date.now();
    const ticker = await bybitTestnet.fetchTicker('BTC/USDT');
    const tickerLatency = Date.now() - startTicker;
    console.log(`✓ [Bybit Testnet] Ticker fetch SUCCESS (Latency: ${tickerLatency}ms):`, {
      symbol: ticker.symbol,
      last: ticker.last.toString(),
      bid: ticker.bid.toString(),
      ask: ticker.ask.toString(),
      high: ticker.high.toString(),
      low: ticker.low.toString(),
      volume: ticker.volume.toString(),
    });
  } catch (err: any) {
    console.error('✗ [Bybit Testnet] Ticker fetch ERROR:', err.message);
  }

  try {
    const startKlines = Date.now();
    const klines = await bybitTestnet.fetchKlines('BTC/USDT', '15m', 5);
    const klineLatency = Date.now() - startKlines;
    console.log(`✓ [Bybit Testnet] Klines fetch SUCCESS (${klines.length} candles, Latency: ${klineLatency}ms). Latest candle:`, klines[klines.length - 1]);
  } catch (err: any) {
    console.error('✗ [Bybit Testnet] Klines fetch ERROR:', err.message);
  }

  try {
    const balances = await bybitTestnet.fetchBalance();
    console.log(`✓ [Bybit Testnet] Account Balance fetch SUCCESS (${balances.length} assets):`, balances.slice(0, 3));
  } catch (err: any) {
    console.error('✗ [Bybit Testnet] Balance fetch ERROR:', err.message);
  }

  try {
    const positions = await bybitTestnet.fetchPositions();
    console.log(`✓ [Bybit Testnet] Positions fetch SUCCESS (${positions.length} active positions).`);
  } catch (err: any) {
    console.error('✗ [Bybit Testnet] Positions fetch ERROR:', err.message);
  }

  // Verify MarketDataEngine with Bybit
  try {
    const provider = new AdapterCandleProvider(bybitTestnet);
    const engine = new MarketDataEngine(provider);
    const snapshot = await engine.getSnapshot('BTC/USDT', ['15m', '1h']);
    console.log(`✓ [Bybit Testnet] MarketDataEngine Snapshot SUCCESS:`, {
      symbol: snapshot.symbol,
      currentPrice: snapshot.currentPrice,
      timeframes: Object.keys(snapshot.candles),
      candleCount_15m: snapshot.candles['15m']?.length,
      candleCount_1h: snapshot.candles['1h']?.length,
    });
  } catch (err: any) {
    console.error('✗ [Bybit Testnet] MarketDataEngine Snapshot ERROR:', err.message);
  }

  // -------------------------------------------------------------------------
  // 2. BINANCE MAINNET VERIFICATION
  // -------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log('[2/3] VERIFYING BINANCE ADAPTER');
  console.log('----------------------------------------------------------------');

  const binance = new BinanceAdapter();
  await binance.connect({ environment: 'mainnet' });
  console.log(`[Binance Mainnet] Hostname: ${binance.getHost()}`);

  try {
    const startTicker = Date.now();
    const ticker = await binance.fetchTicker('BTC/USDT');
    const tickerLatency = Date.now() - startTicker;
    console.log(`✓ [Binance Mainnet] Ticker fetch SUCCESS (Latency: ${tickerLatency}ms):`, {
      symbol: ticker.symbol,
      last: ticker.last.toString(),
      bid: ticker.bid.toString(),
      ask: ticker.ask.toString(),
      high: ticker.high.toString(),
      low: ticker.low.toString(),
      volume: ticker.volume.toString(),
    });
  } catch (err: any) {
    console.error('✗ [Binance Mainnet] Ticker fetch ERROR:', err.message);
  }

  try {
    const startKlines = Date.now();
    const klines = await binance.fetchKlines('BTC/USDT', '1h', 5);
    const klineLatency = Date.now() - startKlines;
    console.log(`✓ [Binance Mainnet] Klines fetch SUCCESS (${klines.length} candles, Latency: ${klineLatency}ms). Latest candle:`, klines[klines.length - 1]);
  } catch (err: any) {
    console.error('✗ [Binance Mainnet] Klines fetch ERROR:', err.message);
  }

  // Verify MarketDataEngine with Binance
  try {
    const provider = new AdapterCandleProvider(binance);
    const engine = new MarketDataEngine(provider);
    const snapshot = await engine.getSnapshot('BTC/USDT', ['15m', '1h']);
    console.log(`✓ [Binance Mainnet] MarketDataEngine Snapshot SUCCESS:`, {
      symbol: snapshot.symbol,
      currentPrice: snapshot.currentPrice,
      timeframes: Object.keys(snapshot.candles),
      candleCount_15m: snapshot.candles['15m']?.length,
      candleCount_1h: snapshot.candles['1h']?.length,
    });
  } catch (err: any) {
    console.error('✗ [Binance Mainnet] MarketDataEngine Snapshot ERROR:', err.message);
  }

  // -------------------------------------------------------------------------
  // 3. KUCOIN MAINNET VERIFICATION
  // -------------------------------------------------------------------------
  console.log('\n----------------------------------------------------------------');
  console.log('[3/3] VERIFYING KUCOIN ADAPTER');
  console.log('----------------------------------------------------------------');

  const kucoin = new KucoinAdapter();
  await kucoin.connect({ environment: 'mainnet' });
  console.log(`[KuCoin Mainnet] Hostname: https://openapi-v2.kucoin.com`);

  try {
    const startTicker = Date.now();
    const ticker = await kucoin.fetchTicker('BTC/USDT');
    const tickerLatency = Date.now() - startTicker;
    console.log(`✓ [KuCoin Mainnet] Ticker fetch SUCCESS (Latency: ${tickerLatency}ms):`, {
      symbol: ticker.symbol,
      last: ticker.last.toString(),
      bid: ticker.bid.toString(),
      ask: ticker.ask.toString(),
      high: ticker.high.toString(),
      low: ticker.low.toString(),
      volume: ticker.volume.toString(),
    });
  } catch (err: any) {
    console.error('✗ [KuCoin Mainnet] Ticker fetch ERROR:', err.message);
  }

  try {
    const startKlines = Date.now();
    const klines = await kucoin.fetchKlines('BTC/USDT', '15m', 5);
    const klineLatency = Date.now() - startKlines;
    console.log(`✓ [KuCoin Mainnet] Klines fetch SUCCESS (${klines.length} candles, Latency: ${klineLatency}ms). Latest candle:`, klines[klines.length - 1]);
  } catch (err: any) {
    console.error('✗ [KuCoin Mainnet] Klines fetch ERROR:', err.message);
  }

  // Verify MarketDataEngine with KuCoin
  try {
    const provider = new AdapterCandleProvider(kucoin);
    const engine = new MarketDataEngine(provider);
    const snapshot = await engine.getSnapshot('BTC/USDT', ['15m', '1h']);
    console.log(`✓ [KuCoin Mainnet] MarketDataEngine Snapshot SUCCESS:`, {
      symbol: snapshot.symbol,
      currentPrice: snapshot.currentPrice,
      timeframes: Object.keys(snapshot.candles),
      candleCount_15m: snapshot.candles['15m']?.length,
      candleCount_1h: snapshot.candles['1h']?.length,
    });
  } catch (err: any) {
    console.error('✗ [KuCoin Mainnet] MarketDataEngine Snapshot ERROR:', err.message);
  }

  console.log('\n================================================================');
  console.log('END-TO-END RUNTIME VERIFICATION COMPLETE');
  console.log('================================================================');
}

runLiveVerification().catch(console.error);
