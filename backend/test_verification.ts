
import { BinanceExchange } from "./src/exchanges/BinanceExchange.ts";

const originalFetch = globalThis.fetch;

async function runTest(name, userAgent) {
    console.log(`\n\n========== ${name} ==========`);
    
    // Monkey patch fetch to intercept requests and log them
    globalThis.fetch = async (url, options) => {
        const reqHeaders = new Headers(options.headers);
        if (userAgent !== undefined) {
            reqHeaders.set("User-Agent", userAgent);
        }
        
        console.log(`\n[HTTP REQUEST]`);
        console.log(`URL: ${url}`);
        console.log(`Method: ${options.method || "GET"}`);
        console.log(`Headers:`);
        reqHeaders.forEach((v, k) => console.log(`  ${k}: ${v}`));
        
        const response = await originalFetch(url, { ...options, headers: reqHeaders });
        
        const clone = response.clone();
        const body = await clone.text();
        
        console.log(`\n[HTTP RESPONSE]`);
        console.log(`Status: ${response.status}`);
        console.log(`Headers:`);
        response.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
        console.log(`Body: ${body}`);
        
        return response;
    };

    const exchange = new BinanceExchange("testnet", "global");
    const result = await exchange.validateCredentials("dummy_api_key", "dummy_secret_key");
    console.log(`\n[FINAL CLASSIFICATION]`, JSON.stringify(result, null, 2));
}

async function main() {
    await runTest("TEST A - Current Implementation (No User-Agent)", undefined);
    await runTest("TEST B - Fixed Implementation (User-Agent: CryptoPulse/1.0)", "CryptoPulse/1.0");
}
main();

