export class StructuredLogger {
  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const lower = k.toLowerCase();
      if (lower.includes('secret') || lower.includes('key') || lower.includes('password') || lower.includes('passphrase')) {
        clean[k] = '[REDACTED]';
      } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        clean[k] = this.sanitize(v as Record<string, unknown>);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }

  public info(message: string, context: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: 'INFO', message, context: this.sanitize(context) }));
  }

  public warn(message: string, context: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({ timestamp: new Date().toISOString(), level: 'WARN', message, context: this.sanitize(context) }));
  }

  public error(message: string, context: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'ERROR', message, context: this.sanitize(context) }));
  }

  public logExchangeRequest(req: {
    exchange: string;
    endpoint: string;
    requestUrl: string;
    symbol?: string;
    timeframe?: string;
    latencyMs: number;
    status: number | string;
    candleCount?: number;
    retryAttempts?: number;
    failures?: number;
  }): void {
    this.info(`[Exchange API] ${req.exchange.toUpperCase()} ${req.endpoint}`, req as Record<string, unknown>);
  }
}

export class MetricsCollector {
  private static counters = new Map<string, number>();
  private static histograms = new Map<string, number[]>();

  public static increment(metricName: string, value: number = 1): void {
    const current = this.counters.get(metricName) || 0;
    this.counters.set(metricName, current + value);
  }

  public static recordLatency(metricName: string, durationMs: number): void {
    if (!this.histograms.has(metricName)) {
      this.histograms.set(metricName, []);
    }
    this.histograms.get(metricName)!.push(durationMs);
  }

  public static getMetrics(): { counters: Record<string, number>; histograms: Record<string, { count: number; avg: number }> } {
    const countersObj: Record<string, number> = {};
    for (const [k, v] of this.counters.entries()) {
      countersObj[k] = v;
    }
    const histogramsObj: Record<string, { count: number; avg: number }> = {};
    for (const [k, arr] of this.histograms.entries()) {
      const avg = arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      histogramsObj[k] = { count: arr.length, avg };
    }
    return { counters: countersObj, histograms: histogramsObj };
  }
}

export class TelemetryTracer {
  constructor(
    readonly workflowId: string = `wf_${crypto.randomUUID()}`,
    readonly correlationId: string = `corr_${crypto.randomUUID()}`,
    readonly traceId: string = `tr_${crypto.randomUUID()}`
  ) {}

  public injectContext(meta: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...meta,
      workflowId: this.workflowId,
      correlationId: this.correlationId,
      traceId: this.traceId,
    };
  }
}
