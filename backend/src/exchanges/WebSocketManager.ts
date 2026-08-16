import { ExchangeName, ExchangeEnvironment } from "./types";
import { ExchangeRoutingResolver, BybitWsPurpose } from "./routing/ExchangeRoutingResolver";
import { WebCryptoSigner } from "../infrastructure/crypto/WebCryptoSigner";
import { UnifiedError } from "./models/UnifiedError";

export interface ExchangeEvent {
  eventId: string;
  clientOrderId?: string;
  exchangeOrderId: string;
  symbol: string;
  exchange: ExchangeName;
  side: 'BUY' | 'SELL';
  status: 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled' | 'rejected' | 'expired';
  price: number;
  quantity: number;
  filledQuantity: number;
  averageFillPrice: number;
  eventTime: number;
}


export class EventDeduplicator {
  private processedEvents = new Set<string>();
  private lastEventTimes = new Map<string, number>();

  public isDuplicateOrOutofOrder(event: ExchangeEvent): boolean {
    const key = `${event.exchange}_${event.clientOrderId || ''}_${event.exchangeOrderId}_${event.status}`;
    if (this.processedEvents.has(key)) {
      return true;
    }

    const lastTime = this.lastEventTimes.get(event.exchangeOrderId) || 0;
    if (event.eventTime < lastTime) {
      return true; // Reject out-of-order delayed packets
    }

    this.processedEvents.add(key);
    this.lastEventTimes.set(event.exchangeOrderId, event.eventTime);

    // Keep cache bounded
    if (this.processedEvents.size > 5000) {
      const iterator = this.processedEvents.values();
      for (let i = 0; i < 1000; i++) {
        const first = iterator.next().value;
        if (first) this.processedEvents.delete(first);
      }
    }

    return false;
  }

  public clear() {
    this.processedEvents.clear();
    this.lastEventTimes.clear();
  }
}

export class WebSocketManager {
  private deduplicator = new EventDeduplicator();
  private eventListeners: Array<(event: ExchangeEvent) => void> = [];
  private listenKeyTimers = new Map<string, any>();
  private activeStreams = new Map<string, boolean>();

  public addEventListener(listener: (event: ExchangeEvent) => void) {
    this.eventListeners.push(listener);
  }

  public removeEventListener(listener: (event: ExchangeEvent) => void) {
    this.eventListeners = this.eventListeners.filter(l => l !== listener);
  }

  public getPingPayload(exchange: ExchangeName): string | null {
    if (exchange === "bybit") {
      return JSON.stringify({ op: "ping" });
    }
    if (exchange === "kucoin") {
      return JSON.stringify({ id: Date.now().toString(), type: "ping" });
    }
    return null;
  }

  public emitEvent(event: ExchangeEvent) {
    if (this.deduplicator.isDuplicateOrOutofOrder(event)) {
      return;
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[WebSocketManager] Listener error:", err);
      }
    }
  }

  // Binance ListenKey Maintenance
  public async createBinanceListenKey(restUrl: string, apiKey: string): Promise<string | null> {
    try {
      const response = await fetch(`${restUrl}/api/v3/userDataStream`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": apiKey },
      });
      if (!response.ok) return null;
      const data = await response.json() as any;
      const listenKey = data.listenKey;

      if (listenKey) {
        // Schedule keep-alive every 25 minutes (expires in 60 minutes)
        const timer = setInterval(async () => {
          try {
            await fetch(`${restUrl}/api/v3/userDataStream?listenKey=${listenKey}`, {
              method: "PUT",
              headers: { "X-MBX-APIKEY": apiKey },
            });
          } catch (e) {
            console.error("[Binance WS] Failed to keep alive listenKey:", e);
          }
        }, 25 * 60 * 1000);
        this.listenKeyTimers.set(listenKey, timer);
      }

      return listenKey;
    } catch {
      return null;
    }
  }

  public closeBinanceListenKey(listenKey: string) {
    const timer = this.listenKeyTimers.get(listenKey);
    if (timer) {
      clearInterval(timer);
      this.listenKeyTimers.delete(listenKey);
    }
  }

// WebSocket Endpoint URL Resolver across Exchanges & Environments
  public getWebSocketUrl(
    exchange: ExchangeName,
    environment: ExchangeEnvironment = "mainnet",
    _region: "global" | "india" = "global",
    listenKey?: string,
    bybitPurpose: BybitWsPurpose = "linear"
  ): string {
    if (exchange === "bybit") {
      const url = ExchangeRoutingResolver.getBybitWebSocketUrl(environment, bybitPurpose);
      return listenKey ? `${url}?listenKey=${listenKey}` : url;
    }

    throw new UnifiedError(`Unsupported exchange: ${exchange}`, "INVALID_INPUT_PARAMETERS");
  }

  public getSubscriptionPayload(exchange: ExchangeName, symbol: string, channel = "ticker"): string {
    const rawSymbol = symbol.replace(/[/\s_-]/g, '').toUpperCase();
    if (exchange === "bybit") {
      return JSON.stringify({
        op: "subscribe",
        args: [`tickers.${rawSymbol}`],
      });
    }
    return "";
  }

  // Event Ingestion Normalizers
  public normalizeBinanceExecutionReport(data: any): ExchangeEvent | null {
    if (data.e !== 'executionReport') return null;
    
    const statusMap: Record<string, any> = {
      'NEW': 'open',
      'PARTIALLY_FILLED': 'partially_filled',
      'FILLED': 'filled',
      'CANCELED': 'cancelled',
      'REJECTED': 'rejected',
      'EXPIRED': 'expired',
    };

    const status = statusMap[data.X] || 'pending';
    const cumQuote = parseFloat(data.Z || '0');
    const execQty = parseFloat(data.z || '0');
    const avgPrice = execQty > 0 ? cumQuote / execQty : parseFloat(data.p || '0');

    return {
      eventId: `${data.i}_${data.x}_${data.T}`,
      clientOrderId: data.c,
      exchangeOrderId: data.i?.toString(),
      symbol: data.s?.replace("USDT", "") || "",
      exchange: "binance",
      side: data.S === "BUY" ? "BUY" : "SELL",
      status: status,
      price: parseFloat(data.p || '0'),
      quantity: parseFloat(data.q || '0'),
      filledQuantity: execQty,
      averageFillPrice: avgPrice,
      eventTime: parseInt(data.T || Date.now().toString()),
    };
  }
}
