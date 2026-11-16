import {
  HttpIngestServiceBinding,
  PipelineTelemetryEvent,
  ProducerDeliveryStats,
  TelemetryIngestBinding,
  TelemetryQueueEnvelope,
} from './contracts';
import { generateSpanId, sanitizeTelemetryEvent } from './sanitizer';

export interface TelemetryEmitterOptions {
  producer: TelemetryQueueEnvelope['producer'];
  queue?: TelemetryIngestBinding | null;
  httpFallback?: HttpIngestServiceBinding | null;
  httpFallbackUrl?: string;
  maxBufferSize?: number;
  maxBatchSize?: number;
  disabled?: boolean;
}

/**
 * Bounded, strictly fail-open telemetry emitter for Workers and Durable Objects.
 *
 * Guarantees:
 * 1. Never throws into caller trading paths.
 * 2. Bounded RAM buffer (drops TIER_3 first under backpressure, never grows unboundedly).
 * 3. Tracks explicit delivery milestones (EVENT_CREATED -> QUEUE_SEND_ATTEMPTED -> QUEUE_ACCEPTED | QUEUE_SEND_FAILED).
 */
export class TelemetryEmitter {
  private readonly producer: TelemetryQueueEnvelope['producer'];
  private queue: TelemetryIngestBinding | null;
  private httpFallback: HttpIngestServiceBinding | null;
  private readonly httpFallbackUrl: string;
  private readonly maxBufferSize: number;
  private readonly maxBatchSize: number;
  private readonly disabled: boolean;

  private buffer: PipelineTelemetryEvent[] = [];
  private seqCounter = 0;

  private stats: ProducerDeliveryStats = {
    eventsCreated: 0,
    queueSendAttempted: 0,
    queueAccepted: 0,
    queueSendFailed: 0,
    httpFallbackSucceeded: 0,
    httpFallbackFailed: 0,
    tier3ShedCount: 0,
    overflowDropCount: 0,
    lastEventCreatedAtMs: null,
    lastQueueAttemptAtMs: null,
    lastQueueAcceptedAtMs: null,
    lastError: null,
  };

  constructor(options: TelemetryEmitterOptions) {
    this.producer = options.producer;
    this.queue = options.queue ?? null;
    this.httpFallback = options.httpFallback ?? null;
    this.httpFallbackUrl = options.httpFallbackUrl ?? 'http://monitoring-worker/internal/ingest';
    this.maxBufferSize = options.maxBufferSize ?? 100;
    this.maxBatchSize = options.maxBatchSize ?? 25;
    this.disabled = options.disabled === true;
  }

  public isDisabled(): boolean {
    return this.disabled;
  }

  public updateBindings(queue?: TelemetryIngestBinding | null, httpFallback?: HttpIngestServiceBinding | null): void {
    if (queue !== undefined) this.queue = queue;
    if (httpFallback !== undefined) this.httpFallback = httpFallback;
  }

  public nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  public emit(raw: Omit<Partial<PipelineTelemetryEvent>, 'schemaVersion'>): PipelineTelemetryEvent | null {
    if (this.disabled) return null;
    try {
      const event = sanitizeTelemetryEvent({
        ...raw,
        stageSeq: typeof raw.stageSeq === 'number' ? raw.stageSeq : this.nextSeq(),
        emittedAtMs: typeof raw.emittedAtMs === 'number' ? raw.emittedAtMs : Date.now(),
        deliveryMilestone: 'EVENT_CREATED',
      });
      if (!event) return null;

      this.stats.eventsCreated += 1;
      this.stats.lastEventCreatedAtMs = event.emittedAtMs;

      if (this.buffer.length >= this.maxBufferSize) {
        this.makeRoomFor(event);
      }

      if (this.buffer.length < this.maxBufferSize) {
        this.buffer.push(event);
      } else {
        this.stats.overflowDropCount += 1;
      }

      return event;
    } catch (err: any) {
      this.stats.lastError = err?.message || 'emit_failed';
      return null;
    }
  }

