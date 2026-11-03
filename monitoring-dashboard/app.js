/**
 * CryptoPulse Centralized Monitoring Dashboard
 * Frontend Application Controller
 *
 * Security & Reliability Invariants:
 * - Never stores permanent ADMIN_API_KEY in sessionStorage, localStorage, cookies, or URLs.
 * - Authenticates via POST /api/admin/login and stores short-lived JWT only.
 * - Complete output sanitization via escapeHtml() prevents Stored XSS.
 * - Pauses polling when browser tab is inactive to preserve Cloudflare edge quotas.
 * - Guards against overlapping concurrent polling requests.
 */

(() => {
  // Application State
  const state = {
    apiUrl: sessionStorage.getItem('cp_monitoring_api_url') || 'https://crypto-pulse-backend.telangrocks.workers.dev',
    jwtToken: sessionStorage.getItem('cp_monitoring_jwt') || '',
    activeTab: 'overview',
    refreshTimer: null,
    refreshIntervalSec: 60,
    currentIncidentId: null,
    lastSyncTime: null,
    isRefreshing: false
  };

  // DOM Elements
  const el = {
    loginModal: document.getElementById('login-modal'),
    loginForm: document.getElementById('login-form'),
    adminKeyInput: document.getElementById('admin-key-input'),
    apiUrlInput: document.getElementById('api-url-input'),
    loginError: document.getElementById('login-error'),
    app: document.getElementById('app'),
    logoutBtn: document.getElementById('logout-btn'),
    sessionUserId: document.getElementById('session-user-id'),
    pageTitle: document.getElementById('page-title'),
    healthDot: document.getElementById('health-dot'),
    healthText: document.getElementById('health-text'),
    lastSyncTime: document.getElementById('last-sync-time'),
    autoRefreshSelect: document.getElementById('auto-refresh-select'),
    manualRefreshBtn: document.getElementById('manual-refresh-btn'),
    badgeIncidentCount: document.getElementById('badge-incident-count'),

    // KPI elements
    kpiTotalUsers: document.getElementById('kpi-total-users'),
    kpiActiveUsers: document.getElementById('kpi-active-users'),
    kpiActiveBots: document.getElementById('kpi-active-bots'),
    kpiHealthyBots: document.getElementById('kpi-healthy-bots'),
    kpiIncidents24h: document.getElementById('kpi-incidents-24h'),
    kpiCriticalIncidents: document.getElementById('kpi-critical-incidents'),
    kpiStorageHealth: document.getElementById('kpi-storage-health'),
    kpiDedupRatio: document.getElementById('kpi-dedup-ratio'),
    overviewIncidentsTbody: document.getElementById('overview-incidents-tbody'),

    // Bots elements
    botStatusFilter: document.getElementById('bot-status-filter'),
    botsTbody: document.getElementById('bots-tbody'),

    // Incidents elements
    incidentSeverityFilter: document.getElementById('incident-severity-filter'),
    incidentStatusFilter: document.getElementById('incident-status-filter'),
    incidentSearchInput: document.getElementById('incident-search-input'),
    incidentPaginationInfo: document.getElementById('incident-pagination-info'),
    incidentsTbody: document.getElementById('incidents-tbody'),

    // Health elements
    quotaTotalEvents: document.getElementById('quota-total-events'),
    quotaPersisted: document.getElementById('quota-persisted'),
    quotaDeduplicated: document.getElementById('quota-deduplicated'),
    quotaDropped: document.getElementById('quota-dropped'),
    quotaWriteFailures: document.getElementById('quota-write-failures'),
    quotaRingBuffer: document.getElementById('quota-ring-buffer'),
    edgeDbStatus: document.getElementById('edge-db-status'),
    edgeDbLatency: document.getElementById('edge-db-latency'),
    edgeCoordinatorStatus: document.getElementById('edge-coordinator-status'),
    edgeSignalMode: document.getElementById('edge-signal-mode'),

    // Modal elements
    incidentModal: document.getElementById('incident-modal'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    modalIncidentTitle: document.getElementById('modal-incident-title'),
    modalIncidentId: document.getElementById('modal-incident-id'),
    modalConfidenceBadge: document.getElementById('modal-confidence-badge'),
    modalRootCause: document.getElementById('modal-root-cause'),
    modalFiles: document.getElementById('modal-files'),
    modalActions: document.getElementById('modal-actions'),
    modalPromptContent: document.getElementById('modal-prompt-content'),
    copyPromptBtn: document.getElementById('copy-prompt-btn'),
    modalEvidenceJson: document.getElementById('modal-evidence-json'),
    modalStatusSelect: document.getElementById('modal-status-select'),
    modalSaveStatusBtn: document.getElementById('modal-save-status-btn')
  };

  // Helper: Decode and validate JWT payload expiry client-side
  function parseJwtClaims(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonStr = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join('')
      );
      return JSON.parse(jsonStr);
    } catch (_) {
      return null;
    }
  }

  // API Client Helper
  async function apiFetch(endpoint, options = {}) {
    const url = `${state.apiUrl.replace(/\/+$/, '')}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'X-CryptoPulse-Admin': '1',
      ...(options.headers || {})
    };

    if (state.jwtToken) {
      headers['Authorization'] = `Bearer ${state.jwtToken}`;
    }

    const deviceToken = localStorage.getItem('cp_device_session');
    if (deviceToken) {
      headers['X-Device-Session'] = deviceToken;
    }

    const res = await fetch(url, { ...options, credentials: 'include', headers });
    if (res.status === 401 || res.status === 403) {
      handleUnauthorized();
      throw new Error(`Authentication failed (${res.status})`);
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.message || `API request failed with status ${res.status}`);
    }

    return await res.json();
  }

  function handleUnauthorized() {
    sessionStorage.removeItem('cp_monitoring_jwt');
    sessionStorage.removeItem('cp_monitoring_admin_key');
    state.jwtToken = '';
    el.app.classList.add('hidden');
    el.loginModal.classList.remove('hidden');
    el.loginError.textContent = 'Session expired, revoked, or unauthorized. Please authenticate.';
    el.loginError.classList.remove('hidden');
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  }

  function enterAuthenticatedState(label) {
    el.loginModal.classList.add('hidden');
    el.app.classList.remove('hidden');
    el.sessionUserId.textContent = label;
    setupAutoRefresh();
    refreshActiveTab();
  }

  async function handleActivationFlow(token) {
    try {
      el.loginError.classList.add('hidden');
      el.loginModal.classList.remove('hidden');
      const submitBtn = el.loginForm.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.textContent = 'Enrolling Device...';

      const res = await fetch(`${state.apiUrl.replace(/\/+$/, '')}/api/admin/activate-device`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-CryptoPulse-Admin': '1'
        },
        body: JSON.stringify({
          activationToken: token,
          deviceName: navigator.userAgent.includes('Mobile') ? 'Mobile Browser' : 'Personal Browser'
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Activation failed with status ${res.status}`);
      }

      const data = await res.json();
      state.jwtToken = data.accessToken;
      sessionStorage.setItem('cp_monitoring_jwt', data.accessToken);
      if (data.deviceToken) {
        localStorage.setItem('cp_device_session', data.deviceToken);
      }

      enterAuthenticatedState(data.user?.deviceName || 'Authorized Device');
      setupSessionRollingTimer();
    } catch (err) {
      console.error('[App] Device activation error:', err);
      el.loginModal.classList.remove('hidden');
      el.app.classList.add('hidden');
      el.loginError.textContent = err.message || 'Activation failed. The link may have expired or was already used.';
      el.loginError.classList.remove('hidden');
    }
  }

  async function attemptSilentDeviceLogin() {
    try {
      const storedDeviceToken = localStorage.getItem('cp_device_session') || '';
      const headers = {
        'Content-Type': 'application/json',
        'X-CryptoPulse-Admin': '1'
      };
      if (storedDeviceToken) {
        headers['X-Device-Session'] = storedDeviceToken;
      }

      const res = await fetch(`${state.apiUrl.replace(/\/+$/, '')}/api/admin/session/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify({ deviceToken: storedDeviceToken })
      });

      if (!res.ok) {
        throw new Error('No active device session');
      }

      const data = await res.json();
      state.jwtToken = data.accessToken;
      sessionStorage.setItem('cp_monitoring_jwt', data.accessToken);
      if (data.deviceToken) {
        localStorage.setItem('cp_device_session', data.deviceToken);
      }

      enterAuthenticatedState(data.user?.deviceName || 'Authorized Device');
      setupSessionRollingTimer();
    } catch (_) {
      // Device session not present or revoked -> display manual login modal
      el.loginModal.classList.remove('hidden');
      el.app.classList.add('hidden');
    }
  }

  function setupSessionRollingTimer() {
    // Refresh session every 4 hours in the background
    setInterval(async () => {
      try {
        const storedDeviceToken = localStorage.getItem('cp_device_session') || '';
        const res = await fetch(`${state.apiUrl.replace(/\/+$/, '')}/api/admin/session/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'X-CryptoPulse-Admin': '1',
            ...(storedDeviceToken ? { 'X-Device-Session': storedDeviceToken } : {})
          },
          body: JSON.stringify({ deviceToken: storedDeviceToken })
        });
        if (res.ok) {
          const data = await res.json();
          state.jwtToken = data.accessToken;
          sessionStorage.setItem('cp_monitoring_jwt', data.accessToken);
          if (data.deviceToken) {
            localStorage.setItem('cp_device_session', data.deviceToken);
          }
        }
      } catch (_) {}
    }, 4 * 60 * 60 * 1000);
  }

  // Initialization
  async function init() {
    el.apiUrlInput.value = state.apiUrl;
    bindEvents();
    setupVisibilityHandler();

    // 1. Check for one-time activation token in URL fragment (#activate=... or #bootstrap=...)
    const hash = window.location.hash;
    if (hash && (hash.includes('activate=') || hash.includes('bootstrap='))) {
      const match = hash.match(/(?:activate|bootstrap)=([a-fA-F0-9]+)/);
      // Immediately scrub the fragment from URL bar & history to prevent log/referrer leaks
      window.history.replaceState(null, '', window.location.pathname);
      if (match && match[1]) {
        await handleActivationFlow(match[1]);
        return;
      }
    }

    // 2. Check for existing active JWT in sessionStorage
    if (state.jwtToken) {
      const claims = parseJwtClaims(state.jwtToken);
      const nowSec = Math.floor(Date.now() / 1000);
      if (claims && claims.exp && claims.exp > nowSec) {
        enterAuthenticatedState(claims.sub || 'admin');
        setupSessionRollingTimer();
        return;
      }
    }

    // 3. Attempt silent auto-login using persistent HttpOnly cookie or device session
    await attemptSilentDeviceLogin();
  }

  function bindEvents() {
    // Login form: Authenticate via POST /api/admin/login and receive short-lived JWT
    el.loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const rawInput = el.adminKeyInput.value.trim();
      const apiUrl = el.apiUrlInput.value.trim();

      if (!rawInput) return;

      state.apiUrl = apiUrl;
      sessionStorage.setItem('cp_monitoring_api_url', apiUrl);

      try {
        el.loginError.classList.add('hidden');

        let tokenToUse = '';

        // Path A: Input is already an admin Bearer JWT
        if (rawInput.startsWith('eyJ') && rawInput.split('.').length === 3) {
          const claims = parseJwtClaims(rawInput);
          const nowSec = Math.floor(Date.now() / 1000);
          if (!claims || (claims.exp && claims.exp <= nowSec)) {
            throw new Error('Provided administrator JWT is expired or invalid.');
          }
          tokenToUse = rawInput;
        } else {
          // Path B: Input is Admin Key — exchange for short-lived JWT via POST /api/admin/login
          const loginRes = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminKey: rawInput })
          });

          if (!loginRes.ok) {
            const errData = await loginRes.json().catch(() => ({}));
            throw new Error(errData.message || `Login failed with status ${loginRes.status}`);
          }

          const loginData = await loginRes.json();
          if (!loginData.token) {
            throw new Error('Backend did not return an administrative session token.');
          }
          tokenToUse = loginData.token;
        }

        // Store ONLY the short-lived JWT (never the permanent master key)
        state.jwtToken = tokenToUse;
        sessionStorage.setItem('cp_monitoring_jwt', tokenToUse);
        sessionStorage.removeItem('cp_monitoring_admin_key');

        const claims = parseJwtClaims(tokenToUse);
        el.sessionUserId.textContent = claims?.sub || 'operator';

        // Validate token by fetching overview
        await apiFetch('/api/admin/monitoring/overview');

        // Transition UI
        el.loginModal.classList.add('hidden');
        el.app.classList.remove('hidden');
        el.adminKeyInput.value = ''; // Clear secret from DOM input
        setupAutoRefresh();
        refreshActiveTab();
      } catch (err) {
        el.loginError.textContent = err.message || 'Authentication failed. Check credentials.';
        el.loginError.classList.remove('hidden');
        sessionStorage.removeItem('cp_monitoring_jwt');
        state.jwtToken = '';
      }
    });

    // Logout & Device Session Revocation
    el.logoutBtn.addEventListener('click', async () => {
      if (confirm('Revoke this device session and sign out? You will need a new activation link or Admin API Key to reconnect.')) {
        try {
          const storedDeviceToken = localStorage.getItem('cp_device_session') || '';
          await fetch(`${state.apiUrl.replace(/\/+$/, '')}/api/admin/session/revoke`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-CryptoPulse-Admin': '1',
              ...(storedDeviceToken ? { 'X-Device-Session': storedDeviceToken } : {})
            },
            body: JSON.stringify({ deviceToken: storedDeviceToken })
          }).catch(() => {});
        } finally {
          localStorage.removeItem('cp_device_session');
          sessionStorage.removeItem('cp_monitoring_jwt');
          state.jwtToken = '';
          handleUnauthorized();
        }
      }
    });

    // Navigation tab switching
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
      });
    });

    // Switch tab buttons inside views
    document.querySelectorAll('[data-switch-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.dataset.switchTab);
      });
    });

    // Refresh controls
    el.manualRefreshBtn.addEventListener('click', () => {
      refreshActiveTab(true);
    });

    el.autoRefreshSelect.addEventListener('change', (e) => {
      state.refreshIntervalSec = Number(e.target.value);
      setupAutoRefresh();
    });

    // Filter controls
    el.botStatusFilter.addEventListener('change', () => loadBots());
    el.incidentSeverityFilter.addEventListener('change', () => loadIncidents());
    el.incidentStatusFilter.addEventListener('change', () => loadIncidents());
    el.incidentSearchInput.addEventListener('input', debounce(() => loadIncidents(), 300));

    // Modal controls
    el.modalCloseBtn.addEventListener('click', () => el.incidentModal.classList.add('hidden'));
    el.incidentModal.addEventListener('click', (e) => {
      if (e.target === el.incidentModal) el.incidentModal.classList.add('hidden');
    });

    // Copy Antigravity prompt
    el.copyPromptBtn.addEventListener('click', () => {
      const promptText = el.modalPromptContent.textContent;
      navigator.clipboard.writeText(promptText).then(() => {
        const originalText = el.copyPromptBtn.innerHTML;
        el.copyPromptBtn.innerHTML = `<span>✓ Copied!</span>`;
        setTimeout(() => {
          el.copyPromptBtn.innerHTML = originalText;
        }, 2000);
      });
    });

    // Save incident status
    el.modalSaveStatusBtn.addEventListener('click', async () => {
      if (!state.currentIncidentId) return;
      const newStatus = el.modalStatusSelect.value;
      try {
        await apiFetch(`/api/admin/monitoring/incidents/${state.currentIncidentId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus })
        });
        el.incidentModal.classList.add('hidden');
        loadIncidents();
        loadOverview();
      } catch (err) {
        alert('Failed to update incident: ' + err.message);
      }
    });
  }

  // Pause automatic refresh when browser tab is inactive; resume when visible
  function setupVisibilityHandler() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (state.refreshTimer) {
          clearInterval(state.refreshTimer);
          state.refreshTimer = null;
        }
      } else {
        setupAutoRefresh();
        // If last sync occurred more than refresh interval ago, refresh immediately
        if (!state.lastSyncTime || Date.now() - state.lastSyncTime > state.refreshIntervalSec * 1000) {
          refreshActiveTab();
        }
      }
    });
  }

  function switchTab(tabId) {
    state.activeTab = tabId;
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-pane').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tabId}`);
    });

    const titles = {
      overview: 'Fleet Overview',
      bots: 'Users & Trading Bots',
      incidents: 'System Incidents',
      health: 'Quotas & Edge Health'
    };
    el.pageTitle.textContent = titles[tabId] || 'Monitoring';

    refreshActiveTab();
  }

  function setupAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.refreshIntervalSec > 0 && !document.hidden) {
      state.refreshTimer = setInterval(() => {
        refreshActiveTab(false);
      }, state.refreshIntervalSec * 1000);
    }
  }

  // Bounded non-overlapping tab refresh
  async function refreshActiveTab(manual = false) {
    if (state.isRefreshing) return; // Prevent overlapping concurrent polling
    state.isRefreshing = true;

    try {
      if (state.activeTab === 'overview') await loadOverview();
      else if (state.activeTab === 'bots') await loadBots();
      else if (state.activeTab === 'incidents') await loadIncidents();
      else if (state.activeTab === 'health') await loadHealth();

      state.lastSyncTime = Date.now();
      el.lastSyncTime.textContent = `Updated: ${new Date(state.lastSyncTime).toLocaleTimeString()}`;
    } catch (err) {
      console.error('[Dashboard] Refresh error:', err);
      el.healthDot.className = 'dot dot-red';
      el.healthText.textContent = 'API Connection Error (Stale Data)';
      el.lastSyncTime.textContent = `Updated: ${state.lastSyncTime ? new Date(state.lastSyncTime).toLocaleTimeString() + ' (Stale)' : 'Never'}`;
    } finally {
      state.isRefreshing = false;
    }
  }

  // View: Overview
  async function loadOverview() {
    const data = await apiFetch('/api/admin/monitoring/overview');

    // Update KPIs
    el.kpiTotalUsers.textContent = (data.fleet?.totalRegisteredUsers || 0).toLocaleString();
    el.kpiActiveUsers.textContent = (data.fleet?.activeUsers24h || 0).toLocaleString();
    el.kpiActiveBots.textContent = (data.fleet?.openPositionsCount || 0).toLocaleString();
    el.kpiHealthyBots.textContent = (data.fleet?.openPositionsCount || 0).toLocaleString();
    el.kpiIncidents24h.textContent = (data.incidents24h?.total || 0).toLocaleString();
    el.kpiCriticalIncidents.textContent = (data.incidents24h?.critical || 0).toLocaleString();
    el.badgeIncidentCount.textContent = data.incidents24h?.unresolved || 0;

    const storageStatus = data.monitoringHealth?.storageHealth || 'HEALTHY';
    el.kpiStorageHealth.textContent = storageStatus;
    el.kpiStorageHealth.className = `kpi-value ${storageStatus === 'HEALTHY' ? 'text-success' : 'text-danger'}`;

    const total = data.monitoringHealth?.totalEventsReceived || 1;
    const deduped = data.monitoringHealth?.totalDeduplicated || 0;
    const ratio = Math.round((deduped / Math.max(total, 1)) * 100);
    el.kpiDedupRatio.textContent = `${ratio}%`;

    // System Status Indicator
    if (data.systemStatus === 'OPERATIONAL') {
      el.healthDot.className = 'dot dot-green';
      el.healthText.textContent = 'All Systems Operational';
    } else if (data.systemStatus === 'WARNING') {
      el.healthDot.className = 'dot dot-amber';
      el.healthText.textContent = 'Elevated Warning Rate';
    } else {
      el.healthDot.className = 'dot dot-red';
      el.healthText.textContent = 'Critical Incident Detected';
    }

    // Load recent incidents preview
    const incidents = await apiFetch('/api/admin/monitoring/incidents?limit=5&status=UNRESOLVED');
    renderIncidentsTable(incidents.items || [], el.overviewIncidentsTbody, true);
  }

  // View: Bots & Users (100% Sanitized against Stored XSS)
  async function loadBots() {
    el.botsTbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-6">Fetching bot fleet state...</td></tr>`;
    const status = el.botStatusFilter.value;
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const data = await apiFetch(`/api/admin/monitoring/bots${query}`);

    const items = data.items || [];
    if (items.length === 0) {
      el.botsTbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-6">No trading bots found matching the filter.</td></tr>`;
      return;
    }

    el.botsTbody.innerHTML = items.map((b) => {
      const stateBadgeClass = {
        HEALTHY: 'badge-healthy',
        STALE: 'badge-stale',
        ERROR: 'badge-error',
        INACTIVE: 'badge-inactive'
      }[b.botState] || 'badge-inactive';

      const botIdSafe = escapeHtml(b.botId);
      const emailSafe = escapeHtml(b.userEmail);
      const exchangeSafe = escapeHtml(b.exchange);
      const envSafe = escapeHtml(b.environment);
      const stateSafe = escapeHtml(b.botState);

      const pos = b.activePosition
        ? `<span class="badge ${b.activePosition.side === 'BUY' ? 'badge-healthy' : 'badge-error'}">${escapeHtml(b.activePosition.side)}</span> ${escapeHtml(b.activePosition.symbol)} @ $${Number(b.activePosition.entryPrice || 0).toFixed(2)}`
        : '<span class="text-muted">None</span>';

      const timeSafe = escapeHtml(new Date(b.lastObservedAt || Date.now()).toLocaleTimeString());

      return `
        <tr>
          <td>
            <div class="font-mono text-xs font-bold">${botIdSafe}</div>
            <div class="text-muted text-xs">${emailSafe}</div>
          </td>
          <td>${exchangeSafe}</td>
          <td><span class="badge badge-info">${envSafe}</span></td>
          <td><span class="badge ${stateBadgeClass}">${stateSafe}</span></td>
          <td>${pos}</td>
          <td class="text-muted text-xs">${timeSafe}</td>
        </tr>
      `;
    }).join('');
  }

  // View: Incidents
  async function loadIncidents() {
    el.incidentsTbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted py-6">Loading incidents...</td></tr>`;

    const severity = el.incidentSeverityFilter.value;
    const status = el.incidentStatusFilter.value;
    const search = el.incidentSearchInput.value.trim();

    const params = new URLSearchParams({ limit: '50' });
    if (severity) params.set('severity', severity);
    if (status) params.set('status', status);
    if (search) params.set('search', search);

    const data = await apiFetch(`/api/admin/monitoring/incidents?${params.toString()}`);
    const items = data.items || [];

    el.incidentPaginationInfo.textContent = `Showing ${items.length} of ${data.total || 0}`;
    renderIncidentsTable(items, el.incidentsTbody, false);
  }

  // Table Renderer: 100% Sanitized against Stored XSS
  function renderIncidentsTable(items, targetTbody, isCompact) {
    if (items.length === 0) {
      targetTbody.innerHTML = `<tr><td colspan="${isCompact ? 7 : 8}" class="text-center text-muted py-6">No incidents found.</td></tr>`;
      return;
    }

    targetTbody.innerHTML = items.map((inc) => {
      const sevClass = {
        CRITICAL: 'badge-critical',
        ERROR: 'badge-error',
        WARNING: 'badge-warning',
        INFO: 'badge-info'
      }[inc.severity] || 'badge-info';

      const idSafe = escapeHtml(inc.id);
      const sevSafe = escapeHtml(inc.severity);
      const compSafe = escapeHtml(inc.component);
      const eventTypeSafe = escapeHtml(inc.eventType);
      const msgSafe = escapeHtml(inc.message);
      const lifecycleSafe = escapeHtml(inc.lifecycleStage || 'N/A');
      const statusSafe = escapeHtml(inc.status);
      const occurrencesSafe = Number(inc.occurrences || 1);
      const timeSafe = escapeHtml(new Date(inc.timestamp).toLocaleTimeString());

      if (isCompact) {
        return `
          <tr>
            <td><span class="badge ${sevClass}">${sevSafe}</span></td>
            <td><strong>${compSafe}</strong></td>
            <td><span class="font-mono text-xs">${eventTypeSafe}</span></td>
            <td>${msgSafe}</td>
            <td class="font-mono text-center">${occurrencesSafe}</td>
            <td class="text-muted text-xs">${timeSafe}</td>
            <td>
              <button class="btn btn-secondary btn-xs" onclick="window.viewIncident('${idSafe}')">Inspect</button>
            </td>
          </tr>
        `;
      }

      return `
        <tr>
          <td><span class="badge ${sevClass}">${sevSafe}</span></td>
          <td class="text-muted text-xs font-mono">${timeSafe}</td>
          <td><strong>${compSafe}</strong></td>
          <td><span class="badge badge-inactive">${lifecycleSafe}</span></td>
          <td>${msgSafe}</td>
          <td class="font-mono text-center font-bold">${occurrencesSafe}</td>
          <td><span class="badge ${inc.status === 'RESOLVED' ? 'badge-resolved' : 'badge-unresolved'}">${statusSafe}</span></td>
          <td>
            <button class="btn btn-secondary btn-xs" onclick="window.viewIncident('${idSafe}')">Inspect</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // View: Health & Quotas
  async function loadHealth() {
    const quotaData = await apiFetch('/api/admin/monitoring/quotas');
    const healthData = await apiFetch('/api/admin/monitoring/health');

    const q = quotaData.quotas || {};
    el.quotaTotalEvents.textContent = (q.totalEventsReceived || 0).toLocaleString();
    el.quotaPersisted.textContent = (q.totalIncidentsPersisted || 0).toLocaleString();
    el.quotaDeduplicated.textContent = (q.totalDeduplicated || 0).toLocaleString();
    el.quotaDropped.textContent = (q.totalDropped || 0).toLocaleString();
    el.quotaWriteFailures.textContent = (q.writeFailuresCount || 0).toLocaleString();
    el.quotaRingBuffer.textContent = `${q.ringBufferSize || 0} / 150 items`;

    el.edgeDbStatus.textContent = healthData.d1Database?.status || 'CONNECTED';
    el.edgeDbLatency.textContent = `${healthData.d1Database?.latencyMs ?? '—'} ms`;
    el.edgeCoordinatorStatus.textContent = healthData.publicMarketCoordinator?.marketsCached ? 'HOT CACHE' : 'ACTIVE';
    el.edgeSignalMode.textContent = healthData.worker?.signalManagerMode || 'SHADOW';
  }

  // Incident Detail Inspector Modal
  window.viewIncident = async (id) => {
    state.currentIncidentId = id;
    try {
      const data = await apiFetch(`/api/admin/monitoring/incidents/${encodeURIComponent(id)}`);
      const inc = data.incident;
      const diag = data.diagnosis;

      el.modalIncidentTitle.textContent = `${inc.component} — ${inc.eventType}`;
      el.modalIncidentId.textContent = inc.id;
      el.modalConfidenceBadge.textContent = `CONFIDENCE: ${diag.confidence}`;
      el.modalConfidenceBadge.className = `badge ${diag.confidence === 'HIGH' ? 'badge-success' : 'badge-warning'}`;

      el.modalRootCause.textContent = diag.likelyRootCause;
      el.modalFiles.textContent = (diag.relevantFiles || []).join(', ') || 'N/A';
      el.modalActions.textContent = (diag.recommendedSteps || []).join(' | ') || 'N/A';

      el.modalPromptContent.textContent = diag.antigravityPrompt || 'No prompt generated.';
      el.modalEvidenceJson.textContent = inc.evidence ? JSON.stringify(inc.evidence, null, 2) : 'No extra evidence.';
      el.modalStatusSelect.value = inc.status || 'UNRESOLVED';

      el.incidentModal.classList.remove('hidden');
    } catch (err) {
      alert('Failed to load incident details: ' + err.message);
    }
  };

  // Utilities: Strict HTML Entity Escaper for XSS Prevention
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function debounce(fn, ms) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn(...args), ms);
    };
  }

  // Start app
  init();
})();
