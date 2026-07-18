import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt } from "hono/jwt";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import {
  handleGetProfile,
  handleLogin,
  handleRegister,
  handleResendOtp,
  handleVerifyOtp,
  handleLogout,
  handleDeleteFcmToken,
} from "./handlers/user";
import {
  handleValidateExchange,
  handleConnectExchange,
  handleGetExchangeStatus,
  handleGetPersonalizedMarketCandidates,
  handleGetStrategies,
  handleGetTechnicalAnalysis,
  handleGetTicker,
  handleGetKlines,
  handleActivateTradingBot,
  handleGetTradingBotStatus,
  handleGetAnalysisStatus,
  handleExecuteTrade,
  handleStopTradingBot,
  handleGetBotAlerts,
  handleAcknowledgeAlert,
} from "./handlers/exchange";
import { handleRegisterFcmToken, sendPriceAlertNotification } from "./handlers/notifications";
import { handleGetPositions, handleClosePosition } from "./handlers/positions";
import { isTokenRevoked } from "./handlers/auth";
import { getExchangeAdapter, type ExchangeName, type ExchangeEnvironment, type ExchangeRegion } from "./exchanges";

export interface Env {
  DB: D1Database;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL?: string;
  AUTH_ALLOW_DEV_OTP_FALLBACK?: string;
  ALLOWED_ORIGINS: string;
  FCM_SERVER_KEY?: string;
  FCM_PROJECT_ID?: string;
  FCM_CLIENT_EMAIL?: string;
  FCM_PRIVATE_KEY?: string;
  TRADING_BOTS: DurableObjectNamespace;
}

function validateEnv(env: Env): void {
  const missing: string[] = [];
  if (!env.JWT_SECRET || typeof env.JWT_SECRET !== "string") {
    missing.push("JWT_SECRET");
  }
  if (!env.DB) {
    missing.push("DB");
  }
  if (!env.ENCRYPTION_KEY || typeof env.ENCRYPTION_KEY !== "string") {
    missing.push("ENCRYPTION_KEY");
  }
  if (!env.RESEND_API_KEY || typeof env.RESEND_API_KEY !== "string") {
    missing.push("RESEND_API_KEY");
  }
  if (!env.ALLOWED_ORIGINS || env.ALLOWED_ORIGINS.trim() === "") {
    missing.push("ALLOWED_ORIGINS");
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }
}

let envValidated = false;
function ensureEnvValidated(env: Env): void {
  if (!envValidated) {
    validateEnv(env);
    envValidated = true;
  }
}

const app = new Hono<{ Bindings: Env }>();

// Apply security headers and CORS middleware to all routes
app.use("*", secureHeaders());
app.use("*", async (c, next) => {
  ensureEnvValidated(c.env);
  const allowedOrigins = c.env.ALLOWED_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowedOrigins.length === 0) {
    c.status(500);
    return c.json({
      status: "error",
      message: "ALLOWED_ORIGINS must be configured",
    });
  }
  const middleware = cors({ origin: allowedOrigins });
  return middleware(c, next);
});

// ==========================================
// PUBLIC ENDPOINTS
// ==========================================
const jsonEndpoints = ["/api/register", "/api/login", "/api/resend-otp", "/api/verify-otp"];

