import dotenv from "dotenv";
dotenv.config({ path: ".dev.vars" });
import { ExchangeManager } from "../exchanges/ExchangeManager";
import BigNumber from "bignumber.js";
import crypto from "crypto";

async function runWriteTest(exchangeId: string, apiKey?: string, secret?: string, password?: string, environment: 'Production'|'Testing'|'mainnet'|'testnet' = 'mainnet') {
  if (!apiKey || !secret) {
    console.log(`[${exchangeId}] Skipping ${environment} - Missing keys`);
    return;
  }

  console.log(`\n=== Testing ${exchangeId} (${environment}) ===`);
  const provider = await ExchangeManager.getProvider(exchangeId, {
    environment,
    apiKey,
    secret,
    password
  });

  try {
    console.log("1. Fetching Balance...");
    const balances = await provider.fetchBalance();
    console.log("   Balance OK:", balances.length > 0 ? "Yes" : "No");

    console.log("2. Fetching Markets...");
    const markets = await provider.fetchMarkets();
    console.log(`   Markets loaded: ${markets.length}`);

    console.log("3. Fetching Ticker (BTC/USDT)...");
    const ticker = await provider.fetchTicker("BTC/USDT");
    console.log(`   Ticker OK: ${ticker.last.toNumber()}`);

    console.log("4. Fetching Positions...");
    try {
      const positions = await provider.fetchPositions();
      console.log(`   Positions fetched: ${positions.length}`);
    } catch (e: any) {
      console.log(`   Positions not supported or failed: ${e.message}`);
    }

    console.log("5. Placing Test Order...");
    const clientOrderId = crypto.randomUUID();
    const orderReq = {
      symbol: "TRX/USDT", // low value coin
      side: "buy" as 'buy',
      type: "limit" as 'limit',
      amount: new BigNumber(10), // 10 TRX
      price: new BigNumber(0.01), // very low price, won't fill
      clientOrderId
    };

    try {
      const order = await ExchangeManager.executeIdempotentOrder(provider, orderReq);
      console.log(`   Order placed: ${order.id} (Status: ${order.status})`);

      console.log("6. Fetching Order Status...");
      const fetchedOrder = await provider.fetchOrder(order.id, "TRX/USDT");
      console.log(`   Order fetched: ${fetchedOrder.id} (Status: ${fetchedOrder.status})`);

      console.log("7. Canceling Order...");
      const canceled = await provider.cancelOrder(order.id, "TRX/USDT");
      console.log(`   Order canceled: ${canceled}`);
      
      console.log("8. Fetching Order History...");
      const history = await provider.fetchClosedOrders("TRX/USDT");
      console.log(`   Order history fetched: ${history.length} orders`);

    } catch (e: any) {
      console.error(`   Order flow failed: ${e.message}`);
    }
    
  } catch (err: any) {
    console.error(`[${exchangeId}] Test failed:`, err.message);
  }
}

async function main() {
  await runWriteTest("kucoin", process.env.KUCOIN_TEST_KEY, process.env.KUCOIN_TEST_SECRET, process.env.KUCOIN_TEST_PASSPHRASE, "mainnet");
  await runWriteTest("binance", process.env.BINANCE_TEST_KEY, process.env.BINANCE_TEST_SECRET, "", "testnet");
  await runWriteTest("binance", process.env.BINANCE_MAINNET_KEY, process.env.BINANCE_MAINNET_SECRET, "", "mainnet");
}

main().catch(console.error);
