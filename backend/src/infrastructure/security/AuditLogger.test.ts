import { describe, it, expect } from 'vitest';
import { AuditLogger } from './AuditLogger';
import { EventBus } from '../../domain/events/EventBus';

describe('Milestone 4 — Immutable Append-Only AuditLogger Unit Tests', () => {
  it('AuditLogger appends immutable audit events and publishes to EventBus', async () => {
    const bus = new EventBus();
    const auditLogger = new AuditLogger(bus);

    let publishedEvent: any = null;
    bus.subscribe('SECURITY_AUDIT_EVENT', (evt) => {
      publishedEvent = evt;
    });

    const evt = await auditLogger.logSecurityEvent('CREDENTIAL_ROTATED', 'usr_sec_10', 'mainnet', 'binance', {
      version: 2,
    });

    expect(evt.securityAction).toBe('CREDENTIAL_ROTATED');
    expect(evt.userId).toBe('usr_sec_10');

    const logs = auditLogger.getImmutableAuditLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].eventId).toBe(evt.eventId);
    expect(publishedEvent).toBeDefined();
    expect(publishedEvent.eventId).toBe(evt.eventId);
  });

  it('AuditLogger tracks security violations cleanly', async () => {
    const auditLogger = new AuditLogger();
    await auditLogger.logSecurityEvent('ENVIRONMENT_VIOLATION', 'usr_hacker', 'mainnet', 'kucoin', {
      attemptedEnv: 'sandbox',
    });

    const logs = auditLogger.getImmutableAuditLogs();
    expect(logs[0].securityAction).toBe('ENVIRONMENT_VIOLATION');
  });
});
