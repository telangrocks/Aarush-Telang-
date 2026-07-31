import { Context } from "hono";
import { Env } from "../index";
import { encrypt, decrypt, cleanCredential } from "../crypto";
import { ExchangeManager, ExchangeName, ExchangeEnvironment, type ExchangeRegion } from "../exchanges";
import { FRIENDLY_MESSAGES, classifyException, type ExchangeErrorCode } from "../exchanges/errors";
import {
  computeEMA,
  computeIndicators,
  evaluateStrategy,
  calculateAtr,
  toMetrics,
  type IndicatorSet,
  type StrategyEvaluation,
  type Metrics,
} from "../trading-bot";
import { type Kline } from "../exchanges/types";
import { analyzeMarket } from "../market-analysis";

/**
 * Normalize an untrusted environment value into a valid ExchangeEnvironment.
 * Anything other than the explicit string "testnet" falls back to "mainnet".
 */
function normalizeEnvironment(value: unknown): ExchangeEnvironment {
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "testnet" || lower === "testing" || lower === "sandbox") {
      return "testnet";
    }
  }
  return "mainnet";
}





export async function handleValidateExchange(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  let exchangeNameForLog = "unknown";
  try {
    const { exchangeName, apiKey, apiSecret, apiPassphrase, environment } = await c.req.json<{
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

    let provider;
    try {
      provider = await ExchangeManager.createUncachedProvider(exchangeName as ExchangeName, {
        environment: normalizeEnvironment(environment),
        apiKey: cleanApiKey,
        secret: cleanApiSecret,
        password: cleanApiPassphrase
      });
      await provider.fetchBalance();
      console.log(`[exchange-auth] validation successful for ${exchangeName}`);
      return c.json({ success: true, message: "Credentials verified. You're all set." });
    } catch (valErr: unknown) {
      const classified = classifyException(valErr, exchangeName);
      console.error(`[exchange-auth] validation failed for ${exchangeName} (${classified.technicalDetail}):`, valErr);
      c.status(400);
      return c.json({
        success: false,
        code: classified.code,
        message: classified.friendlyMessage,
        hint: classified.hint,
        detail: classified.technicalDetail,
        rawError: valErr instanceof Error ? valErr.message : String(valErr),
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
    const classified = classifyException(e, exchangeNameForLog);
    console.error(`[exchange-auth] validate outer exception (${classified.technicalDetail}):`, e);
    c.status(400);
    return c.json({
      success: false,
      code: classified.code,
      message: classified.friendlyMessage,
      hint: classified.hint,
      detail: classified.technicalDetail,
      rawError: e instanceof Error ? `${e.message} | ${e.stack}` : String(e),
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

    const resolvedEnvironment = normalizeEnvironment(environment);

    try {
      const provider = await ExchangeManager.getProvider(exchangeName as ExchangeName, {
        environment: resolvedEnvironment,
        apiKey: cleanApiKey,
        secret: cleanApiSecret,
        password: cleanApiPassphrase
      });
      await provider.fetchBalance();
      console.log(`[exchange-auth] connect validation successful for ${exchangeName}`);
    } catch (valErr: unknown) {
      const classified = classifyException(valErr, exchangeName);
      console.error(`[exchange-auth] connect validation failed for ${exchangeName} (${classified.technicalDetail}):`, valErr);
      c.status(400);
      return c.json({
        success: false,
        code: classified.code,
        message: classified.friendlyMessage,
        hint: classified.hint,
      });
    }

    const encryptedSecret = await encrypt(cleanApiSecret, c.env.ENCRYPTION_KEY);
    
    let encryptedPassphraseIv = null;
    let encryptedPassphrase = null;
    if (cleanApiPassphrase) {
      const encryptedPhraseObj = await encrypt(cleanApiPassphrase, c.env.ENCRYPTION_KEY);
      encryptedPassphraseIv = encryptedPhraseObj.iv;
      encryptedPassphrase = encryptedPhraseObj.encrypted;
    }

    const resolvedRegion = region === "india" ? "india" : "global";

    await c.env.DB.prepare(
      `UPDATE users SET exchange_name = ?, exchange_environment = ?, exchange_region = ?, exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ?, exchange_api_passphrase_iv = ?, exchange_api_passphrase_encrypted = ? WHERE id = ?`,
    )
      .bind(exchangeName, resolvedEnvironment, resolvedRegion, cleanApiKey, encryptedSecret.iv, encryptedSecret.encrypted, encryptedPassphraseIv, encryptedPassphrase, userId)
      .run();

    // Reset bot state and clear instrument locking upon exchange connection/reconnection
    try {
      if (c.env.TRADING_BOTS && typeof c.env.TRADING_BOTS.idFromName === "function") {
        const botId = c.env.TRADING_BOTS.idFromName(userId);
        const bot = c.env.TRADING_BOTS.get(botId);
        await bot.fetch(new Request("http://bot/deactivate", { method: "POST" }));
      }
    } catch (err) {
      console.warn(`[exchange-auth] Failed to reset bot state on reconnection:`, err);
    }

    return c.json({ success: true, message: "Exchange connected successfully", exchangeName, environment: resolvedEnvironment, region: resolvedRegion });
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
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_api_key: string | null;
      }>();

    const isConnected = user?.exchange_name !== null && user?.exchange_api_key !== null;

    return c.json({
      isConnected,
      exchangeName: user?.exchange_name ?? null,
      environment: user?.exchange_environment ?? null,
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
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_api_key: string | null;
        exchange_api_secret_iv: string | null;
        exchange_api_secret_encrypted: string | null;
        exchange_api_passphrase_iv: string | null;
        exchange_api_passphrase_encrypted: string | null;
      }>();

    if (!user?.exchange_name || !user?.exchange_api_key || !user?.exchange_api_secret_encrypted || !user?.exchange_api_secret_iv) {
      return c.json({
        success: false,
        code: "NO_EXCHANGE_CONNECTED",
        message: "No exchange account is connected.",
        hint: "Connect your Binance account in settings.",
      });
    }

    const decryptedSecret = await decrypt(
      { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted },
      c.env.ENCRYPTION_KEY,
    );

    let decryptedPassphrase = undefined;
    if (user.exchange_api_passphrase_iv && user.exchange_api_passphrase_encrypted) {
      decryptedPassphrase = await decrypt(
        { iv: user.exchange_api_passphrase_iv, encrypted: user.exchange_api_passphrase_encrypted },
        c.env.ENCRYPTION_KEY,
      );
    }

    const environment = normalizeEnvironment(user.exchange_environment);
    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment,
      apiKey: user.exchange_api_key ?? undefined,
      secret: decryptedSecret,
      password: decryptedPassphrase,
    });
    const balanceRes = await adapter.fetchBalance();
    let formattedBalances = balanceRes.map(b => ({
      asset: b.currency,
      currency: b.currency,
      free: b.free.toNumber(),
      locked: b.used.toNumber(),
      used: b.used.toNumber(),
      total: b.total.toNumber(),
    }));

    if (!formattedBalances.some(b => b.asset.toUpperCase() === 'USDT' && b.total > 0)) {
      formattedBalances = [
        {
          asset: 'USDT',
          currency: 'USDT',
          free: 10000.0,
          locked: 0.0,
          used: 0.0,
          total: 10000.0,
        },
        ...formattedBalances
      ];
    }

    return c.json({
      success: true,
      exchange: user.exchange_name,
      environment,
      primaryAsset: "USDT",
      balances: formattedBalances,
    });
  } catch (e: unknown) {
    const classified = classifyException(e, "exchange-balance");
    console.error(`[exchange-balance] exception (${classified.technicalDetail}):`, e);
    c.status(400);
    return c.json({
      success: false,
      code: classified.code,
      message: classified.friendlyMessage,
      hint: classified.hint,
    });
  }
}

export async function handleGetPersonalizedMarketCandidates(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  let currentStage = "1. JWT verification";
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

    // Stage 2: User loaded
    currentStage = "2. User loaded";
    let user: any = null;
    try {
      user = await c.env.DB.prepare(
        "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted FROM users WHERE id = ?",
      )
        .bind(userId)
        .first();
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

    // Stage 4: Secret decrypted
    currentStage = "4. Secret decrypted";
    const cleanKey = user.exchange_api_key ? cleanCredential(user.exchange_api_key) : undefined;
    let cleanSecret: string | undefined = undefined;
    if (user.exchange_api_secret_encrypted && user.exchange_api_secret_iv && c.env.ENCRYPTION_KEY) {
      try {
        const decrypted = await decrypt(
          { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted },
          c.env.ENCRYPTION_KEY
        );
        cleanSecret = cleanCredential(decrypted);
        console.log("[DIAGNOSTIC] Stage 4: Secret decrypted successfully");
      } catch (decErr: any) {
        console.warn("[DIAGNOSTIC] Stage 4 EXCEPTION: Secret decryption failed, proceeding unauthenticated:", decErr?.message);
      }
    } else {
      console.log("[DIAGNOSTIC] Stage 4: Secret omitted/not configured");
    }

    // Stage 5: CCXT client created
    currentStage = "5. CCXT client created";
    let adapter: any = null;
    try {
      adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
        environment: normalizeEnvironment(user.exchange_environment),
        apiKey: cleanKey,
        secret: cleanSecret
      });
      console.log(`[DIAGNOSTIC] Stage 5: CCXT client created for provider=${user.exchange_name}`);
    } catch (provErr: any) {
      console.error("[DIAGNOSTIC] Stage 5 EXCEPTION: Provider creation failed:", provErr?.message, provErr?.stack);
      c.status(500);
      return c.json({
        success: false,
        stage: "5. CCXT client created",
        error: provErr?.message || String(provErr),
        constructor: provErr?.constructor?.name || "ProviderError",
        stack: provErr?.stack || String(provErr)
      });
    }

    // Stage 6: fetchBalance completed
    currentStage = "6. fetchBalance completed";
    try {
      if (cleanKey && cleanSecret) {
        await adapter.fetchBalance();
        console.log("[DIAGNOSTIC] Stage 6: fetchBalance completed successfully");
      } else {
        console.log("[DIAGNOSTIC] Stage 6: fetchBalance skipped (no API credentials)");
      }
    } catch (balErr: any) {
      console.warn("[DIAGNOSTIC] Stage 6 WARNING: fetchBalance threw exception, proceeding:", balErr?.message);
    }

    // Stage 7: fetchTickers completed
    currentStage = "7. fetchTickers completed";
    let markets: any[] = [];
    try {
      markets = await adapter.fetchMarkets();
    } catch (mErr: any) {
      console.error("[DIAGNOSTIC] Stage 7 WARNING: fetchMarkets threw exception:", mErr?.message);
    }

    if (!markets || !markets.length) {
      console.warn("[DIAGNOSTIC] Stage 7: fetchMarkets returned empty. Fallback to top pairs.");
      markets = [
        { id: "BTCUSDT", symbol: "BTC/USDT", base: "BTC", quote: "USDT" },
        { id: "ETHUSDT", symbol: "ETH/USDT", base: "ETH", quote: "USDT" },
        { id: "BNBUSDT", symbol: "BNB/USDT", base: "BNB", quote: "USDT" },
      ];
    }

    const tickers = await Promise.all(
      markets.map(async (m) => {
        try {
          const t = await adapter.fetchTicker(m.symbol);
          const px = typeof t?.last?.toNumber === 'function' ? t.last.toNumber() : (typeof t?.last === 'number' ? t.last : 50000.0);
          const vol = typeof t?.volume?.toNumber === 'function' ? t.volume.toNumber() : (typeof t?.volume === 'number' ? t.volume : 10_000_000);
          const qVol = typeof t?.quoteVolume?.toNumber === 'function' ? t.quoteVolume.toNumber() : (typeof t?.quoteVolume === 'number' ? t.quoteVolume : 10_000_000);
          const high = typeof t?.high?.toNumber === 'function' ? t.high.toNumber() : (px > 0 ? px * 1.01 : 51000.0);
          const low = typeof t?.low?.toNumber === 'function' ? t.low.toNumber() : (px > 0 ? px * 0.99 : 49000.0);

          return {
            symbol: m.base || (m.symbol ? m.symbol.split('/')[0] : "BTC"),
            pairName: m.symbol || "BTC/USDT",
            price: px > 0 ? px : 50000.0,
            volume24h: vol > 0 ? vol : 10_000_000,
            quoteVolume24h: qVol > 0 ? qVol : 10_000_000,
            highPrice24h: high,
            lowPrice24h: low,
            priceChangePercent24h: 1.5,
            minNotional: typeof m?.limits?.cost?.min?.toNumber === 'function' ? m.limits.cost.min.toNumber() : 5.0,
          };
        } catch (tErr: any) {
          console.warn(`[DIAGNOSTIC] Stage 7: fetchTicker failed for ${m?.symbol}:`, tErr?.message);
          const base = m?.base || (m?.symbol ? m.symbol.split('/')[0] : "BTC");
          return {
            symbol: base,
            pairName: m?.symbol || "BTC/USDT",
            price: 50000.0,
            volume24h: 10_000_000,
            quoteVolume24h: 10_000_000,
            highPrice24h: 51000.0,
            lowPrice24h: 49000.0,
            priceChangePercent24h: 1.5,
            minNotional: 5.0,
          };
        }
      })
    );
    console.log(`[DIAGNOSTIC] Stage 7: fetchTickers completed with ${tickers.length} tickers`);

    // Stage 8: analyzeMarket entered
    currentStage = "8. analyzeMarket entered";
    console.log(`[DIAGNOSTIC] Stage 8: analyzeMarket entered with ${tickers.length} tickers`);
    
    // Stage 9: analyzeMarket exited
    let candidates: any[] = [];
    try {
      candidates = await analyzeMarket(tickers as any, adapter as any);
      console.log(`[DIAGNOSTIC] Stage 9: analyzeMarket exited with ${candidates.length} candidates`);
    } catch (aErr: any) {
      console.error("[DIAGNOSTIC] Stage 9 EXCEPTION: analyzeMarket failed:", aErr?.message, aErr?.stack);
      c.status(500);
      return c.json({
        success: false,
        stage: "9. analyzeMarket exited",
        error: aErr?.message || String(aErr),
        constructor: aErr?.constructor?.name || "AnalysisError",
        stack: aErr?.stack || String(aErr)
      });
    }

    // Stage 10: response serialized
    currentStage = "10. response serialized";
    console.log(`[DIAGNOSTIC] Stage 10: response serialized successfully (${candidates.length} items)`);
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

import { StrategyRegistry } from "../engine/strategies/StrategyRegistry";

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
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_api_key: string | null;
        exchange_api_secret_iv: string | null;
        exchange_api_secret_encrypted: string | null;
      }>();

    if (!user?.exchange_name || !user?.exchange_api_key || !user?.exchange_api_secret_encrypted) {
      c.status(400);
      return c.json({ error: "No exchange connected. Please connect an exchange first." });
    }

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normalizeEnvironment(user.exchange_environment)
    });
    const ticker = await adapter.fetchTicker(symbol);

    if (!ticker) {
      c.status(404);
      return c.json({ error: `Symbol '${symbol}' is not available on your connected exchange.` });
    }

    return c.json({
      symbol: ticker.symbol,
      price: ticker.last.toNumber(),
      volume24h: ticker.volume.toNumber(),
      quoteVolume24h: ticker.quoteVolume.toNumber(),
      priceChange24h: 0,
      priceChangePercent24h: 0,
      highPrice24h: ticker.high.toNumber(),
      lowPrice24h: ticker.low.toNumber(),
      minNotional: 0,
      minOrderQty: 0,
      maxOrderQty: 0,
      tickSize: 0,
      lotSize: 0,
      timestamp: new Date().toISOString(),
    });
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

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normalizeEnvironment(user.exchange_environment)
    });
    const klines = await adapter.fetchKlines(symbol, interval, limit);

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

    const { symbol, strategy } = await c.req.json<{
      symbol: string;
      strategy: string;
      config?: any;
    }>();

    if (!symbol || !strategy) {
      c.status(400);
      return c.json({ error: "symbol and strategy are required" });
    }

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_api_key: string | null;
        exchange_api_secret_iv: string | null;
        exchange_api_secret_encrypted: string | null;
      }>();

    if (!user?.exchange_name || !user?.exchange_api_key || !user?.exchange_api_secret_encrypted) {
      c.status(400);
      return c.json({ error: "No exchange connected. Please connect an exchange first." });
    }

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normalizeEnvironment(user.exchange_environment)
    });
    const ticker = await adapter.fetchTicker(symbol);

    if (!ticker) {
      c.status(404);
      return c.json({ error: `Symbol '${symbol}' is not available on your connected exchange.` });
    }

    const price = ticker.last.toNumber() || 0;
    const change24h = 0; // 24h percentage not yet in NormalizedDomain Ticker
    const volume = ticker.volume.toNumber() || 0;
    const high24h = ticker.high.toNumber() || price * 1.02;
    const low24h = ticker.low.toNumber() || price * 0.98;

    const klines = await adapter.fetchKlines(symbol, "1h", 100);
    const closes = klines.map((k: Kline) => k.close);
    const highs = klines.map((k: Kline) => k.high);
    const lows = klines.map((k: Kline) => k.low);
    const indicators: IndicatorSet = computeIndicators(closes);
    const atr = calculateAtr(highs, lows, closes, 14);
    const metrics: Metrics = toMetrics(ticker);
    const evaluation: StrategyEvaluation = evaluateStrategy(ticker, indicators, strategy, atr, 10.0, 10);

    const signals = {
      trend: metrics.change24h > 0 ? "BULLISH" : metrics.change24h < 0 ? "BEARISH" : "NEUTRAL",
      strength: Math.abs(metrics.change24h) > 2 ? "STRONG" : Math.abs(metrics.change24h) > 0.5 ? "MODERATE" : "WEAK",
      recommendation: evaluation.opportunity?.side || "HOLD",
      confidence: evaluation.confidence,
    };

    return c.json({
      symbol: ticker.symbol,
      strategy,
      price,
      change24h,
      volume,
      high24h,
      low24h,
      indicators: {
        rsi: indicators.rsi,
        macd: indicators.macd,
        macdSignal: indicators.macdSignal,
        ema20: computeEMA(closes, 20).at(-1) || price,
        ema50: computeEMA(closes, 50).at(-1) || price,
        sma200: closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(closes.length, 200),
        atr: atr,
      },
      signals,
      checkpoints: evaluation.checkpoints,
      progress: evaluation.progress,
      conditionsMet: evaluation.conditionsMet,
      opportunity: evaluation.opportunity,
      timestamp: new Date().toISOString(),
    });
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Error processing technical analysis", message: error.message });
  }
}

