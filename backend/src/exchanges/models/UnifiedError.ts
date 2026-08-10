export class UnifiedError extends Error {
  public mappedInternalErrorCode: string;
  public originalExchangeErrorCode?: string | number;
  public originalExchangeErrorMessage?: string;
  public status?: number;

  constructor(
    message: string,
    mappedInternalErrorCode: string,
    originalExchangeErrorCode?: string | number,
    originalExchangeErrorMessage?: string,
    status?: number
  ) {
    super(message);
    this.name = 'UnifiedError';
    this.mappedInternalErrorCode = mappedInternalErrorCode;
    this.originalExchangeErrorCode = originalExchangeErrorCode;
    this.originalExchangeErrorMessage = originalExchangeErrorMessage;
    this.status = typeof originalExchangeErrorCode === 'number' && originalExchangeErrorCode >= 100 && originalExchangeErrorCode < 600 ? originalExchangeErrorCode : status;
  }

  public get code(): string {
    return this.mappedInternalErrorCode;
  }
}
