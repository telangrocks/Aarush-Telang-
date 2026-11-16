import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const dashboardDir = resolve(__dirname, '../../monitoring-dashboard');
const indexHtml = readFileSync(resolve(dashboardDir, 'index.html'), 'utf8');
const appJs = readFileSync(resolve(dashboardDir, 'app.js'), 'utf8');
const stylesCss = readFileSync(resolve(dashboardDir, 'styles.css'), 'utf8');

describe('Phase 4 — Screen 2 Dashboard UI Verification & Read-Only Guardrails', () => {
  it('parses app.js as valid strict JavaScript without syntax errors', () => {
    expect(() => new vm.Script(appJs, { filename: 'monitoring-dashboard/app.js' })).not.toThrow();
    expect(stylesCss.length).toBeGreaterThan(1000);
  });

  it('includes all 9-stage diagnostic sections (A-G), global jump filters, and self-health banner', () => {
    for (const id of [
      'self-health-banner',
      'section-a',
      'section-b',
      'section-c',
      'section-d',
      'section-e',
      'section-f',
      'section-g',
      'stages-strip',
      'handoff-summary-grid',
      'traces-tbody',
      'trace-inspector-pane',
      'ta-tbody',
      'dead-code-disclosure',
      'trades-tbody',
      'notifications-tbody',
      'incidents-tbody',
      'detail-modal',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }

    const combined = `${indexHtml}\n${appJs}`;
    expect(combined).toContain('READ-ONLY OBSERVER');
    expect(combined).toContain('SCANNER_SIMPLE');
    expect(combined).toContain('[NOT_IN_LIVE_PATH]');
    expect(combined).toContain('ACK ONLY — NOT FILLED');
    expect(combined).toContain('ELIGIBLE_OS_UNPROVABLE');
    expect(combined).toContain('POST_CHECK_MISSING');
    expect(combined).toContain('SUPPRESSED_PRECHECK');
    expect(appJs).toContain('>NULL<');
  });

  it('strictly preserves admin/device authentication while removing all mutation/control workflows', () => {
    // Preserved auth endpoints
    expect(appJs).toContain('/api/admin/activate-device');
    expect(appJs).toContain('/api/admin/session/refresh');
    expect(appJs).toContain('/api/admin/login');
    expect(appJs).toContain('/api/admin/session/revoke');

    // Uses only v2 read-only monitoring endpoints via apiGet
    expect(appJs).toContain('/api/admin/monitor/v2/overview');
    expect(appJs).toContain('/api/admin/monitor/v2/traces');
    expect(appJs).toContain('/api/admin/monitor/v2/ta');
    expect(appJs).toContain('/api/admin/monitor/v2/strategies-gates');
    expect(appJs).toContain('/api/admin/monitor/v2/trades');
    expect(appJs).toContain('/api/admin/monitor/v2/notifications');
    expect(appJs).toContain('/api/admin/monitor/v2/incidents');
    expect(appJs).toContain('/api/admin/monitor/v2/live-probe');

    // Zero banned write/mutation/trading control endpoints or PATCH/DELETE calls
    const combined = `${indexHtml}\n${appJs}`;
    for (const forbidden of [
      '/incidents/',
      'execute-trade',
      '/bot/start',
      '/bot/stop',
      'createOrder',
      'setTradingStop',
      "method: 'PATCH'",
      'method: "PATCH"',
      "method: 'PUT'",
      'method: "PUT"',
      "method: 'DELETE'",
      'method: "DELETE"',
      'resolveIncident',
      'updateIncidentStatus',
    ]) {
      if (forbidden === '/incidents/') {
        expect(combined).not.toContain('/status');
      } else {
        expect(combined).not.toContain(forbidden);
      }
    }

    // Legacy v1 mutation paths must be completely gone
    expect(appJs).not.toContain('/api/admin/monitoring/overview');
    expect(appJs).not.toContain('/api/admin/monitoring/bots');
  });

  it('escapes untrusted XSS payloads cleanly when rendering in a DOM stub', () => {
    const fakeElements = new Map<string, any>();
    const makeEl = (id: string) => {
      const node: any = {
        id,
        value: '',
        checked: true,
        innerHTML: '',
        textContent: '',
        className: '',
        style: {},
        classList: {
          add: () => {},
          remove: () => {},
        },
        addEventListener: () => {},
        querySelector: () => makeEl(`${id}_btn`),
        getAttribute: () => '',
        closest: () => null,
      };
      fakeElements.set(id, node);
      return node;
    };

    const listeners: Record<string, Function> = {};
    const docStub = {
      hidden: false,
      getElementById: (id: string) => fakeElements.get(id) || makeEl(id),
      addEventListener: (ev: string, fn: Function) => { listeners[ev] = fn; },
      querySelector: () => null,
    };

    // Match all element IDs present in index.html
    for (const match of indexHtml.matchAll(/id="([^"]+)"/g)) {
      makeEl(match[1]);
    }
    fakeElements.get('filter-window').value = '60';

    const fetchMock = async (url: string) => {
      const u = String(url);
      if (u.includes('/api/admin/session/refresh')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'header.eyJzdWIiOiJhZG1pbiIsImV4cCI6OTk5OTk5OTk5OX0.sig' }) };
      }
      if (u.includes('/api/admin/monitor/v2/overview')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            overallVerdict: 'FAIL',
            windowMinutes: 60,
            selfHealth: { honestState: 'HEALTHY', eventsReceived: 5, eventsInserted: 5, eventsDeduped: 0, avgIngestLagMs: 12.3, maxIngestLagMs: 25, dlqCount: 0, d1WriteErrors: 0 },
            stages: [{ stage: 1, name: 'Connectivity', honestState: 'FAIL', passCount: 0, warnCount: 0, failCount: 1, skippedCount: 0, ageMs: 1000, latestEventType: 'TEST', latestSymbol: '<script>alert(1)</script>', latestMessage: '<img src=x onerror=alert(2)>' }],
            exchangeHealth: { publicMarketData: { honestState: 'DISCONNECTED' }, privateAccount: { honestState: 'DISCONNECTED' } },
            journeys: { latestDiscovery: null, latestAutonomous: null, handoff: {} },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ total: 0, items: [], stage2Decisions: [], stage2LeakCheck: {}, gateEvaluations: [], deadUnwiredComponents: [], shadowModeComparisons: [], summary: {} }) };
    };

    const storageStub = () => {
      const m = new Map<string, string>();
      return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => m.set(k, String(v)),
        removeItem: (k: string) => m.delete(k),
      };
    };

    const ctx = vm.createContext({
      document: docStub,
      window: { location: { hash: '', pathname: '/', search: '' } },
      navigator: { userAgent: 'Mozilla/5.0' },
      history: { replaceState: () => {} },
      sessionStorage: storageStub(),
      localStorage: storageStub(),
      fetch: fetchMock,
      URL,
      atob: (s: string) => Buffer.from(s, 'base64').toString('utf8'),
      setInterval: () => 1,
      clearInterval: () => {},
      console,
    });

    vm.runInContext(appJs, ctx);

    return new Promise<void>((resolveTest) => {
      setTimeout(() => {
        const renderedStages = fakeElements.get('stages-strip').innerHTML as string;
        expect(renderedStages).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
        expect(renderedStages).toContain('&lt;img src=x onerror=alert(2)&gt;');
        expect(renderedStages).not.toContain('<script>');
        expect(renderedStages).not.toContain('<img ');
        resolveTest();
      }, 30);
    });
  });
});
