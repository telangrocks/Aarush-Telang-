const crypto = require('crypto');

async function hmacSha256Base64(message, secret) {
    return crypto.createHmac("sha256", secret).update(message).digest("base64");
}

async function testKucoin() {
    const apiKey = "dummy_key";
    const apiSecret = "dummy_secret";
    const apiPassphrase = "dummy_passphrase";

    const timestamp = Date.now().toString();
    const method = 'GET';
    const endpoint = '/api/v1/accounts';
    const bodyStr = '';
    const message = timestamp + method + endpoint + bodyStr;

    const signature = await hmacSha256Base64(message, apiSecret);
    let passphraseSignature = '';
    if (apiPassphrase) {
        passphraseSignature = await hmacSha256Base64(apiPassphrase, apiSecret);
    }

    const headers = {
        'KC-API-KEY': apiKey,
        'KC-API-SIGN': signature,
        'KC-API-TIMESTAMP': timestamp,
        'KC-API-KEY-VERSION': '2',
        'Content-Type': 'application/json'
    };
    if (passphraseSignature) {
        headers['KC-API-PASSPHRASE'] = passphraseSignature;
    }

    console.log("Headers:", headers);
    try {
        const response = await fetch(`https://api.kucoin.com${endpoint}`, { headers });
        const text = await response.text();
        console.log(`Response Status: ${response.status}`);
        console.log(`Response Body: ${text}`);
    } catch (e) {
        console.error("Fetch failed:", e);
    }
}
testKucoin();
