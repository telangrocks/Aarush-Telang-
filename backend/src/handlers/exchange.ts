import { Context } from "hono";
import { Env } from "../index";
import { encrypt, decrypt, cleanCredential } from "../crypto";
import { ExchangeManager, ExchangeName, ExchangeEnvironment, type ExchangeRegion } from "../exchanges";
import { FRIENDLY_MESSAGES, classifyException, type ExchangeErrorCode } from "../exchanges/errors";
import { StructuredLogger } from "../infrastructure/telemetry/Telemetry";
import { UnifiedError } from "../exchanges/models/UnifiedError";
import { analyzeMarket } from "../market-analysis";
import { normalizeEnvironment as normEnvUtil, isEnvironmentSupported, getSupportedEnvironmentsList, CanonicalEnvironment } from "../utils/environment";
import { normalizeRegion } from "../utils/region";

/**
 * Normalize an untrusted environment value into a valid ExchangeEnvironment.
 * Returns null for unrecognized values.
 */
function normalizeEnvironment(value: unknown): ExchangeEnvironment | null {
  return normEnvUtil(value) as ExchangeEnvironment | null;
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
        message: "Invalid environment. Supported values: mainnet, testnet, demo.",
        hint: "Supported environment values are mainnet, testnet, or demo.",
        version: "1.0",
        correlationId,
      });
    }

    if (!isEnvironmentSupported(exchangeName, normEnv as CanonicalEnvironment)) {
      c.status(400);
      return c.json({
        success: false,
        code: "UNSUPPORTED_OPERATION" as ExchangeErrorCode,
        message: `${exchangeName} does not support the '${normEnv}' environment. Supported: ${getSupportedEnvironmentsList(exchangeName)}.`,
        hint: `Please select a supported environment for ${exchangeName}: ${getSupportedEnvironmentsList(exchangeName)}.`,
        version: "1.0",
        correlationId,
      });
    }

    const resolvedRegion = normalizeRegion(region);

    let provider;
    try {
      provider = await ExchangeManager.createUncachedProvider(exchangeName as ExchangeName, {
        environment: normEnv,
        apiKey: cleanApiKey,
        secret: cleanApiSecret,
        password: cleanApiPassphrase,
        region: resolvedRegion,
      });
      await provider.fetchBalance();
      console.log(`[EXCHANGE_VALIDATE_SUCCESS] correlationId=${correlationId} exchange=${exchangeName} cfRay=${cfRay}`);
      return c.json({ success: true, message: "Credentials verified. You're all set.", version: "1.0", correlationId });
    } catch (valErr: unknown) {
      const classified = classifyException(valErr, exchangeName, correlationId);
      console.error(`[EXCHANGE_VALIDATE_FAILED] correlationId=${correlationId} exchange=${exchangeName} code=${classified.code} msg="${classified.friendlyMessage}" cfRay=${cfRay} (${classified.technicalDetail}):`, valErr);
      c.status(400);
      let hint = classified.hint;
      if (classified.code === "AUTHENTICATION_FAILED" && normEnv !== "mainnet") {
        hint = `Authentication failed. Please verify that your API key is for the '${normEnv}' environment.`;
      }
      return c.json({
        success: false,
        code: classified.code,
        message: classified.friendlyMessage,
        hint: hint,
        version: classified.version || "1.0",
        correlationId,
        detail: classified.technicalDetail,
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
      detail: classified.technicalDetail,
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

    try {
      const provider = await ExchangeManager.getProvider(exchangeName as ExchangeName, {
        environment: normEnv,
        apiKey: cleanApiKey,
        secret: cleanApiSecret,
        password: cleanApiPassphrase,
        region: resolvedRegion,
      });
      await provider.fetchBalance();
      console.log(`[exchange-auth] connect validation successful for ${exchangeName}`);
    } catch (valErr: unknown) {
      const classified = classifyException(valErr, exchangeName);
      console.error(`[exchange-auth] connect validation failed for ${exchangeName} (${classified.technicalDetail}):`, valErr);
      c.status(400);
      let hint = classified.hint;
      if (classified.code === "AUTHENTICATION_FAILED" && normEnv !== "mainnet") {
        hint = `Authentication failed. Please verify that your API key is for the '${normEnv}' environment.`;
      }
      return c.json({
        success: false,
        code: classified.code,
        message: classified.friendlyMessage,
        hint: hint,
      });
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

    // Set plaintext exchange_api_key to NULL to eliminate plaintext storage
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
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key_encrypted, exchange_api_secret_encrypted, exchange_api_secret_iv FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_environment: string | null;
        exchange_region: string | null;
        exchange_api_key_encrypted: string | null;
        exchange_api_secret_encrypted: string | null;
        exchange_api_secret_iv: string | null;
      }>();

    const isConnected = Boolean(
      user?.exchange_name &&
      user?.exchange_api_key_encrypted &&
      user?.exchange_api_secret_encrypted &&
      user?.exchange_api_secret_iv
    );

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
      "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt, exchange_api_passphrase_iv, exchange_api_passphrase_encrypted, exchange_api_passphrase_salt FROM users WHERE id = ?",
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

    let decryptedKey: string;
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

    const decryptedSecret = await decrypt(
      { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt },
      c.env.ENCRYPTION_KEY,
    );

    let decryptedPassphrase = undefined;
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

    // Stage 2: User loaded
    currentStage = "2. User loaded";
    let user: any = null;
    try {
      user = await c.env.DB.prepare(
        "SELECT exchange_name, exchange_environment, exchange_region, exchange_api_key_iv, exchange_api_key_encrypted, exchange_api_key_salt, exchange_api_secret_iv, exchange_api_secret_encrypted, exchange_api_secret_salt FROM users WHERE id = ?",
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
    let cleanKey: string | undefined = undefined;
    if (user.exchange_api_key_encrypted && user.exchange_api_key_iv && c.env.ENCRYPTION_KEY) {
      try {
        const decryptedKey = await decrypt(
          { iv: user.exchange_api_key_iv, encrypted: user.exchange_api_key_encrypted, salt: user.exchange_api_key_salt },
          c.env.ENCRYPTION_KEY
        );
        cleanKey = cleanCredential(decryptedKey);
      } catch (decKeyErr: any) {
        console.warn("[DIAGNOSTIC] API key decryption failed:", decKeyErr?.message);
      }
    }

    let cleanSecret: string | undefined = undefined;
    if (user.exchange_api_secret_encrypted && user.exchange_api_secret_iv && c.env.ENCRYPTION_KEY) {
      try {
        const decrypted = await decrypt(
          { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted, salt: user.exchange_api_secret_salt },
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
        environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet",
        apiKey: cleanKey,
        secret: cleanSecret
      });
      console.log(`[DIAGNOSTIC] Stage 5: CCXT client created for provider=${user.exchange_name}`);
    } catch (provErr: any) {
      console.error("[EXCHANGE_PROVIDER_ERROR] Provider creation failed:", provErr?.message);
      const classified = classifyException(provErr, user.exchange_name, correlationId);
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

    // Execute ticker fetches in controlled concurrent batches (size 3) to prevent Cloudflare Worker socket deadlocks
    const rawTickers: any[] = [];
    const batchSize = 3;
    for (let i = 0; i < markets.length; i += batchSize) {
      const batch = markets.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (m) => {
          try {
            const t = await adapter.fetchTicker(m.symbol);
            const px = typeof t?.last?.toNumber === 'function' ? t.last.toNumber() : (typeof t?.last === 'number' ? t.last : 0);
            if (!px || px <= 0 || isNaN(px)) {
              console.warn(`[DIAGNOSTIC] Stage 7: Invalid or missing spot price for ${m.symbol}, skipping symbol.`);
              return null;
            }
            const vol = typeof t?.volume?.toNumber === 'function' ? t.volume.toNumber() : (typeof t?.volume === 'number' ? t.volume : 0);
            const qVol = typeof t?.quoteVolume?.toNumber === 'function' ? t.quoteVolume.toNumber() : (typeof t?.quoteVolume === 'number' ? t.quoteVolume : (vol * px));
            const high = typeof t?.high?.toNumber === 'function' ? t.high.toNumber() : (typeof t?.high === 'number' ? t.high : px);
            const low = typeof t?.low?.toNumber === 'function' ? t.low.toNumber() : (typeof t?.low === 'number' ? t.low : px);

            let chg = 0;
            if (typeof (t as any)?.percentage === 'number' && !isNaN((t as any).percentage)) {
              chg = (t as any).percentage;
            } else if (typeof (t as any)?.info?.priceChangePercent !== 'undefined') {
              chg = parseFloat((t as any).info.priceChangePercent) || 0;
            } else if (typeof (t as any)?.info?.changeRate !== 'undefined') {
              chg = (parseFloat((t as any).info.changeRate) || 0) * 100;
            } else if (typeof (t as any)?.open === 'number' || typeof (t as any)?.open?.toNumber === 'function') {
              const open = typeof (t as any)?.open?.toNumber === 'function' ? (t as any).open.toNumber() : (t as any).open;
              if (open > 0) chg = ((px - open) / open) * 100;
            }

            return {
              symbol: m.base || (m.symbol ? m.symbol.split('/')[0] : "BTC"),
              pairName: m.symbol || "BTC/USDT",
              price: px,
              volume24h: vol,
              quoteVolume24h: qVol,
              highPrice24h: high,
              lowPrice24h: low,
              priceChangePercent24h: chg,
              minNotional: typeof m?.limits?.cost?.min?.toNumber === 'function' ? m.limits.cost.min.toNumber() : 5.0,
            };
          } catch (tErr: any) {
            console.warn(`[DIAGNOSTIC] Stage 7: fetchTicker failed for ${m?.symbol}: ${tErr?.message}. Skipping symbol to prevent data fabrication.`);
            return null;
          }
        })
      );
      rawTickers.push(...batchResults);
    }
    const tickers = rawTickers.filter((t): t is NonNullable<typeof t> => t !== null);
    console.log(`[DIAGNOSTIC] Stage 7: fetchTickers completed with ${tickers.length} genuine live tickers`);

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
import { StrategyOrchestrator } from "../engine/orchestrator/StrategyOrchestrator";
import { MarketDataEngine, AdapterCandleProvider } from "../engine/market-data";
import { AnalysisSnapshotMapper } from "../api/engine/AnalysisSnapshotMapper";

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

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet"
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
      environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet"
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

    const { symbol, strategy, config } = await c.req.json<{
      symbol: string;
      strategy: string;
      config?: any;
    }>();

    if (!symbol || !strategy) {
      c.status(400);
      return c.json({ error: "symbol and strategy are required" });
    }

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

    const adapter = await ExchangeManager.getProvider(user.exchange_name as ExchangeName, {
      environment: normalizeEnvironment(user.exchange_environment) ?? "mainnet"
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
      c.status(400);
      return c.json({ 
        error: `Strategy '${strategy}' is not registered.`, 
        availableStrategies: registry.getAllManifests().map(m => m.id) 
      });
    }

    const balanceResult = await adapter.fetchBalance().catch(() => null);
    const accountBalance = (balanceResult as any)?.free?.USDT ?? (balanceResult as any)?.total?.USDT ?? (balanceResult as any)?.USDT?.free ?? 1000;
    const results = await orchestrator.executeCycle(symbol, normalizedId, config, accountBalance);
    const evalResult = results[0] || {
      strategyId: manifest.id,
      timestamp: Date.now(),
      confidenceScore: 50,
      hasSignal: false,
      metadata: { reasoning: ['Evaluation pending'] }
    };

    const snapshot = await dataEngine.getSnapshot(symbol, manifest.supportedTimeframes || ['5m']);
    const snapshotDto = AnalysisSnapshotMapper.map(evalResult, manifest, snapshot, 'ACTIVE', false);

    return c.json(snapshotDto);
  } catch (e: unknown) {
    const error = e as Error;
    const msg = error?.message || String(e);
    if (msg.includes('is not registered') || msg.includes('required') || msg.includes('Invalid symbol') || msg.includes('not available')) {
      c.status(400);
      return c.json({ error: "Error processing technical analysis", message: msg });
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
