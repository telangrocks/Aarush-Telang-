const fetch = require('node:fetch');

async function runSmokeTests() {
  const targetUrl = process.env.URL || 'http://localhost:8787';
  console.log(`Running smoke tests against ${targetUrl}...`);

  let hasErrors = false;

  const endpoints = [
    '/health',
    '/db-status',
    '/api/prices'
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${targetUrl}${endpoint}`);
      if (res.ok) {
        console.log(`✅ GET ${endpoint} - ${res.status} OK`);
      } else {
        console.error(`❌ GET ${endpoint} - Failed with status ${res.status}`);
        hasErrors = true;
      }
    } catch (err) {
      console.error(`❌ GET ${endpoint} - Request error: ${err.message}`);
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.error('Smoke tests failed!');
    process.exit(1);
  } else {
    console.log('All smoke tests passed successfully!');
    process.exit(0);
  }
}

runSmokeTests();
