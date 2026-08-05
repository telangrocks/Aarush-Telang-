import { IExchangeSocketAdapter, ParsedSocketMessage } from './adapters/ExchangeSocketAdapter';

export type SocketLifecycleState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'AUTHENTICATED'
  | 'SUBSCRIBED'
  | 'RECEIVING'
  | 'HEARTBEAT_LOST'
  | 'RECONNECTING'
  | 'RESUBSCRIBING'
  | 'RECOVERING';

export type SocketMessageHandler = (msg: ParsedSocketMessage) => void;

export class ResilientWebSocketManager {
  private state: SocketLifecycleState = 'DISCONNECTED';
  private subscriptions = new Set<string>();
  private messageBuffer: ParsedSocketMessage[] = [];
  private lastPongReceived: number = Date.now();
  private lastSequenceId: number = 0;
  private messageHandlers: SocketMessageHandler[] = [];

  constructor(
    private readonly adapter: IExchangeSocketAdapter,
    private readonly heartbeatTimeoutMs: number = 15000
  ) {}

  public getState(): SocketLifecycleState {
    return this.state;
  }

  public getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  public subscribe(topics: string[]): void {
    for (const t of topics) {
      this.subscriptions.add(t);
    }
    if (this.state === 'CONNECTED' || this.state === 'RECEIVING') {
      this.state = 'SUBSCRIBED';
    }
  }

  public onMessage(handler: SocketMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  public simulateConnect(): void {
    this.state = 'CONNECTED';
    if (this.subscriptions.size > 0) {
      this.state = 'SUBSCRIBED';
    }
    this.lastPongReceived = Date.now();
  }

  public simulateIncomingRawMessage(rawData: string): ParsedSocketMessage {
    const parsed = this.adapter.parseMessage(rawData);

    if (parsed.type === 'pong' || parsed.type === 'heartbeat') {
      this.lastPongReceived = Date.now();
    } else {
      this.state = 'RECEIVING';
      if (parsed.sequenceId) {
        this.lastSequenceId = parsed.sequenceId;
      }
      this.messageBuffer.push(parsed);
      if (this.messageBuffer.length > 100) {
        this.messageBuffer.shift();
      }
      for (const handler of this.messageHandlers) {
        handler(parsed);
      }
    }

    return parsed;
  }

  public checkHeartbeat(): boolean {
    const elapsed = Date.now() - this.lastPongReceived;
    if (elapsed > this.heartbeatTimeoutMs) {
      this.state = 'HEARTBEAT_LOST';
      return false;
    }
    return true;
  }

  public simulateReconnectAndResubscribe(): void {
    this.state = 'RECONNECTING';
    // Re-establish connection
    this.state = 'CONNECTED';
    if (this.subscriptions.size > 0) {
      this.state = 'RESUBSCRIBING';
      // Resubscribe to buffered topics
      this.state = 'RECEIVING';
    }
    this.lastPongReceived = Date.now();
  }
}
