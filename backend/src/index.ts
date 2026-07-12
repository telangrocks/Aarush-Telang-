import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { encrypt } from "./crypto";
import {
  handleGetProfile,
  handleLogin,
  handleRegister,
  handleResendOtp,
  handleVerifyOtp,
} from "./handlers/user";
import {
  handleValidateExchange,
  handleConnectExchange,
  handleGetPersonalizedMarketCandidates,
} from "./handlers/exchange";

export interface Env {
  DB: D1Database;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL?: string;
  AUTH_ALLOW_DEV_OTP_FALLBACK?: string;
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
    const requiredTables = [
      "users",
      "watchlist",
      "portfolio_transactions",
      "price_alerts",
    ];

    const missingTables: string[] = [];
    for (const tableName of requiredTables) {
      const table = await c.env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
        .bind(tableName)
        .first<{ name: string }>();

      if (!table) {
        missingTables.push(tableName);
      }
    }

    if (missingTables.length > 0) {
      c.status(500);
      return c.json({
        status: "error",
        message: "Database schema is incomplete",
        missingTables,
      });
    }

    return c.json({
      status: "ok",
      message: "Database connection successful",
      tablesChecked: requiredTables,
    });
  } catch (e) {
    console.error("DB connection failed:", e);
    c.status(500);
    return c.json({ status: "error", message: "Database connection failed" });
  }
});

// ==========================================
// PUBLIC API ROUTES
// ==========================================
app.post("/api/register", handleRegister);
app.post("/api/resend-otp", handleResendOtp);
app.post("/api/verify-otp", handleVerifyOtp);
app.post("/api/login", handleLogin);

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

api.get("/profile", handleGetProfile);

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

api.post("/exchange/validate", handleValidateExchange);

api.post("/exchange/connect", handleConnectExchange);

api.get("/market/candidates", handleGetPersonalizedMarketCandidates);

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
