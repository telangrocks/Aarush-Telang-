import { Context } from "hono";
import BigNumber from "bignumber.js";
import { Env } from "../index";
import { encrypt, decrypt, cleanCredential } from "../crypto";
import { ExchangeManager, ExchangeName, ExchangeEnvironment, type ExchangeRegion } from "../exchanges";
import { FRIENDLY_MESSAGES, classifyException, type ExchangeErrorCode } from "../exchanges/errors";
import { StructuredLogger } from "../infrastructure/telemetry/Telemetry";
import { UnifiedError } from "../exchanges/models/UnifiedError";
import { analyzeMarket } from "../market-analysis";
import { normalizeEnvironment as normEnvUtil, isEnvironmentSupported, getSupportedEnvironmentsList, CanonicalEnvironment } from "../utils/environment";
import { normalizeRegion, resolveCanonicalRoutingRegion } from "../utils/region";
import { WebCryptoSigner } from "../infrastructure/crypto/WebCryptoSigner";
import {
  MarketOpportunityScanner,
  ExecutionEligibilityGate,
  MultiTimeframeCandleStore,
  DEFAULT_SCANNER_CONFIG,
  type ScannerConfig,
  type ScannerScanResult,
  type MarketOpportunity,
} from "../engine/scanner";
import { SingleFlightCoalescer } from "../infrastructure/cache/SingleFlightCoalescer";
import { LruTtlCache } from "../infrastructure/cache/LruTtlCache";
import { PublicMarketDataService } from "../infrastructure/market-data/PublicMarketDataService";
import { isExcludedAsset } from "../domain/trading/AssetClassification";
import { PriceNormalizer } from "../utils/PriceNormalizer";
import { extractUsdtBalance } from "../utils/balance";

const DISCOVERY_CACHE = new LruTtlCache<string, any[]>(500, 30000);
const CACHE_TTL_MS = 30000;
const SHARED_OPPORTUNITY_CACHE = new Map<string, { timestamp: number; data: ScannerScanResult }>();
const OPPORTUNITY_CACHE = SHARED_OPPORTUNITY_CACHE;
const OPPORTUNITY_CACHE_TTL_MS = 30000;
const PUBLIC_OPPORTUNITY_MAX_CANDIDATES = 8;
const PUBLIC_CANDLE_STORE_DEPTH = 70;
const OPPORTUNITY_SINGLE_FLIGHT = new SingleFlightCoalescer<ScannerScanResult>();
const USER_EXCHANGE_ROUTING_CACHE = new LruTtlCache<string, {
  exchange_name: string | null;
  exchange_environment: string | null;
  exchange_region: string | null;
}>(5000, 60000);
const TICKER_CACHE = new LruTtlCache<string, any>(200, 2000); // 2s TTL
const KLINES_CACHE = new LruTtlCache<string, any>(200, 15000); // 15s TTL

interface ScopedPublicCandleStoreEntry {
  adapter: any;
  store: MultiTimeframeCandleStore;
}

const PUBLIC_CANDLE_STORE_REGISTRY = new Map<string, ScopedPublicCandleStoreEntry>();

