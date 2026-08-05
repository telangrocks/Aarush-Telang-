import { CircuitState } from '../orchestrator/CircuitBreaker';

export type RecoveryReason =
  | 'NONE'
  | 'WEBSOCKET_DISCONNECT'
  | 'RATE_LIMIT_STORM'
  | 'CIRCUIT_BREAKER_OPEN'
  | 'WORKER_ISOLATE_RESTART'
  | 'ORDER_MISMATCH';

export type BotHealthStatus = 'RUNNING' | 'HALTED' | 'DEGRADED' | 'RECOVERING';

export interface ExchangeHealthSnapshot {
  readonly exchangeId: string;
  readonly healthScore: number; // 0 to 100
  readonly circuitState: CircuitState;
  readonly lastErrorTime?: number;
  readonly lastErrorMsg?: string;
}

export class RuntimeState {
  private constructor(
    readonly exchangeHealth: ReadonlyMap<string, ExchangeHealthSnapshot>,
    readonly botHealth: ReadonlyMap<string, BotHealthStatus>,
    readonly lastHeartbeat: number,
    readonly pendingRecovery: boolean,
    readonly recoveryReason: RecoveryReason
  ) {}

  public static createEmpty(): RuntimeState {
    return new RuntimeState(new Map(), new Map(), Date.now(), false, 'NONE');
  }

  public withExchangeHealth(snapshot: ExchangeHealthSnapshot): RuntimeState {
    const updated = new Map(this.exchangeHealth);
    updated.set(snapshot.exchangeId, snapshot);
    return new RuntimeState(updated, this.botHealth, Date.now(), this.pendingRecovery, this.recoveryReason);
  }

  public withBotStatus(botId: string, status: BotHealthStatus): RuntimeState {
    const updated = new Map(this.botHealth);
    updated.set(botId, status);
    return new RuntimeState(this.exchangeHealth, updated, Date.now(), this.pendingRecovery, this.recoveryReason);
  }

  public withRecovery(pending: boolean, reason: RecoveryReason): RuntimeState {
    return new RuntimeState(this.exchangeHealth, this.botHealth, Date.now(), pending, reason);
  }
}
