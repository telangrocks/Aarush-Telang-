import { describe, it } from 'vitest';
import ccxt from 'ccxt';

describe('Task #3 CCXT Initialization Forensics Test', () => {
  it('captures full runtime options vs describe options comparison', async () => {
    const ExchangeClass = (ccxt as any).binance;
    
    // Exact constructor call structure from CcxtProvider.ts
    const userOptions = {
      recvWindow: 10000,
      adjustForTimeDifference: true,
    };

    const exchangeOptions: any = {
      enableRateLimit: true,
      options: userOptions,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      apiKey: 'test_key',
      secret: 'test_secret'
    };

    const exchange = new ExchangeClass(exchangeOptions);

    const describeObj = exchange.describe();
    const describeOptions = describeObj.options || {};
    const runtimeOptions = exchange.options || {};

    const describeKeys = Object.keys(describeOptions);

    const missingKeys = describeKeys.filter(k => !(k in runtimeOptions));

    console.log("=== TASK #3 FORENSICS METADATA ===");
    console.log({
      ccxtVersion: ccxt.version,
      exchangeVersion: exchange.version,
      exchangeId: exchange.id,
      exchangeName: exchange.name
    });

    console.log("\n=== ENTIRE RUNTIME exchange.options ===");
    console.log(JSON.stringify(runtimeOptions, null, 2));

    console.log("\n=== SPECIFIC FIELDS CHECK ===");
    console.log({
      createMarketBuyOrderRequiresPrice: runtimeOptions.createMarketBuyOrderRequiresPrice,
      defaultType: runtimeOptions.defaultType,
      defaultSubType: runtimeOptions.defaultSubType,
      defaultTimeInForce: runtimeOptions.defaultTimeInForce,
      recvWindow: runtimeOptions.recvWindow,
      broker: runtimeOptions.broker
    });

    console.log("\n=== exchange.has ===");
    console.log(JSON.stringify(exchange.has, null, 2));

    console.log("\n=== exchange.features ===");
    console.log(JSON.stringify(exchange.features || null, null, 2));

    console.log("\n=== exchange.describe().options (Total Keys: " + describeKeys.length + ") ===");
    console.log(JSON.stringify(describeOptions, null, 2));

    console.log("\n=== MISSING KEYS IN RUNTIME options (Total Missing: " + missingKeys.length + ") ===");
    console.log(missingKeys);

    // Test calling inArray / createOrderRequest
    console.log("\n=== EXECUTING createOrderRequest SIMULATION ===");
    try {
      await exchange.createOrder('BTC/USDT', 'limit', 'buy', 0.001, 64500, { clientOrderId: 'test-1' });
    } catch (err: any) {
      console.log("Caught Exception Message:", err?.message);
      console.log("Caught Exception Name:", err?.name);
      console.log("Caught Exception Stack:\n", err?.stack);
    }
  });
});
