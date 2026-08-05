import { EventBus, DomainEvent } from '../../domain/events/EventBus';
import { MetricsCollector, StructuredLogger } from '../telemetry/Telemetry';

export type SecurityAuditEventType =
  | 'CREDENTIAL_REGISTERED'
  | 'CREDENTIAL_ROTATED'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_EXPIRED'
  | 'PERMISSION_GRANTED'
  | 'PERMISSION_DENIED'
  | 'ENVIRONMENT_VIOLATION'
  | 'UNAUTHORIZED_ACCESS_ATTEMPT';

export interface SecurityAuditEvent extends DomainEvent {
  readonly eventId: string;
  readonly timestamp: number;
  readonly eventType: string;
  readonly securityAction: SecurityAuditEventType;
  readonly userId: string;
  readonly exchangeId?: string;
  readonly environment: string;
  readonly details?: Record<string, unknown>;
}

export class AuditLogger {
  private static readonly logger = new StructuredLogger();
  private readonly appendOnlyLogs: SecurityAuditEvent[] = [];

  constructor(private readonly eventBus?: EventBus) {}

  public async logSecurityEvent(
    securityAction: SecurityAuditEventType,
    userId: string,
    environment: string = 'mainnet',
    exchangeId?: string,
    details?: Record<string, unknown>
  ): Promise<SecurityAuditEvent> {
    const event: SecurityAuditEvent = Object.freeze({
      eventId: crypto.randomUUID(),
      timestamp: Date.now(),
      eventType: 'SECURITY_AUDIT_EVENT',
      securityAction,
      userId,
      exchangeId,
      environment,
      details: details ? Object.freeze({ ...details }) : undefined,
    });

    // Strictly append-only
    this.appendOnlyLogs.push(event);

    // Security Metrics & Logging
    MetricsCollector.increment(`security_audit_${securityAction.toLowerCase()}`, 1);
    AuditLogger.logger.info(`[SECURITY AUDIT] ${securityAction} for user '${userId}'`, {
      securityAction,
      userId,
      exchangeId,
      environment,
    });

    if (securityAction === 'PERMISSION_DENIED' || securityAction === 'ENVIRONMENT_VIOLATION') {
      MetricsCollector.increment('security_violations_total', 1);
      AuditLogger.logger.warn(`[SECURITY VIOLATION] ${securityAction}`, { userId, exchangeId, environment });
    }

    if (this.eventBus) {
      await this.eventBus.publish(event);
    }

    return event;
  }

  public getImmutableAuditLogs(): ReadonlyArray<SecurityAuditEvent> {
    return Object.freeze([...this.appendOnlyLogs]);
  }
}
