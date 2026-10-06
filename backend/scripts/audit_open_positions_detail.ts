import { execSync } from "node:child_process";

function runWranglerD1(query: string): any[] {
  const escaped = query.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute crypto_pulse_db --remote --json --command="${escaped}"`;
  const raw = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].results) {
    return parsed[0].results;
  }
  return [];
}

async function main() {
  console.log("=== AUDITING ALL OPEN POSITIONS IN D1 ===");

  // 1. Check all users with open positions
  const userCounts = runWranglerD1(
    `SELECT user_id, COUNT(*) as count, SUM(quantity * entry_price) as total_notional FROM trade_positions WHERE status = 'OPEN' GROUP BY user_id;`
  );
  console.log("\n[1] Open Positions Summary by User:");
  console.table(userCounts);

  // 2. Fetch all 24 OPEN positions for target user
  const userId = "a89c86a3-89a7-42d2-a624-bf56e0daa724";
  const openPositions = runWranglerD1(
    `SELECT id, user_id, symbol, side, quantity, entry_price, (quantity * entry_price) as notional, exchange, environment, strategy, created_at, updated_at, close_reason FROM trade_positions WHERE user_id = '${userId}' AND status = 'OPEN' ORDER BY created_at ASC;`
  );

  console.log(`\n[2] Found ${openPositions.length} OPEN positions for user ${userId}:`);
  console.table(
    openPositions.map((p, idx) => ({
      idx: idx + 1,
      id: p.id,
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      entry_price: p.entry_price,
      notional: Number(p.notional).toFixed(2),
      created_at: p.created_at,
      environment: p.environment,
    }))
  );

  // 3. For each position, check trade_execution_audit
  console.log("\n[3] Correlating positions with trade_execution_audit:");
  const audits = runWranglerD1(
    `SELECT id, alert_id, symbol, strategy, target_entry_price, execution_price, average_fill_price, stop_loss, take_profit, created_at FROM trade_execution_audit WHERE user_id = '${userId}' ORDER BY created_at ASC;`
  );
  console.log(`Found ${audits.length} total trade_execution_audit records for user:`);
  console.table(audits);

  // 4. Check whether ANY of these positions are from the current date (2026-09-30)
  const todayPositions = openPositions.filter((p) => p.created_at.startsWith("2026-09-30"));
  console.log(`\n[4] Open positions created today (2026-09-30): ${todayPositions.length}`);

  // 5. Total exposure calculation
  const totalExposure = openPositions.reduce((acc, p) => acc + Number(p.notional), 0);
  console.log(`\n[5] Total Calculated Historical Open Exposure: $${totalExposure.toFixed(2)}`);
}

main().catch(console.error);
