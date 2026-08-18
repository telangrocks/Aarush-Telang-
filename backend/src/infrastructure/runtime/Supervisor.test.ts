import { describe, it, expect } from 'vitest';
import { BotSupervisor } from './BotSupervisor';
import { HealthMonitor } from './HealthMonitor';
import { ExecutionJournal } from './ExecutionJournal';
import { ReconciliationService } from './ReconciliationService';
import { EventBus } from '../../domain/events/EventBus';
import { RecoveryCoordinator } from './RecoveryCoordinator';
import { BybitAdapter } from '../exchange/adapters/BybitAdapter';

describe('Milestone 9 — BotSupervisor Session Supervision Unit Tests', () => {
  it('BotSupervisor tracks bot heartbeats and detects unresponsive bot sessions', async () => {
    const health = new HealthMonitor();
    const journal = new ExecutionJournal();
    const recon = new ReconciliationService(journal);
    const bus = new EventBus();
    const coordinator = new RecoveryCoordinator(health, recon, bus);
    const supervisor = new BotSupervisor(coordinator, health, 50); // 50ms heartbeat threshold

    supervisor.registerBotSession('bot_scalper_1', 'bybit');
    expect(supervisor.getSession('bot_scalper_1')?.status).toBe('RUNNING');

    // Simulate time elapsed beyond 50ms
    await new Promise(r => setTimeout(r, 60));

    const adapterMap = new Map();
    const adapter1 = new BybitAdapter();
    adapter1.fetchOpenOrders = async () => [];
    adapter1.fetchClosedOrders = async () => [];
    adapterMap.set('bybit', adapter1);

    const result = await supervisor.inspectAndSupervise(adapterMap);

    expect(result.inspected).toBe(1);
    expect(result.recovered).toBe(1);
    expect(supervisor.getSession('bot_scalper_1')?.status).toBe('RUNNING');
  });
});