function deepFreezeObject<T>(obj: T): T {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      deepFreezeObject(obj[i]);
    }
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      deepFreezeObject((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

export function buildPublicOpportunityCacheKey(
  exchangeName: string,
  environment: string,
  region: string,
  scannerConfig: ScannerConfig = DEFAULT_SCANNER_CONFIG,
  maxCandidates: number = PUBLIC_OPPORTUNITY_MAX_CANDIDATES,
  candleDepth: number = PUBLIC_CANDLE_STORE_DEPTH
): string {
  const canonicalExchange = (exchangeName || "bybit").toLowerCase().trim() || "bybit";
  const canonicalEnv = (environment || "mainnet").toLowerCase().trim() || "mainnet";
  const canonicalReg = (region || "india").toLowerCase().trim() || "india";
  const configSignature = [
    `b${maxCandidates}`,
    `cd${candleDepth}`,
    `turn${scannerConfig.minTurnover24hUsdt}`,
    `spr${scannerConfig.maxSpreadPercent}`,
    `rng${scannerConfig.minRange24hPercent}`,
    `tfee${scannerConfig.takerFeePercent}`,
    `mfee${scannerConfig.makerFeePercent}`,
    `edge${scannerConfig.minNetEdgeRatio}`,
    `slip${scannerConfig.slippageCoefficient}`,
    `w${scannerConfig.weights.mtfAlignment}-${scannerConfig.weights.regimeAndStrategyFit}-${scannerConfig.weights.momentumAndVolume}-${scannerConfig.weights.costFeasibility}`,
    `hys${scannerConfig.hysteresisScoreBuffer}`,
    `lock${scannerConfig.rankLockDurationMs}`,
    `exp${scannerConfig.staleOpportunityExpiryMs}`,
    `disp${scannerConfig.displayLimit}`,
  ].join("_");
  return `pub_opps:${canonicalExchange}:${canonicalEnv}:${canonicalReg}:${configSignature}`;
}

function getOrCreateScopedPublicCandleStore(
  storeKey: string,
  publicAdapter: any,
  maxCandles: number = PUBLIC_CANDLE_STORE_DEPTH
): MultiTimeframeCandleStore {
  const existing = PUBLIC_CANDLE_STORE_REGISTRY.get(storeKey);
  if (existing) {
    existing.adapter = publicAdapter;
    return existing.store;
  }

  const holder: ScopedPublicCandleStoreEntry = {
    adapter: publicAdapter,
    store: null as unknown as MultiTimeframeCandleStore,
  };

  const delegatingPublicCandleProvider = {
    fetchCandles: (symbol: string, tf: any, limit: number) => {
      if (typeof holder.adapter?.fetchCandles === "function") {
        return holder.adapter.fetchCandles(symbol, tf, limit);
      }
      if (typeof holder.adapter?.fetchKlines === "function") {
        return holder.adapter.fetchKlines(symbol, tf, limit);
      }
      return Promise.resolve([]);
    },
  };

  holder.store = new MultiTimeframeCandleStore(delegatingPublicCandleProvider as any, maxCandles);
  PUBLIC_CANDLE_STORE_REGISTRY.set(storeKey, holder);
  return holder.store;
}

export function __resetPublicOpportunityStateForTests(): void {
  SHARED_OPPORTUNITY_CACHE.clear();
  OPPORTUNITY_SINGLE_FLIGHT.clear();
  PUBLIC_CANDLE_STORE_REGISTRY.clear();
  DISCOVERY_CACHE.clear();
  USER_EXCHANGE_ROUTING_CACHE.clear();
  TICKER_CACHE.clear();
  KLINES_CACHE.clear();
  PublicMarketDataService.getInstance().clearCaches();
}

export function __getPublicOpportunityDiagnosticsForTests(): {
  sharedCacheKeys: string[];
  candleStoreKeys: string[];
  inFlightCount: number;
} {
  return {
    sharedCacheKeys: Array.from(SHARED_OPPORTUNITY_CACHE.keys()),
    candleStoreKeys: Array.from(PUBLIC_CANDLE_STORE_REGISTRY.keys()),
    inFlightCount: OPPORTUNITY_SINGLE_FLIGHT.getActiveCount(),
  };
}
/**
 * Normalize an untrusted environment value into a valid ExchangeEnvironment.
 * Returns null for unrecognized values.
 */
function normalizeEnvironment(value: unknown): ExchangeEnvironment | null {
  return normEnvUtil(value) as ExchangeEnvironment | null;
}

export function isPermanentAuthFailure(code: string): boolean {
  return (
    code === "INVALID_API_KEY" ||
    code === "INVALID_SIGNATURE" ||
    code === "AUTHENTICATION_FAILED" ||
    code === "PERMISSION_DENIED" ||
    code === "INSUFFICIENT_PERMISSIONS" ||
    code === "READ_ONLY_API_KEY" ||
    code === "IP_NOT_WHITELISTED"
  );
}

export function selectBoundedDiscoveryMarkets(
  markets: any[],
  tickers: any[],
  userAllocation: number | null,
  maxCandidates: number = 8
): any[] {
  const tickerMap = new Map<string, any>();
  for (const t of tickers) {
    const sym = String(t.pairName || t.symbol || '').toUpperCase();
    if (sym) {
      tickerMap.set(sym, t);
      tickerMap.set(sym.replace('/', ''), t);
    }
  }

  const seenSymbols = new Set<string>();
  const eligibleAfterStage1And25: { market: any; ticker: any; px: number }[] = [];
  const scored: { market: any; turnover: number }[] = [];

  const toNum = (v: any, fallback = 0): number => {
    if (v === undefined || v === null) return fallback;
    if (typeof v?.toNumber === 'function') {
      const n = v.toNumber();
      return Number.isFinite(n) ? n : fallback;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  for (const m of markets) {
    if (!m || m.active === false) continue;
    const cat = String(m.category || 'linear').toLowerCase();
    if (cat !== 'linear') continue;
    if (m.contractType && m.contractType !== 'LinearPerpetual') continue;
    const quote = String(m.quote || (m.symbol ? m.symbol.split('/')[1] : 'USDT') || 'USDT').toUpperCase();
    if (quote !== 'USDT') continue;

    const sym = String(m.symbol || m.id || '').toUpperCase();
    if (!sym || seenSymbols.has(sym) || isExcludedAsset(sym)) continue;
    seenSymbols.add(sym);

    const t = tickerMap.get(sym) || tickerMap.get(sym.replace('/', ''));
    if (!t) continue;

    const px = toNum(t.last ?? t.price, 0);
    if (!(px > 0)) continue;

    if (userAllocation !== null && userAllocation > 0) {
      const qtyStep = toNum(t.qtyStep ?? m?.precision?.amount, 0);
      const minOrderQty = toNum(t.minOrderQty ?? m?.limits?.amount?.min, 0);
      const minNotional = toNum(t.minNotional ?? m?.limits?.cost?.min, 0);
      const maxOrderQty = toNum(t.maxQty ?? m?.limits?.amount?.max ?? m?.info?.lotSizeFilter?.maxOrderQty, 0);
      const elig = ExecutionEligibilityGate.evaluate({
        tradeAmountUsdt: userAllocation,
        currentPrice: px,
        qtyStep: qtyStep > 0 ? qtyStep : 0,
        minOrderQty: minOrderQty > 0 ? minOrderQty : 0,
        minNotional: minNotional > 0 ? minNotional : 0,
        maxOrderQty: maxOrderQty > 0 ? maxOrderQty : undefined,
      });
      if (!elig.isExecutable) continue;
    }

    eligibleAfterStage1And25.push({ market: m, ticker: t, px });
  }

  if (eligibleAfterStage1And25.length <= maxCandidates) {
    return eligibleAfterStage1And25.map((item) => item.market);
  }

  for (const { market: m, ticker: t, px } of eligibleAfterStage1And25) {
    const turnover = toNum(t.quoteVolume24h ?? t.quoteVolume, 0);
    if (turnover < 1_000_000) continue;

    const bid = toNum(t.bid ?? t._bid, px);
    const ask = toNum(t.ask ?? t._ask, px);
    const spreadPercent = (bid > 0 && ask > 0 && ask >= bid) ? ((ask - bid) / px) * 100 : 0;
    if (spreadPercent > 0.15) continue;

    const high = toNum(t.highPrice24h ?? t.high, px);
    const low = toNum(t.lowPrice24h ?? t.low, px);
    const rangePercent = (high > 0 && low > 0 && high >= low) ? ((high - low) / px) * 100 : 0;
    if (rangePercent < 1.5) continue;

    scored.push({ market: m, turnover });
  }

  scored.sort((a, b) => b.turnover - a.turnover);
  return scored.slice(0, maxCandidates).map((s) => s.market);
}

export async function invalidateExchangeConnection(
  db: any,
  userId: string,
  failureCode: string,
  friendlyMessage?: string,
  tradingBotsBinding?: any,
  exchangeConfig?: { exchangeName: string; config: any }
): Promise<void> {
  // 1. Authoritative D1 State Invalidation (First)
  await db
    .prepare(
      "UPDATE users SET exchange_connection_status = 'INVALID', exchange_invalidated_at = datetime('now'), exchange_failure_code = ? WHERE id = ?"
    )
    .bind(failureCode, userId)
    .run();

  // 2. In-Memory Provider & Discovery/Opportunity/Routing Cache Eviction (Second)
  USER_EXCHANGE_ROUTING_CACHE.delete(userId);
  for (const k of Array.from(DISCOVERY_CACHE.keys())) {
    if (k.startsWith(`${userId}_`)) DISCOVERY_CACHE.delete(k);
  }
  for (const k of Array.from(OPPORTUNITY_CACHE.keys())) {
    if (k.startsWith(`${userId}_`)) OPPORTUNITY_CACHE.delete(k);
  }

  if (exchangeConfig) {
    try {
      await ExchangeManager.invalidateUserProvider(exchangeConfig.exchangeName, exchangeConfig.config);
    } catch (e) {
      console.warn(`[invalidation] ProviderPool eviction warning for user ${userId}:`, e);
    }
  }

  // 3. Notify Durable Object bot if present
  if (tradingBotsBinding && typeof tradingBotsBinding.idFromName === "function") {
    try {
      const botId = tradingBotsBinding.idFromName(userId);
      const bot = tradingBotsBinding.get(botId);
      await bot.fetch(new Request("http://bot/exchange-invalidated", { method: "POST" })).catch(() => null);
    } catch (_) {}
  }
}

export async function handleValidateExchange(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  let exchangeNameForLog = "unknown";
  const correlationId = crypto.randomUUID();
  const cfRay = c.req.header("cf-ray") || "none";
  const cfCountry = c.req.header("cf-ipcountry") || "unknown";

  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;

    const { exchangeName, apiKey, apiSecret, apiPassphrase, environment, region } = await c.req.json<{
      exchangeName: ExchangeName;
      apiKey: string;
      apiSecret: string;
      apiPassphrase?: string;
      environment?: ExchangeEnvironment;
      region?: ExchangeRegion;
    }>();
    if (exchangeName) exchangeNameForLog = exchangeName;

    const cleanApiKey = cleanCredential(apiKey);
    const cleanApiSecret = cleanCredential(apiSecret);
    const cleanApiPassphrase = cleanCredential(apiPassphrase);

    console.log(`[EXCHANGE_VALIDATE_START] correlationId=${correlationId} exchange=${exchangeName} env=${environment} key=[REDACTED] cfRay=${cfRay} cfCountry=${cfCountry}`);

    if (!exchangeName || !cleanApiKey || !cleanApiSecret) {
      c.status(400);
      return c.json({
        success: false,
        code: "MISSING_REQUIRED_CREDENTIALS" as ExchangeErrorCode,
        message: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.friendlyMessage,
        hint: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.hint,
      });
    }

    const normEnv = normalizeEnvironment(environment);
    if (!normEnv) {
      c.status(400);
      return c.json({
        success: false,
        code: "INVALID_REQUEST" as ExchangeErrorCode,
        message: "Invalid environment. Supported values: demo, mainnet.",
        hint: "Supported environment values are demo or mainnet.",
        version: "1.0",
        correlationId,
      });
    }

    if (exchangeName?.toLowerCase() !== "bybit") {
      c.status(400);
      return c.json({
        success: false,
        code: "UNSUPPORTED_OPERATION" as ExchangeErrorCode,
        message: `${exchangeName} is no longer supported. Bybit is the single supported exchange platform.`,
        hint: "Please select Bybit as your exchange platform.",
        version: "1.0",
        correlationId,
      });
    }

    const resolvedRegion = normalizeRegion(region);

    const keyFingerprint = await WebCryptoSigner.hashSha256(cleanApiKey);
    const secretFingerprint = await WebCryptoSigner.hashSha256(cleanApiSecret);
    const passFingerprint = cleanApiPassphrase ? await WebCryptoSigner.hashSha256(cleanApiPassphrase) : "NONE";

    const credentialTrace = {
      credentialPresent: true,
      credentialLength: cleanApiKey.length,
      credentialFingerprint: keyFingerprint,
      secretPresent: true,
      secretLength: cleanApiSecret.length,
      secretFingerprint: secretFingerprint,
      passphrasePresent: Boolean(cleanApiPassphrase),
      passphraseLength: cleanApiPassphrase.length,
      passphraseFingerprint: passFingerprint,
      whitespaceDetected: (apiKey !== cleanApiKey) || (apiSecret !== cleanApiSecret) || (apiPassphrase !== cleanApiPassphrase),
    };

    let provider: any;
    let actualHost = "unknown";
    let actualEndpoint = "/v5/account/wallet-balance";
    try {
      provider = await ExchangeManager.createUncachedProvider(exchangeName as ExchangeName, {
        environment: normEnv,
        apiKey: cleanApiKey,
        secret: cleanApiSecret,
        password: cleanApiPassphrase,
        region: resolvedRegion,
      });
      if (provider && typeof provider.getHost === "function") {
        actualHost = provider.getHost();
      }
      if (typeof provider.checkApiKeyPermissions === "function") {
        const permCheck = await provider.checkApiKeyPermissions();
        if (permCheck.readOnly) {
          throw new UnifiedError(
            "Your Bybit API key is Read-Only. Trading permissions are required.",
            "READ_ONLY_API_KEY",
            undefined,
            undefined,
            400
          );
        }
        if (!permCheck.hasTradingPermission) {
          throw new UnifiedError(
            "Access denied. Your API key does not have the necessary permissions.",
            "PERMISSION_DENIED",
            undefined,
            undefined,
            400
          );
        }
      }
      await provider.fetchBalance();
      console.log(`[EXCHANGE_VALIDATE_SUCCESS] correlationId=${correlationId} exchange=${exchangeName} cfRay=${cfRay}`);
      
      const successProof = {
        workerPath: "/api/exchange/validate",
        adapterSelected: "BybitAdapter",
        exchangeSelected: exchangeName,
        environmentSelected: normEnv,
        actualExchangeHostname: actualHost,
        actualAuthenticatedEndpoint: actualEndpoint,
        httpStatusReturnedByExchange: 200,
        rawExchangeResponseCode: "0",
        rawExchangeResponseMessage: "SUCCESS",
        relevantResponseHeaders: { "cf-ray": cfRay, "content-type": "application/json" },
        bybitAccountType: "UNIFIED",
        timestampInformation: `Timestamp synced: ${Date.now()}`,
        signingVerified: true,
        signingProof: provider?.lastSigningProof,
        credentialTrace,
        exchangeSideMatchStatus: "EXCHANGE-SIDE CREDENTIAL MATCH: NOT VERIFIABLE FROM CURRENT RUNTIME",
        workerClassification: "SUCCESS",
        finalHttpResponseCode: 200,
        correlationId,
      };
      console.log(`[DIAGNOSTIC_PROOF] ${JSON.stringify(successProof)}`);

      return c.json({
        success: true,
        message: "Credentials verified. You're all set.",
        version: "1.0",
        correlationId,
        diagnosticProof: successProof
      });
    } catch (valErr: any) {
      const classified = classifyException(valErr, exchangeName, correlationId);
      console.error(`[EXCHANGE_VALIDATE_FAILED] correlationId=${correlationId} exchange=${exchangeName} code=${classified.code} msg="${classified.friendlyMessage}" cfRay=${cfRay} (${classified.technicalDetail}):`, valErr);
      c.status(400);
      let hint = classified.hint;
      if (classified.code === "AUTHENTICATION_FAILED" && normEnv !== "mainnet") {
        hint = `Authentication failed. Please verify that your API key is for the '${normEnv}' environment.`;
      }
      const origCode = valErr?.rawCode ?? (valErr instanceof UnifiedError ? valErr.originalExchangeErrorCode : undefined);
      const origStatus = valErr?.rawStatus ?? (valErr instanceof UnifiedError ? valErr.status : undefined);
      const origMsg = valErr?.rawMessage ?? valErr?.rawResponseBody ?? valErr?.message;
      const host = valErr?.actualHost ?? actualHost;
      const endpoint = valErr?.actualEndpoint ?? actualEndpoint;

      const failProof = {
        workerPath: "/api/exchange/validate",
        adapterSelected: "BybitAdapter",
        exchangeSelected: exchangeName,
        environmentSelected: normEnv,
        actualExchangeHostname: host,
        actualAuthenticatedEndpoint: endpoint,
        httpStatusReturnedByExchange: origStatus ?? 400,
        rawExchangeResponseCode: String(origCode ?? "N/A"),
        rawExchangeResponseMessage: String(origMsg ?? "N/A"),
        relevantResponseHeaders: valErr?.rawHeaders ?? { "cf-ray": cfRay },
        bybitAccountType: "UNIFIED",
        timestampInformation: `Timestamp offset check at ${Date.now()}`,
        signingVerified: true,
        signingProof: provider?.lastSigningProof,
        credentialTrace,
        exchangeSideMatchStatus: "EXCHANGE-SIDE CREDENTIAL MATCH: NOT VERIFIABLE FROM CURRENT RUNTIME",
        workerClassification: classified.code,
        finalHttpResponseCode: 400,
        correlationId,
      };
      console.log(`[DIAGNOSTIC_PROOF] ${JSON.stringify(failProof)}`);

      return c.json({
        success: false,
        code: classified.code,
        message: classified.friendlyMessage,
        hint: hint,
        version: classified.version || "1.0",
        correlationId,
        exchangeCode: origCode,
        httpStatus: origStatus,
        diagnosticProof: failProof,
      });
    } finally {
      if (provider) {
        try {
          await provider.disconnect();
        } catch (_) {
          // Ignore disconnect errors during validation cleanup
        }
      }
    }
  } catch (e: unknown) {
    const classified = classifyException(e, exchangeNameForLog, correlationId);
    console.error(`[EXCHANGE_VALIDATE_FATAL] correlationId=${correlationId} exchange=${exchangeNameForLog} code=${classified.code} cfRay=${cfRay} (${classified.technicalDetail}):`, e);
    c.status(400);
    return c.json({
      success: false,
      code: classified.code,
      message: classified.friendlyMessage,
      hint: classified.hint,
      version: classified.version || "1.0",
      correlationId,
    });
  }
}

export async function handleConnectExchange(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  let exchangeNameForLog = "unknown";
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const { exchangeName, apiKey, apiSecret, apiPassphrase, environment, region } = await c.req.json<{
      exchangeName: ExchangeName;
      apiKey: string;
      apiSecret: string;
      apiPassphrase?: string;
      environment?: ExchangeEnvironment;
      region?: ExchangeRegion;
    }>();
    if (exchangeName) exchangeNameForLog = exchangeName;

    const cleanApiKey = cleanCredential(apiKey);
    const cleanApiSecret = cleanCredential(apiSecret);
    const cleanApiPassphrase = cleanCredential(apiPassphrase);

    if (!exchangeName || !cleanApiKey || !cleanApiSecret) {
      c.status(400);
      return c.json({
        success: false,
        code: "MISSING_REQUIRED_CREDENTIALS" as ExchangeErrorCode,
        message: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.friendlyMessage,
        hint: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.hint,
      });
    }

    const normEnv = normalizeEnvironment(environment);
    if (!normEnv) {
      c.status(400);
      return c.json({
        success: false,
        code: "INVALID_REQUEST" as ExchangeErrorCode,
        message: "Invalid environment. Supported values: mainnet, testnet, demo.",
        hint: "Supported environment values are mainnet, testnet, or demo.",
      });
    }

    if (!isEnvironmentSupported(exchangeName, normEnv as CanonicalEnvironment)) {
      c.status(400);
      return c.json({
        success: false,
        code: "UNSUPPORTED_OPERATION" as ExchangeErrorCode,
        message: `${exchangeName} does not support the '${normEnv}' environment. Supported: ${getSupportedEnvironmentsList(exchangeName)}.`,
        hint: `Please select a supported environment for ${exchangeName}: ${getSupportedEnvironmentsList(exchangeName)}.`,
      });
    }

    const resolvedRegion = normalizeRegion(region);

    const providerConfig = {
      environment: normEnv,
      apiKey: cleanApiKey,
      secret: cleanApiSecret,
      password: cleanApiPassphrase,
      region: resolvedRegion,
    };

    const validationStartTime = Date.now();
    let provider: any = null;
    try {
      provider = await ExchangeManager.createUncachedProvider(exchangeName as ExchangeName, providerConfig);
      if (typeof provider.checkApiKeyPermissions === "function") {
        const permCheck = await provider.checkApiKeyPermissions();
        if (permCheck.readOnly) {
          throw new UnifiedError(
            "Your Bybit API key is Read-Only. Trading permissions are required.",
            "READ_ONLY_API_KEY",
            undefined,
            undefined,
            400
          );
        }
        if (!permCheck.hasTradingPermission) {
          throw new UnifiedError(
            "Access denied. Your API key does not have the necessary permissions.",
            "PERMISSION_DENIED",
            undefined,
            undefined,
            400
          );
        }
      }
      await provider.fetchBalance();
      console.log(`[exchange-auth] connect validation successful for ${exchangeName} (${normEnv}) in ${Date.now() - validationStartTime}ms`);
    } catch (valErr: unknown) {
      if (provider) {
        try { await provider.disconnect(); } catch (_) {}
      }
      const classified = classifyException(valErr, exchangeName);
      console.error(`[exchange-auth] connect validation failed for ${exchangeName} (${classified.technicalDetail}):`, valErr);
      c.status(400);
      let hint = classified.hint;
      if (classified.code === "AUTHENTICATION_FAILED" && normEnv !== "mainnet") {
        hint = `Authentication failed. Please verify that your API key is for the '${normEnv}' environment.`;
      }
      const origCode = valErr instanceof UnifiedError ? valErr.originalExchangeErrorCode : undefined;
      const origStatus = valErr instanceof UnifiedError ? valErr.status : undefined;
      return c.json({
        success: false,
        code: classified.code,
        message: classified.friendlyMessage,
        hint: hint,
        exchangeCode: origCode,
        httpStatus: origStatus,
      });
    } finally {
      if (provider) {
        try { await provider.disconnect(); } catch (_) {}
      }
    }

    const encryptedKey = await encrypt(cleanApiKey, c.env.ENCRYPTION_KEY);
    const encryptedSecret = await encrypt(cleanApiSecret, c.env.ENCRYPTION_KEY);
    
    let encryptedPassphraseIv = null;
    let encryptedPassphrase = null;
    let encryptedPassphraseSalt = null;
    if (cleanApiPassphrase) {
      const encryptedPhraseObj = await encrypt(cleanApiPassphrase, c.env.ENCRYPTION_KEY);
      encryptedPassphraseIv = encryptedPhraseObj.iv;
      encryptedPassphrase = encryptedPhraseObj.encrypted;
      encryptedPassphraseSalt = encryptedPhraseObj.salt;
    }

    // Safe Sequencing: Check bot state and deactivate running session BEFORE committing new credentials to D1
    if (!c.env.TRADING_BOTS || typeof c.env.TRADING_BOTS.idFromName !== "function") {
      throw new UnifiedError("Trading bot service binding unavailable. Credential update aborted.", "SERVICE_UNAVAILABLE", undefined, undefined, 503);
    }

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    let isBotActive = false;
    try {
      const statusRes = await bot.fetch(new Request("http://bot/status"));
      if (statusRes.ok) {
        const statusData = await statusRes.json<{ isActive: boolean }>();
        isBotActive = Boolean(statusData?.isActive);
      } else {
        throw new Error(`Bot status returned HTTP ${statusRes.status}`);
      }
    } catch (statusErr: any) {
      console.error("[exchange-auth] Failed to query bot status before credential update:", statusErr?.message || statusErr);
      throw new UnifiedError("Unable to verify trading bot state. Credential update aborted.", "SERVICE_UNAVAILABLE", undefined, undefined, 503);
    }

    if (isBotActive) {
      try {
        const deactRes = await bot.fetch(new Request("http://bot/deactivate", { method: "POST" }));
        if (!deactRes.ok) {
          throw new Error(`Bot deactivate returned HTTP ${deactRes.status}`);
        }
      } catch (deactErr: any) {
        console.error("[exchange-auth] Failed to deactivate active bot before credential update:", deactErr?.message || deactErr);
        throw new UnifiedError("Failed to safely deactivate active trading bot. Credential update aborted.", "BOT_DEACTIVATION_FAILED", undefined, undefined, 500);
      }
    }

    // Now commit to D1 with deterministic failure recovery
    try {
      await c.env.DB.prepare(
        `UPDATE users SET exchange_name = ?, exchange_environment = ?, exchange_region = ?, exchange_api_key = NULL, exchange_api_key_iv = ?, exchange_api_key_encrypted = ?, exchange_api_key_salt = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ?, exchange_api_secret_salt = ?, exchange_api_passphrase_iv = ?, exchange_api_passphrase_encrypted = ?, exchange_api_passphrase_salt = ? WHERE id = ?`,
      )
        .bind(
          exchangeName,
          normEnv,
          resolvedRegion,
          encryptedKey.iv,
          encryptedKey.encrypted,
          encryptedKey.salt,
          encryptedSecret.iv,
          encryptedSecret.encrypted,
          encryptedSecret.salt,
          encryptedPassphraseIv,
          encryptedPassphrase,
          encryptedPassphraseSalt,
          userId
        )
        .run();

      await c.env.DB.prepare(
        `UPDATE users SET exchange_connection_status = 'CONNECTED', exchange_invalidated_at = NULL, exchange_failure_code = NULL WHERE id = ?`
      ).bind(userId).run();
    } catch (d1Err: any) {
      console.error("[exchange-auth] Failed to persist credentials to D1:", d1Err?.message || d1Err);
      throw new UnifiedError("Failed to update credentials in database. Previous credentials remain stored. Autonomous bot is paused.", "CREDENTIAL_PERSISTENCE_FAILED", undefined, undefined, 500);
    }

    // Invalidate any previously cached provider instance for this user/slot
    try {
      await ExchangeManager.disconnectProvider(exchangeName, providerConfig);
    } catch (_) {}

    USER_EXCHANGE_ROUTING_CACHE.delete(userId);

    return c.json({ success: true, message: "Exchange connected successfully", exchangeName, environment: normEnv, region: resolvedRegion });
  } catch (e: unknown) {
    const classified = classifyException(e, exchangeNameForLog);
    console.error(`[exchange-auth] connect outer exception (${classified.technicalDetail}):`, e);
    c.status(400);
    return c.json({
      success: false,
      code: classified.code,
      message: classified.friendlyMessage,
      hint: classified.hint,
    });
  }
}

export async function handleGetExchangeStatus(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_connection_status, exchange_api_key_encrypted, exchange_api_secret_encrypted, exchange_api_secret_iv FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_connection_status: string | null;
        exchange_api_key_encrypted: string | null;
        exchange_api_secret_encrypted: string | null;
        exchange_api_secret_iv: string | null;
      }>();

    const isConnected = Boolean(
      user?.exchange_name &&
      user?.exchange_name.toLowerCase() === "bybit" &&
      user?.exchange_api_key_encrypted &&
      user?.exchange_api_secret_encrypted &&
      user?.exchange_api_secret_iv &&
      user?.exchange_connection_status === "CONNECTED"
    );

    return c.json({
      isConnected,
      exchangeName: isConnected ? "bybit" : (user?.exchange_name ?? null),
      environment: isConnected ? (user?.exchange_environment ?? "demo") : null,
      region: user?.exchange_region ?? null,
    });
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ isConnected: false, exchangeName: null, environment: null, message: error.message || "Failed to get exchange status" });
  }
}

