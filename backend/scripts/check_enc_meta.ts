import fs from "node:fs";
import { execSync } from "node:child_process";

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
  const encKey = getEnvVar("ENCRYPTION_KEY");
  console.log("ENCRYPTION_KEY exists in .dev.vars:", Boolean(encKey), "length:", encKey?.length);

  const userId = "a89c86a3-89a7-42d2-a624-bf56e0daa724";
  const user = runWranglerD1(
    `SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key_iv, exchange_api_key_salt, length(exchange_api_key_encrypted) as key_enc_len, exchange_api_secret_iv, exchange_api_secret_salt, length(exchange_api_secret_encrypted) as sec_enc_len FROM users WHERE id = '${userId}';`
  )[0];

  console.log("User exchange metadata:", {
    exchange: user.exchange_name,
    env: user.exchange_environment,
    region: user.exchange_region,
    hasKeyIv: Boolean(user.exchange_api_key_iv),
    hasKeySalt: Boolean(user.exchange_api_key_salt),
    keyEncLen: user.key_enc_len,
    hasSecIv: Boolean(user.exchange_api_secret_iv),
    hasSecSalt: Boolean(user.exchange_api_secret_salt),
    secEncLen: user.sec_enc_len,
  });
}

main().catch(console.error);