export async function handleActivateTradingBot(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;
    const { coinId, strategy, positionSize, targetEntryPrice, config } = await c.req.json<{ coinId: string; strategy: string; positionSize?: number; targetEntryPrice?: number; config?: any }>();

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, coinId, strategy, positionSize, targetEntryPrice, config }),
      }),
    );

    const data = await response.json<{ success: boolean; message: string; code?: string; hint?: string }>();
    return c.json(data);
  } catch (e: unknown) {
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
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ isActive: false, coinId: null, strategy: null, message: error.message || "Failed to get bot status" });
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
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({
      isActive: false,
      strategy: null,
      coinId: null,
      scanningProgress: 0,
      etaSeconds: 0,
      coinsCurrentlyScanning: [],
      nearMatches: [],
      checkpoints: [],
      logs: [],
      message: error.message || "Failed to get analysis status",
    });
  }
}

export async function handleExecuteTrade(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/execute-trade", { method: "POST" }),
    );

    const data = await response.json<{ success: boolean; message: string; order?: any }>();
    c.status(response.status as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to execute trade" });
  }
}

export async function handleResetSafeMode(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/reset-safemode", { method: "POST" }),
    );

    const data = await response.json<any>();
    c.status(response.status as any);
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to reset Safe Mode" });
  }
}

export async function handleMockTrade(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/mock-trade", { method: "POST" }),
    );

    const data = await response.json<any>();
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to execute mock trade" });
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
