import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { encrypt } from "./crypto";

export interface Env {
  DB: D1Database;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  PRICE_CACHE: KVNamespace;
  TRADING_BOTS: DurableObjectNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// Apply security headers and CORS middleware to all routes
app.use("*", secureHeaders());
app.use("*", cors());

// ==========================================
// PUBLIC ENDPOINTS
// ==========================================
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "Crypto Pulse Backend",
    timestamp: new Date().toISOString(),
  });
});

app.get("/db-status", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").run();
    return c.json({ status: "ok", message: "Database connection successful" });
  } catch (e) {
    console.error("DB connection failed:", e);
    c.status(500);
    return c.json({ status: "error", message: "Database connection failed" });
  }
});

// ==========================================
// PROTECTED API ROUTES
// ==========================================
const api = new Hono<{ Bindings: Env }>();

// JWT Middleware with proper error handling
api.use("*", (c, next) => {
  const jwtMiddleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "auth_token",
    alg: "HS256",
  });
  return jwtMiddleware(c, next);
});

api.get("/watchlist", async (c) => {
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM watchlist WHERE user_id = ? ORDER BY added_at DESC",
  )
    .bind(userId)
    .all();

  return c.json(results);
});

api.post("/watchlist", async (c) => {
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;
  const { token_id } = await c.req.json<{ token_id: string }>();

  await c.env.DB.prepare(
    "INSERT INTO watchlist (id, user_id, token_id, added_at) VALUES (?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), userId, token_id, new Date().toISOString())
    .run();

  return c.json({ success: true, token_id });
});

api.delete("/watchlist/:id", async (c) => {
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;
  const itemId = c.req.param("id");

  await c.env.DB.prepare("DELETE FROM watchlist WHERE id = ? AND user_id = ?")
    .bind(itemId, userId)
    .run();

  return c.json({ success: true });
});

api.post("/alerts", async (c) => {
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;
  const { token_id, target_price, condition } = await c.req.json<{
    token_id: string;
    target_price: number;
    condition: "ABOVE" | "BELOW";
  }>();

  await c.env.DB.prepare(
    "INSERT INTO price_alerts (id, user_id, token_id, target_price, condition, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      userId,
      token_id,
      target_price,
      condition,
      new Date().toISOString(),
    )
    .run();

  return c.json({ success: true, token_id });
});

api.post("/exchange/keys", async (c) => {
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;
  const { apiKey, apiSecret } = await c.req.json<{
    apiKey: string;
    apiSecret: string;
  }>();
  const encryptedSecret = await encrypt(apiSecret, c.env.ENCRYPTION_KEY);

  await c.env.DB.prepare(
    "UPDATE users SET exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ? WHERE id = ?",
  )
    .bind(apiKey, encryptedSecret.iv, encryptedSecret.encrypted, userId)
    .run();

  return c.json({ success: true });
});

// This is the crucial fix for the 404 errors.
// It registers the protected 'api' router with the main app.
app.route("/api", api);

// ==========================================
// SCHEDULED HANDLER
// ==========================================
const scheduled = async (
  _event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext,
) => {
  ctx.waitUntil(
    (async () => {
      console.log("Starting alert processing...");
      const { results } = await env.DB.prepare(
        "SELECT * FROM price_alerts WHERE triggered = 0",
      ).all();
      if (!results || results.length === 0) {
        console.log("No active alerts to process.");
        return;
      }
      // ... processing logic
    })(),
  );
};

export default {
  fetch: app.fetch,
  scheduled,
};

// Generic error handler
app.onError((err, c) => {
  console.error(`${err}`);
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  c.status(500);
  return c.json({ error: "Internal Server Error", message: err.message });
});

// 404 Handler
app.notFound((c) => {
  c.status(404);
  return c.json({
    error: "Not Found",
    message: `Endpoint '${c.req.path}' not found.`,
  });
});