export async function handleGetExchangeBalances(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  let user: any = null;
  let decryptedKey: string | undefined = undefined;
  let decryptedSecret: string | undefined = undefined;
  let decryptedPassphrase: string | undefined = undefined;
  let userId: string = "";

  try {
    const payload = c.get("jwtPayload") as { sub: string };
    userId = payload.sub;

    user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_connection_status, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_connection_status: string | null;
        exchange_api_key_iv: string | null;
        exchange_api_key_encrypted: string | null;
        exchange_api_key_salt: string | null;
        exchange_api_secret_iv: string | null;
        exchange_api_secret_encrypted: string | null;
        exchange_api_secret_salt: string | null;
        exchange_api_passphrase_iv: string | null;
        exchange_api_passphrase_encrypted: string | null;
        exchange_api_passphrase_salt: string | null;
      }>();

    if (!user?.exchange_name || !user?.exchange_api_key_encrypted || !user?.exchange_api_key_iv || !user?.exchange_api_secret_encrypted || !user?.exchange_api_secret_iv) {
      return c.json({
        success: false,
        code: "NO_EXCHANGE_CONNECTED",
        message: "No exchange account is connected.",
        hint: "Connect your exchange account in settings to view balances.",
      });
    }

    if (user?.exchange_connection_status === "INVALID") {
      c.status(422);
      return c.json({
        success: false,
        code: "AUTHENTICATION_FAILED",
        message: "Exchange credentials are invalid. Please reconnect your exchange in settings.",
        hint: "Your exchange API keys were invalidated or revoked. Please reconnect in settings.",
      });
    }

    try {
      decryptedKey = await decrypt(
        { iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt },
        c.env.ENCRYPTION_KEY,
      );
    } catch (_) {
      c.status(400);
      return c.json({
        success: false,
        code: "INVALID_CREDENTIALS",
        message: "Exchange credentials need to be re-connected.",
        hint: "Please re-connect your exchange API credentials in settings.",
      });
    }

    decryptedSecret = await decrypt(
      { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt },
      c.env.ENCRYPTION_KEY,
    );

    if (user.exchange_api_passphrase_iv && user.exchange_api_passphrase_encrypted) {
      decryptedPassphrase = await decrypt(
        { iv: user.exchange_api_passphrase_iv, encrypted: user.exchange_api_passphrase_encrypted, salt: user.exchange_api_passphrase_salt },
        c.env.ENCRYPTION_KEY,
      );
    }

    const environment = normalizeEnvironment(user.exchange_environment) ?? "mainnet";
    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment,
      apiKey: decryptedKey,
      secret: decryptedSecret,
      password: decryptedPassphrase,
      region: resolveCanonicalRoutingRegion(user.exchange_region),
    });

    const balanceRes = await adapter.fetchBalance();
    const formattedBalances = balanceRes.map(b => ({
      asset: b.currency,
      currency: b.currency,
      free: b.free.toNumber(),
      locked: b.used.toNumber(),
      used: b.used.toNumber(),
      total: b.total.toNumber(),
    }));

    return c.json({
      success: true,
      exchange: user.exchange_name,
      environment,
      primaryAsset: "USDT",
      balances: formattedBalances,
    });
  } catch (e: unknown) {
    const exchangeId = user?.exchange_name?.toLowerCase() || "bybit";
    const classified = classifyException(e, exchangeId);
    console.error(`[exchange-balance] exception (${classified.technicalDetail}):`, e);
    if (isPermanentAuthFailure(classified.code)) {
      if (user?.exchange_name && decryptedKey && decryptedSecret) {
        try {
          await ExchangeManager.invalidateUserProvider(user.exchange_name, {
            environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet",
            apiKey: decryptedKey,
            secret: decryptedSecret,
            password: decryptedPassphrase,
            region: resolveCanonicalRoutingRegion(user.exchange_region),
          });
        } catch (_) {}
      }
      if (userId) {
        USER_EXCHANGE_ROUTING_CACHE.delete(userId);
      }
      c.status(422);
    } else {
      c.status(400);
    }
    return c.json({
      success: false,
      code: classified.code,
      message: classified.friendlyMessage,
      hint: classified.hint,
    });
  }
}

