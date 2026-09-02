const PROD_URL = 'https://crypto-pulse-backend.telangrocks.workers.dev';

async function testDeployedProductionWorker() {
  console.log('================================================================================');
  console.log('   DEPLOYED CLOUDFLARE PRODUCTION WORKER FORENSIC VERIFICATION');
  console.log('================================================================================');
  console.log(`Target Production URL: ${PROD_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  const results: any[] = [];

  async function prodFetch(method: string, path: string, body?: any, token?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'CryptoPulse-Production-Audit-Harness/1.0',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch(`${PROD_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const raw = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
      return { status: res.status, data, raw, headers: Object.fromEntries(res.headers.entries()) };
    } catch (err: any) {
      return { status: 0, data: null, raw: err.message, headers: {} };
    }
  }

  // 1. Production /health
  console.log('\n[1] Probing Production /health...');
  const healthRes = await prodFetch('GET', '/health');
  console.log('Production Health Status:', healthRes.status, healthRes.data);
  results.push({
    endpoint: 'GET /health',
    status: healthRes.status,
    response: JSON.stringify(healthRes.data).substring(0, 120),
    cfRay: healthRes.headers['cf-ray'] || 'none',
    server: healthRes.headers['server'] || 'cloudflare'
  });

  // 2. Production /db-status
  console.log('\n[2] Probing Production /db-status...');
  const dbRes = await prodFetch('GET', '/db-status');
  console.log('Production DB Status:', dbRes.status, dbRes.data);
  results.push({
    endpoint: 'GET /db-status',
    status: dbRes.status,
    response: JSON.stringify(dbRes.data).substring(0, 120),
    cfRay: dbRes.headers['cf-ray'] || 'none'
  });

  // 3. Production /api/strategies
  console.log('\n[3] Probing Production /api/strategies (Public / Protected check)...');
  const stratRes = await prodFetch('GET', '/api/strategies');
  console.log('Production Strategies Status:', stratRes.status, stratRes.data);
  results.push({
    endpoint: 'GET /api/strategies (No Auth)',
    status: stratRes.status,
    response: JSON.stringify(stratRes.data).substring(0, 120)
  });

  // 4. Production Registration / Login / Auth
  console.log('\n[4] Testing Production Authentication Pipeline...');
  const testUser = {
    email: `prod_audit_${Date.now()}@cryptopulse.test`,
    password: 'Password123!',
    confirmPassword: 'Password123!'
  };

  const regRes = await prodFetch('POST', '/api/register', testUser);
  console.log('Production Register Status:', regRes.status, regRes.data);
  const token = regRes.data?.accessToken;
  results.push({
    endpoint: 'POST /api/register',
    status: regRes.status,
    response: JSON.stringify(regRes.data).substring(0, 120)
  });

  if (token) {
    console.log(`Successfully obtained Production JWT Token (${token.substring(0, 15)}...)`);
    
    // 5. Authenticated Strategies
    const authStratRes = await prodFetch('GET', '/api/strategies', undefined, token);
    console.log('Production Authenticated Strategies:', authStratRes.status, authStratRes.data?.count || authStratRes.data?.length);
    results.push({
      endpoint: 'GET /api/strategies (Authenticated)',
      status: authStratRes.status,
      response: `Strategies Count: ${authStratRes.data?.count || authStratRes.data?.length}`
    });

    // 6. Authenticated Profile
    const profileRes = await prodFetch('GET', '/api/profile', undefined, token);
    console.log('Production Profile:', profileRes.status, profileRes.data?.email);
    results.push({
      endpoint: 'GET /api/profile',
      status: profileRes.status,
      response: JSON.stringify(profileRes.data).substring(0, 120)
    });

    // 7. Authenticated Bot Status (Durable Object probe)
    const botStatusRes = await prodFetch('GET', '/api/trading-bot/status', undefined, token);
    console.log('Production Bot Status:', botStatusRes.status, botStatusRes.data);
    results.push({
      endpoint: 'GET /api/trading-bot/status',
      status: botStatusRes.status,
      response: JSON.stringify(botStatusRes.data).substring(0, 120)
    });
  }

  console.log('\n================================================================================');
  console.log('             DEPLOYED PRODUCTION WORKER RESULTS');
  console.log('================================================================================');
  console.table(results);
}

testDeployedProductionWorker().catch(err => {
  console.error('Fatal error probing production worker:', err);
});
