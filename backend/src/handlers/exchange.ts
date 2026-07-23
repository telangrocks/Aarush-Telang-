import { Context } from "hono";
import { Env } from "../index";
import { encrypt, decrypt } from "../crypto";
import { getExchangeAdapter, ExchangeName, ExchangeEnvironment, ExchangeRegion } from "../exchanges";
import { FRIENDLY_MESSAGES, type ExchangeErrorCode } from "../exchanges/errors";
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
 * Anything other than the explicit string "testnet" falls back to "mainnet"
 * so that the default behaviour is always the safe, well-defined production
 * endpoint unless testnet is explicitly requested.
 */
function normalizeEnvironment(value: unknown): ExchangeEnvironment {
  return value === "testnet" ? "testnet" : "mainnet";
}

/**
 * Normalize an untrusted region value into a valid ExchangeRegion. Anything
 * other than "global" or "india" falls back to "india" so that Delta Exchange
 * India accounts reach the India domain (api.india.delta.exchange) by default
 * instead of the geo-blocked global endpoint.
 */
function normalizeRegion(value: unknown): ExchangeRegion {
  return value === "global" || value === "india" ? value : "india";
}

/**
 * Shape an adapter ValidationResult into the response the app consumes.
 *
 * The user-facing payload (`message`, `code`, `hint`) is plain-language and
 * actionable. The raw/technical adapter `message` is logged server-side via
 * `logTechnical` and is never sent to the client.
 */
function shapeValidation(
  result: { success: boolean; message: string; code?: string; friendlyMessage?: string },
  exchangeName: string,
  logTechnical: (detail: string) => void,
) {
  if (result.success) {
    return { success: true as const, message: "Credentials verified. You're all set." };
  }

  logTechnical(`[exchange-auth] ${exchangeName}: ${result.message}`);

  const code = (result.code as ExchangeErrorCode) ?? "UNKNOWN_EXCHANGE_ERROR";
  const info = FRIENDLY_MESSAGES[code] ?? FRIENDLY_MESSAGES.UNKNOWN_EXCHANGE_ERROR;
  return {
    success: false as const,
    code,
    message: result.friendlyMessage || info.friendlyMessage,
    hint: info.hint,
  };
}

export async function handleValidateExchange(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { exchangeName, apiKey, apiSecret, environment, region } = await c.req.json<{
      exchangeName: ExchangeName;
      apiKey: string;
      apiSecret: string;
      environment?: ExchangeEnvironment;
      region?: ExchangeRegion;
    }>();

    if (!exchangeName || !apiKey || !apiSecret) {
      c.status(400);
      return c.json({
        success: false,
        code: "MISSING_REQUIRED_CREDENTIALS" as ExchangeErrorCode,
        message: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.friendlyMessage,
        hint: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.hint,
      });
    }

    const resolvedRegion = normalizeRegion(region);
    const adapter = getExchangeAdapter(exchangeName, normalizeEnvironment(environment), resolvedRegion);
    const result = await adapter.validateCredentials(apiKey, apiSecret);

    return c.json(shapeValidation(result, exchangeName, (d) => console.error(d)));
  } catch (e: unknown) {
    const error = e as Error;
    console.error(`[exchange-auth] validate exception: ${error?.stack || error?.message || e}`);
    c.status(400);
    return c.json({
      success: false,
      code: "UNKNOWN_EXCHANGE_ERROR" as ExchangeErrorCode,
      message: FRIENDLY_MESSAGES.UNKNOWN_EXCHANGE_ERROR.friendlyMessage,
      hint: FRIENDLY_MESSAGES.UNKNOWN_EXCHANGE_ERROR.hint,
    });
  }
}

