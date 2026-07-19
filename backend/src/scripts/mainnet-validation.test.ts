import { describe, it, expect } from "vitest";
import { getExchangeAdapter } from "../exchanges";
import { DeltaExchange } from "../exchanges/DeltaExchange";


describe("Mainnet Validation (Real Execution)", () => {
  it("should perform live end-to-end validation with smallest trade size", async () => {
    const apiKey = "6nSTYeTLdrXD9v6uGsUCy2lCxAfII2";
    const apiSecret = "LzIopliomk8pKMPQrcNF5caoGQadgz4VTDXfvmeM91IFpjK9E09xFHFDgktw";
    
    // Set to mainnet, india region (since Delta India keys are rejected on global)
    const adapter = getExchangeAdapter("delta", "mainnet", "india") as DeltaExchange;
    // XRP has a very small nominal value per lot
    const symbol = "XRP";
    const clientOrderId = crypto.randomUUID();

    // 1. Validate Credentials
    console.log(`\n1. Validating Credentials...`);
    const valResult = await adapter.validateCredentials(apiKey, apiSecret);
    console.log("valResult:", valResult);
    expect(valResult.success).toBe(true);
    console.log("✅ Credentials Valid.");

    // 2. Fetch Ticker & Metadata
    console.log(`\n2. Fetching Live Ticker and Metadata for ${symbol}...`);
    const ticker = await adapter.fetchTicker(symbol);
    expect(ticker).toBeDefined();
    console.log(`✅ Live Ticker: Price=${ticker?.price}`);
    
    // Calculate minimum size
    let qty = ticker?.minNotional ? (ticker.minNotional / ticker.price) * 1.05 : 10; 
    const lot = await (adapter as any).getSymbolMetadata(symbol);
    if (lot && lot.lotSize) {
       qty = Math.ceil(qty / lot.lotSize) * lot.lotSize;
    }
    console.log(`✅ Safety Check - Calculated minimum qty for ${symbol}: ${qty} (Notional: ~${(qty * (ticker?.price || 0)).toFixed(2)} USD)`);

    // 3. Order Submission
    console.log(`\n3. Order Submission & clientOrderId Verification...`);
    const orderResult = await adapter.placeOrder(symbol, "BUY", apiKey, apiSecret, qty, clientOrderId);
    if (!orderResult.success) {
      console.error(`Order failed: ${orderResult.message}`);
      throw new Error(`Order failed: ${orderResult.message}`);
    }
    expect(orderResult.success).toBe(true);
    console.log(`✅ Order Placed Successfully: ID=${orderResult.orderId}`);

    // Wait a brief moment to ensure exchange processes the fill
    await new Promise(r => setTimeout(r, 2000));

    // 4. Trade Lifecycle / Positions
    console.log(`\n4. Trade Lifecycle & Position Synchronization...`);
    const positions = await adapter.fetchPositions(apiKey, apiSecret);
    expect(positions.success).toBe(true);
    const activePos = positions.result.find((p: any) => p.symbol.includes(symbol));
    console.log(`✅ Positions fetched successfully. Found ${positions.result.length} positions.`);
    
    // 5. Close Position
    if (activePos && activePos.size > 0) {
      console.log(`✅ Active Position Found: Size=${activePos.size}, Entry=${activePos.entry_price}`);
      console.log(`\n5. Immediate Safety Close...`);
      const closeResult = await adapter.placeOrder(symbol, "SELL", apiKey, apiSecret, activePos.size);
      expect(closeResult.success).toBe(true);
      console.log(`✅ Position closed successfully.`);
    } else {
      console.log(`⚠️ Active Position not found (perhaps already closed, or pending fill)`);
      // We still try to sell the qty to be safe if we hold it as balance, though delta is derivatives
      const closeResult = await adapter.placeOrder(symbol, "SELL", apiKey, apiSecret, qty);
      console.log(`✅ Fallback close executed. Status: ${closeResult.success}`);
    }

    // 6. Invalid Request Test
    console.log(`\n6. Error Handling & Edge Cases (Simulated Over-leverage / Max Size)`);
    const badOrder = await adapter.placeOrder(symbol, "BUY", apiKey, apiSecret, 100000000, crypto.randomUUID());
    expect(badOrder.success).toBe(false);
    console.log(`✅ Expected Rejection Handled Gracefully: ${badOrder.message}`);
    
  }, 15000); // 15 sec timeout
});