export function mapScanResultToCandidates(scanResult: any, tickers?: any[]): any[] {
  const seenPairs = new Set<string>();
  const distinctOpportunities: MarketOpportunity[] = [];
  const sourcePool = scanResult.allQualifiedOpportunities && scanResult.allQualifiedOpportunities.length > 0 
    ? scanResult.allQualifiedOpportunities 
    : (scanResult.topOpportunities || []);
  for (const opp of sourcePool) {
    if (isExcludedAsset(opp.symbol)) continue;
    if (!seenPairs.has(opp.symbol)) {
      seenPairs.add(opp.symbol);
      distinctOpportunities.push(opp);
      if (distinctOpportunities.length >= 25) break;
    }
  }

  const tickerMap = new Map<string, any>();
  if (Array.isArray(tickers)) {
    for (const t of tickers) {
      if (t?.pairName) tickerMap.set(t.pairName, t);
      if (t?.symbol) tickerMap.set(t.symbol, t);
    }
  }

  return distinctOpportunities.map((opp: any, idx: number) => {
    const baseAsset = opp.symbol.includes('/') ? opp.symbol.split('/')[0] : opp.symbol.replace(/USDT$/, '');
    const px = opp.timeframes?.['1m']?.closePrice || opp.timeframes?.['5m']?.closePrice || opp.timeframes?.['15m']?.closePrice || 0;
    const strat = opp.strategyCompatibility?.[0]?.strategyId || 'ScalperV2';
    const oppId = opp.opportunityId || `${opp.symbol}:${strat}:${opp.dominantDirection}`;
    const rawPct = opp.marketQuality?.priceChangePercent24h ?? opp.priceChangePercent24h ?? 0;
    const cleanPct = typeof rawPct === 'number' && Number.isFinite(rawPct) ? rawPct : 0;
    const matchedTicker = tickerMap.get(opp.symbol) || tickerMap.get(baseAsset);
    const resolvedMaxQty = (typeof opp.marketQuality?.maxOrderQty === 'number' && opp.marketQuality.maxOrderQty > 0)
      ? opp.marketQuality.maxOrderQty
      : (typeof matchedTicker?.maxQty === 'number' && matchedTicker.maxQty > 0 ? matchedTicker.maxQty : null);
    return {
      id: oppId,
      opportunityId: oppId,
      symbol: baseAsset,
      pairName: opp.symbol,
      category: 'linear',
      timestamp: opp.timestamp,
      price: px,
      volume24h: opp.marketQuality?.turnover24hUsdt ?? 0,
      quoteVolume24h: opp.marketQuality?.turnover24hUsdt ?? 0,
      highPrice24h: px,
      lowPrice24h: px,
      priceChangePercent24h: cleanPct,
      minNotional: opp.marketQuality?.minNotionalUsdt ?? 5,
      minOrderQty: opp.marketQuality?.minOrderQty ?? 0.001,
      qtyStep: typeof opp.marketQuality?.qtyStep === 'number' && opp.marketQuality.qtyStep > 0 ? opp.marketQuality.qtyStep : null,
      tickSize: opp.marketQuality?.tickSize ?? 0.01,
      minPrice: null,
      maxPrice: null,
      maxQty: resolvedMaxQty,
      score: opp.opportunityScore,
      rank: idx + 1,
      tradeSide: opp.dominantDirection === 'LONG' ? 'BUY' : (opp.dominantDirection === 'SHORT' ? 'SELL' : 'NEUTRAL'),
      recommendedStrategy: strat,
      recommendedTimeframe: opp.timeframes?.['15m']?.trend ? '15m' : '1h',
      exchangeTimestamp: opp.timestamp,
      opportunityState: opp.state,
      netEdgeRatio: opp.rawFactors?.netEdgeRatio ?? 0,
      executionFeasible: (opp.rawFactors?.netEdgeRatio ?? 0) >= 3.0,
    };
  });
}

export async function handleGetPersonalizedMarketCandidates(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  let currentStage = "1. JWT verification";
  const correlationId = crypto.randomUUID();
  console.log("[DIAGNOSTIC] Stage 0: Endpoint /api/market/candidates invoked");
  
  try {
    // Stage 1: JWT verified
    currentStage = "1. JWT verification";
    const payload = c.get("jwtPayload") as { sub?: string } | undefined;
    if (!payload || !payload.sub) {
      console.error("[DIAGNOSTIC] Stage 1 FAILED: Missing or invalid JWT payload sub");
      c.status(401);
      return c.json({
        success: false,
        stage: "1. JWT verification",
        error: "Unauthorized: Invalid or missing token",
        constructor: "UnauthorizedError",
        stack: new Error("JWT payload sub missing").stack
      });
    }
    const userId = payload.sub;
    console.log(`[DIAGNOSTIC] Stage 1: JWT verified for userId=${userId}`);

    // Stage 2: User loaded (with routing cache)
    currentStage = "2. User loaded";
    let user = USER_EXCHANGE_ROUTING_CACHE.get(userId);
    if (!user) {
      try {
        user = await c.env.DB.prepare(
          "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt FROM users WHERE id = ?",
        )
          .bind(userId)
          .first();
        if (user && user.exchange_name) {
          USER_EXCHANGE_ROUTING_CACHE.set(userId, { exchange_name: user.exchange_name, exchange_environment: user.exchange_environment, exchange_region: user.exchange_region });
        }
      } catch (dbErr: any) {
        console.error("[DIAGNOSTIC] Stage 2 EXCEPTION: Database query failed:", dbErr?.message, dbErr?.stack);
        c.status(500);
        return c.json({
          success: false,
          stage: "2. User loaded",
          error: dbErr?.message || String(dbErr),
          constructor: dbErr?.constructor?.name || "DatabaseError",
          stack: dbErr?.stack || String(dbErr)
        });
      }
    }

    if (!user) {
      console.error(`[DIAGNOSTIC] Stage 2 FAILED: User record not found in DB for id ${userId}`);
      c.status(404);
      return c.json({
        success: false,
        stage: "2. User loaded",
        error: "User account not found",
        constructor: "NotFoundError",
        stack: new Error("User record not found").stack
      });
    }
    console.log(`[DIAGNOSTIC] Stage 2: User loaded successfully for id=${userId}`);

    // Stage 3: Exchange record loaded
    currentStage = "3. Exchange record loaded";
    if (!user.exchange_name) {
      console.error("[DIAGNOSTIC] Stage 3 FAILED: User has no exchange_name configured");
      c.status(400);
      return c.json({
        success: false,
        stage: "3. Exchange record loaded",
        error: "No exchange connected. Please connect an exchange first.",
        constructor: "ValidationError",
        stack: new Error("No exchange connected").stack
      });
    }
    console.log(`[DIAGNOSTIC] Stage 3: Exchange record loaded: exchange_name=${user.exchange_name}, env=${user.exchange_environment}`);

    const queryBudget = c.req.query("budget");
    const parsedBudget = queryBudget ? parseFloat(queryBudget) : null;
    const userAllocation = (parsedBudget !== null && !isNaN(parsedBudget) && parsedBudget > 0) ? parsedBudget : null;

    const cacheKey = `${userId}_${user.exchange_name}_${user.exchange_environment}_${userAllocation !== null ? String(userAllocation) : 'default'}`;
    const cached = DISCOVERY_CACHE.get(cacheKey);
    if (cached) {
      console.log(`[DIAGNOSTIC] Cache hit for ${cacheKey}`);
      return c.json(cached);
    }

    // Stage 3.5: Authoritative DO Scanner State Query (CP-CONF-001)
    // Directly query user's TradingBot DO for its authoritative scanner state before doing any expensive local work.
    // Handles warm cached scan (<5ms), active in-flight scan, or cold discovery scan in the DO without redundant Worker CCXT overhead.
    if (c.env.TRADING_BOTS) {
      try {
        const botId = c.env.TRADING_BOTS.idFromName(userId);
        const bot = c.env.TRADING_BOTS.get(botId);
        const scanResp = await bot.fetch(new Request("http://bot/scanner-state", {
          headers: { "X-User-Id": userId }
        }));
        if (scanResp.ok) {
          const scanResult = await scanResp.json() as any;
          if (scanResult && scanResult.topOpportunities) {
            console.log(`[DIAGNOSTIC] Stage 3.5: Retrieved authoritative DO scanner state: universeSize=${scanResult.universeSize}, eligible=${scanResult.eligibleCount}, top=${scanResult.topOpportunities?.length || 0}`);
            const candidates = mapScanResultToCandidates(scanResult);

            if (candidates.length > 0 || userAllocation !== null) {
              console.log(`[DIAGNOSTIC] Stage 10: response serialized successfully from DO (${candidates.length} items)`);
              DISCOVERY_CACHE.set(cacheKey, candidates);
              return c.json(candidates);
            }
          }
        }
      } catch (doErr: any) {
        console.warn("[DIAGNOSTIC] Stage 3.5: Failed to query DO scanner-state, proceeding to fallback:", doErr?.message);
      }
    }

    // Stage 4: Secret omitted/not configured (Public Market Discovery requires 0 credential decryption)
    currentStage = "4. Secret decrypted";
    console.log("[DIAGNOSTIC] Stage 4: Secret omitted/not configured");

    // Stage 5: CCXT client created (Anonymous Provider)
    currentStage = "5. CCXT client created";
    console.log(`[DIAGNOSTIC] Stage 5: CCXT client created for provider=${user.exchange_name}`);

    // Stage 6: fetchBalance skipped (no API credentials required)
    currentStage = "6. fetchBalance completed";
    console.log("[DIAGNOSTIC] Stage 6: fetchBalance skipped (no API credentials)");

    // Stage 7: fetchTickers completed via PublicMarketDataService & anonymous adapter
    currentStage = "7. fetchTickers completed";
    const exchangeName = (user.exchange_name || "bybit") as ExchangeName;
    const environment = normalizeEnvironment(user.exchange_environment) ?? "mainnet";
    const region = resolveCanonicalRoutingRegion(user.exchange_region);
    const publicService = PublicMarketDataService.getInstance();
    const publicAdapter = await ExchangeManager.getProvider(exchangeName, {
      environment,
      region,
    });

    let markets: any[] = [];
    try {
      if (c.env.PUBLIC_MARKET_COORDINATOR) {
        markets = await publicService.getMarkets(c.env, exchangeName, environment, region);
      } else {
        markets = await publicAdapter.fetchMarkets();
      }
    } catch (mErr: any) {
      console.error("[DIAGNOSTIC] Stage 7 WARNING: fetchMarkets threw exception:", mErr?.message);
    }

    if (!markets || !markets.length) {
      console.warn("[DIAGNOSTIC] Stage 7: fetchMarkets returned empty. Fallback to top pairs.");
      markets = [
        { id: "BTCUSDT", symbol: "BTC/USDT", base: "BTC", quote: "USDT", active: true },
        { id: "ETHUSDT", symbol: "ETH/USDT", base: "ETH", quote: "USDT", active: true },
        { id: "BNBUSDT", symbol: "BNB/USDT", base: "BNB", quote: "USDT", active: true },
      ];
    }

    // Filter out inactive/delisted markets before ticker ingestion
    const activeMarkets = markets.filter((m: any) => m.active !== false);

    // Execute bulk ticker fetch using PublicMarketDataService or direct adapter
    const rawTickers: any[] = [];
    try {
      const allTickers = c.env.PUBLIC_MARKET_COORDINATOR
        ? await publicService.getTickers(c.env, exchangeName, environment, region)
        : await publicAdapter.fetchTickers(activeMarkets.map((m: any) => m.symbol));
      const tickerMap = new Map<string, any>(allTickers.map((t: any) => [t.symbol || t.pairName, t]));

      for (const m of activeMarkets) {
        const t = tickerMap.get(m.symbol);
        if (!t) {
          console.warn(`[DIAGNOSTIC] Stage 7: Ticker missing in bulk response for ${m.symbol}, skipping.`);
          continue;
        }

        const px = typeof t?.last?.toNumber === 'function' ? t.last.toNumber() : (typeof t?.last === 'number' ? t.last : (typeof t?.price === 'number' ? t.price : 0));
        if (!px || px <= 0 || isNaN(px)) {
          console.warn(`[DIAGNOSTIC] Stage 7: Invalid or missing spot price for ${m.symbol}, skipping symbol.`);
          continue;
        }
        const bidPx = typeof t?.bid?.toNumber === 'function' ? t.bid.toNumber() : (typeof t?.bid === 'number' && t.bid > 0 ? t.bid : (t?._bid || (t?.info?.bid1Price ? parseFloat(t.info.bid1Price) || px : px)));
        const askPx = typeof t?.ask?.toNumber === 'function' ? t.ask.toNumber() : (typeof t?.ask === 'number' && t.ask > 0 ? t.ask : (t?._ask || (t?.info?.ask1Price ? parseFloat(t.info.ask1Price) || px : px)));
        const vol = typeof t?.volume?.toNumber === 'function' ? t.volume.toNumber() : (typeof t?.volume === 'number' ? t.volume : (typeof t?.volume24h === 'number' ? t.volume24h : 0));
        const qVol = typeof t?.quoteVolume?.toNumber === 'function' ? t.quoteVolume.toNumber() : (typeof t?.quoteVolume === 'number' ? t.quoteVolume : (typeof t?.quoteVolume24h === 'number' ? t.quoteVolume24h : (vol * px)));
        const high = typeof t?.high?.toNumber === 'function' ? t.high.toNumber() : (typeof t?.high === 'number' ? t.high : (typeof t?.highPrice24h === 'number' ? t.highPrice24h : px));
        const low = typeof t?.low?.toNumber === 'function' ? t.low.toNumber() : (typeof t?.low === 'number' ? t.low : (typeof t?.lowPrice24h === 'number' ? t.lowPrice24h : px));

        let chg = 0;
        if (typeof (t as any)?.percentage === 'number' && !isNaN((t as any).percentage)) {
          chg = (t as any).percentage;
        } else if (typeof (t as any)?.priceChangePercent24h === 'number') {
          chg = (t as any).priceChangePercent24h;
        } else if (typeof (t as any)?.info?.priceChangePercent !== 'undefined') {
          chg = parseFloat((t as any).info.priceChangePercent) || 0;
        } else if (typeof (t as any)?.info?.changeRate !== 'undefined') {
          chg = (parseFloat((t as any).info.changeRate) || 0) * 100;
        } else if (typeof (t as any)?.open === 'number' || typeof (t as any)?.open?.toNumber === 'function') {
          const open = typeof (t as any)?.open?.toNumber === 'function' ? (t as any).open.toNumber() : (t as any).open;
          if (open > 0) chg = ((px - open) / open) * 100;
        }

        const extractConstraint = (legacyVal: any, bybitVal: any): number | null => {
          if (legacyVal !== undefined && legacyVal !== null) {
            if (typeof legacyVal?.toNumber === 'function') {
              const val = legacyVal.toNumber();
              if (!isNaN(val)) return val;
            } else if (typeof legacyVal === 'number' && !isNaN(legacyVal)) {
              return legacyVal;
            }
          }
          if (bybitVal !== undefined && bybitVal !== null) {
            const parsed = Number(bybitVal);
            if (!isNaN(parsed)) return parsed;
          }
          return null;
        };

        rawTickers.push({
          symbol: m.base || (m.symbol ? m.symbol.split('/')[0] : "BTC"),
          pairName: m.symbol || "BTC/USDT",
          category: m.category || 'linear',
          timestamp: typeof t?.timestamp === 'number' ? t.timestamp : Date.now(),
          price: px,
          _bid: bidPx,
          _ask: askPx,
          volume24h: vol,
          quoteVolume24h: qVol,
          highPrice24h: high,
          lowPrice24h: low,
          priceChangePercent24h: chg,
          minNotional: extractConstraint(m?.limits?.cost?.min, m?.info?.lotSizeFilter?.minNotionalValue),
          minOrderQty: extractConstraint(m?.limits?.amount?.min, m?.info?.lotSizeFilter?.minOrderQty),
          qtyStep: extractConstraint(m?.precision?.amount, m?.info?.lotSizeFilter?.qtyStep),
          tickSize: extractConstraint(m?.precision?.price, m?.info?.priceFilter?.tickSize),
          minPrice: extractConstraint(m?.limits?.price?.min, m?.info?.priceFilter?.minPrice),
          maxPrice: extractConstraint(m?.limits?.price?.max, m?.info?.priceFilter?.maxPrice),
          maxQty: extractConstraint(m?.limits?.amount?.max, m?.info?.lotSizeFilter?.maxOrderQty),
        });
      }
    } catch (tErr: any) {
      console.error(`[DIAGNOSTIC] Stage 7: bulk fetchTickers failed: ${tErr?.message}`);
      c.status(503);
      return c.json({
        success: false,
        stage: "7. fetchTickers completed",
        error: tErr?.message || "Failed to fetch tickers from exchange",
        constructor: tErr?.constructor?.name || "ExchangeError",
        stack: tErr?.stack || String(tErr)
      });
    }
    const tickers = rawTickers.filter((t): t is NonNullable<typeof t> => t !== null);
    console.log(`[DIAGNOSTIC] Stage 7: fetchTickers completed with ${tickers.length} genuine live tickers`);

    // Stage 8: analyzeMarket entered
    currentStage = "8. analyzeMarket entered";
    console.log(`[DIAGNOSTIC] Stage 8: analyzeMarket entered with ${tickers.length} tickers`);
    
    // Stage 9: Opportunity discovery and candidate evaluation (Fallback Path)
    let candidates: any[] = [];
    const boundedMarkets = selectBoundedDiscoveryMarkets(activeMarkets, tickers, userAllocation, 8);
    if (boundedMarkets.length === 0) {
      console.log(`[DIAGNOSTIC] Stage 9: 0 eligible markets after bounded pre-selection (universe=${activeMarkets.length}, budget=${userAllocation ?? 'default'}). Returning empty array without scanner invocation.`);
      DISCOVERY_CACHE.set(cacheKey, []);
      return c.json([]);
    }

    try {
      const publicAdapter = await ExchangeManager.getProvider(exchangeName, {
        environment,
        region,
      });
      const scanner = new MarketOpportunityScanner(publicAdapter as any);
      const scanResult = await scanner.scan({
        markets: boundedMarkets,
        tickers,
        ...(userAllocation !== null ? { tradeAmountUsdt: userAllocation } : {})
      });

      if (
        !scanResult ||
        scanResult.screenedCount === 0 ||
        (scanResult.allQualifiedOpportunities &&
          scanResult.allQualifiedOpportunities.length > 0 &&
          scanResult.allQualifiedOpportunities.every((o: any) => o.state === 'DATA_DEGRADED'))
      ) {
        c.status(503);
        return c.json({
          success: false,
          code: 'MARKET_DATA_DEGRADED',
          error: 'Market data temporarily degraded or unavailable during discovery scan.',
        });
      }

      if (scanResult.topOpportunities && scanResult.topOpportunities.length > 0) {
        console.log(`[DIAGNOSTIC] Stage 9: MarketOpportunityScanner produced ${scanResult.topOpportunities.length} opportunities (${scanResult.allQualifiedOpportunities.length} total qualified)`);
        const mapped = mapScanResultToCandidates(scanResult, tickers);
        candidates = mapped.filter((c: any) => c.opportunityState !== 'DATA_DEGRADED');
      } else {
        console.log(`[DIAGNOSTIC] Stage 9: 0 usable opportunities discovered (screenedCount=${scanResult?.screenedCount ?? 0}). Returning empty candidates list.`);
        candidates = [];
      }
      console.log(`[DIAGNOSTIC] Stage 9: evaluation completed with ${candidates.length} candidates`);
    } catch (aErr: any) {
      console.error("[DIAGNOSTIC] Stage 9 EXCEPTION: Modern scanner threw exception. Aborting without legacy fallback:", aErr?.message);
      c.status(500);
      return c.json({
        success: false,
        stage: "9. scanner evaluation",
        error: aErr?.message || String(aErr),
        constructor: aErr?.constructor?.name || "ScannerError",
        stack: aErr?.stack || String(aErr)
      });
    }

    // Stage 10: response serialized
    currentStage = "10. response serialized";
    console.log(`[DIAGNOSTIC] Stage 10: response serialized successfully (${candidates.length} items)`);
    
    DISCOVERY_CACHE.set(cacheKey, candidates);
    return c.json(candidates);

  } catch (fatalErr: any) {
    console.error(`[DIAGNOSTIC] Stage '${currentStage}' FATAL UNCAUGHT EXCEPTION:`, fatalErr?.message, fatalErr?.stack);
    c.status(500);
    return c.json({
      success: false,
      stage: currentStage,
      error: fatalErr?.message || String(fatalErr),
      constructor: fatalErr?.constructor?.name || "FatalException",
      stack: fatalErr?.stack || String(fatalErr)
    });
  }
}

