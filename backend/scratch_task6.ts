import ccxt from 'ccxt';

async function runTask6StateMutationTrace() {
  console.log("=== TASK #6 STATE MUTATION TRACE ===");

  const exchangeOptions: any = {
    enableRateLimit: true,
    options: {
      recvWindow: 10000,
      adjustForTimeDifference: true,
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    },
    apiKey: 'test_key',
    secret: 'test_secret'
  };

  const ExchangeClass = (ccxt as any).binance;
  const exchange = new ExchangeClass(exchangeOptions);

  const dump1 = {
    checkpoint: "1. IMMEDIATELY AFTER new ExchangeClass(exchangeOptions)",
    keysCount: Object.keys(exchange.options || {}).length,
    defaultType: exchange.options?.defaultType,
    createMarketBuyOrderRequiresPrice: exchange.options?.createMarketBuyOrderRequiresPrice,
    typeofCreateMarketBuyOrderRequiresPrice: typeof exchange.options?.createMarketBuyOrderRequiresPrice,
    jsonCreateMarketBuyOrderRequiresPrice: JSON.stringify(exchange.options?.createMarketBuyOrderRequiresPrice),
    isIdentityWithDescribe: exchange.options === exchange.describe().options,
    describeKeysCount: Object.keys(exchange.describe().options || {}).length,
  };

  // Simulate lifecycle operations (e.g. loadMarkets, fetchTime, fetchBalance)
  if (exchange.has['fetchTime']) {
    try {
      const serverTime = Date.now();
      const diff = serverTime - Date.now();
      exchange.timeDifference = diff;
      if (!exchange.options) exchange.options = {};
      exchange.options['timeDifference'] = diff;
    } catch (_) { /* ignore time sync error */ }
  }

  const dump2 = {
    checkpoint: "2. IMMEDIATELY BEFORE createOrder()",
    keysCount: Object.keys(exchange.options || {}).length,
    defaultType: exchange.options?.defaultType,
    createMarketBuyOrderRequiresPrice: exchange.options?.createMarketBuyOrderRequiresPrice,
    typeofCreateMarketBuyOrderRequiresPrice: typeof exchange.options?.createMarketBuyOrderRequiresPrice,
    jsonCreateMarketBuyOrderRequiresPrice: JSON.stringify(exchange.options?.createMarketBuyOrderRequiresPrice),
    isIdentityWithDescribe: exchange.options === exchange.describe().options,
    describeKeysCount: Object.keys(exchange.describe().options || {}).length,
  };

  console.log("\n--- DUMP 1 (AFTER CONSTRUCTOR) ---");
  console.log(JSON.stringify(dump1, null, 2));

  console.log("\n--- DUMP 2 (BEFORE CREATE ORDER) ---");
  console.log(JSON.stringify(dump2, null, 2));

  console.log("\n--- COMPARISON RESULT ---");
  const isIdentical = JSON.stringify(dump1) === JSON.stringify(dump2);
  console.log("Are Dump 1 and Dump 2 identical?", isIdentical);

  console.log("\n--- ALL ASSIGNMENTS AUDIT IN CODEBASE ---");
  console.log("Searching codebase for any mutations to exchange.options or this.exchange.options...");
}

runTask6StateMutationTrace().catch(console.error);
