import { TradingBot } from "./src/trading-bot";

async function run() {
  const mockStorageData = new Map<string, any>();
  const mockAlarms: number[] = [];
  
  const mockStorage = {
    get: async (key: string) => mockStorageData.get(key),
    put: async (key: string, value: any) => { mockStorageData.set(key, value); },
    delete: async (key: string) => { mockStorageData.delete(key); },
    list: async () => mockStorageData,
    setAlarm: async (time: number) => { mockAlarms.push(time); },
    deleteAlarm: async () => { mockAlarms.length = 0; },
  };

  const mockState: any = {
    id: { toString: () => "mock-do-id-1234" },
    storage: mockStorage,
    blockConcurrencyWhile: async (cb: any) => cb(),
  };

  const auditLogs: any[] = [];
  
  const mockDB: any = {
    prepare: (query: string) => {
      return {
        bind: (...args: any[]) => {
          return {
            first: async () => {
              if (query.includes('users WHERE id')) {
                return { exchange_name: 'binance', exchange_environment: 'testnet', exchange_region: 'global' };
              }
              return null;
            },
            all: async () => ({ results: [] }),
            run: async () => {
              if (query.includes('INSERT INTO audit_log')) {
                auditLogs.push({ id: args[0], user_id: args[1], action: args[2], ip: args[3], user_agent: args[4], metadata: args[5] });
              }
              return { success: true };
            }
          };
        }
      };
    }
  };

  const mockEnv: any = {
    DB: mockDB,
    ENCRYPTION_KEY: "dummy-key",
  };

  const bot = new TradingBot(mockState, mockEnv);
  console.log("1. Bot initialized.");

  // Test /health when idle
  let req = new Request("http://localhost/health");
  let res = await bot.fetch(req);
  let health = await res.json() as any;
  console.log("Health (Idle):", health);
  
  if (health.status !== 'healthy' || health.isActive !== false) {
    throw new Error("Health endpoint failed in idle state");
  }

  // Test /activate
  req = new Request("http://localhost/activate", {
    method: "POST",
    body: JSON.stringify({ userId: "user_123", coinId: "BTC/USDT", strategy: "scalping", positionSize: 100 }),
  });
  await bot.fetch(req);
  console.log("2. Bot activated.");

  // Test /health when active
  req = new Request("http://localhost/health");
  res = await bot.fetch(req);
  health = await res.json() as any;
  console.log("Health (Active):", health);

  if (health.isActive !== true || health.uptimeSeconds < 0) {
    throw new Error("Health endpoint failed in active state");
  }

  // Test execute trade
  console.log("\nSimulating trade execution (no active pending alert)...");
  req = new Request("http://localhost/execute-trade", { method: "POST" });
  res = await bot.fetch(req);
  const tradeRes = await res.json() as any;
  console.log("Execute trade (no alert):", tradeRes);

  console.log("\nAudit Logs recorded:");
  auditLogs.forEach(log => console.log(`- Action: ${log.action} | Metadata: ${log.metadata}`));
  
  if (!auditLogs.some(l => l.action === 'BOT_ACTIVATED')) {
    throw new Error("BOT_ACTIVATED audit log missing!");
  }

  // Check deactivate
  req = new Request("http://localhost/deactivate", { method: "POST" });
  await bot.fetch(req);
  console.log("\n3. Bot deactivated.");
  
  if (!auditLogs.some(l => l.action === 'BOT_DEACTIVATED')) {
    throw new Error("BOT_DEACTIVATED audit log missing!");
  }

  console.log("\n✅ Phase 3.1 Validation Successful!");
}

run().catch(e => {
  console.error("Validation failed:", e);
  process.exit(1);
});
