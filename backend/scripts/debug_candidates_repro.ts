import { execSync } from 'child_process';

async function run() {
  const email = 'audit_debug_' + Date.now() + '@cryptopulse.test';
  console.log('Registering user:', email);
  const regRes = await fetch('https://crypto-pulse-backend.telangrocks.workers.dev/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Password123!', confirmPassword: 'Password123!' })
  });
  const regData = await regRes.json() as any;
  const token = regData.accessToken;
  const userId = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString()).sub;
  console.log('User registered ID:', userId);

  execSync(`npx wrangler d1 execute crypto_pulse_db --remote --command="UPDATE users SET exchange_name = 'bybit', exchange_environment = 'mainnet', exchange_connection_status = 'CONNECTED' WHERE id = '${userId}';"`, { stdio: 'inherit' });
  console.log('User exchange connected in D1.');

  const candRes = await fetch('https://crypto-pulse-backend.telangrocks.workers.dev/api/market/candidates', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const candidates = await candRes.json() as any[];
  console.log('--- /api/market/candidates ---');
  console.log('Returned candidates count:', candidates?.length);
  if (Array.isArray(candidates)) {
    candidates.forEach((c, idx) => {
      console.log(`[#${idx+1}] id: ${c.opportunityId || c.id} | symbol: ${c.symbol} | pairName: ${c.pairName} | score: ${c.score} | rank: ${c.rank} | side: ${c.tradeSide} | strat: ${c.recommendedStrategy}`);
    });
  } else {
    console.log('Response was not an array:', candidates);
  }

  console.log('\n--- /api/market/opportunities ---');
  const oppRes = await fetch('https://crypto-pulse-backend.telangrocks.workers.dev/api/market/opportunities?limit=10', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const oppData = await oppRes.json() as any;
  console.log('Opps success:', oppData?.success);
  console.log('Total qualified count:', oppData?.universe?.qualifiedOpportunityCount);
  console.log('Returned opportunities count:', oppData?.opportunities?.length);
  if (Array.isArray(oppData?.opportunities)) {
    oppData.opportunities.forEach((o: any, idx: number) => {
      console.log(`[#${idx+1}] ${o.opportunityId} | symbol: ${o.symbol} | dir: ${o.dominantDirection} | score: ${o.opportunityScore} | rank: ${o.currentRank}`);
    });
  }

  execSync(`npx wrangler d1 execute crypto_pulse_db --remote --command="DELETE FROM users WHERE id = '${userId}';"`, { stdio: 'inherit' });
  console.log('Cleanup done.');
}

run().catch(console.error);
