import { describe, expect, it, vi } from 'vitest';
import { sign } from 'hono/jwt';
import app from '../../src/index';
import {
  bindTelemetryEnv,
  checkStagingExchangeEnvironment,
  createScopedTelemetryEmitter,
  emitStageSpan,
  flushTelemetry,
  isTelemetryDisabled,
  runWithTelemetryContext,
  validateStagingIsolationEnv,
} from '../../src/infrastructure/monitoring/PipelineTelemetry';
import { ExchangeRoutingResolver } from '../../src/exchanges/routing/ExchangeRoutingResolver';
import { PublicMarketDataCoordinator } from '../../src/infrastructure/market-data/PublicMarketDataCoordinator';
import { PublicMarketDataService } from '../../src/infrastructure/market-data/PublicMarketDataService';

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

  it('enforces staging Demo-only isolation, blocks Mainnet/invalid configs in staging, preserves production Demo + Real routing, and aligns all 9 stages to demo', async () => {
    const jwtSecret = 'staging-isolation-jwt-secret-0123456789abcdef';
    const nowSec = Math.floor(Date.now() / 1000);
    const userJwt = await sign(
      { sub: 'usr_staging_test_1', email: 'staging@cryptopulse.test', role: 'USER', iat: nowSec, exp: nowSec + 3600 },
      jwtSecret
    );

    // 1. Production Demo & Real (Mainnet) routing remain 100% functional
    expect(ExchangeRoutingResolver.getRestUrl({ exchange: 'bybit', environment: 'demo' })).toBe(
      'https://api-demo.bybit.com'
    );
    expect(ExchangeRoutingResolver.getRestUrl({ exchange: 'bybit', environment: 'mainnet' })).toBe(
      'https://api.bybit.com'
    );
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('demo', 'linear')).toBe(
      'wss://stream-demo.bybit.com/v5/public/linear'
    );
    expect(ExchangeRoutingResolver.getBybitWebSocketUrl('mainnet', 'linear')).toBe(
      'wss://stream.bybit.com/v5/public/linear'
    );

    const prodEnv: any = {
      DB: createMockBackendD1(),
      JWT_SECRET: jwtSecret,
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      RESEND_API_KEY: 're_prod_placeholder',
      ALLOWED_ORIGINS: 'https://cryptopulse-monitoring.pages.dev',
      ENVIRONMENT: 'production',
    };
    expect(validateStagingIsolationEnv(prodEnv).isStaging).toBe(false);
    expect(checkStagingExchangeEnvironment(prodEnv, 'mainnet').allowed).toBe(true);
    expect(checkStagingExchangeEnvironment(prodEnv, 'demo').allowed).toBe(true);

    // 2. Staging configuration: rejects Mainnet, missing, null, or invalid environments
    const stagingEnv: any = {
      ...prodEnv,
      ENVIRONMENT: 'demo',
      STAGING_ISOLATION_MODE: 'demo',
    };
    expect(validateStagingIsolationEnv(stagingEnv)).toEqual({
      isStaging: true,
      valid: true,
      allowedExchangeEnv: 'demo',
      status: 200,
      code: 'OK',
      error: null,
    });
    expect(checkStagingExchangeEnvironment(stagingEnv, 'demo').allowed).toBe(true);
    expect(checkStagingExchangeEnvironment(stagingEnv, 'mainnet')).toMatchObject({
      allowed: false,
      status: 403,
      code: 'STAGING_MAINNET_BLOCKED',
    });
    expect(checkStagingExchangeEnvironment(stagingEnv, null)).toMatchObject({
      allowed: false,
      status: 400,
      code: 'INVALID_ENVIRONMENT',
    });
    expect(checkStagingExchangeEnvironment(stagingEnv, '')).toMatchObject({
      allowed: false,
      status: 400,
      code: 'INVALID_ENVIRONMENT',
    });

    // Missing/null/invalid staging configuration fails closed
    for (const badEnv of [
      { ...prodEnv, ENVIRONMENT: 'demo', STAGING_ISOLATION_MODE: '' },
      { ...prodEnv, ENVIRONMENT: 'demo', STAGING_ISOLATION_MODE: null },
      { ...prodEnv, ENVIRONMENT: 'demo', STAGING_ISOLATION_MODE: 'mainnet' },
      { ...prodEnv, ENVIRONMENT: '', STAGING_ISOLATION_MODE: 'demo' },
      { ...prodEnv, ENVIRONMENT: 'staging' },
      { ...prodEnv, ENVIRONMENT: null },
    ]) {
      const badRes = await app.fetch(new Request('https://staging.local/health'), badEnv as any);
      expect(badRes.status).toBe(400);
      const badJson = (await badRes.json()) as any;
      expect(badJson.code).toBe('INVALID_ENVIRONMENT');
    }

    // Gateway rejects POST /api/exchange/validate and /api/exchange/connect with mainnet in staging
    for (const path of ['/api/exchange/validate', '/api/exchange/connect']) {
      const resMainnet = await app.fetch(
        new Request(`https://staging.local${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            environment: 'mainnet',
            apiKey: 'testKey',
            apiSecret: 'testSecret',
          }),
        }),
        stagingEnv
      );
      expect(resMainnet.status).toBe(403);
      const bodyMainnet = (await resMainnet.json()) as any;
      expect(bodyMainnet.code).toBe('STAGING_MAINNET_BLOCKED');

      const resMissingEnv = await app.fetch(
        new Request(`https://staging.local${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${userJwt}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            exchangeName: 'bybit',
            apiKey: 'testKey',
            apiSecret: 'testSecret',
          }),
        }),
        stagingEnv
      );
      expect(resMissingEnv.status).toBe(400);
      const bodyMissingEnv = (await resMissingEnv.json()) as any;
      expect(bodyMissingEnv.code).toBe('INVALID_ENVIRONMENT');
    }

    // Gateway rejects ?environment=mainnet query parameter on market routes in staging
    const candidatesMainnetRes = await app.fetch(
      new Request('https://staging.local/api/market/candidates?budget=100&environment=mainnet', {
        headers: { Authorization: `Bearer ${userJwt}` },
      }),
      stagingEnv
    );
    expect(candidatesMainnetRes.status).toBe(403);

    // PublicMarketDataService rejects default 'mainnet' fallback when called with staging env
    const pmds = PublicMarketDataService.getInstance();
    await expect(pmds.getTickers(stagingEnv, 'bybit', 'mainnet', 'india')).rejects.toThrow(/Mainnet is blocked in staging/i);

    // PublicMarketDataCoordinator initializes to 'demo' in staging and rejects 'mainnet'
    const coord = new PublicMarketDataCoordinator({} as any, stagingEnv);
    const statsRes = await coord.fetch(new Request('http://coordinator/stats'));
    expect(statsRes.status).toBe(200);
    const statsJson = (await statsRes.json()) as any;
    expect(statsJson.environment).toBe('demo');

    const coordMainnetRes = await coord.fetch(new Request('http://coordinator/stats?environment=mainnet'));
    expect(coordMainnetRes.status).toBe(403);

    // 3. All 9 monitoring stages emit environment === 'demo' under staging configuration
    const capturedBatches: any[] = [];
    const stagingTelEnv = {
      ENVIRONMENT: 'demo',
      STAGING_ISOLATION_MODE: 'demo',
      MONITOR_INGEST_SERVICE: {
        fetch: async (_url: string, init?: RequestInit) => {
          capturedBatches.push(JSON.parse(String(init?.body || '{}')));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    };
    const stageEmitter = createScopedTelemetryEmitter('crypto-pulse-backend', stagingTelEnv);
    runWithTelemetryContext({ environment: stagingTelEnv.ENVIRONMENT, emitter: stageEmitter, userId: 'usr_staging_test_1' }, () => {
      for (const stage of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
        emitStageSpan({
          stage,
          journey: stage <= 2 ? 'JOURNEY_A_DISCOVERY' : 'JOURNEY_B_AUTONOMOUS',
          eventType: `STAGE_${stage}_TEST`,
          status: 'PASS',
          component: `Stage${stage}Component`,
          message: `Stage ${stage} demo alignment check`,
        });
      }
    });
    await stageEmitter.flush();
    expect(capturedBatches).toHaveLength(1);
    expect(capturedBatches[0].events).toHaveLength(9);
    for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const ev = capturedBatches[0].events.find((e: any) => e.stage === s);
      expect(ev).toBeDefined();
      expect(ev.environment).toBe('demo');
    }
  });
});
