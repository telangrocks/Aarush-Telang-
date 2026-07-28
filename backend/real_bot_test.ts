import { BinanceExchange } from "./src/exchanges/BinanceExchange.ts";

async function runRealBotLogic() {
    console.log("=== STARTING REAL BOT LOGIC TEST ===");
    const apiKey = "bc0Pl4acHDlW9QVnnIPucuFlnb1zZOwh3Q2DNaELX0d5xV9y22ECxPQYjENsp7hZ";
    const apiSecret = "1vZKvoLrsdeBMlgiWoJTNYlpUACZZK6oLXiYLnOLjkACidQLzzPPqsmoBFCzqsfj";
    
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

    // 3. Place OCO Order
    console.log("\n[3] Executing bot logic: placeOcoOrder()...");
    console.log("Attempting to place a BUY OCO Order on BTCUSDT...");
    // Mock prices for OCO: current price ~60000. Take profit at 61000, Stop loss at 59000
    const ocoResult = await exchange.placeOcoOrder(
        "BTC", 
        "BUY", 
        apiKey, 
        apiSecret, 
        0.01, // quantity
        61000, // takeProfitPrice
        59000  // stopLossPrice
    );
    console.log("\nOCO Order Result:", ocoResult);
}

runRealBotLogic();
