import { Result, ok, fail, createDomainError } from '../types/Result';

export class ClientOrderId {
  private constructor(readonly value: string) {}

  public static create(value?: string): Result<ClientOrderId> {
    const id = value && value.trim() ? value.trim() : crypto.randomUUID();
    return ok(new ClientOrderId(id));
  }

  public equals(other: ClientOrderId): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}

export class OrderId {
  private constructor(readonly value: string) {}

  public static create(value: string): Result<OrderId> {
    if (!value || typeof value !== 'string' || value.trim() === '') {
      return fail(createDomainError('INVALID_IDENTIFIER', 'OrderId cannot be empty.'));
    }
    return ok(new OrderId(value.trim()));
  }

  public equals(other: OrderId): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}

export type SupportedExchangeId = 'bybit';

export class ExchangeId {
  private constructor(readonly value: SupportedExchangeId) {}

  public static create(value: string): Result<ExchangeId> {
    const normalized = (value || '').trim().toLowerCase() as SupportedExchangeId;
    if (!['bybit'].includes(normalized)) {
      return fail(createDomainError('UNSUPPORTED_EXCHANGE', `Exchange '${value}' is not supported.`));
    }
    return ok(new ExchangeId(normalized));
  }

  public equals(other: ExchangeId): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }
}

export class WorkflowId {
  private constructor(readonly value: string) {}

  public static create(value?: string): Result<WorkflowId> {
    const id = value && value.trim() ? value.trim() : `wf_${crypto.randomUUID()}`;
    return ok(new WorkflowId(id));
  }

  public toString(): string {
    return this.value;
  }
}

export class CorrelationId {
  private constructor(readonly value: string) {}

  public static create(value?: string): Result<CorrelationId> {
    const id = value && value.trim() ? value.trim() : `corr_${crypto.randomUUID()}`;
    return ok(new CorrelationId(id));
  }

  public toString(): string {
    return this.value;
  }
}

export class TraceId {
  private constructor(readonly value: string) {}

  public static create(value?: string): Result<TraceId> {
    const id = value && value.trim() ? value.trim() : `tr_${crypto.randomUUID()}`;
    return ok(new TraceId(id));
  }

  public toString(): string {
    return this.value;
  }
}
