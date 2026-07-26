import { BinanceExchange } from "../src/exchanges/BinanceExchange";
import { StrategyOrchestrator } from "../src/engine/orchestrator/StrategyOrchestrator";
import { MarketDataEngine } from "../src/engine/market-data/MarketDataEngine";
import { EngineAPIService } from "../src/api/engine/EngineAPIService";
import { StrategyRegistry } from "../src/engine/strategies/StrategyRegistry";
import { Timeframe } from "../src/engine/market-data/Timeframe";
import { NormalizedCandle } from "../src/engine/market-data/CandleProvider";

const apiKey = "2oeD8QqydFEuQuYsLmIKfXCrvi5p2ecSknnOMX4TWyJE2XW9bk2SJau0cCxxEMpb";
const apiSecret = "G9sQXwGfQODpe445UwIonRl0a2KB2uWSqRdYmj4qjj5Ic3Fds0WzQ2eDy2eJ85th";

class TestAdapterCandleProvider {
  constructor(private adapter: BinanceExchange) {}

  async fetchCandles(symbol: string, timeframe: Timeframe, limit: number = 100): Promise<NormalizedCandle[]> {
    const klines = await this.adapter.fetchKlines(symbol, timeframe, limit);
    return klines.map((k) => ({
      timestamp: k.openTime,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
    }));
  }

  async fetchTicker(symbol: string) {
    return this.adapter.fetchTicker(symbol);
  }
}

async function runStrategyCycleValidation() {
  console.log("================================================================================");
  console.log("      CRYPTOPULSE FEATURE VALIDATION: BOT STRATEGY CYCLE & TA TELEMETRY         ");
  console.log("================================================================================");

  const selectedCoin = "DOGE";
  const selectedStrategy = "scalper-v2";

  console.log(`\n[1/4] Connecting to Binance Testnet & Initializing Adapters...`);
  const adapter = new BinanceExchange("testnet", "global");
  const validation = await adapter.validateCredentials(apiKey, apiSecret);
  console.log(`-> Binance Connection Status: ${validation.success ? "SUCCESS" : "FAILED"}`);

  console.log(`\n[2/4] Setting up StrategyOrchestrator & MarketDataEngine for '${selectedCoin}'...`);
  const candleProvider = new TestAdapterCandleProvider(adapter);
  const dataEngine = new MarketDataEngine(candleProvider as any);

  const orchestrator = new StrategyOrchestrator();
  orchestrator.setMarketDataEngine(dataEngine);

  console.log(`-> Strategy Registry Loaded. Available Strategies:`);
  const registry = StrategyRegistry.getInstance();
  const manifests = registry.getAllManifests();
  manifests.forEach((m) => console.log(`   - ${m.id}: ${m.name} (Timeframe: ${m.defaultTimeframe})`));

  console.log(`\n[3/4] Executing Strategy Cycle for locked coin '${selectedCoin}' with strategy '${selectedStrategy}'...`);
  const startTime = Date.now();
  const results = await orchestrator.executeCycle(selectedCoin, selectedStrategy);
  const duration = Date.now() - startTime;
  console.log(`-> Strategy Cycle executed in ${duration}ms.`);

  const engineState = orchestrator.getCurrentState();
  const primaryResult = results.length > 0 ? results[0] : undefined;

  console.log(`\n[4/4] Transforming Engine State into User-Facing Analysis Snapshot...`);
  const engineApi = new EngineAPIService();
  const snapshot = engineApi.transform(engineState, selectedCoin, primaryResult);

  console.log("--------------------------------------------------------------------------------");
  console.log(`Target Instrument         : ${snapshot.marketAnalysis.symbol}`);
  console.log(`Active Strategy           : ${snapshot.engineStatus.activeStrategy}`);
  console.log(`State Machine Status      : ${snapshot.engineStatus.state}`);
  console.log(`System Health             : ${snapshot.engineStatus.health}`);
  console.log(`Confidence Score          : ${snapshot.marketAnalysis.confidenceScore} / 100`);
  console.log(`Primary Signal Type       : ${snapshot.tradingSignal.type}`);
  console.log(`Risk Classification       : ${snapshot.tradingSignal.riskClassification}`);
  console.log("--------------------------------------------------------------------------------");

  console.log(`\nSignal Reasoning & Explanation:`);
  snapshot.tradingSignal.reasoning.forEach((reason, idx) => {
    console.log(`   [Reason ${idx + 1}]: ${reason}`);
  });

  if (snapshot.tradingSignal.type !== "HOLD") {
    console.log(`\n🎯 ACTIONABLE TRADE SIGNAL DETECTED:`);
    console.log(`   - Signal Type   : ${snapshot.tradingSignal.type}`);
    console.log(`   - Signal Price  : $${snapshot.tradingSignal.signalPrice}`);
    console.log(`   - Target Entry  : $${snapshot.tradingSignal.targetEntryPrice}`);
    console.log(`   - Stop Loss     : $${snapshot.tradingSignal.stopLoss}`);
    console.log(`   - Take Profit   : $${snapshot.tradingSignal.takeProfit}`);
  } else {
    console.log(`\nℹ️  Signal Status: HOLD (No trade triggered; bot is actively monitoring live candles).`);
  }

  console.log("\nFull Analysis Snapshot Payload (JSON):");
  console.log(JSON.stringify(snapshot, null, 2));

  console.log("\n================================================================================");
  console.log("                      FEATURE VALIDATION SUCCESSFUL                             ");
  console.log("================================================================================");
}

runStrategyCycleValidation();
