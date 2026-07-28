
const express = require("express");
const { BinanceExchange } = require("./dist/exchanges/BinanceExchange.js");

const app = express();

app.get("/verify", async (req, res) => {
    const exchange = new BinanceExchange("testnet", "global");
    const result = await exchange.validateCredentials("dummy_api_key", "dummy_secret_key");
    res.json(result);
});

const server = app.listen(3000, async () => {
    console.log("VPS server running on port 3000");
    try {
        const response = await fetch("http://localhost:3000/verify");
        const data = await response.json();
        console.log("Response from VPS deployment:", JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Fetch failed", e);
    }
    server.close();
});

