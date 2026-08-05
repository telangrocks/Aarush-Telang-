export interface DomainEvent {
  readonly eventId: string;
  readonly timestamp: number;
  readonly eventType: string;
}

export type EventHandler<T extends DomainEvent = DomainEvent> = (event: T) => Promise<void> | void;

export class EventBus {
  private handlers = new Map<string, EventHandler[]>();

  public subscribe<T extends DomainEvent>(eventType: string, handler: EventHandler<T>): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, []);
    }
    this.handlers.get(eventType)!.push(handler as EventHandler);
  }

  public async publish<T extends DomainEvent>(event: T): Promise<void> {
    const list = this.handlers.get(event.eventType) || [];
    for (const handler of list) {
      try {
        await handler(event);
      } catch (err) {
        console.error(`[EventBus] Handler exception for ${event.eventType}:`, err);
      }
    }
  }

  public clear(): void {
    this.handlers.clear();
  }
}
