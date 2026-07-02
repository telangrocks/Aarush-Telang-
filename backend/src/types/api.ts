/**
 * API Response types
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface ApiError {
  error: string;
  statusCode: number;
  message: string;
}

/**
 * Crypto Price types (for Feature 1)
 */
export interface CryptoPriceBasic {
  id: string;
  symbol: string;
  name: string;
  current_price: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
}

export interface CryptoPrice extends CryptoPriceBasic {
  market_cap: number;
  market_cap_rank: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  price_change_7d: number;
  price_change_percentage_7d: number;
}
