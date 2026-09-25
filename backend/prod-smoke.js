const URL = 'https://crypto-pulse-backend.telangrocks.workers.dev';

async function run() {
  console.log("Registering test user...");
  const email = 'testagent_' + Date.now() + '@example.com';
  const regRes = await fetch(`${URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: "Password1!", confirmPassword: "Password1!", name: "Test Agent" })
  });
  console.log("Register:", regRes.status);

  console.log("Logging in...");
  const loginRes = await fetch(`${URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: "Password1!" })
  });
  
  if (loginRes.status !== 200) {
      console.log("Failed login:", loginRes.status, await loginRes.text());
      return;
  }
  
  const data = await loginRes.json();
  const token = data.accessToken || data.token;
  console.log("Got token.");
  
  const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
  };

  console.log("\nTesting Bot Activation...");
  const actRes = await fetch(`${URL}/api/trading-bot/activate`, { method: 'POST', headers, body: JSON.stringify({ coinId: 'BTCUSDT', strategy: 'ScalperV2' }) });
  console.log("Activate:", actRes.status, await actRes.text());

  console.log("\nTesting Analysis Status...");
  const statRes = await fetch(`${URL}/api/trading-bot/analysis-status`, { method: 'GET', headers });
  console.log("Status:", statRes.status, await statRes.text());

  console.log("\nTesting Trigger Alert...");
  const triggerRes = await fetch(`${URL}/api/trading-bot/trigger-alert`, { method: 'POST', headers, body: JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY' }) });
  console.log("Trigger:", triggerRes.status, await triggerRes.text());

  console.log("\nTesting Bot Deactivation...");
  const deactRes = await fetch(`${URL}/api/trading-bot/deactivate`, { method: 'POST', headers });
  console.log("Deactivate:", deactRes.status, await deactRes.text());

}
run().catch(console.error);
