/**
 * Environment bindings for Cloudflare Workers
 * These will be bound to the worker at runtime
 */
export interface Env {
  // Environment configuration
  ENVIRONMENT: 'development' | 'production';
  API_TIMEOUT: string;

  // Database binding (will be added in Phase 3)
  // DB: D1Database;

  // KV Cache binding (optional, will be added later)
  // CACHE: KVNamespace;
}
