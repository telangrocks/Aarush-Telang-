import { BinanceExchange } from "./src/exchanges/BinanceExchange";
import { analyzeMarket } from "./src/market-analysis";

async function runRealBotLogic() {
    console.log("=== STARTING REAL BOT LOGIC TEST WITH SPOT TESTNET KEYS ===");
    
    // The keys provided by the user (with the corrected uppercase 'S')
    const apiKey = "o1lGAij4iQDD2PDsOvCeBExnpTWXMDyAiboPAScolnw0feUD5dWOITa8GzyXAJe7";
    const apiSecret = "So9UBSv1Fcn89F1gY43U62p6NlzmaingQdnMpeLaGehq7xZrc5Fa78tEL7H28nzV";
    
    // 1. Initialize Bot Exchange (Testnet)
    const exchange = new BinanceExchange("testnet", "global");
    console.log("\n[1] Bot Initialized. Environment: Testnet");

    // 2. Validate Credentials
    console.log("\n[2] Executing bot logic: validateCredentials()...");
    const validationResult = await exchange.validateCredentials(apiKey, apiSecret);
    console.log("Validation Result:", validationResult);

    if (!validationResult.success) {
        console.log("Stopping execution because credentials failed validation.");
        return;
    }

    // 3. Fetch Top 10 Trading Pairs (Market Analysis)
    console.log("\n[3] Executing bot logic: fetchMarketData() and analyzeMarket()...");
    const tickers = await exchange.fetchMarketData();
    console.log(`Fetched ${tickers.length} tickers from Binance Spot Testnet.`);
    
    console.log("Running technical analysis to rank top 10 pairs...");
    const topPairs = await analyzeMarket(tickers, exchange);
    
    console.log("\n=== TOP 10 CANDIDATE PAIRS ===");
    topPairs.forEach((pair, index) => {
        console.log(`${index + 1}. ${(pair as any).symbol} - Trade: ${pair.tradeSide} | Score: ${pair.score.toFixed(2)} | 24h Vol: $${(pair as any).quoteVolume24h.toFixed(2)} | Price: ${(pair as any).price}`);
    });
}

runRealBotLogic();
