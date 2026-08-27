/**
 * Centralised, exchange-agnostic error classification for the connect-exchange
 * and bot-activation flows.
 */

import { ExchangeErrorClassifier } from './ExchangeErrorClassifier';

export type ExchangeErrorCode =
  | "INVALID_API_KEY"
  | "INVALID_API_KEY_OR_IP_OR_PERMISSION"
  | "INVALID_API_SECRET"
  | "INVALID_PASSPHRASE"
  | "IP_NOT_WHITELISTED"
  | "SPOT_TRADING_NOT_ENABLED"
  | "PERMISSION_DENIED"
  | "READ_ONLY_API_KEY"
  | "INVALID_SIGNATURE"
  | "TIMESTAMP_OUT_OF_SYNC"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_RESTRICTED"
  | "API_RATE_LIMIT_REACHED"
  | "NETWORK_TIMEOUT"
  | "SSL_CONNECTION_FAILURE"
  | "EXCHANGE_UNDER_MAINTENANCE"
  | "SERVICE_TEMPORARILY_UNAVAILABLE"
  | "AUTHENTICATION_FAILED"
  | "REGION_NOT_SUPPORTED"
  | "LEGAL_RESTRICTION_UNKNOWN"
  | "EXCHANGE_NOT_REACHABLE"
  | "INSUFFICIENT_PERMISSIONS"
  | "INVALID_API_VERSION"
  | "MISSING_REQUIRED_CREDENTIALS"
  | "BINANCE_NETWORK_BLOCKED"
  | "UPSTREAM_PROVIDER_BLOCKED"
  | "INSUFFICIENT_BALANCE"
  | "NETWORK_ERROR"
  | "WAF_BLOCKED"
  | "INVALID_REQUEST"
  | "NOT_CONNECTED"
  | "DATABASE_ERROR"
  | "UNSUPPORTED_OPERATION"
  | "CIRCUIT_OPEN"
  | "EXCHANGE_TIMEOUT"
  | "UNKNOWN_EXCHANGE_ERROR";

export interface ExchangeErrorInfo {
  code: ExchangeErrorCode;
  friendlyMessage: string;
  /** Short action hint shown under the message in the app. */
  hint?: string;
}