export async function handleConnectExchange(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const { exchangeName, apiKey, apiSecret, environment, region } = await c.req.json<{
      exchangeName: ExchangeName;
      apiKey: string;
      apiSecret: string;
      environment?: ExchangeEnvironment;
      region?: ExchangeRegion;
    }>();

    if (!exchangeName || !apiKey || !apiSecret) {
      c.status(400);
      return c.json({
        success: false,
        code: "MISSING_REQUIRED_CREDENTIALS" as ExchangeErrorCode,
        message: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.friendlyMessage,
        hint: FRIENDLY_MESSAGES.MISSING_REQUIRED_CREDENTIALS.hint,
      });
    }

    const resolvedEnvironment = normalizeEnvironment(environment);
    const resolvedRegion = normalizeRegion(region);
    const adapter = getExchangeAdapter(exchangeName, resolvedEnvironment, resolvedRegion);
    const validation = await adapter.validateCredentials(apiKey, apiSecret);
    if (!validation.success) {
      c.status(401);
      return c.json(shapeValidation(validation, exchangeName, (d) => console.error(d)));
    }

    const encryptedSecret = await encrypt(apiSecret, c.env.ENCRYPTION_KEY);

    await c.env.DB.prepare(
      `UPDATE users SET exchange_name = ?, exchange_environment = ?, exchange_region = ?, exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ? WHERE id = ?`,
    )
      .bind(exchangeName, resolvedEnvironment, resolvedRegion, apiKey, encryptedSecret.iv, encryptedSecret.encrypted, userId)
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
    const error = e as Error;
    console.error(`[exchange-auth] connect exception: ${error?.stack || error?.message || e}`);
    c.status(500);
    return c.json({
      success: false,
      code: "UNKNOWN_EXCHANGE_ERROR" as ExchangeErrorCode,
      message: FRIENDLY_MESSAGES.UNKNOWN_EXCHANGE_ERROR.friendlyMessage,
      hint: FRIENDLY_MESSAGES.UNKNOWN_EXCHANGE_ERROR.hint,
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

    if (!user?.exchange_name || !user?.exchange_api_key || !user?.exchange_api_secret_encrypted || !user?.exchange_api_secret_iv) {
      return c.json({
        success: false,
        code: "NO_EXCHANGE_CONNECTED",
        message: "No exchange account is connected.",
        hint: "Connect your Binance, Bybit, or Delta Exchange account in settings.",
      });
    }

    const decryptedSecret = await decrypt(
      { iv: user.exchange_api_secret_iv, encrypted: user.exchange_api_secret_encrypted },
      c.env.ENCRYPTION_KEY,
    );

    const environment = normalizeEnvironment(user.exchange_environment);
    const region = normalizeRegion(user.exchange_region);
    const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, environment, region);

    if (!adapter.fetchBalances) {
      return c.json({
        success: false,
        exchange: user.exchange_name,
        environment,
        primaryAsset: "USDT",
        code: "EXCHANGE_UNAVAILABLE",
        message: `Exchange adapter for ${user.exchange_name} does not support fetching balances.`,
      });
    }

    const balanceRes = await adapter.fetchBalances(user.exchange_api_key, decryptedSecret);
    return c.json(balanceRes);
  } catch (e: unknown) {
    const error = e as Error;
    console.error(`[exchange-balance] exception: ${error?.stack || error?.message || e}`);
    return c.json({
      success: false,
      code: "UNKNOWN_EXCHANGE_ERROR",
      message: FRIENDLY_MESSAGES.UNKNOWN_EXCHANGE_ERROR.friendlyMessage,
      hint: FRIENDLY_MESSAGES.UNKNOWN_EXCHANGE_ERROR.hint,
    });
  }
}

export async function handleGetPersonalizedMarketCandidates(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
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

    const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));
    const tickers = await adapter.fetchMarketData();

    if (!tickers.length) {
      c.status(500);
      return c.json({ error: "Failed to fetch market data from exchange" });
    }

    const candidates = await analyzeMarket(tickers, adapter);

    return c.json(candidates);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Error processing market data", message: error.message });
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

    const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));
    const ticker = await adapter.fetchTicker(symbol);

    if (!ticker) {
      c.status(404);
      return c.json({ error: `Symbol '${symbol}' is not available on your connected exchange.` });
    }

    return c.json({
      symbol: ticker.symbol,
      price: ticker.price,
      volume24h: ticker.volume24h,
      quoteVolume24h: ticker.quoteVolume24h,
      priceChange24h: ticker.priceChange24h,
      priceChangePercent24h: ticker.priceChangePercent24h,
      highPrice24h: ticker.highPrice24h,
      lowPrice24h: ticker.lowPrice24h,
      minNotional: ticker.minNotional,
      minOrderQty: ticker.minOrderQty,
      maxOrderQty: ticker.maxOrderQty,
      tickSize: ticker.tickSize,
      lotSize: ticker.lotSize,
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

    const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));
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

    const adapter = getExchangeAdapter(user.exchange_name as ExchangeName, normalizeEnvironment(user.exchange_environment), normalizeRegion(user.exchange_region));
    const ticker = await adapter.fetchTicker(symbol);

    if (!ticker) {
      c.status(404);
      return c.json({ error: `Symbol '${symbol}' is not available on your connected exchange.` });
    }

    const price = ticker.price || 0;
    const change24h = ticker.priceChangePercent24h || 0;
    const volume = ticker.volume24h || 0;
    const high24h = ticker.highPrice24h || price * 1.02;
    const low24h = ticker.lowPrice24h || price * 0.98;

    const klines = await adapter.fetchKlines(symbol, "1h", 100);
    const closes = klines.map((k: Kline) => k.close);
    const highs = klines.map((k: Kline) => k.high);
    const lows = klines.map((k: Kline) => k.low);
    const indicators: IndicatorSet = computeIndicators(closes);
    const atr = calculateAtr(highs, lows, closes, 14);
    const metrics: Metrics = toMetrics(ticker);
    const evaluation: StrategyEvaluation = evaluateStrategy(ticker, indicators, strategy, atr, 10.0, ticker.minNotional || 10);

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
    const error = e as Error;
    console.error(`[trading-bot] activate exception: ${error?.stack || error?.message || e}`);
    c.status(500);
    return c.json({
      success: false,
      code: "UNKNOWN_EXCHANGE_ERROR" as ExchangeErrorCode,
      message: "We couldn't start the trading bot right now.",
      hint: "Please try again in a moment. If this keeps happening, check your exchange connection.",
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
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to execute trade" });
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
