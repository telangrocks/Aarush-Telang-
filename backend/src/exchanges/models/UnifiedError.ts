export class UnifiedError extends Error {
  public mappedInternalErrorCode: string;
  public originalExchangeErrorCode?: string | number;
  public originalExchangeErrorMessage?: string;

  constructor(
    message: string,
    mappedInternalErrorCode: string,
    originalExchangeErrorCode?: string | number,
    originalExchangeErrorMessage?: string
  ) {
    super(message);
    this.name = 'UnifiedError';
    this.mappedInternalErrorCode = mappedInternalErrorCode;
    this.originalExchangeErrorCode = originalExchangeErrorCode;
    this.originalExchangeErrorMessage = originalExchangeErrorMessage;
  }

  public get code(): string {
    return this.mappedInternalErrorCode;
  }
}
