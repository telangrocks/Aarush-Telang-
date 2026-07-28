import dotenv from "dotenv";
dotenv.config({ path: ".dev.vars" });
import { KuCoinExchange } from "../exchanges/KuCoinExchange";
import { analyzeMarket } from "../market-analysis";

async function run() {
  console.log("Initializing KuCoin Exchange Adapter (Production)...");
  const exchange = new KuCoinExchange("production", "global");

  console.log("Fetching live market tickers from KuCoin...");
  const tickers = await exchange.fetchMarketData();
  console.log(`Successfully fetched ${tickers.length} tickers.`);

  console.log("Running Market Analysis algorithm to identify Top 10 coins...");
  console.log("This will also fetch recent 15m and 1h Klines/Candles for top candidates...");
  
  const top10 = await analyzeMarket(tickers, exchange);
  
  console.log("\n=== 🏆 TOP 10 COIN CANDIDATES (RAW BOT OUTPUT) 🏆 ===");
  console.log(JSON.stringify(top10, null, 2));
  console.log("=========================================================\n");
}

run().catch(console.error);
