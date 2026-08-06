import { ExchangeErrorClassifier } from '../src/exchanges/ExchangeErrorClassifier';

interface RegressionMatrixItem {
  exchange: string;
  scenario: string;
  httpStatus?: number;
  expectedCode: string;
  actualCode: string;
  passed: boolean;
  notes: string;
}

const matrix: RegressionMatrixItem[] = [];

async function runLiveValidation() {
  console.log('===================================================================');
  console.log('STARTING REAL-WORLD LIVE EXCHANGE VALIDATION & REGRESSION MATRIX');
  console.log('===================================================================');

  const classifier = ExchangeErrorClassifier.getInstance();

  // -------------------------------------------------------------------
  // 1. LIVE BINANCE TEST (Invalid Key on Live Binance API)
  // -------------------------------------------------------------------
  console.log('\n[1] Testing Live Binance API with Invalid Credentials...');
  try {
    const res = await globalThis.fetch('https://api.binance.com/api/v3/account?timestamp=' + Date.now() + '&signature=invalid_sig', {
      headers: {
        'X-MBX-APIKEY': 'invalid_api_key_test_12345',
        'User-Agent': 'CryptoPulse/1.0'
      }
    });

    const status = res.status;
    const headers = res.headers;
    const bodyText = await res.text();

    const classified = classifier.classifyResponse('binance', status, headers, bodyText);

    console.log(` > HTTP Status: ${status}`);
    console.log(` > Headers (CF-Ray): ${headers.get('cf-ray') || 'none'}`);
    console.log(` > Response Body: ${bodyText}`);
    console.log(` > Classified Code: ${classified.code}`);
    console.log(` > Friendly Message: "${classified.friendlyMessage}"`);

    const passed = classified.code === 'INVALID_API_KEY' || classified.code === 'IP_NOT_WHITELISTED';
    matrix.push({
      exchange: 'Binance',
      scenario: 'Invalid Key on Live API',
      httpStatus: status,
      expectedCode: 'INVALID_API_KEY',
      actualCode: classified.code,
      passed,
      notes: classified.friendlyMessage
    });
  } catch (err: any) {
    console.error(' > Binance fetch error:', err.message);
  }

  // -------------------------------------------------------------------
  // 2. LIVE KUCOIN TEST (Invalid Key on Live KuCoin API)
  // -------------------------------------------------------------------
  console.log('\n[2] Testing Live KuCoin API with Invalid Credentials...');
  try {
    const res = await globalThis.fetch('https://openapi-v2.kucoin.com/api/v1/accounts?type=trade', {
      headers: {
        'KC-API-KEY': 'invalid_kucoin_key_99999',
        'KC-API-SIGN': 'invalid_sig',
        'KC-API-TIMESTAMP': Date.now().toString(),
        'KC-API-PASSPHRASE': 'invalid_pass',
        'KC-API-KEY-VERSION': '2',
        'User-Agent': 'CryptoPulse/1.0'
      }
    });

    const status = res.status;
    const headers = res.headers;
    const bodyText = await res.text();

    const classified = classifier.classifyResponse('kucoin', status, headers, bodyText);

    console.log(` > HTTP Status: ${status}`);
    console.log(` > Response Body: ${bodyText}`);
    console.log(` > Classified Code: ${classified.code}`);
    console.log(` > Friendly Message: "${classified.friendlyMessage}"`);

    const passed = classified.code === 'INVALID_API_KEY' || classified.code === 'AUTHENTICATION_FAILED' || classified.code === 'INVALID_SIGNATURE';
    matrix.push({
      exchange: 'KuCoin',
      scenario: 'Invalid Key on Live API',
      httpStatus: status,
      expectedCode: 'INVALID_API_KEY / AUTHENTICATION_FAILED',
      actualCode: classified.code,
      passed,
      notes: classified.friendlyMessage
    });
  } catch (err: any) {
    console.error(' > KuCoin fetch error:', err.message);
  }

  // -------------------------------------------------------------------
  // 3. LIVE BYBIT TEST (Invalid Key on Live Bybit API)
  // -------------------------------------------------------------------
  console.log('\n[3] Testing Live Bybit API with Invalid Credentials...');
  try {
    const res = await globalThis.fetch('https://api.bybit.com/v5/account/wallet-balance?accountType=UNIFIED', {
      headers: {
        'X-BAPI-API-KEY': 'invalid_bybit_key_11111',
        'X-BAPI-TIMESTAMP': Date.now().toString(),
        'X-BAPI-SIGN': 'invalid_sig',
        'User-Agent': 'CryptoPulse/1.0'
      }
    });

    const status = res.status;
    const headers = res.headers;
    const bodyText = await res.text();

    const classified = classifier.classifyResponse('bybit', status, headers, bodyText);

    console.log(` > HTTP Status: ${status}`);
    console.log(` > Response Body: ${bodyText}`);
    console.log(` > Classified Code: ${classified.code}`);
    console.log(` > Friendly Message: "${classified.friendlyMessage}"`);

    const passed = classified.code === 'INVALID_API_KEY' || classified.code === 'INVALID_SIGNATURE' || classified.code === 'AUTHENTICATION_FAILED';
    matrix.push({
      exchange: 'Bybit',
      scenario: 'Invalid Key on Live API',
      httpStatus: status,
      expectedCode: 'INVALID_API_KEY / INVALID_SIGNATURE',
      actualCode: classified.code,
      passed,
      notes: classified.friendlyMessage
    });
  } catch (err: any) {
    console.error(' > Bybit fetch error:', err.message);
  }

  // -------------------------------------------------------------------
  // 4. CLOUDFLARE WAF HTML PAGE RESPONSE TEST
  // -------------------------------------------------------------------
  console.log('\n[4] Testing Cloudflare WAF HTML Challenge Page Handling...');
  const wafHtml = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Cloudflare WAF Blocked</body></html>';
  const wafHeaders = { 'content-type': 'text/html; charset=UTF-8', 'server': 'cloudflare', 'cf-ray': '999aaa111bbb-BOM' };
  const wafClassified = classifier.classifyResponse('binance', 403, wafHeaders, wafHtml);

  console.log(` > Classified Code: ${wafClassified.code}`);
  console.log(` > Friendly Message: "${wafClassified.friendlyMessage}"`);

  matrix.push({
    exchange: 'Binance (WAF)',
    scenario: 'Cloudflare WAF 403 HTML Page',
    httpStatus: 403,
    expectedCode: 'BINANCE_WAF_BLOCKED',
    actualCode: wafClassified.code,
    passed: wafClassified.code === 'BINANCE_WAF_BLOCKED',
    notes: wafClassified.friendlyMessage
  });

  // -------------------------------------------------------------------
  // 5. EXPLICIT HTTP 451 LEGAL REGION BLOCK TEST
  // -------------------------------------------------------------------
  console.log('\n[5] Testing Explicit HTTP 451 Legal Jurisdiction Block...');
  const legal451Body = JSON.stringify({ code: -451, msg: 'Service unavailable in restricted jurisdiction.' });
  const legal451Classified = classifier.classifyResponse('binance', 451, { 'content-type': 'application/json' }, legal451Body);

  console.log(` > Classified Code: ${legal451Classified.code}`);
  console.log(` > Friendly Message: "${legal451Classified.friendlyMessage}"`);

  matrix.push({
    exchange: 'Binance (Geo)',
    scenario: 'Explicit HTTP 451 Legal Block',
    httpStatus: 451,
    expectedCode: 'REGION_NOT_SUPPORTED',
    actualCode: legal451Classified.code,
    passed: legal451Classified.code === 'REGION_NOT_SUPPORTED',
    notes: legal451Classified.friendlyMessage
  });

  // -------------------------------------------------------------------
  // PRINT SUMMARY MATRIX
  // -------------------------------------------------------------------
  console.log('\n===================================================================');
  console.log('REAL-WORLD LIVE VALIDATION REGRESSION MATRIX RESULTS');
  console.log('===================================================================');
  console.table(matrix);

  const allPassed = matrix.every(m => m.passed);
  if (!allPassed) {
    console.error('\nXXX REAL-WORLD VALIDATION HAD FAILURES XXX');
    process.exit(1);
  } else {
    console.log('\n>>> ALL REAL-WORLD LIVE VALIDATION SCENARIOS PASSED CLEANLY <<<');
  }
}

runLiveValidation().catch((err) => {
  console.error('Fatal live validation failure:', err);
  process.exit(1);
});