export const FRIENDLY_MESSAGES: Record<ExchangeErrorCode, ExchangeErrorInfo> = {
  READ_ONLY_API_KEY: {
    code: "READ_ONLY_API_KEY",
    friendlyMessage: "Your Bybit API key is Read-Only. Trading permissions are required.",
    hint: "Please generate or update your Bybit API key with 'Trade' permissions (Orders and Positions) enabled.",
  },
  INVALID_API_KEY: {
    code: "INVALID_API_KEY",
    friendlyMessage: "The API Key you entered isn't recognised by the exchange.",
    hint: "Double-check the key for typos, or generate a fresh one in your exchange account settings.",
  },
  INVALID_API_KEY_OR_IP_OR_PERMISSION: {
    code: "INVALID_API_KEY_OR_IP_OR_PERMISSION",
    friendlyMessage: "Binance rejected authentication. This can be caused by an invalid API key, IP whitelist restriction, or missing API permissions.",
    hint: "Verify your API Key/Secret, check if IP whitelisting is enabled on Binance, and ensure 'Enable Reading' permission is checked.",
  },
  INVALID_API_SECRET: {
    code: "INVALID_API_SECRET",
    friendlyMessage: "The API Secret doesn't match the API Key.",
    hint: "Make sure you pasted the secret that belongs to this exact API Key (not an older one).",
  },
  INVALID_PASSPHRASE: {
    code: "INVALID_PASSPHRASE",
    friendlyMessage: "The API Passphrase you entered is incorrect.",
    hint: "Verify the passphrase created for this API key on the exchange.",
  },
  IP_NOT_WHITELISTED: {
    code: "IP_NOT_WHITELISTED",
    friendlyMessage: "Your exchange account restricts API access to specific IP addresses.",
    hint: "Add Crypto Pulse's server IP to your exchange API whitelist, or turn off IP restrictions for this key.",
  },
  BINANCE_NETWORK_BLOCKED: {
    code: "BINANCE_NETWORK_BLOCKED",
    friendlyMessage: "Crypto Pulse is temporarily unable to reach Binance due to a network restriction.",
    hint: "This is a server-side connectivity issue. Please try again later.",
  },
  UPSTREAM_PROVIDER_BLOCKED: {
    code: "UPSTREAM_PROVIDER_BLOCKED",
    friendlyMessage: "An upstream provider is blocking our connection to the exchange.",
    hint: "This is a server-side issue, not a problem with your API keys.",
  },
  SPOT_TRADING_NOT_ENABLED: {
    code: "SPOT_TRADING_NOT_ENABLED",
    friendlyMessage: "Linear perpetual trading is not enabled on this API key.",
    hint: "Go to your exchange API settings and enable 'Orders/Positions' permissions for Bybit Linear perpetual trading.",
  },
  INSUFFICIENT_BALANCE: {
    code: "INSUFFICIENT_BALANCE",
    friendlyMessage: "Insufficient balance to perform this operation.",
    hint: "Check your exchange wallet balance and try again.",
  },
  PERMISSION_DENIED: {
    code: "PERMISSION_DENIED",
    friendlyMessage: "Access denied. Your API key does not have the necessary permissions.",
    hint: "Ensure the key has 'Read' and 'Orders/Positions' (Bybit Linear / USDT Perpetual) permissions enabled.",
  },
  INVALID_SIGNATURE: {
    code: "INVALID_SIGNATURE",
    friendlyMessage: "The request signature could not be verified by the exchange.",
    hint: "Verify your API Secret is correct and the system time matches the exchange server time.",
  },
  TIMESTAMP_OUT_OF_SYNC: {
    code: "TIMESTAMP_OUT_OF_SYNC",
    friendlyMessage: "Your device time appears to be out of sync.",
    hint: "Enable automatic date and time settings on your device, then try again.",
  },
  ACCOUNT_SUSPENDED: {
    code: "ACCOUNT_SUSPENDED",
    friendlyMessage: "Your exchange account is suspended.",
    hint: "Please contact the exchange customer support to resolve your account status.",
  },
  ACCOUNT_RESTRICTED: {
    code: "ACCOUNT_RESTRICTED",
    friendlyMessage: "Your exchange account has restrictions placed on it.",
    hint: "Ensure your account has completed KYC verification and has no active trading holds.",
  },
  API_RATE_LIMIT_REACHED: {
    code: "API_RATE_LIMIT_REACHED",
    friendlyMessage: "Too many requests were sent to the exchange too quickly.",
    hint: "Please wait a moment and try again.",
  },
  NETWORK_TIMEOUT: {
    code: "NETWORK_TIMEOUT",
    friendlyMessage: "We couldn't reach the exchange in time.",
    hint: "Check your internet connection or try again in a few moments.",
  },
  NETWORK_ERROR: {
    code: "NETWORK_ERROR",
    friendlyMessage: "Network connection to the exchange failed.",
    hint: "Crypto Pulse could not establish a network connection to the exchange servers. Please try again.",
  },
  SSL_CONNECTION_FAILURE: {
    code: "SSL_CONNECTION_FAILURE",
    friendlyMessage: "Secure connection to the exchange failed.",
    hint: "The exchange secure certificate could not be verified or is blocked by your network.",
  },
  EXCHANGE_UNDER_MAINTENANCE: {
    code: "EXCHANGE_UNDER_MAINTENANCE",
    friendlyMessage: "The exchange is currently undergoing system maintenance.",
    hint: "The exchange has paused API operations. Please try again after maintenance completes.",
  },
  SERVICE_TEMPORARILY_UNAVAILABLE: {
    code: "SERVICE_TEMPORARILY_UNAVAILABLE",
    friendlyMessage: "The exchange service is temporarily unavailable.",
    hint: "The exchange servers are busy or experiencing downtime. Please try again in a few minutes.",
  },
  AUTHENTICATION_FAILED: {
    code: "AUTHENTICATION_FAILED",
    friendlyMessage: "We couldn't authenticate with the exchange using these credentials.",
    hint: "Verify your API Key and Secret, then try again.",
  },
  REGION_NOT_SUPPORTED: {
    code: "REGION_NOT_SUPPORTED",
    friendlyMessage: "This exchange or endpoint is not supported in your region.",
    hint: "Due to local regulations, some markets or products may be blocked. Verify your regional settings.",
  },
  LEGAL_RESTRICTION_UNKNOWN: {
    code: "LEGAL_RESTRICTION_UNKNOWN",
    friendlyMessage: "Access to this exchange endpoint was restricted by a server policy.",
    hint: "Verify your network connection, or try again later.",
  },
  EXCHANGE_NOT_REACHABLE: {
    code: "EXCHANGE_NOT_REACHABLE",
    friendlyMessage: "The exchange API is currently not reachable.",
    hint: "Check if the exchange is down, or if your local firewall/ISP is blocking access to it.",
  },
  INSUFFICIENT_PERMISSIONS: {
    code: "INSUFFICIENT_PERMISSIONS",
    friendlyMessage: "Your API key doesn't have the permissions Crypto Pulse needs.",
    hint: "Enable 'Read' and 'Orders/Positions' (Bybit Linear / USDT Perpetual) permissions, then reconnect. We never require withdrawal access.",
  },
  INVALID_API_VERSION: {
    code: "INVALID_API_VERSION",
    friendlyMessage: "The API version requested is no longer supported by the exchange.",
    hint: "Please update the application to use the latest supported API endpoints.",
  },
  MISSING_REQUIRED_CREDENTIALS: {
    code: "MISSING_REQUIRED_CREDENTIALS",
    friendlyMessage: "Required exchange credentials (API Key or Secret) are missing.",
    hint: "Please provide all required fields before connecting your exchange.",
  },
  WAF_BLOCKED: {
    code: "WAF_BLOCKED",
    friendlyMessage: "Connection temporarily blocked by exchange firewall/WAF.",
    hint: "This is a server-side connectivity restriction by the exchange. Our team is actively monitoring this.",
  },
  INVALID_REQUEST: {
    code: "INVALID_REQUEST",
    friendlyMessage: "The request sent to the exchange was malformed or invalid.",
    hint: "Verify your request parameters, symbol format, and payload parameters.",
  },
  NOT_CONNECTED: {
    code: "NOT_CONNECTED",
    friendlyMessage: "Exchange adapter is not connected.",
    hint: "Please call connect() with valid credentials before executing operations.",
  },
  DATABASE_ERROR: {
    code: "DATABASE_ERROR",
    friendlyMessage: "An internal database error occurred while processing the request.",
    hint: "This is an internal system error. Please try again or contact support.",
  },
  UNSUPPORTED_OPERATION: {
    code: "UNSUPPORTED_OPERATION",
    friendlyMessage: "The requested operation is not supported by this exchange or adapter.",
    hint: "Verify that the exchange supports this feature or order type.",
  },
  CIRCUIT_OPEN: {
    code: "CIRCUIT_OPEN",
    friendlyMessage: "Requests to this exchange are temporarily paused by safety circuit breaker.",
    hint: "Please wait a moment while the circuit breaker resets before retrying.",
  },
  EXCHANGE_TIMEOUT: {
    code: "EXCHANGE_TIMEOUT",
    friendlyMessage: "Request to the exchange timed out.",
    hint: "Check your connection latency or retry the request.",
  },
  UNKNOWN_EXCHANGE_ERROR: {
    code: "UNKNOWN_EXCHANGE_ERROR",
    friendlyMessage: "Something went wrong while connecting to the exchange.",
    hint: "Please try again. If the problem continues, contact support.",
  },
};

export interface ClassifiedError {
  code: ExchangeErrorCode;
  friendlyMessage: string;
  hint?: string;
  technicalDetail: string;
  version: string;
  correlationId?: string;
}

export function classifyExchangeResponse(
  status: number,
  bodyText: string,
  exchangeName: string,
  headers: Record<string, string> = {},
  correlationId?: string
): ClassifiedError {
  return ExchangeErrorClassifier.getInstance().classifyResponse(exchangeName, status, headers, bodyText, correlationId);
}



export function classifyByBodyText(
  lower: string,
  _technicalDetail: string,
  exchangeName: string
): ClassifiedError {
  return ExchangeErrorClassifier.getInstance().classifyResponse(exchangeName, 400, {}, lower);
}

export function classifyException(error: unknown, exchangeName: string, correlationId?: string): ClassifiedError {
  return ExchangeErrorClassifier.getInstance().classifyException(error, exchangeName, correlationId);
}

export function classifyByBody(bodyText: string, exchangeName: string): ClassifiedError {
  return ExchangeErrorClassifier.getInstance().classifyResponse(exchangeName, 400, {}, bodyText);
}
