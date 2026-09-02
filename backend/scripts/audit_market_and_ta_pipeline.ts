import { encrypt } from '../src/crypto';

interface TARuntimeProof {
  strategy: string;
  price: string;
  rsi: number;
  ema9: number;
  ema21: number;
  ema50: number;
  ema200: number;
  atr: number;
  vwap: number;
  score: number;
  signal: string;
}

const BASE_URL = 'http://127.0.0.1:8787';

async function auditMarketAndTAPipeline() {
  console.log('================================================================================');
  console.log('   LIVE MARKET DATA & TECHNICAL ANALYSIS PIPELINE FORENSIC AUDIT');
  console.log('================================================================================');
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const encryptionKey = 'test_encryption_key_minimum_32_characters_for_audit!';
  const testUser = {
    email: `ta_audit_${Date.now()}@cryptopulse.test`,
    password: 'Password123!',
    confirmPassword: 'Password123!'
  };

  // 1. Register & Login
  const regRes = await fetch(`${BASE_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testUser)
  });
  const regData = await regRes.json() as any;
  const token = regData.accessToken;

  // Extract user ID from JWT payload
  const tokenPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
  const userId = tokenPayload.sub;
  console.log(`Registered user: ${userId}, Token: ${token.substring(0, 15)}...`);

  // 2. Connect user to Bybit in local D1 (simulate valid connected exchange)
  console.log('\nConfiguring user exchange connection for live market data...');
  const encKey = await encrypt('test_bybit_api_key_public_sample', encryptionKey);
  const encSecret = await encrypt('test_bybit_api_secret_sample', encryptionKey);

  const { execSync } = await import('child_process');
  execSync(`npx wrangler d1 execute crypto_pulse_db --local --command "UPDATE users SET exchange_name = 'bybit', exchange_environment = 'mainnet', exchange_connection_status = 'CONNECTED', exchange_api_key_iv = '${encKey.iv}', exchange_api_key_encrypted = '${encKey.encrypted}', exchange_api_key_salt = '${encKey.salt}', exchange_api_secret_iv = '${encSecret.iv}', exchange_api_secret_encrypted = '${encSecret.encrypted}', exchange_api_secret_salt = '${encSecret.salt}' WHERE id = '${userId}';"`, { cwd: process.cwd() });
  console.log('User exchange status updated to CONNECTED.');

  // 3. Test Ticker
  console.log('\n[A] Testing /api/market/ticker?symbol=BTCUSDT...');
  const tickerRes = await fetch(`${BASE_URL}/api/market/ticker?symbol=BTCUSDT`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const tickerData = await tickerRes.json() as any;
  console.log('Ticker Response:', tickerData);

  // 4. Test Klines
  console.log('\n[B] Testing /api/market/klines?symbol=BTCUSDT&interval=15m...');
  const klinesRes = await fetch(`${BASE_URL}/api/market/klines?symbol=BTCUSDT&interval=15m&limit=20`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const klinesData = await klinesRes.json() as any;
  console.log('Klines Count:', Array.isArray(klinesData) ? klinesData.length : (klinesData?.data?.length || 0));

  // 5. Test Candidates
  console.log('\n[C] Testing /api/market/candidates...');
  const candRes = await fetch(`${BASE_URL}/api/market/candidates`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const candData = await candRes.json() as any;
  console.log('Candidates Count:', Array.isArray(candData) ? candData.length : (candData?.candidates?.length || Array.isArray(candData?.data) ? candData.data.length : 'Object'));

  // 6. Test Technical Analysis across all 5 Strategies on Live Data
  console.log('\n[D] Testing /api/market/technical-analysis across all 5 strategies...');
  const strategies = ['ScalperV2', 'Momentum', 'Breakout', 'MeanReversion', 'VWAP'];
  const taProofs: TARuntimeProof[] = [];

  for (let i = 0; i < strategies.length; i++) {
    const strat = strategies[i];
    console.log(`\nEvaluating Strategy [${i + 1}/5]: ${strat}...`);
    const taRes = await fetch(`${BASE_URL}/api/market/technical-analysis`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        symbol: 'BTC/USDT',
        strategy: strat
      })
    });
    const taData = await taRes.json() as any;
    console.log(`Status: ${taRes.status}`, JSON.stringify(taData).substring(0, 200));

    if (taData?.indicators || taData?.data?.indicators) {
      const ind = taData.indicators || taData.data.indicators;
      const d = taData.data || taData;
      taProofs.push({
        strategy: strat,
        price: `$${d.currentPrice || d.price || tickerData?.price || tickerData?.data?.price || 0}`,
        rsi: Number(ind.rsi?.toFixed(2) ?? 0),
        ema9: Number(ind.ema9?.toFixed(2) ?? 0),
        ema21: Number(ind.ema21?.toFixed(2) ?? 0),
        ema50: Number(ind.ema50?.toFixed(2) ?? 0),
        ema200: Number(ind.ema200?.toFixed(2) ?? 0),
        atr: Number(ind.atr?.toFixed(2) ?? 0),
        vwap: Number(ind.vwap?.toFixed(2) ?? 0),
        score: d.confidence ?? d.score ?? 0,
        signal: d.signal || 'HOLD'
      });
    }
  }

  // Summary
  console.log('\n================================================================================');
  console.log('               TECHNICAL ANALYSIS LIVE PROOFS TABLE');
  console.log('================================================================================');
  console.table(taProofs);
}

auditMarketAndTAPipeline().catch(err => {
  console.error('Fatal error during TA and Market audit:', err);
  process.exit(1);
});
