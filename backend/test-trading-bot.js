/**
 * CryptoPulse Trading Bot — Point #2 Verification Script
 *
 * Usage:
 *   node test-trading-bot.js <email> <password> <apiKey> <apiSecret> [exchangeName]
 *
 * Example:
 *   node test-trading-bot.js user@example.com mypassword abc123 xyz456 binance
 *
 * Notes:
 * - Credentials are only sent to your own Worker.
 * - Nothing is logged or transmitted anywhere else.
 * - Default exchange is "binance" if not provided.
 */

const args = process.argv.slice(2);

if (args.length < 4) {
  console.error("Usage: node test-trading-bot.js <email> <password> <apiKey> <apiSecret> [exchangeName]");
  console.error("Example: node test-trading-bot.js user@example.com mypassword abc123 xyz456 binance");
  process.exit(1);
}

const [email, password, apiKey, apiSecret, exchangeName = "binance"] = args;
const WORKER_URL = "https://crypto-pulse-backend.telangrocks.workers.dev";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testTradingBot() {
  console.log("\n🚀 CryptoPulse Trading Bot — Point #2 Verification");
  console.log("=".repeat(60));

  // Step 1: Login
  console.log("\n📋 Step 1: Logging in...");
  let loginRes, loginData;
  try {
    loginRes = await fetch(`${WORKER_URL}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    loginData = await loginRes.json();
  } catch (error) {
    console.error("❌ Login request failed:", error.message);
    process.exit(1);
  }

  if (!loginRes.ok || loginData.error) {
    console.error("❌ Login failed:", loginData.error || loginData.message || "Unknown error");
    process.exit(1);
  }

  const token = loginData.token;
  console.log("✅ Login successful.");

  // Step 2: Connect exchange
  console.log("\n🔗 Step 2: Connecting exchange...");
  let connectRes, connectData;
  try {
    connectRes = await fetch(`${WORKER_URL}/api/exchange/connect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ exchangeName, apiKey, apiSecret }),
    });
    connectData = await connectRes.json();
  } catch (error) {
    console.error("❌ Exchange connect request failed:", error.message);
    process.exit(1);
  }

  if (!connectRes.ok || connectData.error) {
    console.error("❌ Exchange connection failed:", connectData.error || connectData.message || "Unknown error");
    process.exit(1);
  }

  console.log("✅ Exchange connected:", connectData.exchangeName);

  // Step 3: Activate trading bot
  console.log("\n🤖 Step 3: Activating trading bot...");
  let activateRes, activateData;
  try {
    activateRes = await fetch(`${WORKER_URL}/api/trading-bot/activate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ coinId: "BTC", strategy: "scalping" }),
    });
    activateData = await activateRes.json();
  } catch (error) {
    console.error("❌ Bot activation request failed:", error.message);
    process.exit(1);
  }

  if (!activateRes.ok || activateData.error) {
    console.error("❌ Bot activation failed:", activateData.error || activateData.message || "Unknown error");
    process.exit(1);
  }

  console.log("✅ Bot activated:", activateData.message);

  // Step 4: Wait for monitoring cycle
  console.log("\n⏳ Step 4: Waiting 90 seconds for monitoring cycle...");
  await sleep(90000);

  // Step 5: Check bot status
  console.log("\n📊 Step 5: Checking bot status...");
  let statusRes, statusData;
  try {
    statusRes = await fetch(`${WORKER_URL}/api/trading-bot/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    statusData = await statusRes.json();
  } catch (error) {
    console.error("❌ Status request failed:", error.message);
    process.exit(1);
  }

  if (!statusRes.ok || statusData.error) {
    console.error("❌ Status check failed:", statusData.error || statusData.message || "Unknown error");
    process.exit(1);
  }

  console.log("✅ Bot status:", JSON.stringify(statusData, null, 2));

  // Step 6: Check for alerts
  console.log("\n🔍 Step 6: Checking for trading opportunities...");
  let alertsRes, alertsData;
  try {
    alertsRes = await fetch(`${WORKER_URL}/api/trading-bot/alerts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    alertsData = await alertsRes.json();
  } catch (error) {
    console.error("❌ Alerts request failed:", error.message);
    process.exit(1);
  }

  if (!alertsRes.ok || alertsData.error) {
    console.error("❌ Alerts check failed:", alertsData.error || alertsData.message || "Unknown error");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📈 TRADING OPPORTUNITIES");
  console.log("=".repeat(60));

  if (!Array.isArray(alertsData) || alertsData.length === 0) {
    console.log("⚠️  No opportunities detected in this cycle.");
    console.log("   This is normal — the bot only detects opportunities when");
    console.log("   specific price/volume conditions are met.");
  } else {
    console.log(`✅ Found ${alertsData.length} opportunity(ies):\n`);
    alertsData.forEach((alert, i) => {
      console.log(`Opportunity #${i + 1}:`);
      console.log(`  Symbol:        ${alert.symbol}`);
      console.log(`  Strategy:      ${alert.strategy}`);
      console.log(`  Side:          ${alert.side}`);
      console.log(`  Entry Price:   ${alert.entryPrice}`);
      console.log(`  Stop Loss:     ${alert.stopLoss}`);
      console.log(`  Take Profit:   ${alert.takeProfit}`);
      console.log(`  Est. PnL:      ${alert.estimatedPnl}`);
      console.log(`  Timestamp:     ${alert.timestamp}`);
      console.log("");
    });
  }

  // Step 7: Check market candidates
  console.log("\n🏆 Step 7: Checking top 10 market candidates...");
  let candidatesRes, candidatesData;
  try {
    candidatesRes = await fetch(`${WORKER_URL}/api/market/candidates`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    candidatesData = await candidatesRes.json();
  } catch (error) {
    console.error("❌ Candidates request failed:", error.message);
    process.exit(1);
  }

  if (!candidatesRes.ok || candidatesData.error) {
    console.error("❌ Candidates check failed:", candidatesData.error || candidatesData.message || "Unknown error");
    process.exit(1);
  }

  const candidateCount = Array.isArray(candidatesData) ? candidatesData.length : 0;
  console.log(`✅ Received ${candidateCount} candidate(s):\n`);

  if (candidateCount > 0) {
    candidatesData.forEach((candidate) => {
      console.log(`#${candidate.rank}: ${candidate.symbol} — Score: ${candidate.score}`);
      console.log(`   Price: $${candidate.price} | Volume: ${candidate.volume24h}`);
      console.log(`   Change 24h: ${candidate.priceChange24h}%`);
    });
  }

  console.log("\n" + "=".repeat(60));
  console.log("✅ VERIFICATION COMPLETE");
  console.log("=".repeat(60));
  console.log("\nIf you see opportunities and candidates above, Point #2 is working!");
  console.log("Share this output to confirm the feature is production-ready.\n");
}

testTradingBot().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
