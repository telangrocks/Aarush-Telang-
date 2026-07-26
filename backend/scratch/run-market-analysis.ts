import { BinanceExchange } from "../src/exchanges/BinanceExchange";
import { analyzeMarket } from "../src/market-analysis";

const apiKey = "2oeD8QqydFEuQuYsLmIKfXCrvi5p2ecSknnOMX4TWyJE2XW9bk2SJau0cCxxEMpb";
const apiSecret = "G9sQXwGfQODpe445UwIonRl0a2KB2uWSqRdYmj4qjj5Ic3Fds0WzQ2eDy2eJ85th";

async function runMarketAnalysisPipeline() {
  console.log("================================================================================");
  console.log("               CRYPTOPULSE TECHNICAL ANALYSIS & SHORTLIST PIPELINE               ");
  console.log("================================================================================");
  console.log(`[1/4] Reconnecting to Binance Testnet...`);
  console.log(`API Key (masked): ${apiKey.slice(0, 6)}...${apiKey.slice(-6)}`);
  
  const adapter = new BinanceExchange("testnet", "global");
  const validation = await adapter.validateCredentials(apiKey, apiSecret);
  console.log(`[Validation Status]: ${validation.success ? "SUCCESS" : "FAILED"} - ${validation.message}`);

  if (!validation.success) {
    console.error("Failed to authenticate credentials. Stopping execution.");
    return;
  }

  console.log(`\n[2/4] Fetching live market tickers from Binance Testnet...`);
  const tickerStartTime = Date.now();
  const tickers = await adapter.fetchMarketData();
  const tickerLatency = Date.now() - tickerStartTime;
  console.log(`Retrieved ${tickers.length} USDT market tickers in ${tickerLatency}ms.`);
  
  if (tickers.length > 0) {
    console.log(`Sample Ticker (${tickers[0].symbol}): Price=$${tickers[0].price}, 24h Change=${tickers[0].priceChangePercent24h}%, 24h Vol=$${tickers[0].quoteVolume24h}`);
  }

  console.log(`\n[3/4] Running multi-pass Technical Analysis engine...`);
  const analysisStartTime = Date.now();
  const topCandidates = await analyzeMarket(tickers, adapter);
  const analysisLatency = Date.now() - analysisStartTime;
  console.log(`Analysis engine completed in ${analysisLatency}ms.`);

  console.log(`\n[4/4] Top 10 Shortlisted Trading Candidates:`);
  console.log("-------------------------------------------------------------------------------------------------------------");
  console.log(
    "Rank | Symbol    | Price ($)     | 24h Change (%) | 24h Vol ($)   | Score    | Timeframe | Side"
  );
  console.log("-------------------------------------------------------------------------------------------------------------");

  topCandidates.forEach((c) => {
    const rankStr = String(c.rank).padStart(4, " ");
    const symStr = c.symbol.padEnd(9, " ");
    const priceStr = String(c.price.toFixed(4)).padEnd(13, " ");
    const changeStr = (c.priceChangePercent24h >= 0 ? `+${c.priceChangePercent24h.toFixed(2)}` : c.priceChangePercent24h.toFixed(2)).padEnd(14, " ");
    const volStr = c.quoteVolume24h.toLocaleString("en-US", { maximumFractionDigits: 0 }).padEnd(13, " ");
    const scoreStr = String(c.score.toFixed(2)).padEnd(8, " ");
    const tfStr = c.recommendedTimeframe.padEnd(9, " ");
    const sideStr = c.tradeSide;

    console.log(`${rankStr} | ${symStr} | ${priceStr} | ${changeStr} | ${volStr} | ${scoreStr} | ${tfStr} | ${sideStr}`);
  });

  console.log("-------------------------------------------------------------------------------------------------------------");
  console.log("\nFull Candidate JSON Output:");
  console.log(JSON.stringify(topCandidates, null, 2));
}

runMarketAnalysisPipeline();
