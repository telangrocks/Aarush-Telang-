import { TelemetryQueueEnvelope } from '../../shared/monitoring';

export interface MonitoringEnv {
  MONITORING_DB: D1Database;
  ENVIRONMENT?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_API_KEY?: string;
  JWT_SECRET?: string;
  ADMIN_EMAILS?: string;
  INTERNAL_INGEST_SECRET?: string;
  REQUIRE_INTERNAL_SECRET?: string;
  /** Optional strictly read-only service binding to query live DO /internal/monitor-state & coordinator /stats */
  BACKEND_SERVICE?: Fetcher;
}

export type MonitoringAccessScope = 'USER_SCOPED' | 'OPERATOR';

export interface AdminPrincipal {
  method: 'admin_key' | 'jwt';
  email?: string;
  role: 'ADMIN';
  userId?: string;
  deviceSessionHash?: string;
  sessionId?: string;
  scope: MonitoringAccessScope;
}

export interface IngestOutcome {
  batchId: string;
  received: number;
  inserted: number;
  deduped: number;
  dlqRouted: number;
  consumerProcessedAtMs: number;
  d1CommittedAtMs: number;
}

export type TelemetryQueueMessage = Message<TelemetryQueueEnvelope>;
export type TelemetryQueueBatch = MessageBatch<TelemetryQueueEnvelope>;
