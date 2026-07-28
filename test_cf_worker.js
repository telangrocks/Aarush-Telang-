async function testBackend() {
  const url = 'https://crypto-pulse-backend.telangrocks.workers.dev/api/exchange/validate';
  const payload = {
    exchangeName: "kucoin",
    apiKey: "dummy_key_123",
    apiSecret: "dummy_secret_123",
    apiPassphrase: "dummy_passphrase",
    environment: "mainnet"
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${text}`);
  } catch(e) {
    console.error(e);
  }
}

testBackend();
