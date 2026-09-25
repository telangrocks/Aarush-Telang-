import { describe, it, expect, vi, beforeEach } from "vitest";
import app from "../../src/index";
import { generateAccessToken } from "../../src/handlers/auth";

describe("CID Subsystem — Ingestion, Security & Authorization Tests", () => {
  const JWT_SECRET = "test-jwt-secret-key-32-bytes-minimum-size!!";
  const TESTER_A_ID = "usr_tester_alice";
  const TESTER_B_ID = "usr_tester_bob";
  const NORMAL_USER_ID = "usr_normal_charlie";

  let mockDb: any;
  let mockEnv: any;
  let sessionsTable: Map<string, any>;
  let eventsTable: Array<any>;
  let usersTable: Map<string, any>;

  beforeEach(() => {
    sessionsTable = new Map();
    eventsTable = [];
    usersTable = new Map([
      [TESTER_A_ID, { id: TESTER_A_ID, role: "TESTER", email: "alice@cryptopulse.dev" }],
      [TESTER_B_ID, { id: TESTER_B_ID, role: "TESTER", email: "bob@cryptopulse.dev" }],
      [NORMAL_USER_ID, { id: NORMAL_USER_ID, role: "USER", email: "charlie@example.com" }],
    ]);

    mockDb = {
      prepare: vi.fn((query: string) => {
        const q = query.trim();
        const createQueryObj = (boundArgs: any[] = []) => ({
          first: vi.fn(async () => {
            if (q.includes("SELECT role FROM users WHERE id = ?")) {
              const u = usersTable.get(boundArgs[0]);
              return u ? { role: u.role } : null;
            }
            if (
              q.includes("SELECT id, user_id, expires_at, status FROM cid_sessions WHERE id = ?") ||
              q.includes("SELECT * FROM cid_sessions WHERE id = ?")
            ) {
              return sessionsTable.get(boundArgs[0]) || null;
            }
            return null;
          }),
          all: vi.fn(async () => {
            if (q.includes("SELECT seq, timestamp, category, component, event_name, severity, duration_ms, correlation_id, payload FROM cid_events WHERE session_id = ?")) {
              const sId = boundArgs[0];
              const matched = eventsTable.filter((e) => e.session_id === sId);
              matched.sort((a, b) => a.seq - b.seq);
              return { results: matched };
            }
            if (q.includes("SELECT id, user_id, app_version, device_model, environment, status, created_at, expires_at FROM cid_sessions")) {
              let allSessions = Array.from(sessionsTable.values());
              if (q.includes("WHERE user_id = ?")) {
                allSessions = allSessions.filter((s) => s.user_id === boundArgs[0]);
              }
              return { results: allSessions };
            }
            return { results: [] };
          }),
          run: vi.fn(async () => {
            if (q.includes("INSERT INTO cid_sessions")) {
              sessionsTable.set(boundArgs[0], {
                id: boundArgs[0],
                user_id: boundArgs[1],
                app_version: boundArgs[2],
                device_model: boundArgs[3],
                environment: boundArgs[4],
                status: "ACTIVE",
                created_at: boundArgs[5],
                expires_at: boundArgs[6],
              });
              return { success: true };
            }
            if (q.includes("DELETE FROM cid_events WHERE timestamp < ?")) {
              return { success: true };
            }
            return { success: true };
          }),
        });

        const obj: any = createQueryObj();
        obj.bind = vi.fn((...args: any[]) => createQueryObj(args));
        return obj;
      }),
      batch: vi.fn(async (statements: any[]) => {
        return statements.map(() => ({ meta: { changes: 1 } }));
      }),
    };

    mockEnv = {
      DB: mockDb,
      JWT_SECRET,
      ENCRYPTION_KEY: "mock-encryption-key-for-testing-12345678",
      RESEND_API_KEY: "mock-resend-api-key",
      ALLOWED_ORIGINS: "http://localhost",
    };
  });

  // =========================================================================
  // 1. Session Start Authorization & Input Validation
  // =========================================================================

  it("1. Rejects unauthenticated request to start CID session with 401", async () => {
    const res = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(401);
  });

  it("2. Allows normal user (role='USER') to start their own CID session", async () => {
    const token = await generateAccessToken(NORMAL_USER_ID, "charlie@example.com", JWT_SECRET);
    const res = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.sessionId).toMatch(/^CID-\d{14}-[a-f0-9]{8}$/);
    expect(json.status).toBe("ACTIVE");
  });

  it("3. Allows authorized tester (role='TESTER') to start CID session with 2-hour TTL", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const res = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          appVersion: "1.2.3",
          deviceModel: "Pixel 7 Pro",
          environment: "demo",
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.sessionId).toMatch(/^CID-\d{14}-[a-f0-9]{8}$/);
    expect(json.status).toBe("ACTIVE");
    expect(json.expiresAt - json.createdAt).toBe(2 * 60 * 60 * 1000);
  });

  it("4. Rejects unsupported environment strings", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const res = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          environment: "production_hacked",
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid environment");
  });

  it("5. Rejects arbitrary metadata fields in session start", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const res = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          environment: "demo",
          arbitraryBackdoor: "malicious_payload",
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("arbitraryBackdoor");
  });

  // =========================================================================
  // 2. Strict Session Ownership Enforcement
  // =========================================================================

  it("6. Allows TESTER to access and post to their own session", async () => {
    const tokenAlice = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);

    // Create session for Alice
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAlice}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    // Alice posts event
    const postRes = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAlice}`,
        },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "NAVIGATION",
              component: "NavController",
              eventName: "NAVIGATE_TO",
              severity: "INFO",
              payload: { fromRoute: "splash", toRoute: "home" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(postRes.status).toBe(200);

    // Alice reads session
    const getRes = await app.fetch(
      new Request(`http://localhost/api/cid/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${tokenAlice}` },
      }),
      mockEnv,
    );
    expect(getRes.status).toBe(200);
  });

  it("7. Rejects cross-user write: TESTER Bob cannot post events to TESTER Alice's session (403)", async () => {
    const tokenAlice = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const tokenBob = await generateAccessToken(TESTER_B_ID, "bob@cryptopulse.dev", JWT_SECRET);

    // Create session for Alice
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAlice}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    // Bob tries to post events to Alice's session
    const postRes = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenBob}`,
        },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "NAVIGATION",
              component: "NavController",
              eventName: "NAVIGATE_TO",
              payload: { toRoute: "dashboard" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(postRes.status).toBe(403);
    const json = await postRes.json();
    expect(json.error).toContain("You do not own this diagnostic session");
  });

  it("8. Allows privileged TESTER Bob to retrieve TESTER Alice's session (cross-session inspection)", async () => {
    const tokenAlice = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const tokenBob = await generateAccessToken(TESTER_B_ID, "bob@cryptopulse.dev", JWT_SECRET);

    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAlice}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const getRes = await app.fetch(
      new Request(`http://localhost/api/cid/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${tokenBob}` },
      }),
      mockEnv,
    );
    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    expect(json.session.id).toBe(sessionId);
    expect(json.session.user_id).toBe(TESTER_A_ID);
  });

  it("9. Rejects normal user from retrieving another user's session (403)", async () => {
    const tokenAlice = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const tokenNormal = await generateAccessToken(NORMAL_USER_ID, "charlie@example.com", JWT_SECRET);

    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAlice}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const getRes = await app.fetch(
      new Request(`http://localhost/api/cid/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${tokenNormal}` },
      }),
      mockEnv,
    );
    expect(getRes.status).toBe(403);
    const json = await getRes.json();
    expect(json.error).toContain("You do not own this diagnostic session");
  });

  it("9b. Allows normal user to retrieve their own session (200)", async () => {
    const tokenNormal = await generateAccessToken(NORMAL_USER_ID, "charlie@example.com", JWT_SECRET);

    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenNormal}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const getRes = await app.fetch(
      new Request(`http://localhost/api/cid/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${tokenNormal}` },
      }),
      mockEnv,
    );
    expect(getRes.status).toBe(200);
    const json = await getRes.json();
    expect(json.session.id).toBe(sessionId);
    expect(json.session.user_id).toBe(NORMAL_USER_ID);
  });

  it("10. Rejects normal user from posting to another user's CID session (403)", async () => {
    const tokenAlice = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const tokenNormal = await generateAccessToken(NORMAL_USER_ID, "charlie@example.com", JWT_SECRET);

    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenAlice}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const postRes = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenNormal}`,
        },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "AUTH",
              component: "Auth",
              eventName: "LOGIN",
              payload: { action: "LOGIN", success: true },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(postRes.status).toBe(403);
    const json = await postRes.json();
    expect(json.error).toContain("You do not own this diagnostic session");
  });

  it("10b. Allows normal user to post to their own CID session (200)", async () => {
    const tokenNormal = await generateAccessToken(NORMAL_USER_ID, "charlie@example.com", JWT_SECRET);

    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenNormal}`,
        },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const postRes = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenNormal}`,
        },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "AUTH",
              component: "Auth",
              eventName: "LOGIN",
              payload: { action: "LOGIN", success: true },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(postRes.status).toBe(200);
    const json = await postRes.json();
    expect(json.success).toBe(true);
    expect(json.insertedCount).toBe(1);
  });

  it("10c. Listing sessions restricts normal user to own sessions", async () => {
    const tokenAlice = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const tokenNormal = await generateAccessToken(NORMAL_USER_ID, "charlie@example.com", JWT_SECRET);

    await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlice}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );

    await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenNormal}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );

    const listRes = await app.fetch(
      new Request("http://localhost/api/cid/sessions", {
        headers: { Authorization: `Bearer ${tokenNormal}` },
      }),
      mockEnv,
    );
    expect(listRes.status).toBe(200);
    const json = await listRes.json();
    expect(json.success).toBe(true);
    expect(json.sessions.every((s: any) => s.user_id === NORMAL_USER_ID)).toBe(true);
  });

  it("10d. Listing sessions allows privileged role to see all sessions", async () => {
    const tokenAlice = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const tokenBob = await generateAccessToken(TESTER_B_ID, "bob@cryptopulse.dev", JWT_SECRET);

    await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenAlice}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );

    const listRes = await app.fetch(
      new Request("http://localhost/api/cid/sessions", {
        headers: { Authorization: `Bearer ${tokenBob}` },
      }),
      mockEnv,
    );
    expect(listRes.status).toBe(200);
    const json = await listRes.json();
    expect(json.success).toBe(true);
    expect(json.sessions.length).toBeGreaterThanOrEqual(1);
    expect(json.sessions.some((s: any) => s.user_id === TESTER_A_ID)).toBe(true);
  });

  // =========================================================================
  // 3. Category & Finite Payload Schema Enforcement
  // =========================================================================

  it("11. Rejects unknown payload fields not in the category's finite allowlist", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const postRes = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "NAVIGATION",
              component: "NavController",
              eventName: "NAVIGATE_TO",
              payload: {
                fromRoute: "splash",
                toRoute: "home",
                unauthorizedInjectedField: "attacker_metadata", // Unknown field
              },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(postRes.status).toBe(400);
    const json = await postRes.json();
    expect(json.error).toContain("is not permitted for category");
  });

  it("12. Rejects forbidden financial data (balance, netWorth, portfolio, wallet)", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const postRes = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "BOT",
              component: "BotEngine",
              eventName: "CYCLE",
              payload: {
                symbol: "BTCUSDT",
                balance: 50000.0, // Strictly forbidden financial data
              },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(postRes.status).toBe(400);
    const json = await postRes.json();
    expect(json.error).toContain("not permitted");
  });

  it("13. Rejects forbidden credentials (apiKey, password, etc.)", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const postRes = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "EXCHANGE",
              component: "ExchangeService",
              eventName: "CONNECT",
              payload: {
                exchangeId: "bybit",
                action: "CONNECT",
                status: "PENDING",
                apiKey: "super_secret_key", // Forbidden credential
              },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(postRes.status).toBe(400);
  });

  // =========================================================================
  // 4. Sequence Number Semantics (0, negative, decimal, non-number, duplicate, out-of-order)
  // =========================================================================

  it("14. Rejects sequence = 0 with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 0, // Invalid seq
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "START",
              payload: { eventType: "START" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("positive finite integer >= 1");
  });

  it("15. Rejects negative sequence with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: -5, // Negative
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "START",
              payload: { eventType: "START" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
  });

  it("16. Rejects decimal sequence with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1.5, // Decimal
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "START",
              payload: { eventType: "START" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
  });

  it("17. Rejects non-number sequence with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: "1", // Non-number
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "START",
              payload: { eventType: "START" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
  });

  it("18. Rejects duplicate sequence numbers within the same batch with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "START",
              payload: { eventType: "START" },
            },
            {
              seq: 1, // Duplicate in batch
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "RESUME",
              payload: { eventType: "RESUME" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Duplicate sequence number");
  });

  it("19. Rejects out-of-order sequence numbers within batch with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 5,
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "START",
              payload: { eventType: "START" },
            },
            {
              seq: 3, // Out-of-order
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "RESUME",
              payload: { eventType: "RESUME" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Out-of-order sequence number");
  });

  // =========================================================================
  // 5. UTF-8 Byte Length vs Character Length Validation
  // =========================================================================

  it("20. Correctly rejects payload exceeding 8192 UTF-8 bytes using multibyte characters", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    // 2500 4-byte emoji characters: character length is 5000 UTF-16 code units, but UTF-8 bytes is 10,000 bytes!
    const multibyteReason = "🚨".repeat(2500);

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "BOT",
              component: "BotEngine",
              eventName: "REJECT",
              payload: {
                rejectionReason: multibyteReason,
              },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("UTF-8 bytes");
  });

  // =========================================================================
  // 6. Batch Size Limits (50 vs 51)
  // =========================================================================

  it("21. Accepts maximum batch size of exactly 50 events", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const events = Array.from({ length: 50 }, (_, i) => ({
      seq: i + 1,
      timestamp: Date.now() + i,
      category: "NAVIGATION",
      component: "NavController",
      eventName: "NAVIGATE_TO",
      payload: { toRoute: `route_${i}` },
    }));

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, events }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.receivedCount).toBe(50);
    expect(json.insertedCount).toBe(50);
  });

  it("22. Rejects batch of 51 events with 400 limit exceeded", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const events = Array.from({ length: 51 }, (_, i) => ({
      seq: i + 1,
      timestamp: Date.now() + i,
      category: "NAVIGATION",
      component: "NavController",
      eventName: "NAVIGATE_TO",
      payload: { toRoute: `route_${i}` },
    }));

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId, events }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("exceeds maximum limit of 50");
  });

  it("23. Rejects expired session with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const expiredSessionId = "CID-20260901000000-expired1";
    sessionsTable.set(expiredSessionId, {
      id: expiredSessionId,
      user_id: TESTER_A_ID,
      app_version: "1.0.0",
      device_model: "Pixel 7",
      environment: "demo",
      status: "ACTIVE",
      created_at: Date.now() - 3 * 3600 * 1000,
      expires_at: Date.now() - 1000, // Expired in past
    });

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId: expiredSessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "NAVIGATION",
              component: "NavController",
              eventName: "NAVIGATE_TO",
              payload: { toRoute: "home" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("expired or is inactive");
  });

  it("24. Rejects inactive session with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const completedSessionId = "CID-20260901000000-compltd1";
    sessionsTable.set(completedSessionId, {
      id: completedSessionId,
      user_id: TESTER_A_ID,
      app_version: "1.0.0",
      device_model: "Pixel 7",
      environment: "demo",
      status: "COMPLETED", // Inactive status
      created_at: Date.now() - 1000,
      expires_at: Date.now() + 7200000,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId: completedSessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "NAVIGATION",
              component: "NavController",
              eventName: "NAVIGATE_TO",
              payload: { toRoute: "home" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("expired or is inactive");
  });

  it("25. Rejects invalid severity with 400", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 1,
              timestamp: Date.now(),
              category: "LIFECYCLE",
              component: "App",
              eventName: "START",
              severity: "SUPER_FATAL", // Invalid severity
              payload: { eventType: "START" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid severity");
  });

  it("26. Correctly reports insertedCount vs duplicateCount when database ignores duplicate rows", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);
    const startRes = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      mockEnv,
    );
    const { sessionId } = await startRes.json();

    // Mock D1 batch returning changes: 1 for first event, 0 for second event (conflict)
    mockDb.batch = vi.fn(async () => [
      { meta: { changes: 1 } },
      { meta: { changes: 0 } }, // Ignored by ON CONFLICT DO NOTHING
    ]);

    const res = await app.fetch(
      new Request("http://localhost/api/cid/events", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          sessionId,
          events: [
            {
              seq: 10,
              timestamp: Date.now(),
              category: "NAVIGATION",
              component: "NavController",
              eventName: "NAVIGATE_TO",
              payload: { toRoute: "home" },
            },
            {
              seq: 11,
              timestamp: Date.now() + 10,
              category: "NAVIGATION",
              component: "NavController",
              eventName: "NAVIGATE_TO",
              payload: { toRoute: "trade" },
            },
          ],
        }),
      }),
      mockEnv,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.receivedCount).toBe(2);
    expect(json.insertedCount).toBe(1);
    expect(json.duplicateCount).toBe(1);
  });

  // =========================================================================
  // 7. Sanitized Error Handling
  // =========================================================================

  it("27. Returns sanitized 500 error on unexpected internal failure without leaking stack trace", async () => {
    const token = await generateAccessToken(TESTER_A_ID, "alice@cryptopulse.dev", JWT_SECRET);

    // Mock DB failure inside the CID handler
    const brokenEnv = {
      ...mockEnv,
      DB: {
        prepare: (query: string) => {
          if (query.includes("jwt_blacklist")) {
            return {
              bind: () => ({
                first: async () => null,
              }),
            };
          }
          throw new Error("D1_INTERNAL_CORRUPTION_SQLITE_ERROR_AT_LINE_9999");
        },
      },
    };

    const res = await app.fetch(
      new Request("http://localhost/api/cid/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ environment: "demo" }),
      }),
      brokenEnv,
    );

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Internal diagnostic server error.");
    expect(json).not.toHaveProperty("message");
    expect(JSON.stringify(json)).not.toContain("D1_INTERNAL_CORRUPTION");
  });
});
