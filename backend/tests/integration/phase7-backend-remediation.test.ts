import { describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import app from '../../src/index';
import {
  bindTelemetryEnv,
  createScopedTelemetryEmitter,
  emitStageSpan,
  flushTelemetry,
  isTelemetryDisabled,
  runWithTelemetryContext,
} from '../../src/infrastructure/monitoring/PipelineTelemetry';

function createMockBackendD1() {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true, meta: { changes: 1 } }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }),
  } as unknown as D1Database;
}

describe('Phase 7: Backend Read-Only Boundary, Legacy Preservation & Isolate-Safe Telemetry', () => {
  it('enforces HTTP 405 on /api/admin/monitor/v2/* mutations while preserving legacy PATCH /api/admin/monitoring/incidents/:id/status', async () => {
    const db = createMockBackendD1();
    const proxyCalls: Array<{ url: string; method: string; auth: string | null }> = [];

    const env: any = {
      DB: db,
      JWT_SECRET: 'backend-test-secret-0123456789abcdef',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      RESEND_API_KEY: 're_test_key_placeholder',
      ALLOWED_ORIGINS: 'https://cryptopulse-monitoring.pages.dev',
      ADMIN_API_KEY: 'backend-admin-key',
      ENVIRONMENT: 'testnet',
      MONITORING_SERVICE: {
        fetch: vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          proxyCalls.push({
            url,
            method: init?.method || 'GET',
            auth: headers.get('Authorization'),
          });
          return new Response(JSON.stringify({ ok: true, readOnly: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }),
      },
    };

    const userAdminJwt = await sign(
      { sub: 'usr-admin-1', email: 'u@example.com', role: 'ADMIN', exp: Math.floor(Date.now() / 1000) + 3600 },
      env.JWT_SECRET,
      'HS256'
    );

    // 1. All write methods on /api/admin/monitor/v2/* must be rejected with 405
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await app.fetch(
        new Request('https://api.local/api/admin/monitor/v2/incidents/inc-1/status', {
          method,
          headers: { Authorization: `Bearer ${userAdminJwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'RESOLVED' }),
        }),
        env
      );
      expect(res.status).toBe(405);
    }
    expect(proxyCalls).toHaveLength(0);

    // 2. GET /api/admin/monitor/v2/overview proxies cleanly with Authorization preserved
    const getRes = await app.fetch(
      new Request('https://api.local/api/admin/monitor/v2/overview', {
        method: 'GET',
        headers: { Authorization: `Bearer ${userAdminJwt}` },
      }),
      env
    );
    expect(getRes.status).toBe(200);
    expect(proxyCalls).toHaveLength(1);
    expect(proxyCalls[0].method).toBe('GET');
    expect(proxyCalls[0].auth).toBe(`Bearer ${userAdminJwt}`);

    // 3. Cross-user /api/admin/monitoring/health probe denied for non-operator admin JWT
    const crossProbe = await app.fetch(
      new Request('https://api.local/api/admin/monitoring/health?userId=victim-user', {
        method: 'GET',
        headers: { Authorization: `Bearer ${userAdminJwt}` },
      }),
      env
    );
    expect(crossProbe.status).toBe(403);

    // 4. Legacy Screen 1 / Admin PATCH /api/admin/monitoring/incidents/:id/status remains functional
    const legacyPatch = await app.fetch(
      new Request('https://api.local/api/admin/monitoring/incidents/inc-1/status', {
        method: 'PATCH',
        headers: { 'X-Admin-Key': env.ADMIN_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'RESOLVED' }),
      }),
      env
    );
    expect(legacyPatch.status).not.toBe(405);
    expect(legacyPatch.status).toBe(200);
  });

  it('isolates DISABLE_MONITORING_TELEMETRY across concurrent and sequential requests in the same V8 isolate', async () => {
    const disabledSent: any[] = [];
    const activeSent: any[] = [];

    const disabledEnv = {
      ENVIRONMENT: 'testnet',
      DISABLE_MONITORING_TELEMETRY: 'true',
      TELEMETRY_QUEUE: {
        send: async (batch: any) => {
          disabledSent.push(batch);
        },
      },
    };
    const activeEnv = {
      ENVIRONMENT: 'testnet',
      DISABLE_MONITORING_TELEMETRY: 'false',
      TELEMETRY_QUEUE: {
        send: async (batch: any) => {
          activeSent.push(batch);
        },
      },
    };

    expect(isTelemetryDisabled(disabledEnv)).toBe(true);
    expect(isTelemetryDisabled(activeEnv)).toBe(false);

    // Sequential check: disabled request FIRST must not poison subsequent active request
    bindTelemetryEnv(disabledEnv);
    const seqDisabledEmitter = createScopedTelemetryEmitter('crypto-pulse-backend', disabledEnv);
    expect(seqDisabledEmitter.isDisabled()).toBe(true);
    const dropped = seqDisabledEmitter.emit({
      journey: 'SYSTEM',
      stage: 1,
      eventType: 'SHOULD_DROP',
      status: 'PASS',
      component: 'Test',
      message: 'must not emit',
    });
    expect(dropped).toBeNull();
    expect(await seqDisabledEmitter.flush()).toEqual({ sentEvents: 0, failedEvents: 0 });
    expect(disabledSent).toHaveLength(0);

    // Active sequential request immediately afterwards MUST work
    bindTelemetryEnv(activeEnv);
    const seqActiveEmitter = createScopedTelemetryEmitter('crypto-pulse-backend', activeEnv);
    expect(seqActiveEmitter.isDisabled()).toBe(false);
    const seqSpan = seqActiveEmitter.emit({
      journey: 'SYSTEM',
      stage: 1,
      eventType: 'SHOULD_EMIT_AFTER_DISABLED',
      status: 'PASS',
      component: 'Test',
      message: 'must emit cleanly',
    });
    expect(seqSpan).not.toBeNull();
    await seqActiveEmitter.flush();
    expect(activeSent).toHaveLength(1);
    expect(activeSent[0].events[0].eventType).toBe('SHOULD_EMIT_AFTER_DISABLED');

    // Concurrent check in the same isolate via AsyncLocalStorage contexts
    const concurrentDisabledSent: any[] = [];
    const concurrentActiveSent: any[] = [];
    const concDisabledEmitter = createScopedTelemetryEmitter('trading-bot-do', {
      ...disabledEnv,
      TELEMETRY_QUEUE: {
        send: async (b: any) => {
          concurrentDisabledSent.push(b);
        },
      },
    });
    const concActiveEmitter = createScopedTelemetryEmitter('trading-bot-do', {
      ...activeEnv,
      TELEMETRY_QUEUE: {
        send: async (b: any) => {
          concurrentActiveSent.push(b);
        },
      },
    });

    await Promise.all([
      runWithTelemetryContext(
        { userId: 'u-disabled', emitter: concDisabledEmitter, disabled: true, traceId: 'tr-dis' },
        async () => {
          await new Promise((r) => setTimeout(r, 10));
          const ev = emitStageSpan({
            stage: 5,
            eventType: 'CONC_DISABLED',
            status: 'PASS',
            component: 'Bot',
            message: 'disabled',
          });
          expect(ev).toBeNull();
          flushTelemetry();
        }
      ),
      runWithTelemetryContext(
        { userId: 'u-active', emitter: concActiveEmitter, disabled: false, traceId: 'tr-act' },
        async () => {
          await new Promise((r) => setTimeout(r, 15));
          const ev = emitStageSpan({
            stage: 5,
            eventType: 'CONC_ACTIVE',
            status: 'PASS',
            component: 'Bot',
            message: 'active',
          });
          expect(ev).not.toBeNull();
          const p = concActiveEmitter.flush();
          await p;
        }
      ),
    ]);

    expect(concurrentDisabledSent).toHaveLength(0);
    expect(concurrentActiveSent).toHaveLength(1);
    expect(concurrentActiveSent[0].events[0].eventType).toBe('CONC_ACTIVE');

    // overrideEnv with DISABLE_MONITORING_TELEMETRY='true' skips single span without affecting future spans
    const skippedOverride = emitStageSpan(
      { stage: 1, eventType: 'OVERRIDE_SKIP', status: 'PASS', component: 'Test', message: 'skip' },
      { ...disabledEnv }
    );
    expect(skippedOverride).toBeNull();
    const afterOverride = runWithTelemetryContext({ emitter: seqActiveEmitter }, () =>
      emitStageSpan({
        stage: 1,
        eventType: 'AFTER_OVERRIDE',
        status: 'PASS',
        component: 'Test',
        message: 'still active',
      })
    );
    expect(afterOverride).not.toBeNull();
  });
});