  private makeRoomFor(incoming: PipelineTelemetryEvent): void {
    // 1. Shed lowest-priority TIER_3 first
    const tier3Idx = this.buffer.findIndex((e) => e.tier === 'TIER_3');
    if (tier3Idx !== -1) {
      this.buffer.splice(tier3Idx, 1);
      this.stats.tier3ShedCount += 1;
      return;
    }

    // 2. If incoming is TIER_3 and buffer has higher priority events, shed incoming cleanly
    if (incoming.tier === 'TIER_3') {
      this.stats.tier3ShedCount += 1;
      return;
    }

    // 3. Evict oldest TIER_2 before ever touching TIER_1
    const tier2Idx = this.buffer.findIndex((e) => e.tier === 'TIER_2');
    if (tier2Idx !== -1) {
      this.buffer.splice(tier2Idx, 1);
      this.stats.overflowDropCount += 1;
      return;
    }

    // 4. Buffer full of TIER_1 — evict oldest event so memory stays strictly bounded
    this.buffer.shift();
    this.stats.overflowDropCount += 1;
  }

  public getBufferSize(): number {
    return this.buffer.length;
  }

  public getBufferedEventsSnapshot(): readonly PipelineTelemetryEvent[] {
    return [...this.buffer];
  }

  public getHealthStats(): ProducerDeliveryStats {
    return { ...this.stats, lastError: this.stats.lastError };
  }

  /**
   * Synchronously schedules an asynchronous flush on waitUntil if provided,
   * guaranteeing zero blocking latency on trading hot paths.
   */
  public scheduleFlush(waitUntilFn?: (promise: Promise<unknown>) => void): void {
    if (this.disabled) return;
    if (this.buffer.length === 0) return;
    if (!this.queue && !this.httpFallback) return;

    const task = this.flush().catch((err: any) => {
      this.stats.lastError = err?.message || 'flush_rejected';
    });

    if (typeof waitUntilFn === 'function') {
      try {
        waitUntilFn(task);
      } catch (err: any) {
        this.stats.lastError = err?.message || 'waitUntil_rejected';
      }
    }
  }

  /**
   * Drains buffered events in bounded chunks to Queue or HTTP fallback. Never throws.
   */
  public async flush(): Promise<{ sentEvents: number; failedEvents: number }> {
    if (this.disabled) return { sentEvents: 0, failedEvents: 0 };
    if (this.buffer.length === 0) return { sentEvents: 0, failedEvents: 0 };

    const drained = this.buffer.splice(0, this.buffer.length);
    let sentEvents = 0;
    let failedEvents = 0;

    for (let i = 0; i < drained.length; i += this.maxBatchSize) {
      const chunk = drained.slice(i, i + this.maxBatchSize);
      const attemptTs = Date.now();
      this.stats.lastQueueAttemptAtMs = attemptTs;
      this.stats.queueSendAttempted += chunk.length;

      const envelope: TelemetryQueueEnvelope = {
        batchId: generateSpanId('bat'),
        producer: this.producer,
        producedAtMs: attemptTs,
        producerStats: this.getHealthStats(),
        events: chunk.map((e) => ({ ...e, deliveryMilestone: 'QUEUE_SEND_ATTEMPTED' })),
      };

      const sentViaQueue = await this.trySendQueue(envelope);
      if (sentViaQueue) {
        this.stats.queueAccepted += chunk.length;
        this.stats.lastQueueAcceptedAtMs = Date.now();
        sentEvents += chunk.length;
        continue;
      }

      const sentViaHttp = await this.trySendHttpFallback(envelope);
      if (sentViaHttp) {
        this.stats.httpFallbackSucceeded += chunk.length;
        this.stats.queueAccepted += chunk.length;
        this.stats.lastQueueAcceptedAtMs = Date.now();
        sentEvents += chunk.length;
        continue;
      }

      failedEvents += chunk.length;
      if (this.queue) this.stats.queueSendFailed += chunk.length;
      if (this.httpFallback) this.stats.httpFallbackFailed += chunk.length;
    }

    return { sentEvents, failedEvents };
  }

  private async trySendQueue(envelope: TelemetryQueueEnvelope): Promise<boolean> {
    if (!this.queue) return false;
    try {
      await this.queue.send(envelope);
      return true;
    } catch (err: any) {
      this.stats.lastError = err?.message || 'queue_send_failed';
      return false;
    }
  }

  private async trySendHttpFallback(envelope: TelemetryQueueEnvelope): Promise<boolean> {
    if (!this.httpFallback) return false;
    try {
      const res = await this.httpFallback.fetch(this.httpFallbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) {
        this.stats.lastError = `http_fallback_status_${res.status}`;
        return false;
      }
      return true;
    } catch (err: any) {
      this.stats.lastError = err?.message || 'http_fallback_error';
      return false;
    }
  }
}
