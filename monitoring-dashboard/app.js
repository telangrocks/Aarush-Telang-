/* CryptoPulse 9-Stage Real-Time Data Flow Monitoring Console (Screen 2)
 * Strictly Read-Only Diagnostic Observer:
 * - Preserves short-lived JWT + device session auth (never stores permanent ADMIN_API_KEY in storage).
 * - Queries only GET /api/admin/monitor/v2/* endpoints.
 * - Contains ZERO bot start/stop, trade execution, balance, strategy, risk, or incident mutation controls.
 * - Escapes every dynamic value with escapeHtml() to prevent Stored XSS.
 */

(function () {
  'use strict';

  const state = {
    apiUrl: sessionStorage.getItem('cp_monitoring_api_url') || 'https://crypto-pulse-backend.telangrocks.workers.dev',
    jwtToken: sessionStorage.getItem('cp_monitoring_jwt') || '',
    pollTimer: null,
    isPolling: false,
    autoPoll: true,
    selectedTraceId: null,
    filters: {
      traceId: '',
      cycleId: '',
      discoveryCycleId: '',
      symbol: '',
      journey: '',
      environment: '',
      windowMinutes: '60',
      taStatus: '',
      taEngine: '',
    },
  };

  const el = {
    loginModal: document.getElementById('login-modal'),
    loginForm: document.getElementById('login-form'),
    apiUrlInput: document.getElementById('api-url-input'),
    adminKeyInput: document.getElementById('admin-key-input'),
    loginError: document.getElementById('login-error'),
    app: document.getElementById('app'),
    logoutBtn: document.getElementById('logout-btn'),
    refreshNowBtn: document.getElementById('refresh-now-btn'),
    liveProbeBtn: document.getElementById('live-probe-btn'),
    autoPollToggle: document.getElementById('auto-poll-toggle'),
    sessionIdentityLabel: document.getElementById('session-identity-label'),
    overallVerdictBadge: document.getElementById('overall-verdict-badge'),
    globalErrorBanner: document.getElementById('global-error-banner'),

    shVerdict: document.getElementById('sh-verdict'),
    shConsumerState: document.getElementById('sh-consumer-state'),
    shCounts: document.getElementById('sh-counts'),
    shLag: document.getElementById('sh-lag'),
    shErrors: document.getElementById('sh-errors'),
    shLastPolled: document.getElementById('sh-last-polled'),

    globalFilterForm: document.getElementById('global-filter-form'),
    resetFiltersBtn: document.getElementById('reset-filters-btn'),
    filterTraceId: document.getElementById('filter-trace-id'),
    filterCycleId: document.getElementById('filter-cycle-id'),
    filterDiscoveryId: document.getElementById('filter-discovery-id'),
    filterSymbol: document.getElementById('filter-symbol'),
    filterJourney: document.getElementById('filter-journey'),
    filterEnv: document.getElementById('filter-env'),
    filterWindow: document.getElementById('filter-window'),
    taStatusFilter: document.getElementById('ta-status-filter'),
    taEngineFilter: document.getElementById('ta-engine-filter'),

    overviewWindowLabel: document.getElementById('overview-window-label'),
    stagesStrip: document.getElementById('stages-strip'),
    pubExchBadge: document.getElementById('pub-exch-badge'),
    pubExchBody: document.getElementById('pub-exch-body'),
    privExchBadge: document.getElementById('priv-exch-badge'),
    privExchBody: document.getElementById('priv-exch-body'),
    probeStatusBadge: document.getElementById('probe-status-badge'),
    liveProbeBody: document.getElementById('live-probe-body'),

    stage2LeakBadge: document.getElementById('stage2-leak-badge'),
    handoffSummaryGrid: document.getElementById('handoff-summary-grid'),
    stage2DecisionsTbody: document.getElementById('stage2-decisions-tbody'),

    tracesCountLabel: document.getElementById('traces-count-label'),
    tracesTbody: document.getElementById('traces-tbody'),
    traceInspectorPane: document.getElementById('trace-inspector-pane'),

    taTbody: document.getElementById('ta-tbody'),

    deadCodeDisclosure: document.getElementById('dead-code-disclosure'),
    gatesCountLabel: document.getElementById('gates-count-label'),
    gatesTbody: document.getElementById('gates-tbody'),
    shadowCountLabel: document.getElementById('shadow-count-label'),
    shadowFeedList: document.getElementById('shadow-feed-list'),

    tradesCountLabel: document.getElementById('trades-count-label'),
    tradesTbody: document.getElementById('trades-tbody'),

    paritySummaryStrip: document.getElementById('parity-summary-strip'),
    notificationsTbody: document.getElementById('notifications-tbody'),
    incidentsCountLabel: document.getElementById('incidents-count-label'),
    incidentsTbody: document.getElementById('incidents-tbody'),

    detailModal: document.getElementById('detail-modal'),
    detailModalTitle: document.getElementById('detail-modal-title'),
    detailModalSubtitle: document.getElementById('detail-modal-subtitle'),
    detailModalClose: document.getElementById('detail-modal-close'),
    detailModalBody: document.getElementById('detail-modal-body'),
  };

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTs(ms) {
    if (ms === null || ms === undefined) return '—';
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return '—';
    return new Date(n).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatAge(ms) {
    if (ms === null || ms === undefined) return '—';
    const s = Math.floor(Number(ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }

  function formatNullableNum(val, digits = 2) {
    if (val === null || val === undefined) return '<span class="muted">NULL</span>';
    const n = Number(val);
    if (!Number.isFinite(n)) return '<span class="muted">NULL</span>';
    return n.toFixed(digits);
  }

  function stateBadgeClass(status) {
    const s = String(status || '').toUpperCase();
    if (['HEALTHY', 'CONNECTED', 'PASS', 'PARITY_OK', 'MATCHED', 'FINAL_APPROVED', 'ELIGIBLE', 'PROTECTED'].includes(s)) return 'badge-healthy';
    if (['FAIL', 'CRITICAL', 'PARITY_MISMATCH', 'MISMATCH', 'D1_ERRORS', 'ERROR', 'FCM_FAILED', 'EXECUTION_FAILED'].includes(s)) return 'badge-fail';
    if (['STALE', 'DEGRADED', 'WARN', 'PENDING_ANDROID', 'PENDING_BACKEND', 'BYBIT_ACKED', 'POST_CHECK_MISSING', 'DLQ_NONZERO', 'DEGRADED_LAG', 'SUPPRESSED_PRECHECK', 'DROPPED_ON_ANDROID'].includes(s)) return 'badge-warn';
    if (['ELIGIBLE_OS_UNPROVABLE', 'SHADOW', 'WARM', 'SIGNAL_ONLY', 'INTENT_RESERVED', 'SUBMITTED_PENDING_ACK', 'FILL_CONFIRMED'].includes(s)) return 'badge-info';
    return 'badge-disconnected';
  }

  function parseJwtClaims(token) {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(b64));
    } catch {
      return null;
    }
  }

  async function apiGet(path, paramsObj = {}) {
    const url = new URL(`${state.apiUrl.replace(/\/+$/, '')}${path}`);
    for (const [k, v] of Object.entries(paramsObj)) {
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        url.searchParams.set(k, String(v).trim());
      }
    }

    const headers = { 'X-CryptoPulse-Admin': '1' };
    if (state.jwtToken) headers['Authorization'] = `Bearer ${state.jwtToken}`;
    const deviceToken = localStorage.getItem('cp_device_session');
    if (deviceToken) headers['X-Device-Session'] = deviceToken;

    let res = await fetch(url.toString(), { method: 'GET', credentials: 'include', headers });
    if (res.status === 401) {
      const refreshed = await attemptRefreshToken();
      if (refreshed) {
        headers['Authorization'] = `Bearer ${state.jwtToken}`;
        res = await fetch(url.toString(), { method: 'GET', credentials: 'include', headers });
      }
    }

    if (res.status === 401 || res.status === 403) {
      handleUnauthorized();
      throw new Error(`Authentication failed (${res.status})`);
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || errBody.message || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function handleUnauthorized() {
    sessionStorage.removeItem('cp_monitoring_jwt');
    sessionStorage.removeItem('cp_monitoring_admin_key');
    state.jwtToken = '';
    stopPolling();
    el.app.classList.add('hidden');
    el.loginModal.classList.remove('hidden');
    el.loginError.textContent = 'Session expired or unauthorized. Authenticate read-only admin session.';
    el.loginError.classList.remove('hidden');
  }

  function enterAuthenticatedState(label) {
    el.loginModal.classList.add('hidden');
    el.app.classList.remove('hidden');
    el.sessionIdentityLabel.textContent = `Read-Only Session: ${label} • Gateway: ${state.apiUrl}`;
    refreshAll(true);
    startPolling();
  }

  async function handleActivationFlow(token) {
    el.loginError.classList.add('hidden');
    el.loginModal.classList.remove('hidden');
    const submitBtn = el.loginForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Enrolling Device...';

    try {
      const res = await fetch(`${state.apiUrl.replace(/\/+$/, '')}/api/admin/activate-device`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CryptoPulse-Admin': '1' },
        body: JSON.stringify({
          activationToken: token,
          deviceName: navigator.userAgent.includes('Mobile') ? 'Mobile Browser' : 'Personal Browser',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Activation failed (${res.status})`);
      }
      const data = await res.json();
      state.jwtToken = data.accessToken;
      sessionStorage.setItem('cp_monitoring_jwt', data.accessToken);
      if (data.deviceToken) localStorage.setItem('cp_device_session', data.deviceToken);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      enterAuthenticatedState(data.user?.deviceName || 'Authorized Device');
    } catch (err) {
      el.loginError.textContent = err.message || 'Activation failed.';
      el.loginError.classList.remove('hidden');
    } finally {
      if (submitBtn) submitBtn.textContent = 'Authenticate Read-Only Session';
    }
  }

  async function attemptRefreshToken() {
    try {
      const storedDeviceToken = localStorage.getItem('cp_device_session') || '';
      const headers = { 'Content-Type': 'application/json', 'X-CryptoPulse-Admin': '1' };
      if (storedDeviceToken) headers['X-Device-Session'] = storedDeviceToken;
      const res = await fetch(`${state.apiUrl.replace(/\/+$/, '')}/api/admin/session/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ deviceToken: storedDeviceToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.accessToken) return false;
      state.jwtToken = data.accessToken;
      sessionStorage.setItem('cp_monitoring_jwt', data.accessToken);
      if (data.deviceToken) localStorage.setItem('cp_device_session', data.deviceToken);
      return true;
    } catch {
      return false;
    }
  }

  async function initAuth() {
    el.apiUrlInput.value = state.apiUrl;
    const hash = window.location.hash || '';
    const match = hash.match(/#(?:activate|bootstrap)=([^&]+)/);
    if (match && match[1]) {
      await handleActivationFlow(decodeURIComponent(match[1]));
      return;
    }

    if (state.jwtToken) {
      const claims = parseJwtClaims(state.jwtToken);
      const nowSec = Math.floor(Date.now() / 1000);
      if (claims && (!claims.exp || claims.exp > nowSec + 30)) {
        enterAuthenticatedState(claims.sub || 'admin');
        return;
      }
    }

    const ok = await attemptRefreshToken();
    if (ok) {
      enterAuthenticatedState('Authorized Device');
    } else {
      el.loginModal.classList.remove('hidden');
    }
  }

  function readFiltersFromInputs() {
    state.filters.traceId = el.filterTraceId.value.trim();
    state.filters.cycleId = el.filterCycleId.value.trim();
    state.filters.discoveryCycleId = el.filterDiscoveryId.value.trim();
    state.filters.symbol = el.filterSymbol.value.trim();
    state.filters.journey = el.filterJourney.value;
    state.filters.environment = el.filterEnv.value;
    state.filters.windowMinutes = el.filterWindow.value || '60';
    state.filters.taStatus = el.taStatusFilter.value;
    state.filters.taEngine = el.taEngineFilter.value;
  }

  function renderOverview(data) {
    const verdict = data.overallVerdict || 'NO_TELEMETRY';
    el.overallVerdictBadge.className = `badge ${stateBadgeClass(verdict)}`;
    el.overallVerdictBadge.textContent = verdict;
    el.shVerdict.textContent = verdict;
    el.overviewWindowLabel.textContent = `Window: ${Number(data.windowMinutes || 60)}m`;

    const sh = data.selfHealth || {};
    el.shConsumerState.textContent = sh.honestState || 'NO_DATA';
    el.shCounts.textContent = `${Number(sh.eventsReceived || 0)} / ${Number(sh.eventsInserted || 0)} / ${Number(sh.eventsDeduped || 0)}`;
    el.shLag.textContent = `${sh.avgIngestLagMs != null ? Number(sh.avgIngestLagMs).toFixed(1) : '—'} / ${sh.maxIngestLagMs != null ? Number(sh.maxIngestLagMs).toFixed(1) : '—'} ms`;
    el.shErrors.textContent = `${Number(sh.dlqCount || 0)} / ${Number(sh.d1WriteErrors || 0)}`;
    el.shLastPolled.textContent = formatTs(Date.now());

    const stages = Array.isArray(data.stages) ? data.stages : [];
    el.stagesStrip.innerHTML = stages
      .map((s) => {
        const hs = escapeHtml(s.honestState);
        const latestCtx = s.latestSymbol ? ` • ${escapeHtml(s.latestSymbol)}` : '';
        const errCode = s.latestErrorCode ? ` [${escapeHtml(s.latestErrorCode)}]` : '';
        return `
          <div class="stage-card state-${hs}" data-jump-stage="${Number(s.stage)}">
            <div class="stage-top">
              <span class="stage-num">STAGE ${Number(s.stage)}</span>
              <span class="badge ${stateBadgeClass(s.honestState)}">${hs}</span>
            </div>
            <div class="stage-title">${escapeHtml(s.name)}</div>
            <div class="stage-counts">P:${Number(s.passCount)} W:${Number(s.warnCount)} F:${Number(s.failCount)} S:${Number(s.skippedCount)} (${escapeHtml(formatAge(s.ageMs))})</div>
            <div class="stage-msg" title="${escapeHtml(s.latestMessage)}">${escapeHtml(s.latestEventType || 'IDLE')}${latestCtx}${errCode}: ${escapeHtml(s.latestMessage)}</div>
          </div>
        `;
      })
      .join('');

    renderExchangeCard(data.exchangeHealth?.publicMarketData, el.pubExchBadge, el.pubExchBody, true);
    renderExchangeCard(data.exchangeHealth?.privateAccount, el.privExchBadge, el.privExchBody, false);
    renderHandoffSummary(data.journeys);
  }

  function renderExchangeCard(ch, badgeEl, bodyEl, isPublic) {
    if (!ch) {
      badgeEl.className = 'badge badge-disconnected';
      badgeEl.textContent = 'DISCONNECTED';
      bodyEl.innerHTML = '<div class="muted">No telemetry recorded.</div>';
      return;
    }
    badgeEl.className = `badge ${stateBadgeClass(ch.honestState)}`;
    badgeEl.textContent = ch.honestState || 'DISCONNECTED';

    const boxes = isPublic
      ? [
          ['Endpoint / Tier', `${ch.endpoint || '—'} (${ch.cacheTier || 'NONE'})`],
          ['HTTP / RetCode', `${ch.httpStatus ?? '—'} / ${ch.retCode ?? '—'}`],
          ['Latency', ch.latencyMs != null ? `${Number(ch.latencyMs).toFixed(1)} ms` : '—'],
          ['Instruments (Rx/Req)', `${ch.instrumentsReceived ?? '—'} / ${ch.instrumentsRequested ?? '—'}`],
          ['Stale / Invalid', `${ch.staleCount ?? 0} / ${ch.invalidCount ?? 0}`],
          ['Last Seen', `${formatTs(ch.recordedAtMs)} (${formatAge(ch.ageMs)})`],
        ]
      : [
          ['Channel / Endpoint', `${ch.channel || '—'} ${ch.endpoint || ''}`],
          ['HTTP / RetCode', `${ch.httpStatus ?? '—'} / ${ch.retCode ?? '—'}`],
          ['Latency / Retries', `${ch.latencyMs != null ? `${Number(ch.latencyMs).toFixed(1)} ms` : '—'} (${ch.retryCount ?? 0} retries)`],
          ['Scheduler Tokens', ch.tokensRemaining != null ? String(ch.tokensRemaining) : '—'],
          ['Rate Limit Rem', ch.rateLimitRemaining != null ? `${ch.rateLimitRemaining}/${ch.rateLimitLimit ?? '?'}` : '—'],
          ['Last Seen', `${formatTs(ch.recordedAtMs)} (${formatAge(ch.ageMs)})`],
        ];

    bodyEl.innerHTML = boxes
      .map(([k, v]) => `<div class="kv-box"><span>${escapeHtml(k)}</span><strong>${escapeHtml(v)}</strong></div>`)
      .join('');
  }

  function renderHandoffSummary(journeys) {
    const disc = journeys?.latestDiscovery || null;
    const auto = journeys?.latestAutonomous || null;
    const ho = journeys?.handoff || {};
    const s2 = journeys?.stage2Summary || null;

    const leaked = Number(s2?.leakedCount || 0);
    el.stage2LeakBadge.className = s2
      ? leaked > 0
        ? 'badge badge-fail'
        : 'badge badge-healthy'
      : 'badge badge-disconnected';
    el.stage2LeakBadge.textContent = s2
      ? leaked > 0
        ? `LEAK DETECTED (${leaked})`
        : 'ZERO STAGE-2 LEAKS VERIFIED'
      : 'NO STAGE-2 DATA';

    el.handoffSummaryGrid.innerHTML = `
      <div class="subcard">
        <div class="subcard-header">
          <h4>Journey A — Discovery Scan</h4>
          <span class="badge ${stateBadgeClass(disc?.overallStatus || 'DISCONNECTED')}">${escapeHtml(disc?.overallStatus || 'NO_DATA')}</span>
        </div>
        <div class="kv-grid">
          <div class="kv-box"><span>Discovery Cycle</span><strong>${escapeHtml(disc?.discoveryCycleId || '—')}</strong></div>
          <div class="kv-box"><span>Approval Gen</span><strong>${disc?.approvalGeneration ?? '—'}</strong></div>
          <div class="kv-box"><span>Accepted / Total</span><strong>${s2 ? `${s2.eligibleCount} / ${s2.total}` : '—'}</strong></div>
          <div class="kv-box"><span>Updated</span><strong>${escapeHtml(formatTs(disc?.updatedAtMs))}</strong></div>
        </div>
      </div>

      <div class="handoff-arrow">
        <span class="badge ${ho.handoffLinked ? 'badge-healthy' : 'badge-warn'}">${ho.handoffLinked ? 'HANDOFF VERIFIED' : 'HANDOFF UNLINKED'}</span>
        <div class="mono small-text top-gap">Gen ${ho.latestDiscoveryApprovalGeneration ?? '—'} &rarr; Parent ${ho.parentApprovalGeneration ?? '—'}</div>
        <div class="muted small-text">${escapeHtml(ho.linkedDiscoveryCycleId || 'No matching discovery link')}</div>
      </div>

      <div class="subcard">
        <div class="subcard-header">
          <h4>Journey B — Autonomous Evaluation</h4>
          <span class="badge ${stateBadgeClass(auto?.overallStatus || 'DISCONNECTED')}">${escapeHtml(auto?.overallStatus || 'NO_DATA')}</span>
        </div>
        <div class="kv-grid">
          <div class="kv-box"><span>Cycle / Trace</span><strong>${escapeHtml(auto?.cycleId || '—')}</strong></div>
          <div class="kv-box"><span>Parent Approval Gen</span><strong>${auto?.parentApprovalGeneration ?? '—'}</strong></div>
          <div class="kv-box"><span>Furthest Stage</span><strong>Stage ${auto?.furthestStage ?? '—'}</strong></div>
          <div class="kv-box"><span>Updated</span><strong>${escapeHtml(formatTs(auto?.updatedAtMs))}</strong></div>
        </div>
      </div>
    `;
  }

  function renderStage2AndTa(data) {
    const s2Leak = data.stage2LeakCheck || {};
    const decisions = Array.isArray(data.stage2Decisions) ? data.stage2Decisions : [];

    if (Number(s2Leak.downstreamLeakedCount || 0) > 0) {
      el.stage2LeakBadge.className = 'badge badge-fail';
      el.stage2LeakBadge.textContent = `LEAK DETECTED (${Number(s2Leak.downstreamLeakedCount)})`;
    } else if (decisions.length > 0) {
      el.stage2LeakBadge.className = 'badge badge-healthy';
      el.stage2LeakBadge.textContent = `0 LEAKS / ${decisions.length} CHECKS`;
    }

    el.stage2DecisionsTbody.innerHTML =
      decisions.length === 0
        ? '<tr><td colspan="8" class="muted">No Stage 2 budget/symbol eligibility decisions in filter scope.</td></tr>'
        : decisions
            .map(
              (d) => `
          <tr>
            <td class="mono"><strong>${escapeHtml(d.symbol)}</strong></td>
            <td><span class="badge ${stateBadgeClass(d.eligible ? 'ELIGIBLE' : 'FAIL')}">${escapeHtml(d.decisionOutcome)}</span></td>
            <td class="mono">${escapeHtml(d.rejectionReason || '—')}</td>
            <td class="mono">$${formatNullableNum(d.allocatedBudgetUsdt)} / ${formatNullableNum(d.lastPrice, 4)}</td>
            <td class="mono">${formatNullableNum(d.minOrderQty, 4)} / $${formatNullableNum(d.minNotionalValue, 2)} / ${formatNullableNum(d.qtyStep, 4)}</td>
            <td class="mono">${formatNullableNum(d.computedQty, 4)} ($${formatNullableNum(d.computedNotional, 2)})</td>
            <td class="mono">G${d.approvalGeneration ?? '—'} ${escapeHtml(d.discoveryCycleId || d.cycleId || '')}</td>
            <td>${d.downstreamLeaked ? '<span class="badge badge-fail">LEAKED</span>' : '<span class="badge badge-healthy">ISOLATED</span>'}</td>
          </tr>
        `
            )
            .join('');

    const taItems = Array.isArray(data.items) ? data.items : [];
    el.taTbody.innerHTML =
      taItems.length === 0
        ? '<tr><td colspan="10" class="muted">No TA indicator snapshots match current filters.</td></tr>'
        : taItems
            .map(
              (t) => `
          <tr>
            <td class="mono"><strong>${escapeHtml(t.symbol)}</strong> <span class="badge badge-info">${escapeHtml(t.timeframe)}</span></td>
            <td class="mono">${escapeHtml(t.indicatorEngine)}</td>
            <td>
              <span class="badge ${stateBadgeClass(t.status)}">${escapeHtml(t.status)}</span>
              ${t.skipReason ? `<div class="mono muted">${escapeHtml(t.skipReason)}</div>` : ''}
            </td>
            <td class="mono">${t.candlesCount ?? '—'} / ${t.minRequiredBars ?? '—'}</td>
            <td class="mono">${formatNullableNum(t.rsi, 2)}</td>
            <td class="mono">${formatNullableNum(t.ema21, 2)}</td>
            <td class="mono">${formatNullableNum(t.adx, 2)}</td>
            <td class="mono">${formatNullableNum(t.vwap, 2)}</td>
            <td class="mono">${escapeHtml(t.regime || '—')}</td>
            <td>${t.antiFabricationVerified ? '<span class="badge badge-healthy">VERIFIED</span>' : '<span class="badge badge-fail">FABRICATED_NUM</span>'}</td>
          </tr>
        `
            )
            .join('');
  }

  function renderTraces(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    el.tracesCountLabel.textContent = `${Number(data.total || items.length)} total traces (showing ${items.length})`;
    el.tracesTbody.innerHTML =
      items.length === 0
        ? '<tr><td colspan="6" class="muted">No pipeline cycles recorded in filter scope.</td></tr>'
        : items
            .map((c) => {
              const lookupId = c.traceId || c.cycleId || c.discoveryCycleId || c.traceKey;
              const isSelected = state.selectedTraceId && state.selectedTraceId === lookupId;
              return `
                <tr class="${isSelected ? 'row-selected' : ''}" data-trace-lookup="${escapeHtml(lookupId)}">
                  <td><span class="badge badge-info">${escapeHtml(c.journey)}</span></td>
                  <td class="mono"><strong>${escapeHtml(c.cycleId || c.discoveryCycleId || c.traceKey)}</strong><div class="muted">${escapeHtml(c.traceId || '')}</div></td>
                  <td class="mono">${c.approvalGeneration != null ? `A:${c.approvalGeneration}` : c.parentApprovalGeneration != null ? `P:${c.parentApprovalGeneration}` : '—'}</td>
                  <td><span class="badge ${stateBadgeClass(c.overallStatus)}">${escapeHtml(c.overallStatus)}</span></td>
                  <td class="mono">S${c.furthestStage}${c.failedStage ? ` (Fail S${c.failedStage})` : ''}</td>
                  <td class="mono">${escapeHtml(formatTs(c.updatedAtMs))}</td>
                </tr>
              `;
            })
            .join('');
  }

  function renderTraceInspector(detail) {
    const c = detail.cycle;
    const spans = Array.isArray(detail.spans) ? detail.spans : [];
    const up = detail.handoff?.upstreamDiscovery;
    const down = Array.isArray(detail.handoff?.downstreamAutonomousCycles) ? detail.handoff.downstreamAutonomousCycles : [];

    const handoffHtml = `
      <div class="summary-chips" style="margin-bottom:10px;">
        ${
          up
            ? `<button type="button" class="btn btn-sm btn-secondary" data-trace-lookup="${escapeHtml(up.discoveryCycleId || up.traceKey)}">&larr; Upstream Discovery: ${escapeHtml(up.discoveryCycleId)} (Gen ${up.approvalGeneration ?? '?'})</button>`
            : ''
        }
        ${down
          .map(
            (d) =>
              `<button type="button" class="btn btn-sm btn-secondary" data-trace-lookup="${escapeHtml(d.traceId || d.cycleId || d.traceKey)}">&rarr; Child Autonomous: ${escapeHtml(d.cycleId || d.traceId)} (S${d.furthestStage})</button>`
          )
          .join('')}
      </div>
    `;

    const spansHtml =
      spans.length === 0
        ? '<div class="muted">No spans attached to this trace.</div>'
        : spans
            .map(
              (sp) => `
          <div class="span-row status-${escapeHtml(sp.status)}">
            <div class="span-row-head">
              <div>
                <span class="badge badge-info">S${Number(sp.stage)}#${Number(sp.stageSeq || 0)}</span>
                <strong class="mono">${escapeHtml(sp.eventType)}</strong>
                ${sp.symbol ? `<span class="badge badge-disconnected">${escapeHtml(sp.symbol)} ${escapeHtml(sp.timeframe || '')}</span>` : ''}
              </div>
              <div>
                <span class="badge ${stateBadgeClass(sp.status)}">${escapeHtml(sp.status)}</span>
                <span class="badge badge-disconnected">${escapeHtml(sp.deliveryMilestone || 'D1_COMMITTED')}</span>
              </div>
            </div>
            <div class="span-row-meta">
              ${escapeHtml(sp.component)}${sp.sourceFile ? ` (${escapeHtml(sp.sourceFile)})` : ''} • ${escapeHtml(formatTs(sp.emittedAtMs))}${sp.durationMs != null ? ` • ${Number(sp.durationMs).toFixed(1)}ms` : ''}${sp.errorCode ? ` • ERR:${escapeHtml(sp.errorCode)}` : ''}
            </div>
            <div style="margin-top:4px;">${escapeHtml(sp.message)}</div>
            ${
              sp.inputSummary || sp.outputSummary
                ? `<pre class="span-json">${escapeHtml(JSON.stringify({ input: sp.inputSummary, output: sp.outputSummary }, null, 2))}</pre>`
                : ''
            }
          </div>
        `
            )
            .join('');

    el.traceInspectorPane.innerHTML = `
      <div class="subcard-header">
        <h4>Trace Detail: ${escapeHtml(c?.cycleId || c?.discoveryCycleId || c?.traceId || 'Spans')}</h4>
        <span class="badge ${stateBadgeClass(c?.overallStatus || 'INFO')}">${escapeHtml(c?.overallStatus || 'SPANS_ONLY')} (${spans.length} spans)</span>
      </div>
      ${handoffHtml}
      ${spansHtml}
    `;
  }

  function renderStrategiesAndGates(data) {
    const dead = Array.isArray(data.deadUnwiredComponents) ? data.deadUnwiredComponents : [];
    el.deadCodeDisclosure.innerHTML = dead
      .map(
        (d) => `
        <div class="disclosure-card">
          <div class="subcard-header">
            <strong class="mono">${escapeHtml(d.name)}</strong>
            <span class="badge badge-warn">${escapeHtml(d.status)}</span>
          </div>
          <div class="mono muted small-text">${escapeHtml(d.sourceFile)}</div>
          <div class="small-text" style="margin-top:4px;">${escapeHtml(d.reason)}</div>
        </div>
      `
      )
      .join('');

    const gates = Array.isArray(data.gateEvaluations) ? data.gateEvaluations : [];
    el.gatesCountLabel.textContent = `${Number(data.total || gates.length)} evaluations`;
    el.gatesTbody.innerHTML =
      gates.length === 0
        ? '<tr><td colspan="5" class="muted">No Stage 5/6 gate evaluations recorded in scope.</td></tr>'
        : gates
            .map(
              (g) => `
          <tr>
            <td class="mono"><strong>S${Number(g.stage)} ${escapeHtml(g.gateName)}</strong><div class="muted">${escapeHtml(g.gateCategory)}</div></td>
            <td><span class="badge ${stateBadgeClass(g.decision === 'PASS' || g.decision === 'ALLOWED' ? 'PASS' : 'FAIL')}">${escapeHtml(g.decision)}</span></td>
            <td class="mono">${escapeHtml(g.symbol || '—')}<div class="muted">${escapeHtml(g.strategyId || '')} ${escapeHtml(g.timeframe || '')}</div></td>
            <td class="mono small-text">${escapeHtml(g.reason || '—')}<div class="muted">${escapeHtml(g.sourceFile || '')}</div></td>
            <td class="mono">${escapeHtml(formatTs(g.evaluatedAtMs))}</td>
          </tr>
        `
            )
            .join('');

    const shadows = Array.isArray(data.shadowModeComparisons) ? data.shadowModeComparisons : [];
    el.shadowCountLabel.textContent = `${shadows.length} shadow spans`;
    el.shadowFeedList.innerHTML =
      shadows.length === 0
        ? '<div class="muted">No SignalLifecycleManager SHADOW comparisons observed yet.</div>'
        : shadows
            .map(
              (s) => `
          <div class="span-row status-${escapeHtml(s.status)}">
            <div class="span-row-head">
              <strong class="mono">${escapeHtml(s.eventType)} — ${escapeHtml(s.symbol || '—')}</strong>
              <span class="badge ${stateBadgeClass(s.status)}">${escapeHtml(s.status)}</span>
            </div>
            <div class="small-text">${escapeHtml(s.message)}</div>
            ${s.outputSummary ? `<pre class="span-json">${escapeHtml(JSON.stringify(s.outputSummary, null, 2))}</pre>` : ''}
          </div>
        `
            )
            .join('');
  }

  function renderTrades(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    el.tradesCountLabel.textContent = `${Number(data.total || items.length)} tracked orders`;
    el.tradesTbody.innerHTML =
      items.length === 0
        ? '<tr><td colspan="7" class="muted">No Stage 7 order lifecycles recorded in scope.</td></tr>'
        : items
            .map((t) => {
              const m = t.milestones || {};
              const pills = [
                ['SIG', m.signalDetectedAtMs],
                ['ALRT', m.tradeAlertCreatedAtMs],
                ['WAL', m.orderIntentReservedAtMs],
                ['SENT', m.orderSubmitDispatchedAtMs],
                ['ACK', m.bybitHttpAckAtMs, t.isAckOnly ? 'ack' : 'done'],
                ['RECON', m.reconciliationAttemptedAtMs],
                ['FILL', m.exchangeFillConfirmedAtMs],
                ['SLTP', m.exchangeSlTpConfirmedAtMs],
                ['D1', m.positionD1SyncedAtMs],
              ]
                .map(([label, ts, forceCls]) => {
                  const cls = ts ? forceCls || 'done' : m.terminalFailedAtMs ? 'fail' : '';
                  return `<span class="ms-pill ${cls}" title="${ts ? escapeHtml(formatTs(ts)) : 'Not reached'}">${escapeHtml(label)}</span>`;
                })
                .join('');

              const ackFillBadge = t.hasFillConfirmation
                ? '<span class="badge badge-healthy">FILL CONFIRMED</span>'
                : t.isAckOnly
                  ? '<span class="badge badge-warn">ACK ONLY — NOT FILLED</span>'
                  : m.terminalFailedAtMs
                    ? '<span class="badge badge-fail">TERMINAL FAIL</span>'
                    : '<span class="badge badge-disconnected">IN FLIGHT / NO FILL</span>';

              return `
                <tr data-trade-id="${escapeHtml(t.tradeKey || t.orderId || t.alertId)}">
                  <td class="mono"><strong>${escapeHtml(t.symbol)}</strong> <span class="badge badge-info">${escapeHtml(t.side || '?')}</span><div class="muted">${escapeHtml(t.strategyId || '')}</div></td>
                  <td class="mono small-text">A:${escapeHtml(t.alertId || '—')}<div class="muted">O:${escapeHtml(t.orderId || '—')}</div></td>
                  <td><span class="badge ${stateBadgeClass(t.executionStatus)}">${escapeHtml(t.currentMilestone)}</span><div class="mono muted">${escapeHtml(t.executionStatus)}</div></td>
                  <td>${ackFillBadge}${t.bybitRetCode != null ? `<div class="mono muted">ret=${t.bybitRetCode} ${escapeHtml(t.bybitRetMsg || '')}</div>` : ''}</td>
                  <td class="mono">${formatNullableNum(t.requestedQty, 4)} / ${formatNullableNum(t.filledQty, 4)}<div class="muted">@ ${formatNullableNum(t.avgFillPrice ?? t.requestedPrice, 2)}</div></td>
                  <td class="mono">${formatNullableNum(t.slPrice, 2)} / ${formatNullableNum(t.tpPrice, 2)}</td>
                  <td><div class="milestone-strip">${pills}</div></td>
                </tr>
              `;
            })
            .join('');
  }

  function renderNotifications(data) {
    const s = data.summary || {};
    el.paritySummaryStrip.innerHTML = [
      ['Total', s.total || 0],
      ['Parity OK', s.parityOkCount ?? s.matchedCount ?? 0],
      ['Parity Mismatch', s.parityMismatchCount ?? s.mismatchCount ?? 0],
      ['Pending Android', s.pendingAndroidCount || 0],
      ['Pending Backend', s.pendingBackendCount || 0],
      ['Dropped on Android', s.droppedOnAndroidCount || 0],
      ['FCM Failed', s.fcmFailedCount || 0],
      ['Eligible (OS Unprovable)', s.eligibleOsUnprovableCount || 0],
      ['Post-Check Missing', s.postCheckMissingCount || 0],
      ['Suppressed Precheck', s.suppressedPrecheckCount || 0],
    ]
      .map(([k, v]) => `<div class="chip-box">${escapeHtml(k)}: <strong>${Number(v)}</strong></div>`)
      .join('');

    const items = Array.isArray(data.items) ? data.items : [];
    el.notificationsTbody.innerHTML =
      items.length === 0
        ? '<tr><td colspan="6" class="muted">No Stage 8/9 notification parity records found.</td></tr>'
        : items
            .map((n) => {
              const mismatches = Array.isArray(n.parityMismatches) ? n.parityMismatches : [];
              return `
                <tr>
                  <td class="mono small-text"><strong>${escapeHtml(n.alertId || n.correlationKey)}</strong><div class="muted">${escapeHtml(n.fcmMessageId || 'No FCM ID')}</div></td>
                  <td class="mono">${escapeHtml(n.symbol || '—')}<div class="muted">${escapeHtml(n.strategyId || '—')} • ${escapeHtml(n.timeframe || 'NO_TF')}</div></td>
                  <td class="mono small-text">${escapeHtml(n.backendEventType || '—')}<div class="muted">HTTP ${n.fcmHttpStatus ?? '—'} • ${escapeHtml(formatTs(n.backendDispatchedAtMs))}</div></td>
                  <td class="mono small-text">${escapeHtml(n.androidSource || 'NONE')} • ${escapeHtml(n.androidDedupOutcome || '—')}<div class="muted">Val: ${escapeHtml(n.androidValidationOutcome || '—')}</div></td>
                  <td><span class="badge ${stateBadgeClass(n.androidOsHeadsUpState)}">${escapeHtml(n.androidOsHeadsUpState || 'UNKNOWN')}</span>${n.androidEligibilityReason ? `<div class="mono muted">${escapeHtml(n.androidEligibilityReason)}</div>` : ''}</td>
                  <td>
                    <span class="badge ${stateBadgeClass(n.parityStatus)}">${escapeHtml(n.parityStatus)}</span>
                    ${mismatches.length > 0 ? `<div class="mono" style="color:#fca5a5;">${escapeHtml(mismatches.join(', '))}</div>` : ''}
                  </td>
                </tr>
              `;
            })
            .join('');
  }

  function renderIncidents(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    el.incidentsCountLabel.textContent = `${Number(data.total || items.length)} incidents (read-only)`;
    el.incidentsTbody.innerHTML =
      items.length === 0
        ? '<tr><td colspan="7" class="muted">No Stage errors or data quality incidents recorded in scope.</td></tr>'
        : items
            .map(
              (inc) => `
          <tr data-incident-fp="${escapeHtml(inc.fingerprint)}">
            <td><span class="badge ${stateBadgeClass(inc.severity)}">${escapeHtml(inc.severity)}</span></td>
            <td class="mono">S${Number(inc.stage)}</td>
            <td class="mono"><strong>${escapeHtml(inc.component)}</strong><div class="muted">${escapeHtml(inc.eventType)}</div></td>
            <td class="mono">${escapeHtml(inc.symbol || '—')}<div class="muted">${escapeHtml(inc.errorCode || '—')}</div></td>
            <td class="mono">${Number(inc.occurrenceCount || 1)}</td>
            <td>${escapeHtml(inc.latestMessage)}</td>
            <td class="mono">${escapeHtml(formatTs(inc.lastSeenAtMs))}</td>
          </tr>
        `
            )
            .join('');
  }

  function renderLiveProbe(data) {
    const status = data.backendProbeStatus || 'UNKNOWN';
    el.probeStatusBadge.className = `badge ${stateBadgeClass(status === 'CONNECTED' ? 'HEALTHY' : 'WARN')}`;
    el.probeStatusBadge.textContent = status;
    el.liveProbeBody.innerHTML = `
      <pre class="span-json">${escapeHtml(
        JSON.stringify(
          {
            probedAt: formatTs(data.probedAtMs),
            neverCallsExchange: data.neverCallsExchange,
            requestedUserId: data.requestedUserId,
            backendProbeStatus: data.backendProbeStatus,
            probeError: data.probeError,
            workerHealth: data.workerHealth,
            coordinatorStats: data.coordinatorStats,
            tradingBotState: data.tradingBotState,
            recentHeartbeatCount: Array.isArray(data.recentHeartbeats) ? data.recentHeartbeats.length : 0,
          },
          null,
          2
        )
      )}</pre>
    `;
  }

  async function openTraceDetail(traceLookupId) {
    state.selectedTraceId = traceLookupId;
    el.traceInspectorPane.innerHTML = '<div class="muted">Loading trace spans...</div>';
    try {
      const detail = await apiGet(`/api/admin/monitor/v2/traces/${encodeURIComponent(traceLookupId)}`);
      renderTraceInspector(detail);
    } catch (err) {
      el.traceInspectorPane.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  async function openTradeModal(tradeId) {
    el.detailModalTitle.textContent = 'Stage 7 Order Lifecycle (Read-Only)';
    el.detailModalSubtitle.textContent = tradeId;
    el.detailModalBody.innerHTML = '<div class="muted">Loading trade lifecycle...</div>';
    el.detailModal.classList.remove('hidden');
    try {
      const detail = await apiGet(`/api/admin/monitor/v2/trades/${encodeURIComponent(tradeId)}`);
      el.detailModalBody.innerHTML = `
        <div class="subcard">
          <h4>Order Milestones &amp; Exchange Response</h4>
          <pre class="span-json">${escapeHtml(JSON.stringify(detail.trade, null, 2))}</pre>
        </div>
        <div class="subcard top-gap">
          <h4>Correlated Spans (${(detail.spans || []).length})</h4>
          <pre class="span-json">${escapeHtml(JSON.stringify(detail.spans, null, 2))}</pre>
        </div>
        <div class="subcard top-gap">
          <h4>Linked Notification Parity (${(detail.notifications || []).length})</h4>
          <pre class="span-json">${escapeHtml(JSON.stringify(detail.notifications, null, 2))}</pre>
        </div>
      `;
    } catch (err) {
      el.detailModalBody.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  async function openIncidentModal(fingerprint) {
    el.detailModalTitle.textContent = 'Read-Only Incident Forensic Detail';
    el.detailModalSubtitle.textContent = fingerprint;
    el.detailModalBody.innerHTML = '<div class="muted">Loading incident detail...</div>';
    el.detailModal.classList.remove('hidden');
    try {
      const detail = await apiGet(`/api/admin/monitor/v2/incidents/${encodeURIComponent(fingerprint)}`);
      el.detailModalBody.innerHTML = `
        <div class="subcard">
          <h4>Incident Summary (Strictly Immutable)</h4>
          <pre class="span-json">${escapeHtml(JSON.stringify(detail.incident, null, 2))}</pre>
        </div>
        <div class="subcard top-gap">
          <h4>Recent Occurrences (${(detail.recentOccurrences || []).length})</h4>
          <pre class="span-json">${escapeHtml(JSON.stringify(detail.recentOccurrences, null, 2))}</pre>
        </div>
      `;
    } catch (err) {
      el.detailModalBody.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  async function runLiveProbe() {
    try {
      const probe = await apiGet('/api/admin/monitor/v2/live-probe', {});
      renderLiveProbe(probe);
    } catch (err) {
      el.probeStatusBadge.className = 'badge badge-fail';
      el.probeStatusBadge.textContent = 'PROBE_ERROR';
      el.liveProbeBody.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  async function refreshAll(includeProbe = false) {
    if (state.isPolling || !state.jwtToken) return;
    state.isPolling = true;
    el.globalErrorBanner.classList.add('hidden');
    readFiltersFromInputs();

    const common = {
      environment: state.filters.environment,
      journey: state.filters.journey,
      symbol: state.filters.symbol,
      traceId: state.filters.traceId,
      cycleId: state.filters.cycleId,
      discoveryCycleId: state.filters.discoveryCycleId,
      windowMinutes: state.filters.windowMinutes,
    };

    try {
      const [overview, traces, ta, stratGates, trades, notifications, incidents] = await Promise.all([
        apiGet('/api/admin/monitor/v2/overview', common),
        apiGet('/api/admin/monitor/v2/traces', { ...common, limit: 25 }),
        apiGet('/api/admin/monitor/v2/ta', {
          ...common,
          status: state.filters.taStatus,
          indicatorEngine: state.filters.taEngine,
          limit: 40,
        }),
        apiGet('/api/admin/monitor/v2/strategies-gates', { ...common, limit: 40 }),
        apiGet('/api/admin/monitor/v2/trades', { ...common, limit: 40 }),
        apiGet('/api/admin/monitor/v2/notifications', { ...common, limit: 40 }),
        apiGet('/api/admin/monitor/v2/incidents', { symbol: state.filters.symbol, limit: 40 }),
      ]);

      renderOverview(overview);
      renderTraces(traces);
      renderStage2AndTa(ta);
      renderStrategiesAndGates(stratGates);
      renderTrades(trades);
      renderNotifications(notifications);
      renderIncidents(incidents);

      if (includeProbe) {
        await runLiveProbe();
      }
      if (state.selectedTraceId) {
        await openTraceDetail(state.selectedTraceId);
      }
    } catch (err) {
      el.globalErrorBanner.textContent = `Monitoring refresh error: ${err.message}`;
      el.globalErrorBanner.classList.remove('hidden');
    } finally {
      state.isPolling = false;
    }
  }

  function startPolling() {
    stopPolling();
    if (!state.autoPoll) return;
    state.pollTimer = setInterval(() => {
      if (!document.hidden) refreshAll(false);
    }, 5000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // Event wiring (strictly read-only interactions)
  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const apiUrl = el.apiUrlInput.value.trim();
    const rawInput = el.adminKeyInput.value.trim();
    if (!apiUrl || !rawInput) return;

    state.apiUrl = apiUrl;
    sessionStorage.setItem('cp_monitoring_api_url', apiUrl);
    el.loginError.classList.add('hidden');
    const submitBtn = el.loginForm.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Authenticating...';

    try {
      let tokenToUse = '';
      if (rawInput.startsWith('eyJ') && rawInput.split('.').length === 3) {
        const claims = parseJwtClaims(rawInput);
        const nowSec = Math.floor(Date.now() / 1000);
        if (!claims || (claims.exp && claims.exp <= nowSec)) {
          throw new Error('Provided administrator JWT is expired or invalid.');
        }
        tokenToUse = rawInput;
      } else {
        const loginRes = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/admin/login`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-CryptoPulse-Admin': '1' },
          body: JSON.stringify({ password: rawInput }),
        });
        if (!loginRes.ok) {
          const errData = await loginRes.json().catch(() => ({}));
          throw new Error(errData.message || `Login failed (${loginRes.status})`);
        }
        const loginData = await loginRes.json();
        if (!loginData.token) throw new Error('Backend did not return session token.');
        tokenToUse = loginData.token;
        if (loginData.deviceToken) localStorage.setItem('cp_device_session', loginData.deviceToken);
      }

      state.jwtToken = tokenToUse;
      sessionStorage.setItem('cp_monitoring_jwt', tokenToUse);
      sessionStorage.removeItem('cp_monitoring_admin_key');
      el.adminKeyInput.value = '';
      enterAuthenticatedState('Authorized Device');
    } catch (err) {
      el.loginError.textContent = err.message || 'Authentication failed.';
      el.loginError.classList.remove('hidden');
      sessionStorage.removeItem('cp_monitoring_jwt');
    } finally {
      if (submitBtn) submitBtn.textContent = 'Authenticate Read-Only Session';
    }
  });

  el.logoutBtn.addEventListener('click', async () => {
    try {
      const storedDeviceToken = localStorage.getItem('cp_device_session') || '';
      await fetch(`${state.apiUrl.replace(/\/+$/, '')}/api/admin/session/revoke`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CryptoPulse-Admin': '1',
          ...(storedDeviceToken ? { 'X-Device-Session': storedDeviceToken } : {}),
        },
        body: JSON.stringify({ deviceToken: storedDeviceToken }),
      }).catch(() => {});
    } finally {
      localStorage.removeItem('cp_device_session');
      sessionStorage.removeItem('cp_monitoring_jwt');
      handleUnauthorized();
    }
  });

  el.refreshNowBtn.addEventListener('click', () => refreshAll(true));
  el.liveProbeBtn.addEventListener('click', () => runLiveProbe());
  el.autoPollToggle.addEventListener('change', (e) => {
    state.autoPoll = Boolean(e.target.checked);
    if (state.autoPoll) startPolling();
    else stopPolling();
  });

  el.globalFilterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    refreshAll(false);
  });
  el.taStatusFilter.addEventListener('change', () => refreshAll(false));
  el.taEngineFilter.addEventListener('change', () => refreshAll(false));

  el.resetFiltersBtn.addEventListener('click', () => {
    el.filterTraceId.value = '';
    el.filterCycleId.value = '';
    el.filterDiscoveryId.value = '';
    el.filterSymbol.value = '';
    el.filterJourney.value = '';
    el.filterEnv.value = '';
    el.filterWindow.value = '60';
    el.taStatusFilter.value = '';
    el.taEngineFilter.value = '';
    state.selectedTraceId = null;
    el.traceInspectorPane.innerHTML =
      '<div class="inspector-empty muted">Select a trace row on the left to inspect ordered stage spans and handoff links.</div>';
    refreshAll(true);
  });

  el.stagesStrip.addEventListener('click', (e) => {
    const card = e.target.closest('[data-jump-stage]');
    if (!card) return;
    const st = Number(card.getAttribute('data-jump-stage'));
    const targetMap = {
      1: '#section-a',
      2: '#section-b',
      3: '#section-d',
      4: '#section-d',
      5: '#section-e',
      6: '#section-e',
      7: '#section-f',
      8: '#section-g',
      9: '#section-g',
    };
    const anchor = document.querySelector(targetMap[st] || '#section-c');
    if (anchor) anchor.scrollIntoView({ behavior: 'smooth' });
  });

  document.addEventListener('click', (e) => {
    const traceBtn = e.target.closest('[data-trace-lookup]');
    if (traceBtn) {
      const id = traceBtn.getAttribute('data-trace-lookup');
      if (id) openTraceDetail(id);
      return;
    }

    const tradeRow = e.target.closest('[data-trade-id]');
    if (tradeRow) {
      const id = tradeRow.getAttribute('data-trade-id');
      if (id) openTradeModal(id);
      return;
    }

    const incRow = e.target.closest('[data-incident-fp]');
    if (incRow) {
      const fp = incRow.getAttribute('data-incident-fp');
      if (fp) openIncidentModal(fp);
    }
  });

  el.detailModalClose.addEventListener('click', () => el.detailModal.classList.add('hidden'));
  el.detailModal.addEventListener('click', (e) => {
    if (e.target === el.detailModal) el.detailModal.classList.add('hidden');
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.autoPoll && state.jwtToken) refreshAll(false);
  });

  initAuth();
})();
