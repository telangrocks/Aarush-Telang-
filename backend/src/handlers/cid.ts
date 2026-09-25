import { Context } from "hono";
import { Env } from "../index";

const ALLOWED_ROLES = new Set(["ADMIN", "TESTER", "DEVELOPER"]);
const ALLOWED_ENVIRONMENTS = new Set(["demo", "testnet", "mainnet", "staging", "development"]);
const ALLOWED_CATEGORIES = new Set([
  "LIFECYCLE",
  "NAVIGATION",
  "NETWORK",
  "AUTH",
  "EXCHANGE",
  "BOT",
  "CRASH",
]);
const ALLOWED_SEVERITIES = new Set(["DEBUG", "INFO", "WARN", "ERROR", "CRITICAL"]);

// Finite category-specific payload schema definitions
const CATEGORY_ALLOWED_FIELDS: Record<string, Set<string>> = {
  LIFECYCLE: new Set([
    "eventType",
    "deviceModel",
    "osVersion",
    "appVersion",
    "batteryLevel",
    "memoryUsageMb",
    "cleanShutdown",
    "lastHeartbeatTimestamp",
    "gapDurationMs",
    "reason",
    "packageName",
    "pid",
  ]),
  NAVIGATION: new Set([
    "fromRoute",
    "toRoute",
    "trigger",
  ]),
  NETWORK: new Set([
    "method",
    "path",
    "statusCode",
    "durationMs",
    "contentLength",
    "cfRay",
    "error",
  ]),
  AUTH: new Set([
    "action",
    "success",
    "errorCode",
  ]),
  EXCHANGE: new Set([
    "exchangeId",
    "action",
    "status",
    "durationMs",
    "errorCode",
    "orderType",
  ]),
  BOT: new Set([
    "botId",
    "symbol",
    "strategyId",
    "cycleCount",
    "signalType",
    "marketPrice",
    "entryPrice",
    "stopLoss",
    "takeProfit",
    "score",
    "longScore",
    "shortScore",
    "overallLongScore",
    "overallShortScore",
    "confidence",
    "riskClassification",
    "rejectionReason",
    "error",
  ]),
  CRASH: new Set([
    "exceptionClass",
    "message",
    "stackTraceTop",
    "threadName",
    "fatal",
  ]),
};

// Secondary defense-in-depth blacklist
const FORBIDDEN_KEYS_LOWER = new Set([
  "apikey",
  "apisecret",
  "apipassphrase",
  "password",
  "confirmpassword",
  "accesstoken",
  "refreshtoken",
  "authorization",
  "pin",
  "recoverycode",
  "privatekey",
  "seedphrase",
  "secretkey",
  "x-bapi-api-key",
  "x-bapi-sign",
  "balance",
  "balances",
  "networth",
  "portfolio",
  "wallet",
  "wallets",
]);

const MAX_BATCH_SIZE = 50;
const MAX_PAYLOAD_BYTES = 8192; // 8KB UTF-8
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function containsForbiddenKeys(obj: unknown): boolean {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => containsForbiddenKeys(item));
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const cleanKey = key.toLowerCase().replace(/[-_]/g, "");
    if (FORBIDDEN_KEYS_LOWER.has(cleanKey)) {
      return true;
    }
    if (typeof value === "object" && value !== null) {
      if (containsForbiddenKeys(value)) return true;
    }
  }
  return false;
}

