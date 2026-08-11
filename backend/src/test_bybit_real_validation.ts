import { BybitAdapter } from './infrastructure/exchange/adapters/BybitAdapter';
import { BinanceAdapter } from './infrastructure/exchange/adapters/BinanceAdapter';
import { KucoinAdapter } from './infrastructure/exchange/adapters/KucoinAdapter';

async function runLiveValidation() {
  console.log('====================================================');
  console.log('STARTING REAL-WORLD LIVE EXCHANGE VALIDATION');
  console.log('====================================================\n');

  // 1. BYBIT TESTNET VALIDATION WITH USER CREDENTIALS
  console.log('[1/3] Testing BybitAdapter against Bybit Testnet API...');
  const bybit = new BybitAdapter();
  await bybit.connect({
    environment: 'testnet',
    apiKey: process.env.TEST_BYBIT_API_KEY || '',
    secret: process.env.TEST_BYBIT_API_SECRET || '',
  });

  try {
    console.log(' -> Testing fetchBalance()...');
    const balances = await bybit.fetchBalance();
    console.log(`    SUCCESS: Received ${balances.length} balance entries. Example:`, balances.slice(0, 3));
  } catch (err: any) {
    console.error('    FAIL fetchBalance:', err.message, err);
  }

  try {
    console.log(' -> Testing fetchTicker("BTC/USDT")...');
    const ticker = await bybit.fetchTicker('BTC/USDT');
    console.log('    SUCCESS: Received Ticker:', {
      symbol: ticker.symbol,
      last: ticker.last.toString(),
      bid: ticker.bid.toString(),
      ask: ticker.ask.toString(),
      volume: ticker.volume.toString(),
    });
  } catch (err: any) {
    console.error('    FAIL fetchTicker:', err.message, err);
  }

  try {
    console.log(' -> Testing fetchKlines("BTC/USDT", "15m", 5)...');
    const klines = await bybit.fetchKlines('BTC/USDT', '15m', 5);
    console.log(`    SUCCESS: Received ${klines.length} candles. Latest candle:`, klines[0]);
  } catch (err: any) {
    console.error('    FAIL fetchKlines:', err.message, err);
  }

  try {
    console.log(' -> Testing fetchMarkets()...');
    const markets = await bybit.fetchMarkets();
    console.log(`    SUCCESS: Received ${markets.length} market entries. Example:`, markets[0]);
  } catch (err: any) {
    console.error('    FAIL fetchMarkets:', err.message, err);
  }

  try {
    console.log(' -> Testing fetchPositions()...');
    const positions = await bybit.fetchPositions();
    console.log(`    SUCCESS: Received ${positions.length} active positions.`);
  } catch (err: any) {
    console.error('    FAIL fetchPositions:', err.message, err);
  }

  try {
    console.log(' -> Testing fetchOpenOrders()...');
    const openOrders = await bybit.fetchOpenOrders();
    console.log(`    SUCCESS: Received ${openOrders.length} open orders.`);
  } catch (err: any) {
    console.error('    FAIL fetchOpenOrders:', err.message, err);
  }

  // 2. BINANCE PUBLIC LIVE TEST
  console.log('\n[2/3] Testing BinanceAdapter against Binance REST API...');
  const binance = new BinanceAdapter();
  await binance.connect({ environment: 'mainnet' });
  try {
    const ticker = await binance.fetchTicker('BTC/USDT');
    console.log('    SUCCESS: Binance Mainnet Ticker:', {
      symbol: ticker.symbol,
      last: ticker.last.toString(),
    });
  } catch (err: any) {
    console.error('    FAIL Binance fetchTicker:', err.message);
  }

  // 3. KUCOIN PUBLIC LIVE TEST
  console.log('\n[3/3] Testing KucoinAdapter against KuCoin REST API...');
  const kucoin = new KucoinAdapter();
  await kucoin.connect({ environment: 'mainnet' });
  try {
    const ticker = await kucoin.fetchTicker('BTC/USDT');
    console.log('    SUCCESS: KuCoin Mainnet Ticker:', {
      symbol: ticker.symbol,
      last: ticker.last.toString(),
    });
  } catch (err: any) {
    console.error('    FAIL KuCoin fetchTicker:', err.message);
  }

  console.log('\n====================================================');
  console.log('LIVE VALIDATION COMPLETE');
  console.log('====================================================');
}

runLiveValidation().catch(console.error);
