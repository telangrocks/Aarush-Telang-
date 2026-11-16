import { AdminPrincipal, MonitoringEnv } from './types';

const DEFAULT_ALLOWED_ORIGINS = [
  'https://cryptopulse-monitoring.pages.dev',
  'http://localhost:3000',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
];

export function parseAllowedOrigins(env: MonitoringEnv): Set<string> {
  const raw = env.ALLOWED_ORIGINS?.trim();
  if (!raw) return new Set(DEFAULT_ALLOWED_ORIGINS);
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function buildCorsHeaders(request: Request, env: MonitoringEnv): Record<string, string> {
  const origin = request.headers.get('Origin');
  const allowed = parseAllowedOrigins(env);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key, X-CryptoPulse-Admin, X-Device-Session',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  if (origin && (allowed.has(origin) || origin.endsWith('.cryptopulse-monitoring.pages.dev'))) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (!origin) {
    headers['Access-Control-Allow-Origin'] = 'https://cryptopulse-monitoring.pages.dev';
  }

  return headers;
}

export function timingSafeEqualAscii(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    const ba = i < aBytes.length ? aBytes[i] : 0;
    const bb = i < bBytes.length ? bBytes[i] : 0;
    diff |= ba ^ bb;
  }
  return diff === 0;
}

function decodeBase64UrlToUint8Array(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (segment.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64UrlJson<T>(segment: string): T | null {
  try {
    const bytes = decodeBase64UrlToUint8Array(segment);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function verifyHs256Jwt(
  token: string,
  secret: string
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; typ?: string }>(headerB64);
  if (!header || header.alg !== 'HS256') return null;

  const payload = decodeBase64UrlJson<Record<string, unknown>>(payloadB64);
  if (!payload || typeof payload !== 'object') return null;

  const exp = payload.exp;
  if (typeof exp === 'number') {
    const nowSec = Math.floor(Date.now() / 1000);
    if (exp + 30 < nowSec) return null;
  }

  try {
    const keyData = new TextEncoder().encode(secret);
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = decodeBase64UrlToUint8Array(sigB64);
    const ok = await crypto.subtle.verify('HMAC', cryptoKey, signature, signingInput);
    return ok ? payload : null;
  } catch {
    return null;
  }
}

function isAdminEmail(email: string | undefined, env: MonitoringEnv): boolean {
  if (!email) return false;
  const allow = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}

/**
 * Authenticates read-only requests to /api/monitor/v2/*.
 * Supports X-Admin-Key (constant-time) OR HS256 Admin JWT matching CryptoPulse backend AdminAuth rules.
 */
export async function authenticateReadOnlyAdmin(
  request: Request,
  env: MonitoringEnv
): Promise<{ ok: true; principal: AdminPrincipal } | { ok: false; status: number; error: string }> {
  const adminKeyHeader = request.headers.get('X-Admin-Key')?.trim();
  if (adminKeyHeader && env.ADMIN_API_KEY) {
    if (timingSafeEqualAscii(adminKeyHeader, env.ADMIN_API_KEY)) {
      return { ok: true, principal: { method: 'admin_key', role: 'ADMIN', scope: 'OPERATOR' } };
    }
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const authHeader = request.headers.get('Authorization')?.trim();
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const jwt = authHeader.slice(7).trim();
    if (!env.JWT_SECRET) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }
    const payload = await verifyHs256Jwt(jwt, env.JWT_SECRET);
    if (!payload) {
      return { ok: false, status: 401, error: 'Unauthorized' };
    }

    const role = typeof payload.role === 'string' ? payload.role.toUpperCase() : '';
    const email = typeof payload.email === 'string' ? payload.email : undefined;
    const sub = typeof payload.sub === 'string' && payload.sub.trim().length > 0 ? payload.sub.trim() : undefined;
    const userId =
      typeof payload.userId === 'string' && payload.userId.trim().length > 0
        ? payload.userId.trim()
        : sub;

    if (role !== 'ADMIN' && !isAdminEmail(email, env)) {
      return { ok: false, status: 403, error: 'Forbidden' };
    }

    const deviceSessionHash =
      typeof payload.androidDeviceSessionHash === 'string' && payload.androidDeviceSessionHash.trim().length > 0
        ? payload.androidDeviceSessionHash.trim()
        : typeof payload.deviceSessionHash === 'string' && payload.deviceSessionHash.trim().length > 0
        ? payload.deviceSessionHash.trim()
        : typeof payload.deviceHash === 'string' && payload.deviceHash.trim().length > 0
        ? payload.deviceHash.trim()
        : undefined;
    const sessionId =
      typeof payload.sid === 'string' && payload.sid.trim().length > 0
        ? payload.sid.trim()
        : typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : undefined;

    const isExplicitOperatorToken =
      payload.monitoringScope === 'OPERATOR' &&
      (sub === 'admin_operator' || sub === 'admin_device_owner' || !userId || userId === 'admin_operator' || userId === 'admin_device_owner');

    if (isExplicitOperatorToken) {
      return {
        ok: true,
        principal: {
          method: 'jwt',
          role: 'ADMIN',
          email,
          deviceSessionHash,
          sessionId,
          scope: 'OPERATOR',
        },
      };
    }

    if (!userId) {
      return { ok: false, status: 403, error: 'Forbidden: monitoring token missing user subject' };
    }

    return {
      ok: true,
      principal: {
        method: 'jwt',
        role: 'ADMIN',
        email,
        userId,
        deviceSessionHash,
        sessionId,
        scope: 'USER_SCOPED',
      },
    };
  }

  return { ok: false, status: 401, error: 'Unauthorized' };
}
