
const crypto = require("crypto");

async function hmacSha256(message, secret) {
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

async function testRequest(testName, userAgent) {
    const timestamp = Date.now();
    const recvWindow = 10000;
    const query = `recvWindow=${recvWindow}&timestamp=${timestamp}`;
    const signature = await hmacSha256(query, "dummy_secret_123");
    
    const url = `https://api.binance.com/api/v3/account?${query}&signature=${signature}`;
    
    const headers = {
        "X-MBX-APIKEY": "dummy_key_123"
    };
    if (userAgent !== undefined) {
        headers["User-Agent"] = userAgent;
    }
    
    console.log(`\n=== ${testName} ===`);
    console.log(`URL: ${url.split("?")[0]}`);
    console.log(`Method: GET`);
    console.log(`Query string: ${query}&signature=${signature.substring(0, 10)}...`);
    console.log(`Headers:`, headers);
    
    try {
        const response = await fetch(url, { headers });
        console.log(`\nResponse Status: ${response.status}`);
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) {
            responseHeaders[key] = value;
        }
        console.log(`Response Headers:`, responseHeaders);
        const body = await response.text();
        console.log(`Response Body: ${body}`);
    } catch (e) {
        console.error("Fetch failed:", e.message);
    }
}

async function run() {
    await testRequest("Test A (Current Implementation - Empty or Default CF Worker)", "Cloudflare-Workers");
    await testRequest("Test B (With User-Agent: CryptoPulse/1.0)", "CryptoPulse/1.0");
}
run();

