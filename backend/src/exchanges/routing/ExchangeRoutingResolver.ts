// backend/src/exchanges/routing/ExchangeRoutingResolver.ts

import { CanonicalRoutingRegion, resolveCanonicalRoutingRegion } from "../../utils/region";
import { CanonicalEnvironment, resolveCanonicalEnvironment } from "../../utils/environment";
import { UnifiedError } from "../models/UnifiedError";

export type ExchangeProductCategory = "spot" | "linear" | "inverse" | "option" | "futures";

export type BybitWsPurpose = "spot" | "linear" | "inverse" | "option" | "private" | "trade";

export interface RoutingContext {
  exchange: "bybit" | string;
  product?: ExchangeProductCategory;
  environment: string;
  region?: string;
}

export class ExchangeRoutingResolver {
  public static getCanonicalRegion(_rawRegion?: unknown): CanonicalRoutingRegion {
    return resolveCanonicalRoutingRegion(_rawRegion);
  }

  public static getCanonicalEnvironment(env?: unknown): CanonicalEnvironment {
    return resolveCanonicalEnvironment(env);
  }

  /**
   * Primary REST URL resolution returning authoritative endpoint for Bybit Demo / Mainnet.
   */
  public static getRestUrl(context: RoutingContext, envBindings?: Record<string, unknown>): string {
    const exchange = (context.exchange || "").toLowerCase().trim();
    if (exchange !== "bybit" && exchange !== "") {
      // Legacy connection attempt -> throw invalidation error
      throw new UnifiedError(`Exchange '${context.exchange}' is no longer supported. Please connect Bybit.`, "EXCHANGE_RECONNECT_REQUIRED");
    }

    const env = this.getCanonicalEnvironment(context.environment);
    if (env === "demo") {
      return "https://api-demo.bybit.com";
    }
    if (env === "testnet") {
      return "https://api-testnet.bybit.com";
    }
    return "https://api.bybit.com";
  }

  /**
   * Adapter Compatibility Helper: Returns primary REST URL array.
   */
  public static getRestUrls(context: RoutingContext, envBindings?: Record<string, unknown>): string[] {
    return [this.getRestUrl(context, envBindings)];
  }

  /**
   * Product/Purpose-Aware Bybit WebSocket URL Resolver.
   */
  public static getBybitWebSocketUrl(envInput: string, purpose: BybitWsPurpose): string {
    const env = this.getCanonicalEnvironment(envInput);
    const domain = env === "demo" ? "stream-demo.bybit.com" : env === "testnet" ? "stream-testnet.bybit.com" : "stream.bybit.com";
    const path = (purpose === "private" || purpose === "trade") ? purpose : `public/${purpose}`;
    return `wss://${domain}/v5/${path}`;
  }
}

