export type SocketMessageType = 'ticker' | 'candle' | 'order' | 'pong' | 'heartbeat' | 'unknown';

export interface ParsedSocketMessage {
  readonly type: SocketMessageType;
  readonly symbol?: string;
  readonly payload: unknown;
  readonly sequenceId?: number;
}

export interface IExchangeSocketAdapter {
  readonly exchangeId: string;
  getSocketUrl(environment?: string): string;
  formatPingPayload(): string;
  formatSubscribePayload(topics: string[]): string;
  parseMessage(rawData: string): ParsedSocketMessage;
}

export class MockExchangeSocketAdapter implements IExchangeSocketAdapter {
  readonly exchangeId = 'mock_exchange';

  public getSocketUrl(): string {
    return 'wss://ws.mockexchange.com/v1';
  }

  public formatPingPayload(): string {
    return JSON.stringify({ op: 'ping' });
  }

  public formatSubscribePayload(topics: string[]): string {
    return JSON.stringify({ op: 'subscribe', args: topics });
  }

  public parseMessage(rawData: string): ParsedSocketMessage {
    try {
      const parsed = JSON.parse(rawData);
      if (parsed.op === 'pong') return { type: 'pong', payload: parsed };
      if (parsed.topic) return { type: 'ticker', symbol: parsed.symbol, payload: parsed, sequenceId: parsed.seq };
      return { type: 'unknown', payload: parsed };
    } catch (_) {
      return { type: 'unknown', payload: rawData };
    }
  }
}