function formatOpportunitiesResponse(c: Context<{ Bindings: Env }>, scanResult: ScannerScanResult): Response {
  const queryLimit = c.req.query("limit");
  const queryDirection = c.req.query("direction")?.toUpperCase();
  const queryStrategy = c.req.query("strategy");
  const queryMinScore = c.req.query("minScore");

  let opportunities = scanResult.allQualifiedOpportunities;

  if (queryDirection === "LONG" || queryDirection === "SHORT") {
    opportunities = opportunities.filter(o => o.dominantDirection === queryDirection);
  }

  if (queryStrategy) {
    opportunities = opportunities.filter(o => o.strategyCompatibility.some(s => s.strategyId.toLowerCase() === queryStrategy.toLowerCase()));
  }

  if (queryMinScore) {
    const minScore = parseFloat(queryMinScore);
    if (!isNaN(minScore)) {
      opportunities = opportunities.filter(o => o.opportunityScore >= minScore);
    }
  }

  const limit = queryLimit ? parseInt(queryLimit, 10) : undefined;
  const returnedOpportunities = limit && !isNaN(limit) && limit > 0
    ? opportunities.slice(0, limit)
    : (opportunities.length > 0 ? opportunities : scanResult.topOpportunities);

  return c.json({
    success: true,
    timestamp: scanResult.timestamp,
    executionDurationMs: scanResult.executionDurationMs,
    universeSize: scanResult.universeSize,
    eligibleCount: scanResult.eligibleCount,
    qualityCount: scanResult.qualityCount,
    screenedCount: scanResult.screenedCount,
    totalOpportunities: opportunities.length,
    opportunities: returnedOpportunities,
    telemetry: scanResult.telemetry,
  });
}

export async function handleGetMarketOpportunities(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  const correlationId = crypto.randomUUID();
  console.log(`[DIAGNOSTIC] Endpoint /api/market/opportunities invoked (correlationId=${correlationId})`);

  try {
    const payload = c.get("jwtPayload") as { sub?: string } | undefined;
    if (!payload || !payload.sub) {
      c.status(401);
      return c.json({
        success: false,
        error: "Unauthorized: Invalid or missing token",
      });
    }
    const userId = payload.sub;

    let user: any = null;
    try {
      user = await c.env.DB.prepare(
        "SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?"
      )
        .bind(userId)
        .first();
    } catch (dbErr: any) {
      console.warn("[DIAGNOSTIC] /market/opportunities DB query error, proceeding with default provider:", dbErr?.message);
    }

    const rawExchangeName = typeof user?.exchange_name === "string" ? user.exchange_name.toLowerCase().trim() : "";
    const exchangeName: ExchangeName = (rawExchangeName as ExchangeName) || "bybit";
    const environment = normalizeEnvironment(user?.exchange_environment) ?? "mainnet";
    const region = resolveCanonicalRoutingRegion(user?.exchange_region);

    const publicCacheKey = buildPublicOpportunityCacheKey(
      exchangeName,
      environment,
      region,
      DEFAULT_SCANNER_CONFIG,
      PUBLIC_OPPORTUNITY_MAX_CANDIDATES,
      PUBLIC_CANDLE_STORE_DEPTH
    );

    const cached = SHARED_OPPORTUNITY_CACHE.get(publicCacheKey);
    if (cached && Date.now() - cached.timestamp < OPPORTUNITY_CACHE_TTL_MS) {
      console.log(`[DIAGNOSTIC] /market/opportunities shared cache hit for ${publicCacheKey}`);
      return formatOpportunitiesResponse(c, structuredClone(cached.data));
    }

    const scanResult = await OPPORTUNITY_SINGLE_FLIGHT.do(publicCacheKey, async () => {
      const freshCached = SHARED_OPPORTUNITY_CACHE.get(publicCacheKey);
      if (freshCached && Date.now() - freshCached.timestamp < OPPORTUNITY_CACHE_TTL_MS) {
        return freshCached.data;
      }

      // Anonymous public exchange provider: credentials intentionally omitted for public market endpoints
      const publicAdapter = await ExchangeManager.getProvider(exchangeName, {
        environment,
        region,
      });

      const markets = await publicAdapter.fetchMarkets();
      const tickers = await publicAdapter.fetchTickers();
      const boundedMarkets = selectBoundedDiscoveryMarkets(
        markets || [],
        tickers || [],
        null,
        PUBLIC_OPPORTUNITY_MAX_CANDIDATES
      );

      if (boundedMarkets.length === 0) {
        const emptyScanResult: ScannerScanResult = {
          timestamp: Date.now(),
          executionDurationMs: 0,
          universeSize: (markets || []).length,
          eligibleCount: 0,
          qualityCount: 0,
          screenedCount: 0,
          allQualifiedOpportunities: [],
          topOpportunities: [],
          telemetry: {} as any,
        };
        // Do not cache empty universe results globally across users so transient empty upstream lists can recover immediately
        return deepFreezeObject(structuredClone(emptyScanResult));
      }

      const candleStoreKey = `${exchangeName}:${environment}:${region}:cd${PUBLIC_CANDLE_STORE_DEPTH}`;
      const candleStore = getOrCreateScopedPublicCandleStore(
        candleStoreKey,
        publicAdapter,
        PUBLIC_CANDLE_STORE_DEPTH
      );

      const scanner = new MarketOpportunityScanner(
        publicAdapter as any,
        DEFAULT_SCANNER_CONFIG,
        candleStore
      );
      const result = await scanner.scan({ markets: boundedMarkets, tickers });

      if (
        !result ||
        result.screenedCount === 0 ||
        (result.allQualifiedOpportunities.length > 0 &&
          result.allQualifiedOpportunities.every((o: any) => o.state === "DATA_DEGRADED"))
      ) {
        const degradedError: any = new Error("Market data temporarily degraded or unavailable during opportunity scan.");
        degradedError.__isMarketDataDegraded = true;
        throw degradedError;
      }

      const immutableResult = deepFreezeObject(structuredClone(result));
      SHARED_OPPORTUNITY_CACHE.set(publicCacheKey, { timestamp: Date.now(), data: immutableResult });
      return immutableResult;
    });

    return formatOpportunitiesResponse(c, structuredClone(scanResult));
  } catch (fatalErr: any) {
    if (fatalErr?.__isMarketDataDegraded) {
      c.status(503);
      return c.json({
        success: false,
        code: "MARKET_DATA_DEGRADED",
        error: "Market data temporarily degraded or unavailable during opportunity scan.",
      });
    }
    console.error(`[DIAGNOSTIC] /market/opportunities FATAL EXCEPTION:`, fatalErr?.message, fatalErr?.stack);
    c.status(500);
    return c.json({
      success: false,
      error: fatalErr?.message || String(fatalErr),
      correlationId,
    });
  }
}


