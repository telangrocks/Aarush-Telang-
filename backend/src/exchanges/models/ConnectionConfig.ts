export interface ProviderConfig {
  apiKey?: string;
  secret?: string;
  password?: string;
  passphrase?: string;
  environment: 'Production' | 'Testing' | 'mainnet' | 'testnet' | 'sandbox';
}

export interface ExchangeCapabilities {
  hasSandbox: boolean;
  hasFetchPositions: boolean;
  hasFetchOrderBook: boolean;
  hasFetchTicker: boolean;
  hasCreateOrder: boolean;
  hasCancelOrder: boolean;
  hasFetchOrder: boolean;
  hasFetchOpenOrders: boolean;
  hasFetchClosedOrders: boolean;
  hasFetchMyTrades: boolean;
}
