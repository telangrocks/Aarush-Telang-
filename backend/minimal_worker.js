
export default {
  async fetch(request, env, ctx) {
    let result = {};
    try {
      const timeRes = await fetch("https://api.binance.com/api/v3/time");
      const timeBody = await timeRes.text();
      result.time = { status: timeRes.status, body: timeBody };
      
      const accountRes = await fetch("https://testnet.binance.vision/api/v3/account?recvWindow=10000&timestamp=123456789&signature=dummy", {
          headers: { "X-MBX-APIKEY": "dummy_key_123" }
      });
      const accountBody = await accountRes.text();
      const headers = {};
      accountRes.headers.forEach((v, k) => headers[k] = v);
      result.account = { status: accountRes.status, headers, body: accountBody };
    } catch (e) {
      result.error = e.message;
    }
    return new Response(JSON.stringify(result, null, 2), { headers: { "Content-Type": "application/json" } });
  }
}

