import fs from "node:fs";
import { execSync } from "node:child_process";
import { BybitAdapter } from "../src/infrastructure/exchange/adapters/BybitAdapter";
import { decrypt } from "../src/crypto";

function getEnvVar(name: string): string {
  const content = fs.readFileSync(".dev.vars", "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.slice(`${name}=`.length).trim();
    }
  }
  return "";
}

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
  console.log("=== VERIFYING BYBIT DEMO ADAPTER CONNECTIVITY ===");
  const encKey = getEnvVar("ENCRYPTION_KEY");
  if (!encKey) {
    throw new Error("ENCRYPTION_KEY not found in .dev.vars");
  }

  const userId = "a89c86a3-89a7-42d2-a624-bf56e0daa724";
  const users = runWranglerD1(
    `SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt FROM users WHERE id = '${userId}';`
  );

  if (users.length === 0) throw new Error("User not found");
  const user = users[0];

  const apiKey = await decrypt(
    { iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt },
    encKey
  );
  const secret = await decrypt(
    { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt },
    encKey
  );

  console.log("Credentials successfully decrypted in memory (NOT PRINTED).");
  console.log(`Exchange Name: ${user.exchange_name}`);
  console.log(`Environment: ${user.exchange_environment}`);

  const adapter = new BybitAdapter();
  await adapter.connect({
    environment: "demo",
    apiKey,
    secret,
  });

  console.log(`Connected Host: ${adapter.getHost()}`);

  // Fetch balances
  const balances = await adapter.fetchBalance();
  console.log(`✓ Fetched ${balances.length} balance entries from Bybit Demo.`);
  const usdtBal = balances.find((b: any) => b.asset === "USDT" || b.currency === "USDT");
  console.log("USDT Balance:", usdtBal);

  // Fetch open positions
  const positions = await adapter.fetchPositions();
  console.log(`✓ Fetched ${positions.length} active positions on Bybit Demo.`);
  for (const pos of positions) {
    console.log(`  - ${pos.symbol} ${pos.side}: size=${pos.size?.toString()}`);
  }

  // Fetch ticker
  const ticker = await adapter.fetchTicker("BTC/USDT");
  console.log(`✓ Fetched BTC/USDT Ticker: last=$${ticker.last?.toString()}`);
}

main().catch(console.error);