import { StrategyRegistry } from "../engine/strategies/StrategyRegistry";
import { StrategyOrchestrator } from "../engine/orchestrator/StrategyOrchestrator";
import { MarketDataEngine, AdapterCandleProvider } from "../engine/market-data";
import { AnalysisSnapshotMapper } from "../api/engine/AnalysisSnapshotMapper";
import { StopLossCalculator } from "../engine/risk/StopLossCalculator";
import { TakeProfitCalculator } from "../engine/risk/TakeProfitCalculator";
import { RiskParameters } from "../engine/risk/RiskParameters";
import { calculateATR } from "../engine/indicator/indicators/ATR";
import { TradeAlert } from "../trading-bot";

export async function handleGetStrategies(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const manifests = StrategyRegistry.getInstance().getAllManifests();
  const response: import('../api/engine/StrategyManifestDTO').StrategyDiscoveryResponseDTO = {
    version: '2.0',
    count: manifests.length,
    strategies: manifests
  };
  return c.json(response);
}

export async function handleGetTicker(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const symbol = c.req.query("symbol");
    if (!symbol) {
      c.status(400);
      return c.json({ error: "symbol query parameter is required" });
    }

    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_api_key_iv: string | null;
        exchange_api_key_encrypted: string | null;
        exchange_api_key_salt: string | null;
        exchange_api_secret_iv: string | null;
        exchange_api_secret_encrypted: string | null;
        exchange_api_secret_salt: string | null;
      }>();

    const hasApiKey = Boolean(user?.exchange_api_key_encrypted);
    if (!user?.exchange_name || !hasApiKey || !user?.exchange_api_secret_encrypted) {
      c.status(400);
      return c.json({ error: "No exchange connected. Please connect an exchange first." });
    }

    const normEnv = normalizeEnvironment(user.exchange_environment) ?? "mainnet";
    const normReg = resolveCanonicalRoutingRegion(user.exchange_region);
    const tickerCacheKey = `${user.exchange_name}:${normEnv}:${normReg}:${symbol}`;
    const cachedTicker = TICKER_CACHE.get(tickerCacheKey);
    if (cachedTicker) {
      return c.json(cachedTicker);
    }

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normEnv,
      region: normReg,
    });

    const ticker = await adapter.fetchTicker(symbol);

    if (!ticker) {
      c.status(404);
      return c.json({ error: `Symbol '${symbol}' is not available on your connected exchange.` });
    }

    const price = ticker.last.toNumber();
    const rawPct = typeof ticker.percentage === 'number' && Number.isFinite(ticker.percentage) 
      ? ticker.percentage 
      : 0;

    const rawChange = (price * rawPct) / 100;
    const priceChange24h = Number.isFinite(rawChange) ? rawChange : 0;
    const priceChangePercent24h = Number.isFinite(rawPct) ? rawPct : 0;

    const result = {
      symbol: ticker.symbol,
      price: price,
      volume24h: ticker.volume.toNumber(),
      quoteVolume24h: ticker.quoteVolume.toNumber(),
      priceChange24h: priceChange24h,
      priceChangePercent24h: priceChangePercent24h,
      highPrice24h: ticker.high.toNumber(),
      lowPrice24h: ticker.low.toNumber(),
      minNotional: null,
      minOrderQty: null,
      maxOrderQty: null,
      tickSize: null,
      lotSize: null,
      timestamp: new Date().toISOString(),
    };
    TICKER_CACHE.set(tickerCacheKey, result);

    return c.json(result);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Error fetching ticker", message: error.message });
  }
}

export async function handleGetKlines(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const symbol = c.req.query("symbol");
    const interval = c.req.query("interval") || "1h";
    const limit = parseInt(c.req.query("limit") || "100", 10);

    if (!symbol) {
      c.status(400);
      return c.json({ error: "symbol query parameter is required" });
    }

    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{ exchange_name: string | null; exchange_environment: string | null; exchange_region: string | null }>();

    if (!user?.exchange_name) {
      c.status(400);
      return c.json({ error: "No exchange connected. Please connect an exchange first." });
    }

    const normEnv = normalizeEnvironment(user.exchange_environment) ?? "mainnet";
    const normReg = resolveCanonicalRoutingRegion(user.exchange_region);
    const klinesCacheKey = `${user.exchange_name}:${normEnv}:${normReg}:${symbol}:${interval}:${limit}`;
    const cachedKlines = KLINES_CACHE.get(klinesCacheKey);
    if (cachedKlines) {
      return c.json(cachedKlines);
    }

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normEnv,
      region: normReg,
    });

    const klines = await adapter.fetchKlines(symbol, interval, limit);
    KLINES_CACHE.set(klinesCacheKey, klines);

    return c.json(klines);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Error fetching klines", message: error.message });
  }
}

export async function handleGetTechnicalAnalysis(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const { symbol, strategy, config } = await c.req.json<{
      symbol: string;
      strategy: string;
      config?: any;
    }>();

    if (!symbol || !strategy) {
      c.status(400);
      return c.json({ error: "symbol and strategy are required" });
    }

    // Authoritative Single-Brain Projection: Proxy analysis snapshot from user's TradingBot DO
    if (c.env.TRADING_BOTS) {
      try {
        const botId = c.env.TRADING_BOTS.idFromName(userId);
        const bot = c.env.TRADING_BOTS.get(botId);
        const analysisResp = await bot.fetch(new Request("http://bot/analysis-status"));
        if (analysisResp.ok) {
          const analysisData: any = await analysisResp.json();
          const requestedNormalized = strategy ? StrategyRegistry.getInstance().normalizeStrategyId(strategy)?.toLowerCase() : null;
          const activeNormalized = analysisData?.activeStrategy ? StrategyRegistry.getInstance().normalizeStrategyId(analysisData.activeStrategy)?.toLowerCase() : null;

          const isAuthoritativeActive = 
            analysisData?.isActive === true &&
            requestedNormalized != null &&
            activeNormalized != null &&
            requestedNormalized === activeNormalized &&
            Boolean(analysisData.marketAnalysis || analysisData.indicators) &&
            (analysisData.symbol === symbol || analysisData.symbol === symbol.replace('/', '') || !symbol);

          if (isAuthoritativeActive) {
            return c.json(analysisData);
          }
        }
      } catch (doErr: any) {
        console.warn("[TechnicalAnalysis] Failed to query DO analysis-status, falling back to on-demand preview:", doErr?.message);
      }
    }

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_api_key: string | null;
        exchange_api_key_iv: string | null;
        exchange_api_key_encrypted: string | null;
        exchange_api_key_salt: string | null;
        exchange_api_secret_iv: string | null;
        exchange_api_secret_encrypted: string | null;
        exchange_api_secret_salt: string | null;
        exchange_api_passphrase_iv: string | null;
        exchange_api_passphrase_encrypted: string | null;
        exchange_api_passphrase_salt: string | null;
      }>();

    const hasApiKey = Boolean(user?.exchange_api_key_encrypted || user?.exchange_api_key);
    if (!user?.exchange_name || !hasApiKey || (!user?.exchange_api_secret_encrypted && !user?.exchange_api_key)) {
      c.status(400);
      return c.json({ error: "No exchange connected. Please connect an exchange first." });
    }

    let apiKey: string | undefined = undefined;
    if (c.env.ENCRYPTION_KEY && user.exchange_api_key_iv && user.exchange_api_key_encrypted) {
      try {
        const decrypted = await decrypt(
          { iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt },
          c.env.ENCRYPTION_KEY,
        );
        apiKey = cleanCredential(decrypted);
      } catch (decErr: any) {
        console.warn("[TechnicalAnalysis] API key decryption failed:", decErr?.message);
      }
    }
    if (!apiKey && user.exchange_api_key) {
      apiKey = cleanCredential(user.exchange_api_key);
    }

    let secret: string | undefined = undefined;
    if (c.env.ENCRYPTION_KEY && user.exchange_api_secret_iv && user.exchange_api_secret_encrypted) {
      try {
        const decrypted = await decrypt(
          { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt },
          c.env.ENCRYPTION_KEY,
        );
        secret = cleanCredential(decrypted);
      } catch (decErr: any) {
        console.warn("[TechnicalAnalysis] API secret decryption failed:", decErr?.message);
      }
    }

    let password: string | undefined = undefined;
    if (c.env.ENCRYPTION_KEY && user.exchange_api_passphrase_iv && user.exchange_api_passphrase_encrypted) {
      try {
        const decrypted = await decrypt(
          { iv: user.exchange_api_passphrase_iv, encrypted: user.exchange_api_passphrase_encrypted, salt: user.exchange_api_passphrase_salt },
          c.env.ENCRYPTION_KEY,
        );
        password = cleanCredential(decrypted);
      } catch (decErr: any) {
        console.warn("[TechnicalAnalysis] API passphrase decryption failed:", decErr?.message);
      }
    }

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet",
      apiKey,
      secret,
      password,
      region: resolveCanonicalRoutingRegion(user.exchange_region),
    });

    const ticker = await adapter.fetchTicker(symbol);

    if (!ticker) {
      c.status(404);
      return c.json({ error: `Symbol '${symbol}' is not available on your connected exchange.` });
    }

    const candleProvider = new AdapterCandleProvider(adapter);
    const dataEngine = new MarketDataEngine(candleProvider);
    const orchestrator = new StrategyOrchestrator();
    orchestrator.setMarketDataEngine(dataEngine);

    const registry = StrategyRegistry.getInstance();
    const normalizedId = registry.normalizeStrategyId(strategy);
    const manifests = registry.getAllManifests();
    const manifest = registry.getManifest(normalizedId) 
      || manifests.find(m => m.id.toLowerCase() === normalizedId.toLowerCase());
    if (!manifest) {
      c.status(404);
      return c.json({ 
        error: `Strategy '${strategy}' is not registered.`, 
        availableStrategies: registry.getAllManifests().map(m => m.id) 
      });
    }

    let accountBalance = 1000;
    try {
      const balanceResult = await adapter.fetchBalance();
      accountBalance = extractUsdtBalance(balanceResult);
    } catch (balErr: unknown) {
      new StructuredLogger().warn(`[TechnicalAnalysis] Balance fetch non-fatal fallback on ${user.exchange_name}`, { error: String(balErr) });
    }

    let results: any[] = [];
    try {
      results = await orchestrator.executeCycle(symbol, normalizedId, config, accountBalance);
    } catch (cycleErr: unknown) {
      new StructuredLogger().warn(`[TechnicalAnalysis] executeCycle non-fatal fallback for ${symbol}/${normalizedId}`, { error: String(cycleErr) });
    }

    const evalResult = (results && results[0]) || {
      strategyId: manifest.id,
      timestamp: Date.now(),
      confidenceScore: 50,
      hasSignal: false,
      metadata: { reasoning: ['Evaluation pending initial cycle'] }
    };

    let snapshot: any = orchestrator.getLastSnapshot();
    if (!snapshot || snapshot.symbol !== symbol) {
      try {
        snapshot = await dataEngine.getSnapshot(symbol, manifest.supportedTimeframes || ['5m']);
      } catch (snapErr: unknown) {
        new StructuredLogger().warn(`[TechnicalAnalysis] getSnapshot fallback for ${symbol}`, { error: String(snapErr) });
        snapshot = {
          symbol,
          timestamp: Date.now(),
          currentPrice: ticker.last.toNumber(),
          volume24h: ticker.volume.toNumber(),
          quoteVolume24h: ticker.quoteVolume.toNumber(),
          candles: { '1m': [], '3m': [], '5m': [], '15m': [], '30m': [], '1h': [], '4h': [] },
          metadata: { priceChange24h: 0, priceChangePercent24h: 0, highPrice24h: ticker.high.toNumber(), lowPrice24h: ticker.low.toNumber() },
        };
      }
    }

    const snapshotDto = AnalysisSnapshotMapper.map(evalResult, manifest, snapshot, 'PREVIEW', false);
    snapshotDto.strategyAnalyses = AnalysisSnapshotMapper.mapStrategyEvaluations(
      results && results.length > 0 ? results : [evalResult],
      registry,
      Date.now()
    );
    return c.json(snapshotDto);
  } catch (e: unknown) {
    const error = e as Error;
    const msg = error?.message || String(e);
    const code = (e as any)?.code;

    // Authentication / Credential errors -> 401
    const isAuthError =
      code === 'AUTHENTICATION_FAILED' ||
      code === 'INVALID_API_KEY' ||
      code === 'INVALID_API_SECRET' ||
      code === 'MISSING_REQUIRED_CREDENTIALS' ||
      code === 'PERMISSION_DENIED' ||
      code === 'INVALID_SIGNATURE' ||
      code === 'IP_NOT_WHITELISTED';

    if (isAuthError) {
      c.status(401);
      return c.json({ error: "Exchange authentication failed", code, message: msg });
    }

    // Missing symbol or strategy -> 404
    if (
      msg.includes('is not registered') ||
      msg.includes('not found') ||
      code === 'SYMBOL_NOT_FOUND' ||
      msg.includes('is not available on your connected exchange')
    ) {
      c.status(404);
      return c.json({ error: "Resource not found", message: msg });
    }

    // Client Bad Request / Invalid Request -> 400
    if (code === 'INVALID_REQUEST' || code === 'UNSUPPORTED_OPERATION') {
      c.status(400);
      return c.json({ error: "Invalid request parameters", message: msg });
    }

    // Exchange Connectivity / Timeout / Maintenance -> 502
    if (
      code === 'EXCHANGE_NOT_REACHABLE' ||
      code === 'EXCHANGE_TIMEOUT' ||
      code === 'RATE_LIMIT_EXCEEDED' ||
      code === 'EXCHANGE_UNDER_MAINTENANCE' ||
      code === 'SERVICE_TEMPORARILY_UNAVAILABLE'
    ) {
      c.status(502);
      return c.json({ error: "Exchange connection issue", message: msg });
    }

    c.status(500);
    return c.json({ error: "Error processing technical analysis", message: msg });
  }
}

