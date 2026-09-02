interface EndpointTestResult {
  endpoint: string;
  method: string;
  httpStatus: number;
  expectedStatus: number | number[];
  success: boolean;
  responseSnippet: string;
  notes?: string;
}

const results: EndpointTestResult[] = [];
const BASE_URL = 'http://127.0.0.1:8787';

async function testWranglerRuntime() {
  console.log('================================================================================');
  console.log('   WRANGLER RUNTIME ENDPOINT & ARCHITECTURAL VERIFICATION SUITE');
  console.log('================================================================================');
  console.log(`Target Base URL: ${BASE_URL}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  let authToken: string | null = null;
  const testUser = {
    email: `audit_user_${Date.now()}@cryptopulse.test`,
    password: 'Password123!',
    confirmPassword: 'Password123!'
  };

  // Helper for requests
  async function apiRequest(
    method: string,
    path: string,
    body?: any,
    token?: string | null
  ): Promise<{ status: number; data: any; raw: string }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'CryptoPulse-Audit-Harness/1.0',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const res = await fetch(`${BASE_URL}${path}`, {
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
      return { status: res.status, data, raw };
    } catch (err: any) {
      return { status: 0, data: null, raw: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // 1. HEALTH & DB STATUS ENDPOINTS
  // ---------------------------------------------------------------------------
  console.log('\n[1] Testing Health & Database Verification Endpoints...');
  const healthRes = await apiRequest('GET', '/health');
  console.log(`Health Status: ${healthRes.status}`, healthRes.data);
  results.push({
    endpoint: '/health',
    method: 'GET',
    httpStatus: healthRes.status,
    expectedStatus: 200,
    success: healthRes.status === 200 && healthRes.data?.status === 'ok',
    responseSnippet: JSON.stringify(healthRes.data).substring(0, 100),
  });

  const dbRes = await apiRequest('GET', '/db-status');
  console.log(`DB Status: ${dbRes.status}`, dbRes.data);
  results.push({
    endpoint: '/db-status',
    method: 'GET',
    httpStatus: dbRes.status,
    expectedStatus: 200,
    success: dbRes.status === 200 && dbRes.data?.status === 'ok',
    responseSnippet: JSON.stringify(dbRes.data).substring(0, 100),
  });

  // ---------------------------------------------------------------------------
  // 2. AUTHENTICATION & SESSION PIPELINE
  // ---------------------------------------------------------------------------
  console.log('\n[2] Testing Authentication & Session Pipeline...');
  
  // Register User
  console.log(`Registering new audit user: ${testUser.email}...`);
  const regRes = await apiRequest('POST', '/api/register', testUser);
  console.log(`Register Status: ${regRes.status}`, regRes.data);
  authToken = regRes.data?.token || regRes.data?.accessToken || null;
  results.push({
    endpoint: '/api/register',
    method: 'POST',
    httpStatus: regRes.status,
    expectedStatus: [200, 201],
    success: (regRes.status === 200 || regRes.status === 201) && !!authToken,
    responseSnippet: JSON.stringify(regRes.data).substring(0, 100),
  });

  // Login User
  console.log(`Logging in audit user...`);
  const loginRes = await apiRequest('POST', '/api/login', {
    email: testUser.email,
    password: testUser.password
  });
  console.log(`Login Status: ${loginRes.status}`, loginRes.data);
  if (!authToken) {
    authToken = loginRes.data?.token || loginRes.data?.accessToken || null;
  }
  console.log(`Received JWT Auth Token: ${authToken ? authToken.substring(0, 20) + '...' : 'NONE'}`);
  results.push({
    endpoint: '/api/login',
    method: 'POST',
    httpStatus: loginRes.status,
    expectedStatus: 200,
    success: loginRes.status === 200 && !!authToken,
    responseSnippet: JSON.stringify(loginRes.data).substring(0, 100),
  });

  // Authenticated Profile /api/profile
  if (authToken) {
    const profileRes = await apiRequest('GET', '/api/profile', undefined, authToken);
    console.log(`Auth Profile /api/profile Status: ${profileRes.status}`, profileRes.data);
    results.push({
      endpoint: '/api/profile',
      method: 'GET',
      httpStatus: profileRes.status,
      expectedStatus: 200,
      success: profileRes.status === 200,
      responseSnippet: JSON.stringify(profileRes.data).substring(0, 100),
    });
  }

  // ---------------------------------------------------------------------------
  // 3. STRATEGIES REGISTRY ENDPOINT
  // ---------------------------------------------------------------------------
  console.log('\n[3] Testing Strategies Registry Endpoint...');
  const stratRes = await apiRequest('GET', '/api/strategies', undefined, authToken);
  console.log(`Strategies Status: ${stratRes.status}`, stratRes.data);
  const stratsList = Array.isArray(stratRes.data) ? stratRes.data : (Array.isArray(stratRes.data?.strategies) ? stratRes.data.strategies : []);
  results.push({
    endpoint: '/api/strategies',
    method: 'GET',
    httpStatus: stratRes.status,
    expectedStatus: 200,
    success: stratRes.status === 200 && stratsList.length >= 5,
    responseSnippet: JSON.stringify(stratRes.data).substring(0, 100),
    notes: `Found ${stratsList.length} strategies: ${stratsList.map((s: any) => s.id || s.name).join(', ')}`
  });

  // ---------------------------------------------------------------------------
  // 4. TRADING BOT DURABLE OBJECT ACTIVATION & LIFECYCLE
  // ---------------------------------------------------------------------------
  console.log('\n[4] Testing Trading Bot DO Lifecycle (Activate, Status, Alerts, Deactivate)...');
  
  // Bot Status
  const statusRes = await apiRequest('GET', '/api/trading-bot/status', undefined, authToken);
  console.log(`Bot Status: ${statusRes.status}`, statusRes.data);
  results.push({
    endpoint: '/api/trading-bot/status',
    method: 'GET',
    httpStatus: statusRes.status,
    expectedStatus: 200,
    success: statusRes.status === 200,
    responseSnippet: JSON.stringify(statusRes.data).substring(0, 100),
  });

  // Bot Alerts Fetch
  const alertsRes = await apiRequest('GET', '/api/trading-bot/alerts', undefined, authToken);
  console.log(`Bot Alerts Status: ${alertsRes.status}`, alertsRes.data);
  results.push({
    endpoint: '/api/trading-bot/alerts',
    method: 'GET',
    httpStatus: alertsRes.status,
    expectedStatus: 200,
    success: alertsRes.status === 200,
    responseSnippet: JSON.stringify(alertsRes.data).substring(0, 100),
  });

  // ---------------------------------------------------------------------------
  // 5. TRADE EXECUTION PIPELINE & MOCK TRADE RUNTIME
  // ---------------------------------------------------------------------------
  console.log('\n[5] Testing Trade Execution Safety & Mock Trade with Live Bybit Price...');
  
  const testAlertId = 'audit_alert_' + Date.now();
  // Valid Mock Trade (TP above current market price, SL below current market price for BUY)
  console.log(`Testing Mock Trade Execution for ${testAlertId}...`);
  const mockRes = await apiRequest('POST', '/api/trading-bot/mock-trade', {
    alertId: testAlertId,
    symbol: 'BTC/USDT',
    side: 'BUY',
    orderType: 'MARKET',
    targetEntryPrice: 77500,
    signalPrice: 77500,
    stopLoss: 74000,
    takeProfit: 85000,
    positionSizeUsdt: 100,
    strategy: 'ScalperV2'
  }, authToken);
  console.log(`Mock Trade Status: ${mockRes.status}`, mockRes.data);
  results.push({
    endpoint: '/api/trading-bot/mock-trade',
    method: 'POST',
    httpStatus: mockRes.status,
    expectedStatus: 200,
    success: mockRes.status === 200 && (mockRes.data?.success === true || mockRes.data?.isFilled === true),
    responseSnippet: JSON.stringify(mockRes.data).substring(0, 100),
    notes: `Position ID: ${mockRes.data?.positionId}, Fill Price: $${mockRes.data?.actualFillPrice}`
  });

  // Invalid SL/TP Rejection Test (Safety Gate Invariant)
  console.log(`Testing Safety Gate Rejection for Invalid SL/TP...`);
  const invalidMockRes = await apiRequest('POST', '/api/trading-bot/mock-trade', {
    alertId: 'invalid_' + testAlertId,
    symbol: 'BTC/USDT',
    side: 'BUY',
    orderType: 'MARKET',
    targetEntryPrice: 77500,
    signalPrice: 77500,
    stopLoss: 85000, // Invalid: SL above entry for BUY
    takeProfit: 70000, // Invalid: TP below entry for BUY
    positionSizeUsdt: 100,
    strategy: 'ScalperV2'
  }, authToken);
  console.log(`Invalid Mock Trade Status: ${invalidMockRes.status}`, invalidMockRes.data);
  results.push({
    endpoint: '/api/trading-bot/mock-trade (Invalid SL/TP Gate)',
    method: 'POST',
    httpStatus: invalidMockRes.status,
    expectedStatus: 400,
    success: invalidMockRes.status === 400,
    responseSnippet: JSON.stringify(invalidMockRes.data).substring(0, 100),
    notes: 'Correctly rejected unsafe SL/TP parameters.'
  });

  // Deactivate Bot
  const deactRes = await apiRequest('POST', '/api/trading-bot/deactivate', undefined, authToken);
  console.log(`Deactivate Status: ${deactRes.status}`, deactRes.data);
  results.push({
    endpoint: '/api/trading-bot/deactivate',
    method: 'POST',
    httpStatus: deactRes.status,
    expectedStatus: 200,
    success: deactRes.status === 200,
    responseSnippet: JSON.stringify(deactRes.data).substring(0, 100),
  });

  // ---------------------------------------------------------------------------
  // 6. SECURITY & ERROR HANDLING VERIFICATION
  // ---------------------------------------------------------------------------
  console.log('\n[6] Testing Security & Unauthenticated Access Rejection...');
  
  // Unauthenticated access to protected route
  const unauthRes = await apiRequest('GET', '/api/trading-bot/status', undefined, null);
  console.log(`Unauthenticated Request Status: ${unauthRes.status}`, unauthRes.data);
  results.push({
    endpoint: '/api/trading-bot/status (No Token)',
    method: 'GET',
    httpStatus: unauthRes.status,
    expectedStatus: 401,
    success: unauthRes.status === 401,
    responseSnippet: JSON.stringify(unauthRes.data).substring(0, 100),
  });

  // Invalid Token
  const badTokenRes = await apiRequest('GET', '/api/trading-bot/status', undefined, 'invalid.jwt.token');
  console.log(`Bad Token Request Status: ${badTokenRes.status}`, badTokenRes.data);
  results.push({
    endpoint: '/api/trading-bot/status (Bad Token)',
    method: 'GET',
    httpStatus: badTokenRes.status,
    expectedStatus: [401, 403],
    success: badTokenRes.status === 401 || badTokenRes.status === 403,
    responseSnippet: JSON.stringify(badTokenRes.data).substring(0, 100),
  });

  // ---------------------------------------------------------------------------
  // SUMMARY TABLE
  // ---------------------------------------------------------------------------
  console.log('\n================================================================================');
  console.log('                 WRANGLER RUNTIME ENDPOINT AUDIT RESULTS');
  console.log('================================================================================');
  console.table(results.map(r => ({
    Endpoint: `${r.method} ${r.endpoint}`,
    Status: r.httpStatus,
    Expected: Array.isArray(r.expectedStatus) ? r.expectedStatus.join('/') : r.expectedStatus,
    Passed: r.success ? 'YES' : 'NO',
    Snippet: r.responseSnippet
  })));

  const allPassed = results.every(r => r.success);
  console.log(`\nOverall Wrangler Runtime Status: ${allPassed ? 'ALL TESTS PASSED (100%)' : 'SOME TESTS FAILED'}`);
}

testWranglerRuntime().catch(err => {
  console.error('Fatal error during Wrangler runtime testing:', err);
  process.exit(1);
});