app.get("/health", (c) => {
  return c.json({
    status: "ok",
    service: "Crypto Pulse Backend",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/*", async (c, next) => {
  if (c.req.method === "POST" && jsonEndpoints.includes(c.req.path)) {
    const contentType = c.req.header("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      c.status(415);
      return c.json({
        error: "Unsupported Media Type",
        message: "Content-Type must be application/json",
      });
    }
  }
  await next();
});

app.get("/db-status", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").run();
    const requiredTables = [
      "users",
      "watchlist",
      "portfolio_transactions",
      "price_alerts",
      "jwt_blacklist",
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

// JWT Middleware with proper error handling.
// NOTE: Hono applies sub-app (`api`) middleware to the parent app as well, so
// this guard would otherwise run on every /api/* route. Explicitly skip the
// public auth routes (login, register, otp, and exchange credential
// validation, which runs before a user is authenticated) so they remain
// publicly accessible while everything else requires a valid JWT.
const PUBLIC_AUTH_PATHS = new Set([
  "/api/register",
  "/api/login",
  "/api/resend-otp",
  "/api/verify-otp",
  "/api/exchange/validate",
]);

api.use("*", (c, next) => {
  if (PUBLIC_AUTH_PATHS.has(c.req.path)) {
    return next();
  }
  const jwtMiddleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "auth_token",
    headerName: "Authorization",
    alg: "HS256",
  });
  return jwtMiddleware(c, next);
});

api.use("*", async (c, next) => {
  if (PUBLIC_AUTH_PATHS.has(c.req.path)) {
    return next();
  }
  const payload = c.get("jwtPayload") as { sub: string; jti?: string } | undefined;
  if (payload?.jti && await isTokenRevoked(c, payload.jti)) {
    c.status(401);
    return c.json({ error: "Token has been revoked" });
  }
  await next();
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

  const alertId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO price_alerts (id, user_id, token_id, target_price, condition, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      alertId,
      userId,
      token_id,
      target_price,
      condition,
      new Date().toISOString(),
    )
    .run();

  return c.json({ success: true, id: alertId, token_id });
});

api.post("/exchange/validate", handleValidateExchange);

api.post("/exchange/connect", handleConnectExchange);
api.get("/exchange/status", handleGetExchangeStatus);

api.get("/market/candidates", handleGetPersonalizedMarketCandidates);

api.get("/strategies", handleGetStrategies);

api.get("/market/ticker", handleGetTicker);
api.get("/market/klines", handleGetKlines);

api.post("/market/technical-analysis", handleGetTechnicalAnalysis);

api.post("/trading-bot/activate", handleActivateTradingBot);
api.get("/trading-bot/status", handleGetTradingBotStatus);
api.get("/trading-bot/analysis-status", handleGetAnalysisStatus);
api.post("/trading-bot/execute-trade", handleExecuteTrade);
api.post("/trading-bot/stop-trade", handleStopTradingBot);
api.get("/trading-bot/alerts", handleGetBotAlerts);
api.post("/trading-bot/alerts/acknowledge", handleAcknowledgeAlert);

api.get("/positions", handleGetPositions);
api.post("/positions/:id/close", handleClosePosition);

api.post("/fcm/register", handleRegisterFcmToken);
api.delete("/fcm/register", handleDeleteFcmToken);

api.post("/logout", handleLogout);

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
        "SELECT * FROM price_alerts WHERE is_active = 1",
      ).all();
      if (!results || results.length === 0) {
        console.log("No active alerts to process.");
        return;
      }

      // Resolve each user's connected exchange + environment so price alerts
      // are checked against the correct exchange (mainnet or testnet) — never
      // hard-coded to a single venue.
      const exchangeCache = new Map<string, { name: ExchangeName; environment: ExchangeEnvironment; region: ExchangeRegion } | null>();
      for (const alert of results as any[]) {
        try {
          const tokenId = alert.token_id as string;
          const targetPrice = parseFloat(alert.target_price as string);
          const condition = alert.condition as string;
          const userId = alert.user_id as string;
          const symbol = tokenId.toUpperCase();

          let cached = exchangeCache.get(userId);
          if (cached === undefined) {
            const user = await env.DB.prepare(
              "SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?"
            ).bind(userId).first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();
            cached = user?.exchange_name
              ? {
                  name: user.exchange_name as ExchangeName,
                  environment: user.exchange_environment === "testnet" ? "testnet" : "mainnet",
                  region: user.exchange_region === "global" ? "global" : "india",
                }
              : null;
            exchangeCache.set(userId, cached);
          }

          if (!cached) {
            console.log(`Skipping price alert ${alert.id}: no exchange connected for user ${userId}`);
            continue;
          }

          const adapter = getExchangeAdapter(cached.name, cached.environment, cached.region);
          const ticker = await adapter.fetchTicker(symbol);
          if (!ticker) continue;

          const currentPrice = ticker.price;
          let triggered = false;

          if (condition === "ABOVE" && currentPrice >= targetPrice) {
            triggered = true;
          } else if (condition === "BELOW" && currentPrice <= targetPrice) {
            triggered = true;
          }

          if (triggered) {
            await env.DB.prepare(
              "UPDATE price_alerts SET is_active = 0, triggered_at = ? WHERE id = ?"
            ).bind(new Date().toISOString(), alert.id).run();
            console.log(`Alert ${alert.id} triggered for ${symbol} at ${currentPrice}`);

            await sendPriceAlertNotification(env, userId, {
              tokenId,
              targetPrice,
              condition: condition as "ABOVE" | "BELOW",
              currentPrice,
            });
          }
        } catch (err) {
          console.error("Error processing alert:", err);
        }
      }
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

export { TradingBot } from "./trading-bot";
