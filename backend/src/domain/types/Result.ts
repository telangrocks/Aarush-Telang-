export type DomainErrorCode =
  | 'INVALID_SYMBOL'
  | 'INVALID_PRICE'
  | 'INVALID_QUANTITY'
  | 'INVALID_MONEY'
  | 'INVALID_PERCENTAGE'
  | 'INVALID_IDENTIFIER'
  | 'UNSUPPORTED_EXCHANGE'
  | 'EXCHANGE_ERROR'
  | 'AUTHENTICATION_FAILED'
  | 'INSUFFICIENT_FUNDS'
  | 'REGION_NOT_SUPPORTED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'CIRCUIT_OPEN'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

export interface DomainError {
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type Result<T, E = DomainError> = Success<T, E> | Failure<T, E>;

export class Success<T, E> {
  readonly isSuccess = true;
  readonly isFailure = false;
  constructor(readonly value: T) {}
}

export class Failure<T, E> {
  readonly isSuccess = false;
  readonly isFailure = true;
  constructor(readonly error: E) {}
}

export function ok<T, E = DomainError>(value: T): Result<T, E> {
  return new Success(value);
}

export function fail<T = never, E = DomainError>(error: E): Result<T, E> {
  return new Failure(error);
}

export function createDomainError(
  code: DomainErrorCode,
  message: string,
  details?: Record<string, unknown>
): DomainError {
  return { code, message, details };
}
