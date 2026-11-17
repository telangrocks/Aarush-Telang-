import { Hono } from "hono";
import { cors } from "hono/cors";
import { jwt, sign as signJwt } from "hono/jwt";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import {
  handleGetProfile,
  handleLogin,
  handleRegister,
  handleResendVerification,
  handleVerifyEmail,
  handleLogout,
  handleDeleteFcmToken,
  handleForgotPassword,
  handleResetPassword,
  handleRefresh,
  handleDeleteAccount,
  handleRegisterDevice,
  handleListDevices,
  handleRemoveDevice,
  handleEnableMfa,
  handleDisableMfa,
  handleSetPin,
  handleVerifyPin,
  handleRequestPinReset,
  handleConfirmPinReset,
} from "./handlers/user";
import {
  handleValidateExchange,
  handleConnectExchange,
  handleGetExchangeStatus,
  handleGetExchangeBalances,
  handleGetPersonalizedMarketCandidates,
  handleGetMarketOpportunities,
  handleGetStrategies,
  handleGetTechnicalAnalysis,
  handleGetTicker,
  handleGetKlines,
  handleActivateTradingBot,
  handleGetTradingBotStatus,
  handleGetAnalysisStatus,
  handleExecuteTrade,
  handleMockTrade,
  handleDeactivateTradingBot,
  handleStopTradingBot,
  handleGetBotAlerts,
  handleAcknowledgeAlert,
  handleDismissAlert,
  handleGetExecutionStatus,
} from "./handlers/exchange";
import { handleRegisterFcmToken } from "./handlers/notifications";
import {
  handleGetFleetOverview,
  handleGetUsersList,
  handleGetBotFleet,
  handleGetIncidents,
  handleGetIncidentDetail,
  handleUpdateIncidentStatus,
  handleGetBotTimeline,
  handleGetComponentHealth,
  handleGetQuotaStatus,
  handleReportClientIncident,
} from "./handlers/admin-monitoring";
import {
  adminAuthMiddleware,
  handleAdminLogin,
  handleCreateActivationToken,
  handleActivateDevice,
  handleRefreshDeviceSession,
  handleRevokeDeviceSession,
} from "./infrastructure/monitoring/AdminAuth";

import { isTokenRevoked } from "./handlers/auth";
import { chatWithKimiK3 } from "./services/kimi";
import { LruTtlCache } from "./infrastructure/cache/LruTtlCache";
import {
  bindTelemetryEnv,
  checkStagingExchangeEnvironment,
  createScopedTelemetryEmitter,
  flushTelemetry,
  runWithTelemetryContext,
  validateStagingIsolationEnv,
} from "./infrastructure/monitoring/PipelineTelemetry";

export interface Env {
  DB: D1Database;
  ENCRYPTION_KEY: string;
  JWT_SECRET: string;
  RESEND_API_KEY: string;
  RESEND_FROM_EMAIL?: string;
  ALLOWED_ORIGINS: string;
  FCM_SERVER_KEY?: string;
  FCM_PROJECT_ID?: string;
  FCM_CLIENT_EMAIL?: string;
  GLOBAL_TRADING_HALT?: string;
  FCM_PRIVATE_KEY?: string;
  TRADING_BOTS: DurableObjectNamespace;
  PUBLIC_MARKET_COORDINATOR?: DurableObjectNamespace;
  /** Workers AI binding — used to call Moonshot AI Kimi K3 (moonshotai/kimi-k3). Optional so non-AI routes/tests don't require it. */
  AI?: Ai;
  ENVIRONMENT?: string;
  SIGNAL_MANAGER_MODE?: string;
  /** Explicit staging-only exchange isolation constraint (e.g. "demo"); never set in production. */
  STAGING_ISOLATION_MODE?: string;
  ADMIN_API_KEY?: string;
  ADMIN_EMAILS?: string;
  ADMIN_PASSWORD_HASH?: string;
  TELEMETRY_QUEUE?: Queue<any>;
  MONITOR_INGEST_SERVICE?: Fetcher;
  MONITORING_SERVICE?: Fetcher;
  /** Shared secret for queue-free service-binding telemetry ingest (staging/monitoring only). */
  INTERNAL_INGEST_SECRET?: string;
}

