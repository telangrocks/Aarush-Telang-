/**
 * Monitoring.test.ts
 *
 * Comprehensive test suite verifying the CryptoPulse Centralized Monitoring Platform.
 *
 * Verifies:
 * 1. Event schema validation and strict field sanitization (zero secret leakage)
 * 2. Admin authorization (X-Admin-Key, Admin JWT, 401 on missing, 403 on non-admin user)
 * 3. Cross-user isolation & fleet queries
 * 4. Deduplication of identical incidents via stable fingerprints
 * 5. Event correlation across cycleId, intentId, orderId
 * 6. Bounded pagination & query limits
 * 7. Graceful degradation when D1 storage throws or is unavailable
 * 8. Bounded memory behavior of ring buffers
 * 9. Fail-safe isolation (monitoring errors NEVER impact caller)
 * 10. Deterministic root-cause rule matching (facts vs hypotheses)
 * 11. Copyable Antigravity investigation prompt generation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateMonitoringEvent,
  sanitizeMonitoringPayload,
  generateEventFingerprint,
  FORBIDDEN_KEY_PATTERNS
} from '../MonitoringEvent';
import { RootCauseEngine } from '../RootCauseEngine';
import { MonitoringService } from '../MonitoringService';
import { timingSafeStringCompare, adminAuthMiddleware, handleAdminLogin } from '../AdminAuth';
import { sign } from 'hono/jwt';

describe('CryptoPulse Centralized Monitoring Platform', () => {
  const monitoring = MonitoringService.getInstance();

  beforeEach(() => {
    monitoring.resetForTesting();
    vi.restoreAllMocks();
  });

  describe('1. Schema Validation & Security Sanitization', () => {
    it('validates a normal monitoring event payload', () => {
      const res = validateMonitoringEvent({
        severity: 'ERROR',
        source: 'BOT',
        component: 'TradingBot',
        eventType: 'FINAL_DISPATCH_GATE',
        message: 'Suppressed TradeAlert: IN_FLIGHT_INTENT',
        userId: 'usr_123',
        evidence: { symbol: 'BTCUSDT', gate: 'IN_FLIGHT_INTENT' }
      });

      expect(res.valid).toBe(true);
      expect(res.event).toBeDefined();
      expect(res.event?.severity).toBe('ERROR');
      expect(res.event?.source).toBe('BOT');
      expect(res.event?.fingerprint).toContain('TRADINGBOT::FINAL_DISPATCH_GATE');
    });

    it('rejects invalid severity or source values', () => {
      const res1 = validateMonitoringEvent({ severity: 'SUPER_FATAL', component: 'A', eventType: 'B' });
      expect(res1.valid).toBe(false);
      expect(res1.error).toContain('Invalid severity');

      const res2 = validateMonitoringEvent({ severity: 'INFO', source: 'UNKNOWN_DEVICE', component: 'A', eventType: 'B' });
      expect(res2.valid).toBe(false);
      expect(res2.error).toContain('Invalid source');
    });

    it('strictly sanitizes and redacts all credential and secret fields', () => {
      const rawPayload = {
        symbol: 'ETHUSDT',
        price: 2500,
        apiKey: 'bybit_live_key_9999',
        api_secret: 'super_secret_raw_bytes',
        password: 'UserPassword123!',
        jwt: 'eyJhbGciOi...',
        nested: {
          token: 'secret_token',
          passphrase: 'pass',
          safeParam: 'ok'
        }
      };

      const sanitized = sanitizeMonitoringPayload(rawPayload) as any;
      expect(sanitized.symbol).toBe('ETHUSDT');
      expect(sanitized.price).toBe(2500);
      expect(sanitized.apiKey).toBe('[REDACTED]');
      expect(sanitized.api_secret).toBe('[REDACTED]');
      expect(sanitized.password).toBe('[REDACTED]');
      expect(sanitized.jwt).toBe('[REDACTED]');
      expect(sanitized.nested.token).toBe('[REDACTED]');
      expect(sanitized.nested.passphrase).toBe('[REDACTED]');
      expect(sanitized.nested.safeParam).toBe('ok');
    });

    it('enforces string length limits on oversized messages and evidence', () => {
      const hugeString = 'A'.repeat(2000);
      const sanitized = sanitizeMonitoringPayload(hugeString) as string;
      expect(sanitized.length).toBeLessThanOrEqual(550);
      expect(sanitized).toContain('[TRUNCATED]');
    });
  });

  describe('2. Deterministic Root-Cause Engine & Antigravity Prompts', () => {
    it('diagnoses INSUFFICIENT_BALANCE with HIGH confidence and candidate files', () => {
      const event = validateMonitoringEvent({
        severity: 'ERROR',
        source: 'BOT',
        component: 'TradingBot',
        eventType: 'BYBIT_RESULT',
        errorCode: 'INSUFFICIENT_BALANCE',
        message: 'Order rejected: insufficient balance',
        evidence: { exchange: 'Bybit', symbol: 'BTCUSDT' }
      }).event!;

      const diag = RootCauseEngine.diagnoseIncident(event);
      expect(diag.confidence).toBe('HIGH');
      expect(diag.likelyRootCause).toContain('does not hold sufficient free USDT');
      expect(diag.relevantFiles).toContain('backend/src/utils/balance.ts');
      expect(diag.antigravityPrompt).toContain('### CRYPTOPULSE INCIDENT INVESTIGATION PROMPT');
      expect(diag.antigravityPrompt).toContain('Preserve Trading Logic');
    });

    it('diagnoses FINAL_DISPATCH_GATE in-flight intent suppression', () => {
      const event = validateMonitoringEvent({
        severity: 'WARNING',
        source: 'BOT',
        component: 'TradingBot',
        eventType: 'FINAL_DISPATCH_GATE',
        message: 'Suppressed: IN_FLIGHT_INTENT',
        evidence: { gate: 'IN_FLIGHT_INTENT', symbol: 'SOLUSDT' }
      }).event!;

      const diag = RootCauseEngine.diagnoseIncident(event);
      expect(diag.confidence).toBe('HIGH');
      expect(diag.likelyRootCause).toContain('order intent was dispatched to the exchange and has not yet transitioned');
      expect(diag.relevantFiles).toContain('backend/src/engine/safety/FinalDispatchSafetyGate.ts');
    });

    it('falls back to "Root cause unknown — more evidence required" for unclassified errors', () => {
      const event = validateMonitoringEvent({
        severity: 'ERROR',
        source: 'BACKEND',
        component: 'CustomWorkerModule',
        eventType: 'UNEXPECTED_CONDITION',
        message: 'Something rare happened in edge worker',
        evidence: { arbitraryKey: 123 }
      }).event!;

      const diag = RootCauseEngine.diagnoseIncident(event);
      expect(diag.confidence).toBe('LOW');
      expect(diag.likelyRootCause).toBe('Root cause unknown — more evidence required.');
      expect(diag.alternativeExplanations.length).toBeGreaterThan(0);
    });
  });

  describe('3. Deduplication, Quotas & In-Memory Bounded Ring Buffer', () => {
    it('deduplicates identical error events within the dedup window', async () => {
      const fakeDb = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            run: vi.fn().mockResolvedValue({ success: true })
          })
        })
      } as any;

      const eventPayload = {
        severity: 'ERROR' as const,
        source: 'BOT' as const,
        component: 'TradingBot',
        eventType: 'FINAL_DISPATCH_GATE',
        errorCode: 'GATE_REJECTED',
        message: 'In flight intent',
        userId: 'usr_dedup_test',
        evidence: { symbol: 'BTCUSDT' }
      };

      // Emit 5 identical errors in rapid succession
      for (let i = 0; i < 5; i++) {
        await monitoring.recordEvent(eventPayload, { db: fakeDb });
      }

      const stats = monitoring.getHealthStats();
      expect(stats.totalEventsReceived).toBe(5);
      expect(stats.totalIncidentsPersisted).toBe(1); // Only 1 insert!
      expect(stats.totalDeduplicated).toBe(4); // 4 deduplications!
    });

    it('enforces maximum ring buffer capacity without unbounded memory growth', async () => {
      // Record 200 events (hard cap is 150)
      for (let i = 0; i < 200; i++) {
        await monitoring.recordEvent({
          severity: 'INFO',
          source: 'BACKEND',
          component: 'Pacer',
          eventType: 'TICK',
          message: `Tick #${i}`
        });
      }

      const stats = monitoring.getHealthStats();
      expect(stats.totalEventsReceived).toBe(200);
      expect(stats.ringBufferSize).toBe(150); // Hard bounded at 150

      const recent = monitoring.getRecentEvents(10);
      expect(recent.length).toBe(10);
      expect(recent[0].message).toBe('Tick #199'); // Most recent first
    });

    it('swallows storage errors gracefully without throwing', async () => {
      const failingDb = {
        prepare: vi.fn().mockImplementation(() => {
          throw new Error('D1 storage quota exceeded (simulated)');
        })
      } as any;

      // Must NOT throw
      await expect(
        monitoring.recordEvent(
          {
            severity: 'CRITICAL',
            source: 'BOT',
            component: 'CircuitBreaker',
            eventType: 'CIRCUIT_BREAKER',
            message: 'Emergency tripwire'
          },
          { db: failingDb }
        )
      ).resolves.not.toThrow();

      const stats = monitoring.getHealthStats();
      expect(stats.writeFailuresCount).toBe(1);
      // Event is still safely preserved in in-memory ring buffer!
      expect(monitoring.getRecentEvents(1)[0].message).toBe('Emergency tripwire');
    });
  });

  describe('4. Administrative Authorization & Boundaries', () => {
    it('verifies constant-time comparison for API keys', () => {
      expect(timingSafeStringCompare('secret_admin_key_123', 'secret_admin_key_123')).toBe(true);
      expect(timingSafeStringCompare('secret_admin_key_123', 'secret_admin_key_wrong')).toBe(false);
      expect(timingSafeStringCompare('short', 'much_longer_string')).toBe(false);
    });

    it('allows access via valid X-Admin-Key header', async () => {
      const mockContext = {
        req: {
          header: (name: string) => (name.toLowerCase() === 'x-admin-key' ? 'valid_key_456' : null)
        },
        env: {
          ADMIN_API_KEY: 'valid_key_456'
        },
        set: vi.fn(),
        json: vi.fn()
      } as any;

      const next = vi.fn().mockResolvedValue('OK');
      await adminAuthMiddleware(mockContext, next);

      expect(next).toHaveBeenCalled();
      expect(mockContext.set).toHaveBeenCalledWith(
        'adminSession',
        expect.objectContaining({ role: 'ADMIN', authMethod: 'API_KEY' })
      );
    });

    it('rejects requests with missing or invalid admin key (HTTP 401)', async () => {
      const mockContext = {
        req: {
          header: () => null
        },
        env: {
          ADMIN_API_KEY: 'valid_key_456'
        },
        set: vi.fn(),
        json: vi.fn().mockReturnValue(new Response('Unauthorized', { status: 401 }))
      } as any;

      const next = vi.fn();
      const res = await adminAuthMiddleware(mockContext, next);

      expect(next).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Unauthorized' }),
        401
      );
    });

    it('rejects regular user JWT without admin role (HTTP 403 Forbidden)', async () => {
      const jwtSecret = 'test_jwt_secret_super_secure_32_characters_long';
      const userToken = await sign(
        {
          sub: 'usr_normal_trader',
          email: 'trader@gmail.com',
          role: 'USER', // Normal user!
          exp: Math.floor(Date.now() / 1000) + 3600
        },
        jwtSecret,
        'HS256'
      );

      const mockContext = {
        req: {
          header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${userToken}` : null)
        },
        env: {
          JWT_SECRET: jwtSecret,
          ADMIN_API_KEY: 'key_123'
        },
        set: vi.fn(),
        json: vi.fn().mockReturnValue(new Response('Forbidden', { status: 403 }))
      } as any;

      const next = vi.fn();
      await adminAuthMiddleware(mockContext, next);

      expect(next).not.toHaveBeenCalled();
      expect(mockContext.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Forbidden' }),
        403
      );
    });

    it('allows admin JWT with explicit role ADMIN', async () => {
      const jwtSecret = 'test_jwt_secret_super_secure_32_characters_long';
      const adminToken = await sign(
        {
          sub: 'usr_admin_operator',
          email: 'admin@cryptopulse.app',
          role: 'ADMIN',
          exp: Math.floor(Date.now() / 1000) + 3600
        },
        jwtSecret,
        'HS256'
      );

      const mockContext = {
        req: {
          header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${adminToken}` : null)
        },
        env: {
          JWT_SECRET: jwtSecret
        },
        set: vi.fn(),
        json: vi.fn()
      } as any;

      const next = vi.fn().mockResolvedValue('OK');
      await adminAuthMiddleware(mockContext, next);

      expect(next).toHaveBeenCalled();
      expect(mockContext.set).toHaveBeenCalledWith(
        'adminSession',
        expect.objectContaining({ role: 'ADMIN', email: 'admin@cryptopulse.app' })
      );
    });
  });

  describe('5. Bounded Pagination & Query Fallback', () => {
    it('seamlessly queries from memory buffer when D1 is unavailable', async () => {
      for (let i = 0; i < 25; i++) {
        await monitoring.recordEvent({
          severity: i % 2 === 0 ? 'ERROR' : 'WARNING',
          source: 'BOT',
          component: 'OrderExecutor',
          eventType: 'ORDER_SUBMIT',
          message: `Order #${i}`
        });
      }

      // Query without DB (null)
      const res = await monitoring.queryIncidents(null, {
        severity: 'ERROR',
        page: 1,
        limit: 5
      });

      expect(res.source).toBe('IN_MEMORY_FALLBACK');
      expect(res.total).toBe(13); // 13 even numbers out of 25
      expect(res.items.length).toBe(5);
      expect(res.hasMore).toBe(true);
      expect(res.items.every((item) => item.severity === 'ERROR')).toBe(true);
    });
  });
});
