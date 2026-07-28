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

const key = "o1lGAij4iQDD2PDsOvCeBExnpTWXMDyAiboPAScolnw0feUD5dWOITa8GzyXAJe7";
const secret = "so9UBSv1Fcn89F1gY43U62p6NlzmaingQdnMpeLaGehq7xZrc5Fa78tEL7H28nzV";

async function run() {
    await testRequest("Testnet Spot (Old Key)", "https://testnet.binance.vision", "/api/v3/account", key, secret);
}
run();