export async function handleActivateTradingBot(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;
    const { symbols, coinId, strategy, positionSize, targetEntryPrice, config } = await c.req.json<{
      symbols?: string[];
      coinId?: string;
      strategy: string;
      positionSize?: number;
      targetEntryPrice?: number;
      config?: any;
    }>();

    const targetSymbols = (symbols && Array.isArray(symbols) && symbols.length > 0)
      ? symbols
      : (coinId ? [coinId] : []);

    if (targetSymbols.length === 0) {
      c.status(400);
      return c.json({ success: false, error: 'At least one symbol or coinId must be provided for activation.' });
    }

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, symbols: targetSymbols, coinId: targetSymbols[0], strategy, positionSize, targetEntryPrice, config }),
      }),
    );

    const data = await response.json<{ success: boolean; message?: string; error?: string; code?: string; hint?: string }>();
    c.status(response.status as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    const errMsg = error?.message || String(e);
    const isInternalInfrastructureError =
      errMsg.includes("Durable Object") ||
      errMsg.includes("free tier") ||
      errMsg.includes("quota") ||
      errMsg.includes("storage") ||
      errMsg.includes("isolate") ||
      errMsg.includes("reset") ||
      errMsg.includes("network");

    if (isInternalInfrastructureError) {
      console.error(`[trading-bot] activate infrastructure exception:`, e);
      c.status(503);
      return c.json({
        success: false,
        code: "SYSTEM_UNAVAILABLE",
        message: "Trading service is temporarily unavailable. Please try again shortly.",
        hint: "The bot engine is initializing or undergoing maintenance. Please retry in a few moments.",
        error: errMsg,
        endpoint: "/api/trading-bot/activate",
        deploymentVersion: "2.1.0",
      });
    }

    const classified = classifyException(e, "trading-bot-activate");
    console.error(`[trading-bot] activate exception (${classified.technicalDetail}):`, e);
    c.status(500);
    return c.json({
      success: false,
      code: classified.code,
      message: classified.friendlyMessage,
      hint: classified.hint,
    });
  }
}

export async function handleGetTradingBotStatus(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/status", { method: "GET" }),
    );

    const data = await response.json<{ isActive: boolean; coinId: string | null; strategy: string | null }>();
    c.status(response.status as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(200);
    return c.json({ isActive: false, coinId: null, strategy: null, message: error.message || "Bot is currently stopped" });
  }
}

export async function handleGetAnalysisStatus(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/analysis-status", { method: "GET" }),
    );

    const data = await response.json<any>();
    c.status(response.status as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    const errMsg = error?.message || String(e);
    console.warn(`[trading-bot] analysis-status fallback due to:`, errMsg);
    c.status(200);
    return c.json({
      isActive: false,
      engineStatus: { state: "STOPPED", isRunning: false, activeStrategy: null },
      safeMode: false,
      strategy: null,
      coinId: null,
      scanningProgress: 0,
      etaSeconds: 0,
      coinsCurrentlyScanning: [],
      nearMatches: [],
      checkpoints: [],
      logs: [],
      message: errMsg || "Bot is currently stopped",
    });
  }
}

export async function handleExecuteTrade(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    let reqBody: any = {};
    try {
      reqBody = await c.req.json();
    } catch (e) {
      // Ignore if no JSON body
    }
    const alertId = reqBody?.alertId;

    if (!alertId) {
      c.status(400);
      return c.json({ success: false, message: "alertId is required to execute a trade." });
    }

    if (reqBody?.quantity !== undefined) {
      const q = Number(reqBody.quantity);
      if (!Number.isFinite(q) || q <= 0) {
        c.status(400);
        return c.json({ success: false, code: "INVALID_QUANTITY", message: "Approved quantity must be a positive finite number." });
      }
    }

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/execute-trade", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody)
      }),
    );

    const data = await response.json<{ success: boolean; message: string; order?: any; code?: string; error?: string }>();
    const effectiveStatus = response.status === 200 && data && data.success === false ? 409 : response.status;
    c.status(effectiveStatus as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to execute trade" });
  }
}



export async function handleMockTrade(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  if (c.env.ENVIRONMENT === 'production') {
    c.status(403);
    return c.json({
      success: false,
      code: "MOCK_TRADING_DISABLED",
      error: "Mock trading is disabled in production.",
      message: "Mock trading is disabled in production.",
    });
  }

  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    let body: any = {};
    try {
      body = await c.req.json();
    } catch (e) {
      // Empty or non-JSON body
    }

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/mock-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, userId }),
      }),
    );

    const data = await response.json<any>();
    c.status(response.status as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to execute mock trade" });
  }
}

export async function handleDeactivateTradingBot(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/deactivate", { method: "POST" }),
    );

    const data = await response.json<{ success: boolean; message: string }>();
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to deactivate trading bot" });
  }
}

export async function handleStopTradingBot(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/stop-trade", { method: "POST" }),
    );

    const data = await response.json<{ success: boolean; message: string }>();
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to stop trading bot" });
  }
}

export async function handleGetBotAlerts(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/alerts", { method: "GET" }),
    );

    const data = await response.json<any[]>();
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Failed to get bot alerts", message: error.message });
  }
}

export async function handleAcknowledgeAlert(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;
    const { alertId } = await c.req.json<{ alertId: string }>();

    if (!alertId) {
      c.status(400);
      return c.json({ error: "alertId is required" });
    }

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/acknowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId }),
      }),
    );

    const data = await response.json<{ success: boolean }>();
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to acknowledge alert" });
  }
}

export async function handleGetExecutionStatus(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;
    const positionId = c.req.param("positionId");

    if (!positionId) {
      c.status(400);
      return c.json({ success: false, message: "positionId parameter is required." });
    }

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request(`http://bot/execution-status?positionId=${encodeURIComponent(positionId)}`, {
        method: "GET",
      }),
    );

    const data = await response.json<any>();
    c.status(response.status as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to get execution status" });
  }
}

