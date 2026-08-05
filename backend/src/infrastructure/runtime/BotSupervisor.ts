import { RecoveryCoordinator } from './RecoveryCoordinator';
import { HealthMonitor } from './HealthMonitor';
import { BaseExchangeAdapter } from '../exchange/adapters/BaseExchangeAdapter';
import { ResilientWebSocketManager } from './WebSocketManager';
import { BotHealthStatus, RecoveryReason } from './RuntimeState';

export interface BotSessionSnapshot {
  readonly botId: string;
  readonly exchangeId: string;
  readonly status: BotHealthStatus;
  readonly lastHeartbeat: number;
}

export class BotSupervisor {
  private sessions = new Map<string, BotSessionSnapshot>();

  constructor(
    private readonly recoveryCoordinator: RecoveryCoordinator,
    private readonly healthMonitor: HealthMonitor,
    private readonly maxHeartbeatAgeMs: number = 30000
  ) {}

  public registerBotSession(botId: string, exchangeId: string): void {
    const snapshot: BotSessionSnapshot = {
      botId,
      exchangeId,
      status: 'RUNNING',
      lastHeartbeat: Date.now(),
    };
    this.sessions.set(botId, snapshot);
    this.healthMonitor.getRuntimeState().withBotStatus(botId, 'RUNNING');
  }

  public recordBotHeartbeat(botId: string): void {
    const existing = this.sessions.get(botId);
    if (existing) {
      const updated: BotSessionSnapshot = {
        ...existing,
        lastHeartbeat: Date.now(),
        status: 'RUNNING',
      };
      this.sessions.set(botId, updated);
      this.healthMonitor.getRuntimeState().withBotStatus(botId, 'RUNNING');
    }
  }

  public getSession(botId: string): BotSessionSnapshot | null {
    return this.sessions.get(botId) || null;
  }

  public async inspectAndSupervise(
    adapterMap: Map<string, BaseExchangeAdapter>,
    wsMap?: Map<string, ResilientWebSocketManager>
  ): Promise<{ inspected: number; recovered: number }> {
    const now = Date.now();
    let recovered = 0;

    for (const [botId, session] of this.sessions.entries()) {
      const elapsed = now - session.lastHeartbeat;
      if (elapsed > this.maxHeartbeatAgeMs) {
        // Bot is unresponsive! Trigger self-healing recovery flow
        this.sessions.set(botId, { ...session, status: 'RECOVERING' });
        this.healthMonitor.getRuntimeState().withBotStatus(botId, 'RECOVERING');

        const adapter = adapterMap.get(session.exchangeId);
        if (adapter) {
          const wsManager = wsMap ? wsMap.get(session.exchangeId) : undefined;
          const reason: RecoveryReason = 'WORKER_ISOLATE_RESTART';
          await this.recoveryCoordinator.executeSelfHealingRecovery(adapter, reason, wsManager);
          
          this.recordBotHeartbeat(botId);
          recovered++;
        }
      }
    }

    return { inspected: this.sessions.size, recovered };
  }
}
