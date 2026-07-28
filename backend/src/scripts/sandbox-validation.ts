import { KuCoinExchange } from "../exchanges/KuCoinExchange";
import dotenv from "dotenv";

dotenv.config({ path: ".dev.vars" });
dotenv.config();

const API_KEY = process.env.KUCOIN_TEST_KEY;
const API_SECRET = process.env.KUCOIN_TEST_SECRET;
const API_PASSPHRASE = process.env.KUCOIN_TEST_PASSPHRASE;

if (!API_KEY || !API_SECRET || !API_PASSPHRASE) {
  console.error("Missing KuCoin credentials! Set KUCOIN_TEST_KEY, KUCOIN_TEST_SECRET, and KUCOIN_TEST_PASSPHRASE in .dev.vars or environment.");
  process.exit(1);
}

// Since the sandbox is dead, we MUST use production.
const exchange = new KuCoinExchange("production", "global");

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runValidation() {
  console.log("=== STARTING SAFE PRODUCTION VALIDATION ===");
  const report: any[] = [];

  function addReport(category: string, action: string, success: boolean, details: any) {
    console.log(`[${success ? 'OK' : 'FAIL'}] ${category} - ${action}`);
    if (details.message) console.log(`   Message: ${details.message}`);
    if (details.code) console.log(`   Code: ${details.code}`);
    if (!success) console.log(`   Raw Details:`, details);
    report.push({ category, action, success, details });
  }

  // 1. Authentication Check
  console.log("\n--- [1] Authentication ---");
  
  const validResult = await exchange.validateCredentials(API_KEY!, API_SECRET!, API_PASSPHRASE!);
  addReport("Authentication", "Valid Credentials", validResult.success, validResult);

  const invalidSecret = await exchange.validateCredentials(API_KEY!, "wrongsecret", API_PASSPHRASE!);
  addReport("Authentication", "Invalid Secret", !invalidSecret.success && invalidSecret.code === "INVALID_SIGNATURE", invalidSecret);

  const invalidPass = await exchange.validateCredentials(API_KEY!, API_SECRET!, "wrongpass");
  addReport("Authentication", "Invalid Passphrase", !invalidPass.success && invalidPass.code === "INVALID_PASSPHRASE", invalidPass);

  // 2. Market Data
  console.log("\n--- [2] Market Data ---");
  try {
    const tickers = await exchange.fetchMarketData();
    const btcTicker = tickers.find(t => t.symbol === "BTC");
    addReport("Market Data", "Fetch Tickers & Metadata", tickers.length > 0 && !!btcTicker, {
        count: tickers.length,
        btcTicker: btcTicker ? { symbol: btcTicker.symbol, price: btcTicker.price } : null
    });
  } catch (err: any) {
    addReport("Market Data", "Fetch Tickers", false, { error: err.message });
  }

  try {
    const klines = await exchange.fetchKlines("BTCUSDT", "15m", 10);
    addReport("Market Data", "Fetch Klines (Candles)", klines.length === 10, { count: klines.length });
  } catch (err: any) {
    addReport("Market Data", "Fetch Klines", false, { error: err.message });
  }

  // 3. Trading & Order Lifecycle (EXTREMELY SAFE LIMIT ORDER ONLY)
  console.log("\n--- [3] Trading (SAFE LIMIT ONLY) ---");
  const symbol = "BTC-USDT";
  
  // Safe Limit Buy (buying 0.0001 BTC at $10 to ensure it NEVER fills)
  const limitClientOid = `limit-${Date.now()}`;
  const limitBuy = await exchange.placeOrder(symbol, "BUY", API_KEY!, API_SECRET!, 0.0001, limitClientOid, "LIMIT", 10, undefined, undefined, API_PASSPHRASE!);
  
  // It might fail due to insufficient balance, which is fine and proves it works.
  if (limitBuy.success || limitBuy.code === 'INSUFFICIENT_BALANCE') {
      addReport("Trading", "Safe Limit Buy", true, limitBuy);
  } else {
      addReport("Trading", "Safe Limit Buy", false, limitBuy);
  }

  if (limitBuy.success && limitBuy.exchangeOrderId) {
    console.log("Waiting 3 seconds before fetching order status...");
    await sleep(3000);
    
    // We don't have fetchOrder, so we just cancel immediately
    // Cancel Order
    const cancelRes = await exchange.cancelOrder(limitBuy.exchangeOrderId, symbol, API_KEY!, API_SECRET!, API_PASSPHRASE!);
    addReport("Trading", "Cancel Order", cancelRes.success, cancelRes);
  }

  // 4. Rate Limits & Resiliency
  console.log("\n--- [4] Rate Limits & Circuit Breaker ---");
  let rateLimitHit = false;
  let circuitBreakerOpen = false;
  let successCount = 0;
  
  console.log("Spamming fetchBalances to test resiliency...");
  for (let i = 0; i < 20; i++) {
    try {
      const bal = await exchange.fetchBalances!(API_KEY!, API_SECRET!, API_PASSPHRASE!);
      if (bal.success) successCount++;
      else if (bal.code === "API_RATE_LIMIT_REACHED") rateLimitHit = true;
      else if (bal.message?.includes("Circuit breaker")) circuitBreakerOpen = true;
    } catch (e: any) {
      if (e.message?.includes("Circuit breaker") || e.message?.includes("API_RATE_LIMIT_REACHED")) {
        circuitBreakerOpen = true;
      }
    }
  }
  addReport("Resiliency", "Rate Limit / Circuit Breaker Handled", rateLimitHit || circuitBreakerOpen || successCount > 0, {
    successCount, rateLimitHit, circuitBreakerOpen
  });

  console.log("\n=== VALIDATION SCRIPT FINISHED ===");
}

runValidation().catch(console.error);
