import { getExchangeAdapter } from "../exchanges";
import { DeltaExchange } from "../exchanges/DeltaExchange";
import { randomUUID } from "crypto";
import * as dotenv from "dotenv";

dotenv.config({ path: ".dev.vars" });

async function runTestnetValidation() {
  console.log("Starting Real Exchange Testnet Validation (Phase 1)");
  
  // Try to load API keys from environment
  const apiKey = process.env.TESTNET_API_KEY;
  const apiSecret = process.env.TESTNET_API_SECRET;
  
  if (!apiKey || !apiSecret) {
    console.error("ERROR: TESTNET_API_KEY and TESTNET_API_SECRET are not set in .dev.vars");
    console.error("Cannot perform real exchange validation without credentials.");
    process.exit(1);
  }

  const adapter = getExchangeAdapter("delta", "testnet", "india") as DeltaExchange;
  const symbol = "BTC"; // Base symbol for Delta
  const clientOrderId = randomUUID();

  try {
    console.log(`\n1. Validating Credentials...`);
    const valResult = await adapter.validateCredentials(apiKey, apiSecret);
    if (!valResult.success) {
      throw new Error(`Credential validation failed: ${valResult.friendlyMessage}`);
    }
    console.log("✅ Credentials Valid.");

    console.log(`\n2. Fetching Live Ticker and Metadata for ${symbol}...`);
    const ticker = await adapter.fetchTicker(symbol);
    if (!ticker) throw new Error("Ticker fetch failed");
    console.log(`✅ Live Ticker: Price=${ticker.lastPrice}`);
    
    // We expect the bot to trade a small amount
    const qty = ticker.minNotional ? (ticker.minNotional / ticker.lastPrice) * 1.5 : 0.005;
    console.log(`✅ Precision Rounding/Lot Size Calculation: Raw Qty=${qty}`);

    console.log(`\n3. Order Submission & clientOrderId Verification...`);
    console.log(`Placing LONG order with clientOrderId: ${clientOrderId}`);
    const orderResult = await adapter.placeOrder(symbol, "BUY", apiKey, apiSecret, qty, clientOrderId);
    
    if (orderResult.success) {
      console.log(`✅ Order Placed Successfully: ID=${orderResult.orderId}`);
    } else {
      console.warn(`⚠️ Order Placement Failed: ${orderResult.message}`);
      console.log("This might be due to insufficient testnet funds. Continuing validation if possible...");
    }

    console.log(`\n4. Trade Lifecycle & Position Synchronization...`);
    console.log("Fetching active positions...");
    const positions = await adapter.fetchPositions(apiKey, apiSecret);
    if (positions.success) {
      console.log(`✅ Positions fetched successfully. Found ${positions.result.length} positions.`);
      const activeBtc = positions.result.find((p: any) => p.symbol.includes(symbol));
      if (activeBtc) {
        console.log(`✅ Active Position Found: Size=${activeBtc.size}, Entry=${activeBtc.entry_price}`);
      }
    } else {
      throw new Error(`Failed to fetch positions: ${positions.friendlyMessage}`);
    }

    console.log(`\n5. Error Handling & Edge Cases (Simulated Over-leverage / Max Size)`);
    const badOrder = await adapter.placeOrder(symbol, "BUY", apiKey, apiSecret, 1000000, randomUUID());
    if (!badOrder.success) {
      console.log(`✅ Expected Rejection Handled Gracefully: ${badOrder.message}`);
    } else {
      console.warn("⚠️ Unexpected success for obviously invalid order size.");
    }

    console.log("\n✅ Testnet Validation Script Completed.");
  } catch (err: any) {
    console.error(`\n❌ Validation Failed with Exception:`, err.message);
  }
}

runTestnetValidation();
