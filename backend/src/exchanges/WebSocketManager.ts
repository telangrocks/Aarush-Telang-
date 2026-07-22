import { ExchangeName, ExchangeEnvironment } from "./types";

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

  public normalizeBybitOrderEvent(data: any): ExchangeEvent | null {
    if (!data || !Array.isArray(data.data)) return null;
    const item = data.data[0];
    if (!item) return null;

    const statusMap: Record<string, any> = {
      'New': 'open',
      'PartiallyFilled': 'partially_filled',
      'Filled': 'filled',
      'Cancelled': 'cancelled',
      'Rejected': 'rejected',
    };

    return {
      eventId: `${item.orderId}_${item.orderStatus}_${item.updatedTime}`,
      clientOrderId: item.orderLinkId,
      exchangeOrderId: item.orderId,
      symbol: item.symbol?.replace("USDT", "") || "",
      exchange: "bybit",
      side: item.side === "Buy" ? "BUY" : "SELL",
      status: statusMap[item.orderStatus] || 'pending',
      price: parseFloat(item.price || '0'),
      quantity: parseFloat(item.qty || '0'),
      filledQuantity: parseFloat(item.cumExecQty || '0'),
      averageFillPrice: parseFloat(item.avgPrice || '0'),
      eventTime: parseInt(item.updatedTime || Date.now().toString()),
    };
  }

  public normalizeDeltaOrderEvent(data: any): ExchangeEvent | null {
    if (!data || data.type !== 'orders') return null;
    const item = data.payload || data;

    const statusMap: Record<string, any> = {
      'open': 'open',
      'pending': 'pending',
      'closed': 'filled',
      'cancelled': 'cancelled',
      'rejected': 'rejected',
    };

    let status = statusMap[item.state] || 'pending';
    const filledQty = parseFloat(item.filled_quantity || '0');
    const totalQty = parseFloat(item.size || '0');
    if (status === 'open' && filledQty > 0 && filledQty < totalQty) {
      status = 'partially_filled';
    }

    return {
      eventId: `${item.id}_${item.state}_${item.updated_at || Date.now()}`,
      clientOrderId: item.client_order_id,
      exchangeOrderId: item.id?.toString(),
      symbol: item.symbol?.replace("USD", "").replace("USDT", "") || "",
      exchange: "delta",
      side: item.side === "buy" ? "BUY" : "SELL",
      status: status,
      price: parseFloat(item.limit_price || item.avg_fill_price || '0'),
      quantity: totalQty,
      filledQuantity: filledQty,
      averageFillPrice: parseFloat(item.avg_fill_price || '0'),
      eventTime: Date.parse(item.updated_at || new Date().toISOString()),
    };
  }
}