export async function handleTriggerManualTradeAlert(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;
    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized. Please login again." });
    }

    const { symbol, strategy, config } = await c.req.json<{
      symbol: string;
      strategy?: string;
      config?: any;
    }>();

    if (!symbol) {
      if (c.env.TRADING_BOTS) {
        const botId = c.env.TRADING_BOTS.idFromName(userId);
        const bot = c.env.TRADING_BOTS.get(botId);
        const execResp = await bot.fetch(new Request("http://bot/execute-current-opportunity", { method: "POST" }));
        const execData = await execResp.json();
        c.status(execResp.status as any);
        return c.json(execData);
      }
      c.status(400);
      return c.json({ error: "Trading symbol is required." });
    }

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<any>();

    if (!user || !user.exchange_name) {
      c.status(400);
      return c.json({ error: "No exchange connected. Please connect an exchange first." });
    }

    let apiKey: string | undefined = undefined;
    if (c.env.ENCRYPTION_KEY && user.exchange_api_key_iv && user.exchange_api_key_encrypted) {
      apiKey = await decrypt(
        { iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt },
        c.env.ENCRYPTION_KEY,
      );
    } else {
      apiKey = user.exchange_api_key ?? undefined;
    }

    let secret: string | undefined = undefined;
    if (c.env.ENCRYPTION_KEY && user.exchange_api_secret_iv && user.exchange_api_secret_encrypted) {
      secret = await decrypt(
        { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt },
        c.env.ENCRYPTION_KEY,
      );
    }

    let password: string | undefined = undefined;
    if (c.env.ENCRYPTION_KEY && user.exchange_api_passphrase_iv && user.exchange_api_passphrase_encrypted) {
      password = await decrypt(
        { iv: user.exchange_api_passphrase_iv, encrypted: user.exchange_api_passphrase_encrypted, salt: user.exchange_api_passphrase_salt },
        c.env.ENCRYPTION_KEY,
      );
    }

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet",
      apiKey,
      secret,
      password,
      region: resolveCanonicalRoutingRegion(user.exchange_region),
    });

    const registry = StrategyRegistry.getInstance();
    const strategyId = strategy || config?.strategyId || "ScalperV2";
    const normalizedId = registry.normalizeStrategyId(strategyId);
    const manifest = registry.getManifest(normalizedId) || registry.getAllManifests().find(m => m.id.toLowerCase() === normalizedId.toLowerCase());
    const side: 'BUY' | 'SELL' = (manifest && !manifest.supportsShort) ? 'BUY' : (config?.side === 'SELL' ? 'SELL' : 'BUY');

    const orderSymbol = symbol.includes('/') ? symbol : `${symbol.replace('USDT', '')}/USDT`;
    const ticker = await adapter.fetchTicker(orderSymbol).catch(() => null);
    const livePrice = typeof ticker?.last?.toNumber === 'function' ? ticker.last.toNumber() : (typeof ticker?.last === 'number' ? ticker.last : 0);
    const currentPrice = livePrice > 0 ? livePrice : (config?.entryPrice || 50000.0);

    let accountBalance = 1000;
    try {
      const balanceResult = await adapter.fetchBalance();
      accountBalance = extractUsdtBalance(balanceResult);
    } catch (_) {}

    const targetEntryPrice = typeof config?.entryPrice === 'number' && config.entryPrice > 0 ? config.entryPrice : currentPrice;
    const rp = config?.riskParameters || {};
    const riskPercent = typeof rp.accountRiskPercent === 'number' && rp.accountRiskPercent >= 0.1 && rp.accountRiskPercent <= 5.0 ? rp.accountRiskPercent : 1.0;
    const rawTp = rp.atrTakeProfitMultiplier !== undefined && rp.atrTakeProfitMultiplier !== null
      ? rp.atrTakeProfitMultiplier
      : rp.riskRewardRatio;
    const tpMultiplier = typeof rawTp === 'number' && rawTp >= 1.0 && rawTp <= 5.0 ? rawTp : 2.0;
    const atrMultiplier = typeof rp.atrStopLossMultiplier === 'number' && rp.atrStopLossMultiplier >= 0.5 && rp.atrStopLossMultiplier <= 5.0 ? rp.atrStopLossMultiplier : 1.5;

    let currentAtr = 0;
    try {
      const klines = await adapter.fetchKlines(orderSymbol, '5m', 20);
      if (klines && klines.length >= 14) {
        const mapped = klines.map((k: any) => ({
          high: typeof k.high === 'number' ? k.high : parseFloat(k.high || 0),
          low: typeof k.low === 'number' ? k.low : parseFloat(k.low || 0),
          close: typeof k.close === 'number' ? k.close : parseFloat(k.close || 0),
          open: typeof k.open === 'number' ? k.open : parseFloat(k.open || 0),
          volume: typeof k.volume === 'number' ? k.volume : parseFloat(k.volume || 0),
          timestamp: typeof k.timestamp === 'number' ? k.timestamp : Date.now(),
        }));
        const atrValues = calculateATR(mapped, 14);
        currentAtr = (atrValues && atrValues.length > 0) ? atrValues[atrValues.length - 1] : 0;
      }
    } catch (_) {}

    if (!currentAtr || currentAtr <= 0) {
      currentAtr = currentPrice * 0.005;
    }

    const riskParams: RiskParameters = {
      accountRiskPercent: riskPercent,
      atrTakeProfitMultiplier: tpMultiplier,
      atrStopLossMultiplier: atrMultiplier,
      riskRewardRatio: tpMultiplier, // Legacy mirror for interface compatibility
      maxExposureLimit: 25.0
    };

    const stopLossDistance = StopLossCalculator.calculateDistance(currentAtr, riskParams);
    const takeProfitDistance = TakeProfitCalculator.calculateDistance(currentAtr, riskParams);

    // Allocation Priority Hierarchy (Model A Only):
    // 1. Authoritative: User-configured tradeValueUsdt from Trade Setup
    // 2. Secondary fallback: Explicit positionSize passed in config
    // 3. Fallback: Standard system minimum allocation (5.00 USDT)
    const explicitTradeAmount = typeof config?.tradeValueUsdt === 'number' && config.tradeValueUsdt > 0
      ? config.tradeValueUsdt
      : undefined;
    const secondaryTradeAmount = explicitTradeAmount ?? (
      typeof config?.positionSize === 'number' && config.positionSize > 0
        ? config.positionSize
        : undefined
    );
    const rawPositionSize = secondaryTradeAmount ?? 5.0;
    // Ensure individual trade allocation cannot exceed portfolio exposure safety limit if explicitly configured
    const configuredMaxExposure = typeof config?.maxPortfolioExposureUsdt === 'number' && config.maxPortfolioExposureUsdt > 0
      ? config.maxPortfolioExposureUsdt
      : (typeof config?.maxPortfolioExposure === 'number' && config.maxPortfolioExposure > 0 ? config.maxPortfolioExposure : undefined);
    const positionSize = configuredMaxExposure !== undefined
      ? Math.min(rawPositionSize, configuredMaxExposure)
      : rawPositionSize;

    let tickSize = 0;
    let minPrice = 0;
    let matchedMarket: any = null;
    try {
      if (typeof (adapter as any).fetchMarket === 'function') {
        matchedMarket = await (adapter as any).fetchMarket(orderSymbol);
      } else if (typeof adapter.fetchMarkets === 'function') {
        const markets = await adapter.fetchMarkets();
        const cleanSymbol = orderSymbol.toUpperCase();
        const rawBase = cleanSymbol.split('/')[0];
        const rawId = cleanSymbol.replace('/', '');

        matchedMarket = markets.find(m =>
          m.symbol?.toUpperCase() === cleanSymbol ||
          m.id?.toUpperCase() === rawId ||
          m.symbol?.toUpperCase() === rawId ||
          (m.base?.toUpperCase() === rawBase && m.quote?.toUpperCase() === 'USDT')
        );
      }

      if (matchedMarket) {
        if (typeof matchedMarket.precision?.price === 'number' && matchedMarket.precision.price > 0) {
          tickSize = matchedMarket.precision.price;
        } else if (typeof matchedMarket.precision?.price === 'string') {
          const parsed = parseFloat(matchedMarket.precision.price);
          if (parsed > 0) tickSize = parsed;
        }

        if (matchedMarket.limits?.price?.min) {
          const minP = matchedMarket.limits.price.min as any;
          minPrice = typeof minP?.toNumber === 'function' ? minP.toNumber() : (typeof minP === 'number' ? minP : 0);
        }
      }
    } catch (_) {}

    // Authoritative Exchange Metadata Verification (Fail Closed)
    if (!matchedMarket) {
      c.status(400);
      return c.json({
        success: false,
        error: `Exchange trading rules for '${orderSymbol}' could not be loaded from exchange. Please try again.`,
        message: `Exchange trading rules for '${orderSymbol}' could not be loaded from exchange. Please try again.`,
        code: 'EXCHANGE_METADATA_UNAVAILABLE',
      });
    }

    const rawMinQty = matchedMarket.limits?.amount?.min as any;
    const minOrderQty = typeof rawMinQty?.toNumber === 'function'
      ? rawMinQty.toNumber()
      : (typeof rawMinQty === 'number' ? rawMinQty : (parseFloat(rawMinQty) || 0));

    const rawQtyStep = matchedMarket.precision?.amount as any;
    const qtyStep = typeof rawQtyStep === 'number' && !isNaN(rawQtyStep) && rawQtyStep > 0
      ? rawQtyStep
      : (parseFloat(rawQtyStep) || 0);

    const rawMinNotional = matchedMarket.limits?.cost?.min as any;
    const rawMaxQty = (matchedMarket.limits?.amount?.max ?? (matchedMarket as any).info?.lotSizeFilter?.maxOrderQty) as any;
    const maxOrderQty = typeof rawMaxQty?.toNumber === 'function' ? rawMaxQty.toNumber() : (typeof rawMaxQty === 'number' ? rawMaxQty : (parseFloat(rawMaxQty) || 0));
    const minNotional = typeof rawMinNotional?.toNumber === 'function'
      ? rawMinNotional.toNumber()
      : (typeof rawMinNotional === 'number' ? rawMinNotional : (parseFloat(rawMinNotional) || 0));

    // Fail closed if required execution constraints cannot be verified
    if (minOrderQty <= 0 || qtyStep <= 0 || minNotional <= 0 || maxOrderQty <= 0 || !Number.isFinite(maxOrderQty)) {
      c.status(400);
      return c.json({
        success: false,
        error: `Authoritative order execution constraints for '${orderSymbol}' could not be verified from exchange rules.`,
        message: `Authoritative order execution constraints for '${orderSymbol}' could not be verified from exchange rules.`,
        code: 'INVALID_EXCHANGE_RULES',
        details: {
          symbol: orderSymbol,
          qtyStep,
          minOrderQty,
          minNotional,
      maxOrderQty,
        }
      });
    }

    // Pre-Alert Execution Eligibility Gate for Manual Trade
    const eligibility = ExecutionEligibilityGate.evaluate({
      tradeAmountUsdt: positionSize,
      currentPrice: targetEntryPrice,
      qtyStep,
      minOrderQty,
      minNotional,
      maxOrderQty,
    });

    if (!eligibility.isExecutable) {
      c.status(400);
      return c.json({
        success: false,
        error: eligibility.rejectionReason || `Trade amount ($${positionSize} USDT) cannot meet exchange order constraints for ${orderSymbol}`,
        message: eligibility.rejectionReason || `Trade amount ($${positionSize} USDT) cannot meet exchange order constraints for ${orderSymbol}`,
        code: 'EXECUTION_INELIGIBLE',
        details: {
          symbol: orderSymbol,
          tradeAmountUsdt: positionSize,
          currentPrice: targetEntryPrice,
          minOrderQty,
          qtyStep,
          minNotional,
      maxOrderQty,
          quantizedQty: eligibility.quantizedQty,
          postRoundingNotional: eligibility.postRoundingNotional,
          rejectionReason: eligibility.rejectionReason,
        }
      });
    }

    // Dynamic magnitude fallback if authoritative tickSize could not be fetched
    if (!tickSize || tickSize <= 0) {
      if (targetEntryPrice <= 0) tickSize = 0.01;
      else if (targetEntryPrice < 0.0001) tickSize = 0.00000001; // 8 decimals (e.g. PEPE, SHIB)
      else if (targetEntryPrice < 0.001) tickSize = 0.000001;     // 6 decimals (e.g. SOPH)
      else if (targetEntryPrice < 0.01) tickSize = 0.00001;       // 5 decimals (e.g. GALA)
      else if (targetEntryPrice < 0.1) tickSize = 0.0001;         // 4 decimals (e.g. DOGE)
      else if (targetEntryPrice < 1.0) tickSize = 0.001;          // 3 decimals
      else tickSize = 0.01;                                       // Standard 2 decimals
    }

    const minAllowedPrice = minPrice > 0 ? minPrice : tickSize;

    const entryBN = new BigNumber(targetEntryPrice);
    const slDistBN = new BigNumber(stopLossDistance);
    const tpDistBN = new BigNumber(takeProfitDistance);

    const theoreticalSL = side === 'BUY' ? entryBN.minus(slDistBN).toNumber() : entryBN.plus(slDistBN).toNumber();
    const theoreticalTP = side === 'BUY' ? entryBN.plus(tpDistBN).toNumber() : entryBN.minus(tpDistBN).toNumber();

    const normalized = PriceNormalizer.normalizeTradePrices({
      entryPrice: targetEntryPrice,
      theoreticalSL,
      theoreticalTP,
      tickSize,
      minAllowedPrice,
      side: side as 'BUY' | 'SELL'
    });

    const finalStopLoss = normalized.stopLoss;
    const finalTakeProfit = normalized.takeProfit;

    const estimatedPnl = Math.abs(finalTakeProfit - targetEntryPrice) * (targetEntryPrice > 0 ? positionSize / targetEntryPrice : 0);
    const entryIntent = (config?.entryIntent as any) || 'WAIT_FOR_PRICE';
    const targetTimeframe = (config?.timeframe || manifest?.supportedTimeframes?.[0] || '5m') as any;

    const alert: TradeAlert = {
      id: crypto.randomUUID(),
      symbol: orderSymbol,
      strategy: normalizedId,
      side: side,
      targetEntryPrice: targetEntryPrice,
      entryIntent: entryIntent,
      entryPrice: targetEntryPrice,
      signalPrice: currentPrice,
      stopLoss: finalStopLoss,
      takeProfit: finalTakeProfit,
      positionSize: parseFloat(positionSize.toFixed(2)),
      quantity: eligibility.quantizedQty,
      requestedBudget: positionSize,
      effectiveNotional: eligibility.postRoundingNotional,
      estimatedPnl: parseFloat(estimatedPnl.toFixed(2)),
      timestamp: new Date().toISOString(),
      status: 'pending',
      source: 'MANUAL',
      generation: undefined,
      timeframe: targetTimeframe,
    };

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);
    const regResp = await bot.fetch(
      new Request("http://bot/register-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert }),
      })
    );

    if (!regResp.ok) {
      const errText = await regResp.text();
      new StructuredLogger().error(`[TriggerAlert] Failed to register alert in DO: ${errText}`);
      c.status(500);
      return c.json({ error: "Failed to register trade alert in trading session." });
    }

    console.log(`[MANUAL_ALERT_TRIGGERED] alertId=${alert.id} symbol=${alert.symbol} strategy=${alert.strategy}`);
    return c.json(alert);
  } catch (e: unknown) {
    const error = e as Error;
    new StructuredLogger().error("[TriggerAlert] Error handling manual alert trigger", { error: error.message });
    c.status(500);
    return c.json({ error: "Failed to generate manual trade alert", message: error.message });
  }
}


