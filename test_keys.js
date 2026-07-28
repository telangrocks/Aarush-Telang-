const crypto = require("crypto");

async function hmacSha256(message, secret) {
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

async function testRequest(testName, baseUrl, endpoint, apiKey, apiSecret) {
    const timestamp = Date.now();
    const recvWindow = 10000;
    const query = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
    const signature = await hmacSha256(query, apiSecret);
    
    const url = `${baseUrl}${endpoint}?${query}&signature=${signature}`;
    
    const headers = {
        "X-MBX-APIKEY": apiKey,
        "User-Agent": "CryptoPulse/1.0",
        "Content-Type": "application/json"
    };
    
    console.log(`\n=== ${testName} ===`);
    try {
        const response = await fetch(url, { headers });
        console.log(`Response Status: ${response.status}`);
        const body = await response.text();
        console.log(`Response Body: ${body.substring(0, 200)}`);
    } catch (e) {
        console.error("Fetch failed:", e.message);
    }
}

const key = "bc0Pl4acHDlW9QVnnIPucuFlnb1zZOwh3Q2DNaELX0d5xV9y22ECxPQYjENsp7hZ";
const secret = "1vZKvoLrsdeBMlgiWoJTNYlpUACZZK6oLXiYLnOLjkACidQLzzPPqsmoBFCzqsfj";

async function run() {
    await testRequest("Mainnet Spot", "https://api.binance.com", "/api/v3/account", key, secret);
    await testRequest("Mainnet Futures", "https://fapi.binance.com", "/fapi/v2/account", key, secret);
    await testRequest("Testnet Spot", "https://testnet.binance.vision", "/api/v3/account", key, secret);
    await testRequest("Testnet Futures", "https://testnet.binancefuture.com", "/fapi/v2/account", key, secret);
}
run();
