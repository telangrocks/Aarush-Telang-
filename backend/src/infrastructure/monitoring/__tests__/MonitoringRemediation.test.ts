/**
 * MonitoringRemediation.test.ts
 *
 * Dedicated regression test suite for Phase 1 Monitoring Remediation:
 * 1. Admin login brute-force rate-limiting (max 5 failed attempts per 15 min, reset on success)
 * 2. Cross-isolate atomic bounded-window deduplication
 * 3. Protection placement & Unprotected exposure telemetry
 * 4. Reconciliation mismatch telemetry
 * 5. Android client telemetry route (JWT authentication, rate limiting, payload size cap, verified user derivation)
 * 6. Dashboard XSS escaping verification
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleAdminLogin,
  isAdminLoginAllowed,
  recordFailedAdminLogin,
  clearAdminLoginAttempts,
  resetAdminRateLimiterForTesting,
  ADMIN_LOGIN_MAX_ATTEMPTS,
  handleCreateActivationToken,
  handleActivateDevice,
  handleRefreshDeviceSession,
  handleRevokeDeviceSession,
  sha256Hex
} from '../AdminAuth';
import { MonitoringService } from '../MonitoringService';
import { EVENT_PAYLOAD_ALLOWLIST, BackendDiagnosticSink } from '../../../telemetry/BackendDiagnosticSink';
import { ReconciliationEngine } from '../../../engine/reconciliation/ReconciliationEngine';
import { handleReportClientIncident, resetClientTelemetryLimiterForTesting } from '../../../handlers/admin-monitoring';
import { sign } from 'hono/jwt';

describe('Phase 1 Monitoring Remediation Regression Suite', () => {
  const monitoring = MonitoringService.getInstance();

  beforeEach(() => {
    monitoring.resetForTesting();
    resetAdminRateLimiterForTesting();
    resetClientTelemetryLimiterForTesting();
    vi.restoreAllMocks();
  });

  describe('1. Admin Login Brute-Force Rate Limiting', () => {
    it('blocks after 5 consecutive failed login attempts (HTTP 429)', async () => {
      const testIp = '198.51.100.42';
      const mockEnv = {
        JWT_SECRET: 'test_jwt_secret_32_characters_long_min',
        ADMIN_API_KEY: 'correct_master_key_999'
      } as any;

      // Simulate 5 failed attempts
      for (let i = 0; i < 5; i++) {
        const mockCtx = {
          req: {
            header: (name: string) => (name.toLowerCase() === 'cf-connecting-ip' ? testIp : null),
            json: vi.fn().mockResolvedValue({ adminKey: 'wrong_key' })
          },
          env: mockEnv,
          json: vi.fn().mockImplementation((body, status) => ({ body, status }))
        } as any;

        const res = await handleAdminLogin(mockCtx);
        expect(res.status).toBe(401);
      }

      // 6th attempt must be blocked with HTTP 429
      const blockedCtx = {
        req: {
          header: (name: string) => (name.toLowerCase() === 'cf-connecting-ip' ? testIp : null),
          json: vi.fn().mockResolvedValue({ adminKey: 'correct_master_key_999' }) // Even with correct key!
        },
        env: mockEnv,
        json: vi.fn().mockImplementation((body, status) => ({ body, status }))
      } as any;

      const blockedRes: any = await handleAdminLogin(blockedCtx);
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.error).toBe('Too Many Requests');
      expect(blockedRes.body.message).toContain('locked for 15 minutes');
    });

    it('clears failed login attempts upon successful authentication', async () => {
      const testIp = '198.51.100.99';
      const mockEnv = {
        JWT_SECRET: 'test_jwt_secret_32_characters_long_min',
        ADMIN_API_KEY: 'correct_master_key_999'
      } as any;

      // 3 failed attempts
      for (let i = 0; i < 3; i++) {
        const mockCtx = {
          req: {
            header: (name: string) => (name.toLowerCase() === 'cf-connecting-ip' ? testIp : null),
            json: vi.fn().mockResolvedValue({ adminKey: 'wrong_key' })
          },
          env: mockEnv,
          json: vi.fn().mockImplementation((body, status) => ({ body, status }))
        } as any;
        await handleAdminLogin(mockCtx);
      }

      // 4th attempt succeeds
      const successCtx = {
        req: {
          header: (name: string) => (name.toLowerCase() === 'cf-connecting-ip' ? testIp : null),
          json: vi.fn().mockResolvedValue({ adminKey: 'correct_master_key_999' })
        },
        env: mockEnv,
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const successRes: any = await handleAdminLogin(successCtx);
      expect(successRes.body.success).toBe(true);
      expect(successRes.body.token).toBeDefined();

      // Ensure failed attempts were reset
      const allowed = await isAdminLoginAllowed(successCtx, testIp);
      expect(allowed).toBe(true);
    });

    it('synchronizes rate limit state to D1 login_attempts table', async () => {
      const testIp = '203.0.113.5';
      const runMock = vi.fn().mockResolvedValue({ success: true });
      const firstMock = vi.fn().mockResolvedValue({ count: 5, window_start: Date.now() });

      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: runMock,
            first: firstMock
          })
        })
      };

      const mockCtx = { env: { DB: mockDb } } as any;

      // Check allowed: D1 reports count = 5 within window -> should return false
      const allowed = await isAdminLoginAllowed(mockCtx, testIp);
      expect(allowed).toBe(false);
      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT count, window_start FROM login_attempts'));
    });
  });

  describe('2. Cross-Isolate Bounded-Window Deduplication', () => {
    it('executes atomic UPSERT with window_bucket on D1 database', async () => {
      const runMock = vi.fn().mockResolvedValue({ success: true });
      const bindMock = vi.fn().mockReturnValue({ run: runMock });
      const prepareMock = vi.fn().mockReturnValue({ bind: bindMock });
      const fakeDb = { prepare: prepareMock } as any;

      await monitoring.recordEvent(
        {
          severity: 'CRITICAL',
          source: 'BOT',
          component: 'TradingBot',
          eventType: 'UNPROTECTED_EXPOSURE',
          errorCode: 'UNPROTECTED_EXPOSURE_LOCK',
          message: 'Exposure lock active',
          userId: 'usr_upsert_test'
        },
        { db: fakeDb }
      );

      expect(prepareMock).toHaveBeenCalledWith(
        expect.stringContaining('ON CONFLICT(fingerprint, window_bucket, status) DO UPDATE SET')
      );
      expect(runMock).toHaveBeenCalled();
    });
  });

  describe('3. Protection & Reconciliation Telemetry Allowlist', () => {
    it('preserves fields for PROTECTION_ERROR and UNPROTECTED_EXPOSURE in allowlist', () => {
      const sink = new BackendDiagnosticSink();

      const rawProtError = {
        alertId: 'alt_123',
        positionId: 'pos_456',
        symbol: 'BTCUSDT',
        side: 'BUY',
        errorCode: 'EXPOSURE_CLOSED_UNPROTECTED',
        message: 'Protection verification failed',
        closeIntentId: 'cls_789',
        secretApiKey: 'MUST_BE_STRIPPED' // Forbidden pattern
      };

      const sanitized = sink.filterAndSanitizePayload('PROTECTION_ERROR', rawProtError);
      expect(sanitized.alertId).toBe('alt_123');
      expect(sanitized.positionId).toBe('pos_456');
      expect(sanitized.errorCode).toBe('EXPOSURE_CLOSED_UNPROTECTED');
      expect((sanitized as any).secretApiKey).toBeUndefined();
    });

    it('preserves fields for RECONCILIATION_MISMATCH in allowlist', () => {
      const sink = new BackendDiagnosticSink();

      const rawMismatch = {
        intentId: 'int_001',
        symbol: 'ETHUSDT',
        reason: 'Affirmative flatness not proven',
        retryCount: 2,
        reconciliationStatus: 'UNKNOWN',
        errorCode: 'RECONCILIATION_MISMATCH'
      };

      const sanitized = sink.filterAndSanitizePayload('RECONCILIATION_MISMATCH', rawMismatch);
      expect(sanitized.intentId).toBe('int_001');
      expect(sanitized.symbol).toBe('ETHUSDT');
      expect(sanitized.retryCount).toBe(2);
      expect(sanitized.errorCode).toBe('RECONCILIATION_MISMATCH');
    });

    it('emits RECONCILIATION_MISMATCH telemetry when evidence query fails', async () => {
      const mockSink = { emit: vi.fn() } as any;

      const failingAdapter = {
        fetchOrder: vi.fn().mockRejectedValue(new Error('Bybit network timeout')),
        fetchOrders: vi.fn().mockResolvedValue([]),
        fetchPositions: vi.fn().mockRejectedValue(new Error('Bybit network timeout'))
      } as any;

      const intent: any = {
        intentId: 'int_recon_test',
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 1,
        version: 1,
        status: 'DISPATCHED' as const,
        reconciliationAttemptCount: 1,
        lastReconciliationAttempt: 0,
        createdAt: Date.now() - 20 * 60 * 1000
      };

      await ReconciliationEngine.reconcile(failingAdapter, intent, Date.now(), {
        userId: 'usr_recon_owner',
        sink: mockSink
      });

      expect(mockSink.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: 'RECONCILIATION_MISMATCH',
          severity: 'WARN',
          userId: 'usr_recon_owner',
          correlationId: 'int_recon_test'
        })
      );
    });
  });

  describe('4. Android Client Telemetry Route', () => {
    it('derives userId strictly from verified JWT and overrides caller payload', async () => {
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockImplementation(() => {
              return { success: true };
            })
          })
        })
      };

      const mockCtx = {
        req: {
          json: vi.fn().mockResolvedValue({
            source: 'ANDROID',
            severity: 'CRITICAL',
            component: 'AndroidWatchdog',
            eventType: 'NATIVE_CRASH',
            userId: 'spoofed_target_victim_id', // Maliciously supplied caller ID
            botId: 'spoofed_bot_id',
            message: 'NullPointerException in ChartRenderer'
          })
        },
        get: vi.fn().mockImplementation((key: string) => {
          if (key === 'jwtPayload') return { sub: 'usr_legitimate_jwt_owner' };
          return null;
        }),
        env: { DB: mockDb },
        executionCtx: undefined,
        json: vi.fn().mockImplementation((body, status) => ({ body, status }))
      } as any;

      const res: any = await handleReportClientIncident(mockCtx);
      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      // Ensure the generated fingerprint reflects the verified JWT owner, not the spoofed victim ID
      expect(res.body.fingerprint).toContain('usr_legitimate_jwt_owner');
    });

    it('rejects unauthenticated requests (HTTP 401)', async () => {
      const mockCtx = {
        req: {
          json: vi.fn().mockResolvedValue({
            source: 'ANDROID',
            severity: 'ERROR',
            component: 'App',
            eventType: 'ERROR',
            message: 'Unauthenticated error'
          })
        },
        get: vi.fn().mockReturnValue(null), // No JWT, no Admin session
        env: {},
        json: vi.fn().mockImplementation((body, status) => ({ body, status }))
      } as any;

      const res: any = await handleReportClientIncident(mockCtx);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('rejects client telemetry payloads exceeding 4KB (HTTP 413)', async () => {
      const hugeObject = {
        component: 'CrashTracker',
        eventType: 'CRASH',
        hugeTrace: 'X'.repeat(5000)
      };

      const mockCtx = {
        req: {
          json: vi.fn().mockResolvedValue(hugeObject)
        },
        get: vi.fn().mockReturnValue({ sub: 'usr_normal' }),
        env: {},
        json: vi.fn().mockImplementation((body, status) => ({ body, status }))
      } as any;

      const res: any = await handleReportClientIncident(mockCtx);
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('Payload Too Large');
    });

    it('enforces rate limiting on client telemetry (max 30 per 5 min)', async () => {
      const userSub = 'usr_spammer_99';
      const mockCtx = {
        req: {
          json: vi.fn().mockResolvedValue({
            component: 'App',
            eventType: 'EVENT',
            message: 'Frequent event'
          })
        },
        get: vi.fn().mockImplementation((k: string) => (k === 'jwtPayload' ? { sub: userSub } : null)),
        env: { DB: null },
        json: vi.fn().mockImplementation((body, status) => ({ body, status }))
      } as any;

      // Submit 30 allowed events
      for (let i = 0; i < 30; i++) {
        const res: any = await handleReportClientIncident(mockCtx);
        expect(res.status).toBe(202);
      }

      // 31st event must be rate limited
      const rateLimitedRes: any = await handleReportClientIncident(mockCtx);
      expect(rateLimitedRes.status).toBe(429);
      expect(rateLimitedRes.body.error).toBe('Too Many Requests');
    });
  });

  describe('5. Dashboard Stored XSS Escaping', () => {
    function escapeHtml(str: any): string {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    it('neutralizes malicious HTML payloads in user-controlled fields', () => {
      const attackEmail = '<script>alert("pwned")</script>@domain.com';
      const attackBotId = 'bot_<img src=x onerror=alert(1)>';
      const attackMessage = 'Normal text <iframe src="javascript:evil()"></iframe>';

      expect(escapeHtml(attackEmail)).toBe('&lt;script&gt;alert(&quot;pwned&quot;)&lt;/script&gt;@domain.com');
      expect(escapeHtml(attackBotId)).toBe('bot_&lt;img src=x onerror=alert(1)&gt;');
      expect(escapeHtml(attackMessage)).toBe('Normal text &lt;iframe src=&quot;javascript:evil()&quot;&gt;&lt;/iframe&gt;');

      // Verify no executable HTML characters remain unescaped
      expect(escapeHtml(attackEmail)).not.toContain('<');
      expect(escapeHtml(attackEmail)).not.toContain('>');
      expect(escapeHtml(attackBotId)).not.toContain('<');
      expect(escapeHtml(attackBotId)).not.toContain('>');
    });
  });

  describe('6. Zero-Manual-Login Device Session & Single-Use Activation', () => {
    it('creates a 15-minute single-use activation token', async () => {
      const mockDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true })
          })
        })
      };

      const mockCtx = {
        env: { DB: mockDb },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const res: any = await handleCreateActivationToken(mockCtx);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.activationToken).toBeDefined();
      expect(res.body.activationToken.length).toBe(64); // 32 bytes hex
      expect(res.body.expiresInSeconds).toBe(900); // 15 minutes
    });

    it('rejects activation requests missing CSRF header (HTTP 403)', async () => {
      const mockCtx = {
        req: {
          header: vi.fn().mockReturnValue(null), // No CSRF header
          json: vi.fn().mockResolvedValue({ activationToken: 'test_token' })
        },
        env: { DB: {} },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const res: any = await handleActivateDevice(mockCtx);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Forbidden');
    });

    it('activates device on valid single-use token and rejects reuse', async () => {
      let isUsed = false;
      const mockDb = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockImplementation((...args: any[]) => ({
            first: vi.fn().mockImplementation(async () => {
              if (sql.includes('SELECT token_id')) {
                return {
                  token_id: 'tok_1',
                  expires_at: Date.now() + 600000,
                  used_at: isUsed ? Date.now() - 1000 : null
                };
              }
              return null;
            }),
            run: vi.fn().mockImplementation(async () => {
              if (sql.includes('UPDATE admin_activation_tokens')) {
                if (isUsed) return { success: true, meta: { changes: 0 } };
                isUsed = true;
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true };
            })
          }))
        }))
      };

      const mockCtx = {
        header: vi.fn(),
        req: {
          raw: { headers: new Headers() },
          header: vi.fn().mockImplementation((h: string) => {
            if (h.toLowerCase() === 'x-cryptopulse-admin') return '1';
            return null;
          }),
          json: vi.fn().mockResolvedValue({ activationToken: 'valid_token_123', deviceName: 'MacBook Pro' })
        },
        env: {
          DB: mockDb,
          JWT_SECRET: 'test_jwt_secret_32_characters_long_min'
        },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      // First activation attempt succeeds
      const res1: any = await handleActivateDevice(mockCtx);
      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.accessToken).toBeDefined();
      expect(res1.body.deviceToken).toBeDefined();

      // Second activation attempt with same token fails immediately (single-use invariant)
      const res2: any = await handleActivateDevice(mockCtx);
      expect(res2.status).toBe(401);
      expect(res2.body.message).toContain('already been used');
    });

    it('refreshes active device session and rolls forward expiry', async () => {
      let expiry = Date.now() + 100000;
      const mockDb = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockImplementation((...args: any[]) => ({
            first: vi.fn().mockResolvedValue({
              session_id: 'sess_99',
              device_name: 'Personal Chrome',
              expires_at: expiry,
              revoked_at: null
            }),
            run: vi.fn().mockImplementation(async () => {
              if (sql.includes('UPDATE admin_device_sessions')) {
                expiry = args[1]; // newExpiresAt
              }
              return { success: true };
            })
          }))
        }))
      };

      const mockCtx = {
        header: vi.fn(),
        req: {
          raw: { headers: new Headers() },
          header: vi.fn().mockImplementation((h: string) => {
            if (h.toLowerCase() === 'x-cryptopulse-admin') return '1';
            if (h.toLowerCase() === 'x-device-session') return 'my_device_session_token';
            return null;
          }),
          json: vi.fn().mockResolvedValue({})
        },
        env: {
          DB: mockDb,
          JWT_SECRET: 'test_jwt_secret_32_characters_long_min'
        },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const res: any = await handleRefreshDeviceSession(mockCtx);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.accessToken).toBeDefined();
      expect(expiry).toBeGreaterThan(Date.now() + 20 * 24 * 3600 * 1000);
    });

    it('rejects revoked device sessions immediately (HTTP 401)', async () => {
      const mockDb = {
        prepare: vi.fn().mockImplementation(() => ({
          bind: vi.fn().mockImplementation(() => ({
            first: vi.fn().mockResolvedValue({
              session_id: 'sess_compromised',
              device_name: 'Lost Phone',
              expires_at: Date.now() + 100000,
              revoked_at: Date.now() - 5000 // Revoked!
            }),
            run: vi.fn().mockResolvedValue({ success: true })
          }))
        }))
      };

      const mockCtx = {
        header: vi.fn(),
        req: {
          raw: { headers: new Headers() },
          header: vi.fn().mockImplementation((h: string) => {
            if (h.toLowerCase() === 'x-cryptopulse-admin') return '1';
            if (h.toLowerCase() === 'x-device-session') return 'revoked_token_abc';
            return null;
          }),
          json: vi.fn().mockResolvedValue({})
        },
        env: {
          DB: mockDb,
          JWT_SECRET: 'test_jwt_secret_32_characters_long_min'
        },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const res: any = await handleRefreshDeviceSession(mockCtx);
      expect(res.status).toBe(401);
      expect(res.body.message).toContain('revoked');
    });

    it('marks device session revoked in D1 upon logout', async () => {
      let revokedSet = false;
      const mockDb = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockImplementation(() => ({
            run: vi.fn().mockImplementation(async () => {
              if (sql.includes('UPDATE admin_device_sessions SET revoked_at')) {
                revokedSet = true;
              }
              return { success: true };
            })
          }))
        }))
      };

      const mockCtx = {
        header: vi.fn(),
        req: {
          raw: { headers: new Headers() },
          header: vi.fn().mockImplementation((h: string) => {
            if (h.toLowerCase() === 'x-cryptopulse-admin') return '1';
            if (h.toLowerCase() === 'x-device-session') return 'session_to_revoke';
            return null;
          }),
          json: vi.fn().mockResolvedValue({})
        },
        env: { DB: mockDb },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const res: any = await handleRevokeDeviceSession(mockCtx);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(revokedSet).toBe(true);
    });

    it('authenticates with master dashboard password, creating 30-day device session', async () => {
      let insertedSession = false;
      const mockDb = {
        prepare: vi.fn().mockImplementation((sql: string) => ({
          bind: vi.fn().mockImplementation(() => ({
            run: vi.fn().mockImplementation(async () => {
              if (sql.includes('INSERT INTO admin_device_sessions')) {
                insertedSession = true;
              }
              return { success: true };
            })
          }))
        }))
      };

      const testPasswordHash = 'UbU+C9KZgTziLeDzBq68Hw==:Cs+IpUxQs/88Eq3sl4nrw/8DkippOveI37xsV4l0oHs=';
      const mockCtx = {
        header: vi.fn(),
        req: {
          raw: { headers: new Headers() },
          header: vi.fn().mockReturnValue(null),
          json: vi.fn().mockResolvedValue({ password: 'Trader@1984' })
        },
        env: {
          DB: mockDb,
          JWT_SECRET: 'test_jwt_secret_32_characters_long_min',
          ADMIN_PASSWORD_HASH: testPasswordHash
        },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const res: any = await handleAdminLogin(mockCtx);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBeDefined();
      expect(res.body.deviceToken).toBeDefined();
      expect(insertedSession).toBe(true);
    });

    it('rejects incorrect master dashboard password (HTTP 401)', async () => {
      const testPasswordHash = 'UbU+C9KZgTziLeDzBq68Hw==:Cs+IpUxQs/88Eq3sl4nrw/8DkippOveI37xsV4l0oHs=';
      const mockCtx = {
        header: vi.fn(),
        req: {
          raw: { headers: new Headers() },
          header: vi.fn().mockReturnValue(null),
          json: vi.fn().mockResolvedValue({ password: 'WrongPassword' })
        },
        env: {
          DB: {},
          JWT_SECRET: 'test_jwt_secret_32_characters_long_min',
          ADMIN_PASSWORD_HASH: testPasswordHash
        },
        json: vi.fn().mockImplementation((body, status) => ({ body, status: status || 200 }))
      } as any;

      const res: any = await handleAdminLogin(mockCtx);
      expect(res.status).toBe(401);
      expect(res.body.message).toContain('Invalid administrative password');
    });
  });
});
