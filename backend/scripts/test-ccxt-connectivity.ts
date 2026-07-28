import { ProviderFactory } from '../src/exchanges/ProviderFactory';
import { ProviderConfig } from '../src/exchanges/models/ConnectionConfig';
import BigNumber from 'bignumber.js';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config({ path: '.dev.vars' });

interface TestResult {
  exchange: string;
  environment: string;
  status: 'Pass' | 'Fail' | 'Skipped';
  errorStep?: string;
  exceptionClass?: string;
  message?: string;
}

const results: TestResult[] = [];

async function runTest(exchangeId: string, config: ProviderConfig, symbol: string) {
  console.log(`\n======================================================`);
  console.log(`Executing Milestone 0 Proof for: ${exchangeId.toUpperCase()} (${config.environment})`);
  console.log(`======================================================`);

  if (!config.apiKey) {
    console.log(`Skipping: Credentials missing from .dev.vars`);
    results.push({
      exchange: exchangeId,
      environment: config.environment,
      status: 'Skipped',
      message: 'API credentials genuinely missing from .dev.vars'
    });
    return;
  }

  let currentStep = 'Instantiate';
  try {
    const provider = ProviderFactory.create(exchangeId);
    
    // Hack to get URLs to display them
    const ccxtInstance = (provider as any).exchange || (provider as any).getCcxtInstance?.() || ((provider as any).exchange);

    currentStep = 'Connect & Authenticate';
    console.log(`[Connecting...]`);
    await provider.connect(config);
    
    const actualExchange = (provider as any).exchange;
    console.log(` > Base URL: ${actualExchange.urls.api.public || actualExchange.urls.api}`);

    currentStep = 'Fetch Balances (Authentication Check)';
    console.log(`[Fetching Balances...]`);
    const balances = await provider.fetchBalance();
    
    // Identify account info if possible (e.g. total balance value)
    const usdtBalance = balances.find(b => b.currency === 'USDT');
    console.log(` > Authenticated! USDT Balance: ${usdtBalance ? usdtBalance.total.toString() : '0'}`);

    currentStep = 'Fetch Ticker';
    console.log(`[Fetching Ticker...]`);
    await provider.fetchTicker(symbol);
    console.log(` > Fetched ticker for ${symbol}`);

    currentStep = 'Fetch Positions';
    console.log(`[Fetching Positions...]`);
    try {
      await provider.fetchPositions();
      console.log(` > Fetched positions successfully`);
    } catch (e: any) {
      if (e.mappedInternalErrorCode !== 'UNSUPPORTED_OPERATION') throw e;
      console.log(` > fetchPositions not supported (Expected for spot endpoints)`);
    }

    if (config.environment === 'Testing') {
      currentStep = 'Place Test Order';
      console.log(`[Placing Test Order...]`);
      const order = await provider.createOrder({
        symbol,
        type: 'market',
        side: 'buy',
        amount: new BigNumber('5'),
        clientOrderId: crypto.randomUUID()
      });

      currentStep = 'Verify Order';
      console.log(`[Verifying Order...]`);
      await provider.fetchOrder(order.id, symbol);

      currentStep = 'Verify Order Status';
      console.log(`[Verifying Order Status...]`);
      const finalOrder = await provider.fetchOrder(order.id, symbol);
      if (finalOrder.status !== 'closed' && finalOrder.status !== 'open') {
         throw new Error(`Order ended in unexpected state: ${finalOrder.status}`);
      }
    } else {
      console.log(`[Order Placement Skipped] Connectivity proof has been completed up to authenticated trading access. Live order execution was skipped for safety on the Production environment.`);
    }

    currentStep = 'Disconnect';
    console.log(`[Disconnecting...]`);
    await provider.disconnect();

    currentStep = 'Reconnect';
    console.log(`[Reconnecting...]`);
    await provider.connect(config);
    await provider.disconnect();

    console.log(`\n>>> SUCCESS <<<`);
    results.push({
      exchange: exchangeId,
      environment: config.environment,
      status: 'Pass'
    });

  } catch (error: any) {
    console.error(`\nXXX FAILED at step: ${currentStep} XXX`);
    console.error(error.message);
    
    results.push({
      exchange: exchangeId,
      environment: config.environment,
      status: 'Fail',
      errorStep: currentStep,
      exceptionClass: error.originalCcxtExceptionClass || error.name,
      message: error.originalExchangeErrorMessage || error.message
    });
  }
}

async function main() {
  console.log(`Using environment configuration from: .dev.vars`);

  // The KUCOIN_TEST_KEY is actually a live key used for testing purposes.
  // We map it to Production since KuCoin Sandbox is deprecated.
  const kucoinProdConfig: ProviderConfig = {
    apiKey: process.env.KUCOIN_TEST_KEY || '',
    secret: process.env.KUCOIN_TEST_SECRET || '',
    password: process.env.KUCOIN_TEST_PASSPHRASE || '',
    environment: 'Production'
  };

  const binanceTestConfig: ProviderConfig = {
    apiKey: process.env.BINANCE_TEST_KEY || '',
    secret: process.env.BINANCE_TEST_SECRET || '',
    environment: 'Testing'
  };

  const binanceProdConfig: ProviderConfig = {
    apiKey: process.env.BINANCE_PROD_KEY || '',
    secret: process.env.BINANCE_PROD_SECRET || '',
    environment: 'Production'
  };

  await runTest('kucoin', kucoinProdConfig, 'BTC/USDT');
  await runTest('binance', binanceTestConfig, 'BTC/USDT');
  await runTest('binance', binanceProdConfig, 'BTC/USDT');

  console.log('\n======================================================');
  console.log('FINAL REPORT');
  console.log('======================================================');
  console.table(results);
}

main().catch(console.error);