function validateEnv(env: Env): void {
  const missing: string[] = [];
  if (!env.JWT_SECRET || typeof env.JWT_SECRET !== "string") {
    missing.push("JWT_SECRET");
  } else if (env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters long");
  }
  if (!env.DB) {
    missing.push("DB");
  }
  if (!env.ENCRYPTION_KEY || typeof env.ENCRYPTION_KEY !== "string") {
    missing.push("ENCRYPTION_KEY");
  } else if (env.ENCRYPTION_KEY.length < 32) {
    throw new Error("ENCRYPTION_KEY must be at least 32 characters long");
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

function validateCorsOrigins(origins: string[]): void {
  for (const origin of origins) {
    if (origin === "*") {
      throw new Error("Wildcard origin (*) is not allowed in ALLOWED_ORIGINS");
    }
    if (origin.startsWith("http://") && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
      throw new Error(`Non-localhost HTTP origin is not allowed: ${origin}. Use HTTPS in production.`);
    }
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
  validateCorsOrigins(allowedOrigins);
  const middleware = cors({
    origin: allowedOrigins,
    credentials: true,
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Admin-Key",
      "X-CryptoPulse-Admin",
      "X-Device-Session",
      "X-Correlation-Id",
    ],
    exposeHeaders: [
      "X-Empty-Reason",
      "X-Eligible-Market-Count",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  return middleware(c, next);
});

// ==========================================
// PUBLIC ENDPOINTS
// ==========================================
const jsonEndpoints = ["/api/register", "/api/login", "/api/resend-verification", "/api/verify-email", "/api/forgot-password", "/api/reset-password", "/api/refresh", "/api/verify-pin", "/api/reset-pin", "/api/confirm-pin-reset"];

app.get("/health", (c) => {
  const stagingCfg = validateStagingIsolationEnv(c.env);
  if (stagingCfg.isStaging && !stagingCfg.valid) {
    c.status(stagingCfg.status as any);
    return c.json({
      status: "error",
      code: stagingCfg.code,
      error: stagingCfg.error,
      message: stagingCfg.error,
    });
  }
  return c.json({
    status: "ok",
    service: "Crypto Pulse Backend",
    environment: c.env?.ENVIRONMENT || "production",
    stagingIsolationMode: c.env?.STAGING_ISOLATION_MODE || null,
    timestamp: new Date().toISOString(),
  });
});

app.use("*", async (c, next) => {
  const stagingCfg = validateStagingIsolationEnv(c.env);
  if (stagingCfg.isStaging && !stagingCfg.valid) {
    c.status(stagingCfg.status as any);
    return c.json({
      success: false,
      code: stagingCfg.code,
      error: stagingCfg.error,
      message: stagingCfg.error,
    });
  }
  if (
    c.req.method === "POST" &&
    jsonEndpoints.some((ep) => c.req.path.endsWith(ep))
  ) {
    const contentType = c.req.header("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      c.status(415);
      return c.json({
        error: "Unsupported Media Type",
        message: "Content-Type must be application/json",
      });
    }
  }
  bindTelemetryEnv(c.env, "crypto-pulse-backend");
  const reqEmitter = createScopedTelemetryEmitter("crypto-pulse-backend", c.env);
  return runWithTelemetryContext(
    { environment: c.env?.ENVIRONMENT, emitter: reqEmitter },
    async () => {
      try {
        await next();
      } finally {
        flushTelemetry((p) => {
          try {
            c.executionCtx.waitUntil(p);
          } catch {}
        }, reqEmitter);
      }
    }
  );
});

const DB_STATUS_CACHE = new LruTtlCache<string, { status: string; message: string; tablesChecked: string[] }>(5, 60_000);

app.get("/db-status", async (c) => {
  const cached = DB_STATUS_CACHE.get("status");
  if (cached) {
    return c.json(cached);
  }

  try {
    await c.env.DB.prepare("SELECT 1").run();
    const requiredTables = [
      "users",
      "watchlist",
      "portfolio_transactions",
      "jwt_blacklist",
      "refresh_tokens",
      "login_attempts",
      "registration_attempts",
      "password_reset_tokens",
      "audit_log",
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

    const result = {
      status: "ok",
      message: "Database connection successful",
      tablesChecked: requiredTables,
    };
    DB_STATUS_CACHE.set("status", result);
    return c.json(result);
  } catch (err: unknown) {
    const error = err as Error;
    console.error("Database connection check failed:", error);
    c.status(500);
    return c.json({
      status: "error",
      message: "Database connection failed",
      details: error.message,
    });
  }
});

// Chat with Kimi K3 (moonshotai/kimi-k3 via Workers AI)
app.post("/api/chat", async (c) => {
  try {
    const body = await c.req.json<any>();
    if (!c.env.AI) {
      c.status(503);
      return c.json({ error: "AI service binding unavailable" });
    }
    const result = await chatWithKimiK3(c.env.AI, body);
    return c.json(result);
  } catch (err: any) {
    c.status(500);
    return c.json({ error: err?.message || String(err) });
  }
});

// User routes (some are public, some need JWT)
const api = new Hono<{ Bindings: Env }>();

const PUBLIC_AUTH_PATHS = new Set([
  "/api/register",
  "/api/login",
  "/api/resend-verification",
  "/api/verify-email",
  "/api/refresh",
  "/api/forgot-password",
  "/api/reset-password",
  "/api/verify-pin",
  "/api/reset-pin",
  "/api/confirm-pin-reset",
]);

api.use("*", async (c, next) => {
  const incomingCorrId = c.req.header("x-correlation-id") || c.req.header("cf-ray") || crypto.randomUUID();
  c.set("correlationId" as any, incomingCorrId);
  c.header("X-Correlation-Id", incomingCorrId);
  await next();
});

api.use("*", (c, next) => {
  if (c.req.path.startsWith("/api/admin") || PUBLIC_AUTH_PATHS.has(c.req.path)) {
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
  if (c.req.path.startsWith("/api/admin") || PUBLIC_AUTH_PATHS.has(c.req.path)) {
    return next();
  }
  const payload = c.get("jwtPayload") as { sub: string; jti?: string; type?: string } | undefined;
  if (payload?.type && payload.type !== "access") {
    c.status(401);
    return c.json({ error: "Invalid token type. Access token required." });
  }
  const isHighStakes =
    c.req.path.includes("/execute-trade") ||
    c.req.path.includes("/credentials") ||
    c.req.path.includes("/password") ||
    c.req.path.includes("/exchange/connect") ||
    c.req.path.includes("/trading-bot/activate") ||
    c.req.path.includes("/trading-bot/deactivate") ||
    c.req.path.includes("/account") ||
    c.req.path.includes("/set-pin") ||
    c.req.path.includes("/mfa/disable");
  try {
    if (payload?.jti && await isTokenRevoked(c, payload.jti, { failClosed: isHighStakes })) {
      c.status(401);
      return c.json({ error: "Token has been revoked" });
    }
  } catch (_err) {
    if (isHighStakes) {
      c.status(503);
      return c.json({ error: "Authentication verification service temporarily unavailable. Operation locked for safety." });
    }
  }
  await next();
});

// Staging-only exchange environment isolation guard (no-op in production where STAGING_ISOLATION_MODE is unset)
api.use("*", async (c, next) => {
  const stagingCfg = validateStagingIsolationEnv(c.env);
  if (!stagingCfg.isStaging) {
    return await next();
  }
  if (!stagingCfg.valid) {
    c.status(stagingCfg.status as any);
    return c.json({
      success: false,
      code: stagingCfg.code,
      error: stagingCfg.error,
      message: stagingCfg.error,
    });
  }

  const subPath = c.req.path.replace(/^\/api/, "");
  const isExchangeOrMarketOrBot =
    subPath.startsWith("/exchange/") ||
    subPath.startsWith("/market/") ||
    subPath.startsWith("/trading-bot/");

  if (isExchangeOrMarketOrBot) {
    const queryEnv = c.req.query("environment");
    if (queryEnv !== undefined) {
      const qCheck = checkStagingExchangeEnvironment(c.env, queryEnv);
      if (!qCheck.allowed) {
        c.status(qCheck.status as any);
        return c.json({ success: false, code: qCheck.code, error: qCheck.error, message: qCheck.error });
      }
    }
    const headerEnv = c.req.header("x-exchange-environment");
    if (headerEnv !== undefined) {
      const hCheck = checkStagingExchangeEnvironment(c.env, headerEnv);
      if (!hCheck.allowed) {
        c.status(hCheck.status as any);
        return c.json({ success: false, code: hCheck.code, error: hCheck.error, message: hCheck.error });
      }
    }

    if (c.req.method === "POST" && (subPath === "/exchange/validate" || subPath === "/exchange/connect")) {
      const rawBody = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
      const bodyEnvCheck = checkStagingExchangeEnvironment(c.env, rawBody?.environment);
      if (!bodyEnvCheck.allowed) {
        c.status(bodyEnvCheck.status as any);
        return c.json({
          success: false,
          code: bodyEnvCheck.code,
          error: bodyEnvCheck.error,
          message: bodyEnvCheck.error,
        });
      }
    } else if (c.req.method === "POST" && subPath === "/trading-bot/activate") {
      const rawBody = await c.req.raw.clone().json().catch(() => null) as Record<string, any> | null;
      if (rawBody?.config && "environment" in rawBody.config) {
        const cfgEnvCheck = checkStagingExchangeEnvironment(c.env, rawBody.config.environment);
        if (!cfgEnvCheck.allowed) {
          c.status(cfgEnvCheck.status as any);
          return c.json({
            success: false,
            code: cfgEnvCheck.code,
            error: cfgEnvCheck.error,
            message: cfgEnvCheck.error,
          });
        }
      }
    }

    if (
      subPath !== "/exchange/validate" &&
      subPath !== "/exchange/connect" &&
      subPath !== "/market/strategies" &&
      c.env.DB
    ) {
      const payload = c.get("jwtPayload") as { sub?: string } | undefined;
      if (payload?.sub) {
        const userRow = await c.env.DB.prepare(
          "SELECT exchange_name, exchange_environment FROM users WHERE id = ?"
        )
          .bind(payload.sub)
          .first<{ exchange_name: string | null; exchange_environment: string | null }>()
          .catch(() => null);
        if (userRow?.exchange_name) {
          const storedEnvCheck = checkStagingExchangeEnvironment(c.env, userRow.exchange_environment);
          if (!storedEnvCheck.allowed) {
            c.status(storedEnvCheck.status as any);
            return c.json({
              success: false,
              code: storedEnvCheck.code,
              error: storedEnvCheck.error,
              message: storedEnvCheck.error,
            });
          }
        }
      }
    }
  }

  return await next();
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

  if (!token_id) {
    c.status(400);
    return c.json({ error: "token_id is required" });
  }

  const id = crypto.randomUUID();
  const added_at = new Date().toISOString();

  await c.env.DB.prepare(
    "INSERT INTO watchlist (id, user_id, token_id, added_at) VALUES (?, ?, ?, ?)",
  )
    .bind(id, userId, token_id, added_at)
    .run();

  return c.json({ success: true, id, token_id });
});

api.delete("/watchlist/:id", async (c) => {
  const payload = c.get("jwtPayload") as { sub: string };
  const userId = payload.sub;
  const id = c.req.param("id");

  await c.env.DB.prepare(
    "DELETE FROM watchlist WHERE id = ? AND user_id = ?",
  )
    .bind(id, userId)
    .run();

  return c.json({ success: true });
});

// Exchange Routes
api.post("/exchange/validate", handleValidateExchange);
api.post("/exchange/connect", handleConnectExchange);
api.get("/exchange/status", handleGetExchangeStatus);
api.get("/exchange/balance", handleGetExchangeBalances);

// Market Discovery Routes
api.get("/market/candidates", handleGetPersonalizedMarketCandidates);
api.get("/market/opportunities", handleGetMarketOpportunities);
api.get("/market/strategies", handleGetStrategies);
api.get("/strategies", handleGetStrategies); // backward-compatible alias for older APK versions
api.post("/market/technical-analysis", handleGetTechnicalAnalysis);
api.get("/market/ticker", handleGetTicker);
api.get("/market/klines", handleGetKlines);

// Trading Bot Execution & Monitoring Routes
api.post("/trading-bot/activate", handleActivateTradingBot);
api.get("/trading-bot/status", handleGetTradingBotStatus);
api.get("/trading-bot/analysis-status", handleGetAnalysisStatus);
api.post("/trading-bot/execute-trade", handleExecuteTrade);
api.post("/trading-bot/mock-trade", handleMockTrade);
api.post("/trading-bot/deactivate", handleDeactivateTradingBot);
api.post("/trading-bot/stop", handleStopTradingBot);
api.get("/trading-bot/alerts", handleGetBotAlerts);
api.post("/trading-bot/alerts/:alertId/ack", handleAcknowledgeAlert);
api.post("/trading-bot/alerts/acknowledge", handleAcknowledgeAlert);
api.post("/trading-bot/alerts/:alertId/dismiss", handleDismissAlert);
api.post("/trading-bot/alerts/dismiss", handleDismissAlert);
api.get("/trading-bot/execution-status/:positionId", handleGetExecutionStatus);

// FCM token registration for push notifications
api.post("/fcm/register", handleRegisterFcmToken);
api.delete("/fcm/register", handleDeleteFcmToken);

// Authentication Routes
api.post("/register", handleRegister);
api.post("/login", handleLogin);
api.post("/resend-verification", handleResendVerification);
api.get("/verify-email", handleVerifyEmail);
api.post("/logout", handleLogout);
api.post("/forgot-password", handleForgotPassword);
api.post("/reset-password", handleResetPassword);
api.post("/refresh", handleRefresh);
api.delete("/account", handleDeleteAccount);

// Device management routes
api.post("/devices", handleRegisterDevice);
api.get("/devices", handleListDevices);
api.delete("/devices/:id", handleRemoveDevice);

// MFA routes
api.post("/mfa/enable", handleEnableMfa);
api.post("/mfa/disable", handleDisableMfa);

// PIN routes
api.post("/set-pin", handleSetPin);
api.post("/verify-pin", handleVerifyPin);
api.post("/reset-pin", handleRequestPinReset);
api.post("/confirm-pin-reset", handleConfirmPinReset);

// Client Diagnostic Telemetry (Authenticated Mobile & Web User Sessions)
api.post("/client/telemetry", handleReportClientIncident);

app.route("/api", api);

// ==========================================
// CENTRALIZED ADMIN MONITORING ROUTES
// ==========================================
const adminApi = new Hono<{ Bindings: Env }>();

// Public admin login and device enrollment
adminApi.post("/login", handleAdminLogin);
adminApi.post("/activate-device", handleActivateDevice);
adminApi.post("/session/refresh", handleRefreshDeviceSession);
adminApi.post("/session/revoke", handleRevokeDeviceSession);

// Protected monitoring endpoints (strictly guarded by adminAuthMiddleware)
adminApi.use("/monitoring/*", adminAuthMiddleware);
adminApi.post("/create-activation-token", adminAuthMiddleware, handleCreateActivationToken);

adminApi.get("/monitoring/overview", handleGetFleetOverview);
adminApi.get("/monitoring/users", handleGetUsersList);
adminApi.get("/monitoring/bots", handleGetBotFleet);
adminApi.get("/monitoring/incidents", handleGetIncidents);
adminApi.get("/monitoring/incidents/:id", handleGetIncidentDetail);
adminApi.patch("/monitoring/incidents/:id/status", handleUpdateIncidentStatus);
adminApi.get("/monitoring/timeline", handleGetBotTimeline);
adminApi.get("/monitoring/health", handleGetComponentHealth);
adminApi.get("/monitoring/quotas", handleGetQuotaStatus);
adminApi.post("/monitoring/report-incident", handleReportClientIncident);

// Strictly read-only proxy to isolated monitoring-worker v2 query API
adminApi.use("/monitor/v2/*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "OPTIONS") {
    c.status(405);
    return c.json({ error: "Method Not Allowed: monitoring API is strictly read-only", readOnly: true });
  }
  return await next();
});
adminApi.use("/monitor/v2/*", adminAuthMiddleware);
adminApi.get("/monitor/v2/*", async (c) => {
  if (!c.env.MONITORING_SERVICE) {
    c.status(503);
    return c.json({ error: "Monitoring service binding not configured" });
  }
  const url = new URL(c.req.url);
  const rewrittenPath = url.pathname.replace(/^\/api\/admin\/monitor\/v2/, "/api/monitor/v2");
  const targetUrl = `https://monitoring-worker${rewrittenPath}${url.search}`;
  const fwdHeaders = new Headers();
  const authHeader = c.req.header("Authorization");
  const adminKey = c.req.header("X-Admin-Key");
  if (authHeader) fwdHeaders.set("Authorization", authHeader);
  if (adminKey) fwdHeaders.set("X-Admin-Key", adminKey);
  if (!authHeader && !adminKey && c.env.JWT_SECRET) {
    const adminSession = (c.get as any)("adminSession");
    if (adminSession?.authMethod === "DEVICE_SESSION") {
      const nowSec = Math.floor(Date.now() / 1000);
      const delegated = await signJwt(
        {
          sub: "admin_device_owner",
          email: adminSession.email || "device@cryptopulse.internal",
          role: "ADMIN",
          monitoringScope: "OPERATOR",
          sessionId: adminSession.sessionId,
          iat: nowSec,
          exp: nowSec + 60,
        },
        c.env.JWT_SECRET,
        "HS256"
      );
      fwdHeaders.set("Authorization", `Bearer ${delegated}`);
    }
  }
  return c.env.MONITORING_SERVICE.fetch(targetUrl, {
    method: "GET",
    headers: fwdHeaders,
  });
});
adminApi.all("/monitor/v2/*", (c) => {
  c.status(405);
  return c.json({ error: "Method Not Allowed: monitoring API is strictly read-only", readOnly: true });
});

app.route("/api/admin", adminApi);

export default app;

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
export { PublicMarketDataCoordinator } from "./infrastructure/market-data/PublicMarketDataCoordinator";
export interface Env { USE_NEW_ENGINE?: string; }
