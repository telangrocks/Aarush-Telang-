import { describe, it, expect } from "vitest";
import { getExchangeAdapter } from "../../src/exchanges";
import { BinanceExchange } from "../exchanges/BinanceExchange";

describe("Binance Testnet Validation (Real Execution)", () => {
  it("should perform live end-to-end validation on Binance Testnet", async () => {
    const apiKey = "DxprEk9rEHOT0DfP0SpyhjLcBwoYthuiiUlkeZmfZbfRp2qwWBXnvr76hpQhtud5";
    const apiSecret = "LoYuM0BqzqYjHIyRSHe5fdrvSi79VLLsS7STjAMNknHUiulbbJcd6Lp58fpUzHq6";
    
    // Set to testnet
    const adapter = getExchangeAdapter("binance", "testnet", "global") as BinanceExchange;
    
    // Test on a highly liquid pair
    const symbol = "BTC"; 

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
    let qty = ticker?.minNotional ? (ticker.minNotional / (ticker.price || 1)) * 1.05 : 0.001; 
    const lot = await (adapter as any).getSymbolMetadata(symbol);
    if (lot && lot.lotSize) {
       qty = Math.ceil(qty / lot.lotSize) * lot.lotSize;
    }
    // Make sure it meets minimum size for Binance BTCUSDT
    if (qty < 0.001) qty = 0.001;
    console.log(`✅ Safety Check - Calculated minimum qty for ${symbol}: ${qty.toFixed(5)} (Notional: ~${(qty * (ticker?.price || 0)).toFixed(2)} USD)`);

    // 3. Order Submission
    console.log(`\n3. Order Submission...`);
    const orderResult = await adapter.placeOrder(symbol, "BUY", apiKey, apiSecret, qty);
    if (!orderResult.success) {
      console.error(`Order failed: ${orderResult.message}`);
      throw new Error(`Order failed: ${orderResult.message}`);
    }
    expect(orderResult.success).toBe(true);
    expect(orderResult.orderId).toBeDefined();
    console.log(`✅ Order Placed Successfully: ID=${orderResult.orderId}, Average Fill Price=${orderResult.price}, Quantity=${orderResult.quantity}`);

    // Wait a brief moment to ensure exchange processes the fill
    await new Promise(r => setTimeout(r, 2000));

    // 4. Fetch the specific order (Feature 3 Verification)
    console.log(`\n4. Fetching Order details directly (Partial Fills check)...`);
    const fetchedOrder = await adapter.fetchOrder(orderResult.orderId!, apiKey, apiSecret, symbol);
    expect(fetchedOrder.success).toBe(true);
    console.log(`✅ Fetched Order: Status=${fetchedOrder.status}, Average Fill Price=${fetchedOrder.averageFillPrice}, Filled Qty=${fetchedOrder.filledQuantity}`);

    // 5. Position Synchronization
    console.log(`\n5. Trade Lifecycle & Position Synchronization...`);
    const positions = await adapter.fetchPositions(apiKey, apiSecret);
    expect(positions.success).toBe(true);
    const activePos = positions.result.find((p: any) => p.symbol.includes(symbol));
    console.log(`✅ Positions fetched successfully. Found ${positions.result.length} active balances/positions.`);
    
    // 6. Close Position
    if (activePos && activePos.size > 0) {
      console.log(`✅ Active Position Found: Size=${activePos.size}`);
      console.log(`\n6. Immediate Safety Close...`);
      const closeResult = await adapter.placeOrder(symbol, "SELL", apiKey, apiSecret, activePos.size);
      expect(closeResult.success).toBe(true);
      console.log(`✅ Position closed successfully. Exit Price=${closeResult.price}`);
    } else {
      console.log(`⚠️ Active Position not found (perhaps already closed, or pending fill)`);
      const closeResult = await adapter.placeOrder(symbol, "SELL", apiKey, apiSecret, qty);
      console.log(`✅ Fallback close executed. Status: ${closeResult.success}`);
    }

    // 7. Invalid Request Test
    console.log(`\n7. Error Handling & Edge Cases (Simulated Over-leverage / Max Size)`);
    const badOrder = await adapter.placeOrder(symbol, "BUY", apiKey, apiSecret, 100000000);
    expect(badOrder.success).toBe(false);
    console.log(`✅ Expected Rejection Handled Gracefully: ${badOrder.message}`);
    
  }, 20000); // 20 sec timeout
});
