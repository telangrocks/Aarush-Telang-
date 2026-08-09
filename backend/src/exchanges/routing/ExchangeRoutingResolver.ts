// backend/src/exchanges/routing/ExchangeRoutingResolver.ts

import { CanonicalRoutingRegion, resolveCanonicalRoutingRegion } from "../../utils/region";
import { CanonicalEnvironment, resolveCanonicalEnvironment } from "../../utils/environment";
import { UnifiedError } from "../models/UnifiedError";

export type ExchangeProductCategory = "spot" | "linear" | "inverse" | "option" | "futures";

export type BybitWsPurpose = "spot" | "linear" | "inverse" | "option" | "private" | "trade";

export type KuCoinWsPurpose = "public" | "private";

export interface RoutingContext {
  exchange: "binance" | "bybit" | "kucoin" | string;
  product?: ExchangeProductCategory;
  environment: string;
  region?: string;
}

export interface KuCoinBulletTokenResponse {
  token: string;
  instanceServers: Array<{
    endpoint: string;
    pingInterval: number;
    pingTimeout: number;
  }>;
}

export class ExchangeRoutingResolver {
  public static getCanonicalRegion(_rawRegion?: unknown): CanonicalRoutingRegion {
    return resolveCanonicalRoutingRegion(_rawRegion);
  }

  public static getCanonicalEnvironment(env?: unknown): CanonicalEnvironment {
    return resolveCanonicalEnvironment(env);
  }

  /**
   * Primary REST URL resolution method returning a single authoritative endpoint string.
   * Cloudflare Worker / Hono compatible via optional envBindings parameter.
   */
  public static getRestUrl(context: RoutingContext, envBindings?: Record<string, unknown>): string {
    const exchange = (context.exchange || "").toLowerCase().trim();
    const env = this.getCanonicalEnvironment(context.environment);
    const product = context.product || "spot";

    if (exchange === "binance") {
      if (env === "testnet") {
        const customTestnet = envBindings?.BINANCE_TESTNET_URL as string;
        return (customTestnet || "https://testnet.binance.vision").replace(/\/$/, "");
      }
      if (env === "demo") {
        throw new UnifiedError("Binance does not support demo environment.", "UNSUPPORTED_OPERATION");
      }
      const customBase = envBindings?.BINANCE_BASE_URL as string;
      return (customBase && customBase.trim() !== "") ? customBase.replace(/\/$/, "") : "https://api.binance.com";
    }

    if (exchange === "bybit") {
      if (env === "demo") return "https://api-demo.bybit.com";
      if (env === "testnet") {
        const customTestnet = envBindings?.BYBIT_TESTNET_URL as string;
        return (customTestnet || "https://api-testnet.bybit.com").replace(/\/$/, "");
      }
      return "https://api.bybit.com";
    }

    if (exchange === "kucoin") {
      if (env === "demo" || env === "testnet") {
        throw new UnifiedError("KuCoin Sandbox/Testnet is officially deprecated and offline.", "UNSUPPORTED_OPERATION");
      }
      if (product === "futures") {
        return "https://api-futures.kucoin.com";
      }
      return "https://api.kucoin.com";
    }

    throw new UnifiedError(`Unsupported exchange: ${context.exchange}`, "INVALID_INPUT_PARAMETERS");
  }

  /**
   * Adapter Compatibility Helper:
   * Returns a single-element array containing getRestUrl().
   * NOTE: This array is strictly an adapter interface contract and MUST NOT be interpreted
   * as permission for cross-jurisdiction failover (e.g. Binance US is NEVER included).
   */
  public static getRestUrls(context: RoutingContext, envBindings?: Record<string, unknown>): string[] {
    return [this.getRestUrl(context, envBindings)];
  }

  /**
   * Product/Purpose-Aware Bybit WebSocket URL Resolver.
   */
  public static getBybitWebSocketUrl(envInput: string, purpose: BybitWsPurpose): string {
    const env = this.getCanonicalEnvironment(envInput);
    const domain = env === "testnet" ? "stream-testnet.bybit.com" : env === "demo" ? "stream-demo.bybit.com" : "stream.bybit.com";
    const path = (purpose === "private" || purpose === "trade") ? purpose : `public/${purpose}`;
    return `wss://${domain}/v5/${path}`;
  }


  /**
   * Binance WebSocket URL Resolver.
   */
  public static getBinanceWebSocketUrl(envInput: string, listenKey?: string): string {
    const env = this.getCanonicalEnvironment(envInput);
    const baseUrl = env === "testnet" ? "wss://testnet.binance.vision/ws" : "wss://stream.binance.com:9443/ws";
    return listenKey ? `${baseUrl}/${listenKey}` : baseUrl;
  }
}
