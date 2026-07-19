import { CircuitBreaker } from "../exchanges/CircuitBreaker";
import { TradingBot } from "../trading-bot";

async function runValidation() {
  console.log("=========================================");
  console.log("PHASE 3.2 VALIDATION: PROTECTION MECHANISMS");
  console.log("=========================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string) {
    if (condition) {
      console.log(`[PASS] ${message}`);
      passed++;
    } else {
      console.error(`[FAIL] ${message}`);
      failed++;
    }
  }

  // --- 1. Circuit Breaker Validation ---
  console.log("--- 1. Circuit Breaker Validation ---");
  const breaker = new CircuitBreaker(3, 1000); // 3 failures, 1s reset

  // Initial state
  let check = breaker.check();
  assert(check.allowed && check.state === 'CLOSED', "Initial state is CLOSED and allowed");

  // Failures before threshold
  breaker.recordFailure();
  breaker.recordFailure();
  check = breaker.check();
  assert(check.allowed && check.state === 'CLOSED', "State is CLOSED after 2 failures (threshold 3)");

  // Tripping the breaker
  breaker.recordFailure();
  check = breaker.check();
  assert(!check.allowed && check.state === 'OPEN', "State is OPEN and denied after 3 failures");

  // Try to record success while open
  breaker.recordSuccess();
  check = breaker.check();
  assert(!check.allowed && check.state === 'OPEN', "State remains OPEN even if a delayed success is recorded");

  // Wait for reset timeout
  await new Promise(r => setTimeout(r, 1100));
  check = breaker.check();
  assert(check.allowed && check.state === 'HALF_OPEN', "State transitions to HALF_OPEN after timeout");

  // Success in HALF_OPEN
  breaker.recordSuccess();
  check = breaker.check();
  assert(check.allowed && check.state === 'CLOSED', "State transitions to CLOSED after successful probe in HALF_OPEN");

  console.log("");


  // --- 2. Global Kill Switch & Health Endpoint Validation ---
  console.log("--- 2. Global Trading Kill Switch & Health Endpoint Validation ---");
  
  // Mock DO State and Env
  const mockStorage = new Map<string, any>();
  mockStorage.set('isActive', true);
  mockStorage.set('userId', 'test-user-123');

  const mockState = {
    id: { toString: () => "mock-do-id" },
    storage: {
      get: async (key: string) => mockStorage.get(key),
      put: async (key: string, value: any) => mockStorage.set(key, value),
      setAlarm: async (ms: number) => {},
      list: async () => mockStorage,
    },
    blockConcurrencyWhile: async (cb: () => Promise<any>) => await cb()
  };

  // Mock Env with Kill Switch OFF
  let mockEnv = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => null,
          run: async () => {}
        })
      })
    },
    GLOBAL_TRADING_HALT: 'false'
  };

  const botOff = new TradingBot(mockState as any, mockEnv as any);
  
  let res = await botOff.fetch(new Request("https://mock/execute-trade", { method: 'POST', body: JSON.stringify({}) }));
  assert(res.status !== 503, "Kill switch OFF: Trade execution allowed (Status not 503)");

  // Health endpoint when OFF
  res = await botOff.fetch(new Request("https://mock/health"));
  let healthData = await res.json();
  assert(healthData.globalTradingHalt === false, "Health endpoint reflects globalTradingHalt: false");


  // Mock Env with Kill Switch ON
  mockEnv.GLOBAL_TRADING_HALT = 'true';
  const botOn = new TradingBot(mockState as any, mockEnv as any);

  res = await botOn.fetch(new Request("https://mock/execute-trade", { method: 'POST', body: JSON.stringify({}) }));
  assert(res.status === 503, "Kill switch ON: Trade execution blocked with 503");
  const errorData = await res.json();
  assert(errorData.error.includes("safely suspended"), "Kill switch ON: Rejection includes appropriate safety message");

  // Health endpoint when ON
  res = await botOn.fetch(new Request("https://mock/health"));
  healthData = await res.json();
  assert(healthData.globalTradingHalt === true, "Health endpoint reflects globalTradingHalt: true");
  assert(healthData.version === '1.0.0-phase3.2', "Health endpoint reflects correct version");
  assert(healthData.activePositionsCount === 0, "Health endpoint includes activePositionsCount");

  // Verify alarm method behavior when KILL SWITCH is ON
  // We can't directly check the stdout of console.warn easily without mocking, but we can verify it doesn't run analysis
  let analysisRan = false;
  // Override runAnalysisCycle for the test
  (botOn as any).runAnalysisCycle = async () => { analysisRan = true; };
  await botOn.alarm();
  assert(analysisRan === false, "Kill switch ON: Background analysis is aborted immediately");

  mockEnv.GLOBAL_TRADING_HALT = 'false';
  await botOn.alarm();
  assert(analysisRan === true, "Kill switch OFF: Background analysis runs normally");

  console.log("\n=========================================");
  console.log(`Validation Complete: ${passed} Passed, ${failed} Failed`);
  console.log("=========================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runValidation().catch(e => {
  console.error("Validation threw an error:", e);
  process.exit(1);
});
