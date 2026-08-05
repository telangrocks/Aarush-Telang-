import { describe, it, expect } from 'vitest';
import { BotSupervisor } from './BotSupervisor';
import { HealthMonitor } from './HealthMonitor';
import { ExecutionJournal } from './ExecutionJournal';
import { ReconciliationService } from './ReconciliationService';
import { EventBus } from '../../domain/events/EventBus';
import { RecoveryCoordinator } from './RecoveryCoordinator';
import { BinanceAdapter } from '../exchange/adapters/BinanceAdapter';

describe('Milestone 9 — BotSupervisor Session Supervision Unit Tests', () => {
  it('BotSupervisor tracks bot heartbeats and detects unresponsive bot sessions', async () => {
    const health = new HealthMonitor();
    const journal = new ExecutionJournal();
    const recon = new ReconciliationService(journal);
    const bus = new EventBus();
    const coordinator = new RecoveryCoordinator(health, recon, bus);
    const supervisor = new BotSupervisor(coordinator, health, 50); // 50ms heartbeat threshold

    supervisor.registerBotSession('bot_scalper_1', 'binance');
    expect(supervisor.getSession('bot_scalper_1')?.status).toBe('RUNNING');

    // Simulate time elapsed beyond 50ms
    await new Promise(r => setTimeout(r, 60));

    const adapterMap = new Map();
    const binanceAdapter = new BinanceAdapter();
    binanceAdapter.fetchOpenOrders = async () => [];
    binanceAdapter.fetchClosedOrders = async () => [];
    adapterMap.set('binance', binanceAdapter);

    const result = await supervisor.inspectAndSupervise(adapterMap);

    expect(result.inspected).toBe(1);
    expect(result.recovered).toBe(1);
    expect(supervisor.getSession('bot_scalper_1')?.status).toBe('RUNNING');
  });
});
