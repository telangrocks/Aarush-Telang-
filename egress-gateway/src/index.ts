import { Hono } from "hono";
import { serve } from "@hono/node-server";

const ALLOWED_HOSTS = new Set([
  "api.binance.com",
  "api1.binance.com",
  "api2.binance.com",
  "api3.binance.com",
  "api4.binance.com",
  "testnet.binance.vision",
  "api.bybit.com",
  "api-testnet.bybit.com",
  "api-demo.bybit.com",
  "api.kucoin.com",
  "api-futures.kucoin.com"
]);

export function createEgressGatewayApp(overrideSecret?: string) {
  const app = new Hono<{ Bindings: { EGRESS_PROXY_SECRET?: string } }>();

  // Health check endpoint
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      gateway: "CryptoPulse Egress Gateway",
      timestamp: new Date().toISOString()
    });
  });

  // Forwarding endpoint
  app.post("/forward", async (c) => {
    const proxySecret = overrideSecret || c.env?.EGRESS_PROXY_SECRET || (globalThis as any).process?.env?.EGRESS_PROXY_SECRET || "crypto-pulse-egress-secret-2026";
    // 1. Authenticate Cloudflare Worker token
    const authToken = c.req.header("X-Egress-Auth-Token");
    if (!authToken || authToken !== proxySecret) {
      return c.json({ success: false, error: "Unauthorized gateway request" }, 401);
    }

    // 2. Parse request payload
    let payload: { targetUrl?: string; method?: string; headers?: Record<string, string>; body?: string };
    try {
      payload = await c.req.json();
    } catch (_) {
      return c.json({ success: false, error: "Invalid JSON payload" }, 400);
    }

    const { targetUrl, method = "GET", headers = {}, body } = payload;
    if (!targetUrl) {
      return c.json({ success: false, error: "Missing targetUrl" }, 400);
    }

    // 3. SSRF & Host Whitelist Validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (_) {
      return c.json({ success: false, error: "Invalid targetUrl format" }, 400);
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    if (!ALLOWED_HOSTS.has(hostname)) {
      console.warn(`[EGRESS GATEWAY] Blocked unauthorized target host: ${hostname}`);
      return c.json({ success: false, error: `Forbidden target host: ${hostname}` }, 403);
    }

    // 4. Sanitize headers (remove host, content-length override)
    const sanitizedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (lower !== "host" && lower !== "content-length" && lower !== "x-egress-auth-token") {
        sanitizedHeaders[k] = v;
      }
    }

    // Safe structured logging (Zero credential leakage)
    const safePath = parsedUrl.pathname;
    console.log(`[EGRESS GATEWAY] Forwarding ${method.toUpperCase()} to https://${hostname}${safePath}`);

    // 5. Execute outbound fetch from Egress Gateway IP
    try {
      const startTime = Date.now();
      const outboundRes = await fetch(targetUrl, {
        method: method.toUpperCase(),
        headers: sanitizedHeaders,
        body: (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD") ? undefined : body,
      });

      const responseStatus = outboundRes.status;
      const responseText = await outboundRes.text();
      const responseHeaders: Record<string, string> = {};
      
      outboundRes.headers.forEach((val, key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey === "content-type" || lowerKey === "x-result-biz-code" || lowerKey === "kc-deny-0x0103") {
          responseHeaders[key] = val;
        }
      });

      console.log(`[EGRESS GATEWAY] Completed ${hostname}${safePath} -> Status: ${responseStatus} (${Date.now() - startTime}ms)`);

      return c.json({
        success: responseStatus < 400,
        status: responseStatus,
        headers: responseHeaders,
        body: responseText
      }, 200);

    } catch (err: any) {
      console.error(`[EGRESS GATEWAY] Outbound fetch error for ${hostname}:`, err.message);
      return c.json({
        success: false,
        status: 502,
        error: `Gateway egress error: ${err.message}`
      }, 502);
    }
  });

  return app;
}

// Start standalone server if executed directly
if (typeof process !== "undefined" && process.argv && process.argv[1] && process.argv[1].includes("index")) {
  const port = parseInt(process.env.PORT || "8080", 10);
  const app = createEgressGatewayApp();
  console.log(`[EGRESS GATEWAY] Server listening on port ${port}...`);
  serve({ fetch: app.fetch, port });
}

export default createEgressGatewayApp();