export async function handleStartCidSession(
  c: Context<{ Bindings: Env; Variables: { correlationId?: string } }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;
    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized. Valid user authentication required." });
    }

    const user = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?")
      .bind(userId)
      .first<{ role: string | null }>();

    if (!user) {
      c.status(401);
      return c.json({ error: "User account not found." });
    }

    interface StartSessionBody {
      appVersion?: string;
      deviceModel?: string;
      environment?: string;
    }
    const body = await c.req.json<StartSessionBody>().catch(() => ({} as StartSessionBody));

    // Reject unknown top-level fields
    const allowedSessionFields = new Set(["appVersion", "deviceModel", "environment"]);
    for (const key of Object.keys(body)) {
      if (!allowedSessionFields.has(key)) {
        c.status(400);
        return c.json({
          error: `Field '${key}' is not permitted in session start request.`,
        });
      }
    }

    const envStr = (body.environment || "demo").toLowerCase();
    if (!ALLOWED_ENVIRONMENTS.has(envStr)) {
      c.status(400);
      return c.json({
        error: `Invalid environment '${body.environment}'. Allowed: ${Array.from(ALLOWED_ENVIRONMENTS).join(", ")}.`,
      });
    }

    const appVersion = body.appVersion || "1.0.0";
    if (
      typeof appVersion !== "string" ||
      appVersion.length < 1 ||
      appVersion.length > 50 ||
      !/^[a-zA-Z0-9._-]+$/.test(appVersion)
    ) {
      c.status(400);
      return c.json({
        error: "Invalid appVersion. Must be an alphanumeric string between 1 and 50 characters (allowed: letters, digits, '.', '_', '-').",
      });
    }

    const deviceModel = body.deviceModel || "Unknown";
    if (
      typeof deviceModel !== "string" ||
      deviceModel.length < 1 ||
      deviceModel.length > 100 ||
      !/^[a-zA-Z0-9 ._/-]+$/.test(deviceModel)
    ) {
      c.status(400);
      return c.json({
        error: "Invalid deviceModel. Must be a sanitized string between 1 and 100 characters.",
      });
    }

    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    const datePrefix = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const sessionId = `CID-${datePrefix}-${crypto.randomUUID().slice(0, 8)}`;

    await c.env.DB.prepare(
      `INSERT INTO cid_sessions (id, user_id, app_version, device_model, environment, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    )
      .bind(
        sessionId,
        userId,
        appVersion,
        deviceModel,
        envStr,
        now,
        expiresAt,
      )
      .run();

    return c.json({
      success: true,
      sessionId,
      status: "ACTIVE",
      createdAt: now,
      expiresAt,
    });
  } catch (err: unknown) {
    console.error("[CID_SESSION_START_ERROR]", err);
    c.status(500);
    return c.json({ error: "Internal diagnostic server error." });
  }
}

export async function handlePostCidEvents(
  c: Context<{ Bindings: Env; Variables: { correlationId?: string } }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;
    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized. Valid user authentication required." });
    }

    const user = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?")
      .bind(userId)
      .first<{ role: string | null }>();

    if (!user) {
      c.status(401);
      return c.json({ error: "User account not found." });
    }

    const body = await c.req.json<{
      sessionId?: string;
      events?: Array<{
        seq: number;
        timestamp: number;
        category: string;
        component: string;
        eventName: string;
        severity?: string;
        durationMs?: number;
        correlationId?: string;
        payload?: Record<string, unknown>;
      }>;
    }>();

    const sessionId = body.sessionId;
    const events = body.events;

    if (!sessionId || typeof sessionId !== "string") {
      c.status(400);
      return c.json({ error: "Field 'sessionId' (string) is required." });
    }

    if (!Array.isArray(events) || events.length === 0) {
      c.status(400);
      return c.json({ error: "Field 'events' must be a non-empty array." });
    }

    if (events.length > MAX_BATCH_SIZE) {
      c.status(400);
      return c.json({
        error: `Batch size ${events.length} exceeds maximum limit of ${MAX_BATCH_SIZE} events.`,
      });
    }

    // Verify session exists and is owned by the authenticated user
    const session = await c.env.DB.prepare(
      "SELECT id, user_id, expires_at, status FROM cid_sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ id: string; user_id: string; expires_at: number; status: string }>();

    if (!session) {
      c.status(404);
      return c.json({ error: `Diagnostic session '${sessionId}' not found.` });
    }

    // Strict ownership enforcement
    if (session.user_id !== userId) {
      c.status(403);
      return c.json({ error: "Access denied. You do not own this diagnostic session." });
    }

    if (Date.now() > session.expires_at || session.status !== "ACTIVE") {
      c.status(400);
      return c.json({ error: `Diagnostic session '${sessionId}' has expired or is inactive.` });
    }

    // Validate each event in the batch
    const insertStatements = [];
    const correlationFallback = c.get("correlationId") || c.req.header("cf-ray") || "none";
    const seenSeqsInBatch = new Set<number>();
    let lastSeq = -1;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];

      // Sequence number validation: positive finite integer >= 1
      if (
        typeof ev.seq !== "number" ||
        !Number.isFinite(ev.seq) ||
        !Number.isInteger(ev.seq) ||
        ev.seq < 1
      ) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: 'seq' must be a positive finite integer >= 1. Received: ${ev.seq}`,
        });
      }

      // Check for duplicate sequence numbers within batch
      if (seenSeqsInBatch.has(ev.seq)) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: Duplicate sequence number ${ev.seq} in batch.`,
        });
      }
      seenSeqsInBatch.add(ev.seq);

      // Check for out-of-order sequence numbers within batch
      if (lastSeq !== -1 && ev.seq <= lastSeq) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: Out-of-order sequence number ${ev.seq}. Batch sequence numbers must be strictly increasing.`,
        });
      }
      lastSeq = ev.seq;

      if (
        typeof ev.timestamp !== "number" ||
        !Number.isFinite(ev.timestamp) ||
        ev.timestamp <= 0
      ) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: 'timestamp' must be a valid epoch millisecond number.`,
        });
      }

      const category = (ev.category || "").toUpperCase();
      if (!ALLOWED_CATEGORIES.has(category)) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: Invalid category '${ev.category}'. Allowed: ${Array.from(ALLOWED_CATEGORIES).join(", ")}.`,
        });
      }

      if (!ev.component || typeof ev.component !== "string" || ev.component.length > 100) {
        c.status(400);
        return c.json({ error: `Event at index ${i}: 'component' string (max 100 chars) is required.` });
      }
      if (!ev.eventName || typeof ev.eventName !== "string" || ev.eventName.length > 100) {
        c.status(400);
        return c.json({ error: `Event at index ${i}: 'eventName' string (max 100 chars) is required.` });
      }

      const severity = (ev.severity || "INFO").toUpperCase();
      if (!ALLOWED_SEVERITIES.has(severity)) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: Invalid severity '${ev.severity}'. Allowed: ${Array.from(ALLOWED_SEVERITIES).join(", ")}.`,
        });
      }

      // Strict finite payload schema validation
      const allowedFields = CATEGORY_ALLOWED_FIELDS[category];
      const eventPayload = ev.payload && typeof ev.payload === "object" ? ev.payload : {};

      if (Array.isArray(eventPayload)) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: Payload must be a JSON object, not an array.`,
        });
      }

      for (const key of Object.keys(eventPayload)) {
        if (!allowedFields.has(key)) {
          c.status(400);
          return c.json({
            error: `Event at index ${i}: Payload field '${key}' is not permitted for category '${category}'. Only finite schema fields allowed.`,
          });
        }
      }

      // Secondary defense-in-depth blacklist check
      if (containsForbiddenKeys(eventPayload)) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: Security invariant violation. Forbidden credential or secret key detected in payload.`,
        });
      }

      const payloadStr = JSON.stringify(eventPayload);
      const payloadBytes = new TextEncoder().encode(payloadStr).length;
      if (payloadBytes > MAX_PAYLOAD_BYTES) {
        c.status(400);
        return c.json({
          error: `Event at index ${i}: Payload size (${payloadBytes} bytes) exceeds maximum limit of ${MAX_PAYLOAD_BYTES} UTF-8 bytes.`,
        });
      }

      const eventId = crypto.randomUUID();
      const corrId = ev.correlationId || correlationFallback;
      const durationMs = typeof ev.durationMs === "number" ? ev.durationMs : null;

      insertStatements.push(
        c.env.DB.prepare(
          `INSERT INTO cid_events (id, session_id, seq, timestamp, category, component, event_name, severity, duration_ms, correlation_id, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, seq) DO NOTHING`,
        ).bind(
          eventId,
          sessionId,
          ev.seq,
          ev.timestamp,
          category,
          ev.component,
          ev.eventName,
          severity,
          durationMs,
          corrId,
          payloadStr,
        ),
      );
    }

    // Execute batched D1 inserts
    const batchResults = await c.env.DB.batch(insertStatements);
    let insertedCount = 0;
    for (const res of batchResults) {
      insertedCount += (res.meta?.changes ?? 0);
    }
    const duplicateCount = events.length - insertedCount;

    // Opportunistic retention cleanup: prune events older than 14 days
    const cutoffTimestamp = Date.now() - RETENTION_MS;
    try {
      c.executionCtx?.waitUntil(
        c.env.DB.prepare("DELETE FROM cid_events WHERE timestamp < ?")
          .bind(cutoffTimestamp)
          .run()
          .catch(() => {}),
      );
    } catch (_) {}

    return c.json({
      success: true,
      sessionId,
      receivedCount: events.length,
      insertedCount,
      duplicateCount,
    });
  } catch (err: unknown) {
    console.error("[CID_EVENTS_INGESTION_ERROR]", err);
    c.status(500);
    return c.json({ error: "Internal diagnostic server error." });
  }
}

export async function handleGetCidSession(
  c: Context<{ Bindings: Env; Variables: { correlationId?: string } }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;
    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized. Valid user authentication required." });
    }

    const user = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?")
      .bind(userId)
      .first<{ role: string | null }>();

    if (!user) {
      c.status(401);
      return c.json({ error: "User account not found." });
    }

    const userRole = (user.role || "USER").toUpperCase();

    const sessionId = c.req.param("id");
    if (!sessionId) {
      c.status(400);
      return c.json({ error: "Parameter 'id' is required." });
    }

    const session = await c.env.DB.prepare("SELECT * FROM cid_sessions WHERE id = ?")
      .bind(sessionId)
      .first<{ id: string; user_id: string; [key: string]: any }>();

    if (!session) {
      c.status(404);
      return c.json({ error: `Diagnostic session '${sessionId}' not found.` });
    }

    // Access check: User can access own session. Privileged roles (ADMIN, TESTER, DEVELOPER) can inspect cross-session.
    if (session.user_id !== userId && !ALLOWED_ROLES.has(userRole)) {
      c.status(403);
      return c.json({ error: "Access denied. You do not own this diagnostic session." });
    }

    const { results: events } = await c.env.DB.prepare(
      "SELECT seq, timestamp, category, component, event_name, severity, duration_ms, correlation_id, payload FROM cid_events WHERE session_id = ? ORDER BY seq ASC",
    )
      .bind(sessionId)
      .all();

    return c.json({
      session,
      totalEvents: events.length,
      events: events.map((row: any) => {
        let parsedPayload = {};
        try {
          parsedPayload = JSON.parse(row.payload);
        } catch (_) {}
        return {
          seq: row.seq,
          timestamp: row.timestamp,
          category: row.category,
          component: row.component,
          eventName: row.event_name,
          severity: row.severity,
          durationMs: row.duration_ms,
          correlationId: row.correlation_id,
          payload: parsedPayload,
        };
      }),
    });
  } catch (err: unknown) {
    console.error("[CID_GET_SESSION_ERROR]", err);
    c.status(500);
    return c.json({ error: "Internal diagnostic server error." });
  }
}

export async function handleListCidSessions(
  c: Context<{ Bindings: Env; Variables: { correlationId?: string } }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;
    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized. Valid user authentication required." });
    }

    const user = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?")
      .bind(userId)
      .first<{ role: string | null }>();

    if (!user) {
      c.status(401);
      return c.json({ error: "User account not found." });
    }

    const userRole = (user.role || "USER").toUpperCase();
    const isPrivileged = ALLOWED_ROLES.has(userRole);

    let query = "SELECT id, user_id, app_version, device_model, environment, status, created_at, expires_at FROM cid_sessions";
    const bindArgs: any[] = [];

    if (!isPrivileged) {
      query += " WHERE user_id = ?";
      bindArgs.push(userId);
    }

    query += " ORDER BY created_at DESC LIMIT 50";

    const stmt = c.env.DB.prepare(query);
    const { results } = bindArgs.length > 0 ? await stmt.bind(...bindArgs).all() : await stmt.all();

    return c.json({
      success: true,
      sessions: results,
    });
  } catch (err: unknown) {
    console.error("[CID_LIST_SESSIONS_ERROR]", err);
    c.status(500);
    return c.json({ error: "Internal diagnostic server error." });
  }
}

