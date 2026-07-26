import { BinanceExchange } from "../src/exchanges/BinanceExchange";

const apiKey = "2oeD8QqydFEuQuYsLmIKfXCrvi5p2ecSknnOMX4TWyJE2XW9bk2SJau0cCxxEMpb";
const apiSecret = "G9sQXwGfQODpe445UwIonRl0a2KB2uWSqRdYmj4qjj5Ic3Fds0WzQ2eDy2eJ85th";

async function runLiveValidation() {
  console.log("=== CRYPTOPULSE LIVE BINANCE TESTNET VALIDATION ===");
  console.log(`Environment: TESTNET`);
  console.log(`REST Base URL: https://testnet.binance.vision`);
  console.log(`API Key (masked): ${apiKey.slice(0, 6)}...${apiKey.slice(-6)}`);

  const adapter = new BinanceExchange("testnet", "global");

  // 1. Validate Credentials
  console.log("\n[1/4] Calling validateCredentials()...");
  const startTime = Date.now();
  const valResult = await adapter.validateCredentials(apiKey, apiSecret);
  const latency = Date.now() - startTime;
  console.log(`Latency: ${latency}ms`);
  console.log(`Result success: ${valResult.success}`);
  console.log(`Message: ${valResult.message}`);

  // 2. Fetch Balances via Adapter
  console.log("\n[2/4] Calling fetchBalances() via BinanceExchange Adapter...");
  const balanceResult = await adapter.fetchBalances(apiKey, apiSecret);
  console.log(`Result success: ${balanceResult.success}`);
  console.log(`Message: ${balanceResult.message}`);
  if (balanceResult.balances) {
    console.log(`Balances returned count: ${balanceResult.balances.length} assets`);
    console.log(`USDT Balance: ${JSON.stringify(balanceResult.balances.find((b) => b.asset === "USDT"))}`);
    console.log(`Top Balances: ${JSON.stringify(balanceResult.balances.slice(0, 5), null, 2)}`);
  }

  // 3. Direct REST Fetch to /api/v3/openOrders
  console.log("\n[3/4] Direct REST Fetch to /api/v3/openOrders...");
  const ts4 = Date.now();
  const q4 = `recvWindow=10000&timestamp=${ts4}`;
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig4Buf = await crypto.subtle.sign("HMAC", keyMaterial, encoder.encode(q4));
  const sig4 = Array.from(new Uint8Array(sig4Buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  const url4 = `https://testnet.binance.vision/api/v3/openOrders?${q4}&signature=${sig4}`;
  try {
    const res4 = await fetch(url4, { headers: { "X-MBX-APIKEY": apiKey } });
    console.log(`HTTP Status: ${res4.status} ${res4.statusText}`);
    const body4 = await res4.text();
    if (res4.ok) {
      const orders = JSON.parse(body4);
      console.log(`Open Orders Count: ${orders.length}`);
    } else {
      console.log(`Error Body: ${body4}`);
    }
  } catch (e: any) {
    console.error("openOrders exception:", e.message || e);
  }

  // 4. Test Invalid Credentials Error Handling
  console.log("\n[4/4] Testing Error Handling with Invalid API Key...");
  const badResult = await adapter.validateCredentials("INVALID_API_KEY_12345", apiSecret);
  console.log(`Result success: ${badResult.success}`);
  console.log(`Code: ${badResult.code}`);
  console.log(`Friendly Message: ${badResult.friendlyMessage}`);
  console.log(`Hint: ${badResult.hint}`);

  console.log("\n=== VALIDATION COMPLETED ===");
}

runLiveValidation();
