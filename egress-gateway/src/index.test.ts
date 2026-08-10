import test from "node:test";
import assert from "node:assert";
import { createEgressGatewayApp } from "./index.js";

test("Egress Gateway Unit Tests", async (t) => {
  const secret = "test-secret-12345";
  const app = createEgressGatewayApp(secret);

  await t.test("Health check endpoint returns ok", async () => {
    const res = await app.request("/health");
    assert.strictEqual(res.status, 200);
    const json: any = await res.json();
    assert.strictEqual(json.status, "ok");
  });

  await t.test("Reject unauthenticated request without token", async () => {
    const res = await app.request("/forward", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl: "https://api.binance.com/api/v3/time" })
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test("Reject request with invalid secret token", async () => {
    const res = await app.request("/forward", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Egress-Auth-Token": "wrong-secret"
      },
      body: JSON.stringify({ targetUrl: "https://api.binance.com/api/v3/time" })
    });
    assert.strictEqual(res.status, 401);
  });

  await t.test("Reject non-whitelisted destination host (SSRF protection)", async () => {
    const res = await app.request("/forward", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Egress-Auth-Token": secret
      },
      body: JSON.stringify({ targetUrl: "https://malicious-site.com/steal-data" })
    });
    assert.strictEqual(res.status, 403);
    const json: any = await res.json();
    assert.strictEqual(json.success, false);
    assert.match(json.error, /Forbidden target host/);
  });

  await t.test("Allow whitelisted destination host (binance public time)", async () => {
    const res = await app.request("/forward", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Egress-Auth-Token": secret
      },
      body: JSON.stringify({ targetUrl: "https://api.binance.com/api/v3/time", method: "GET" })
    });
    assert.strictEqual(res.status, 200);
    const json: any = await res.json();
    assert.strictEqual(json.success, true);
    assert.strictEqual(json.status, 200);
    assert.ok(json.body.includes("serverTime"));
  });
});
