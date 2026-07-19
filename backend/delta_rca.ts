import * as crypto from "crypto";

async function hmacSha256(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function testDelta(endpointUrl: string, apiKey: string, apiSecret: string) {
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const requestPath = "/v2/wallet/balances";
    const query = `timestamp=${timestamp}`;
    const prehash = "GET" + timestamp + requestPath + "?" + query;
    const signature = await hmacSha256(prehash, apiSecret);

    const response = await fetch(`${endpointUrl}${requestPath}?${query}`, {
      headers: {
        "api-key": apiKey,
        "signature": signature,
        "timestamp": timestamp,
      },
    });

    const body = await response.text();
    console.log(`Endpoint: ${endpointUrl}`);
    console.log(`Status: ${response.status}`);
    console.log(`Response: ${body}\n`);
  } catch (err: any) {
    console.log(`Error on ${endpointUrl}: ${err.message}\n`);
  }
}

async function run() {
  const apiKey = "6nSTYeTLdrXD9v6uGsUCy2lCxAfII2";
  const apiSecret = "LzIopliomk8pKMPQrcNF5caoGQadgz4VTDXfvmeM91IFpjK9E09xFHFDgktw";
  
  await testDelta("https://api.delta.exchange", apiKey, apiSecret);
  await testDelta("https://api.india.delta.exchange", apiKey, apiSecret);
}

run();
