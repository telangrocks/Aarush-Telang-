import { Context } from "hono";
import { Env } from "../index";
import { encrypt } from "../crypto";
import { getExchangeAdapter, ExchangeName, ExchangeEnvironment, ExchangeRegion } from "../exchanges";
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
      return c.json({ error: "exchangeName, apiKey, and apiSecret are required" });
    }

    const resolvedRegion = normalizeRegion(region);
    const adapter = getExchangeAdapter(exchangeName, normalizeEnvironment(environment), resolvedRegion);
    const result = await adapter.validateCredentials(apiKey, apiSecret);

    return c.json(result);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(400);
    return c.json({ success: false, message: error.message || "Invalid exchange or parameters" });
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
      return c.json({ error: "exchangeName, apiKey, and apiSecret are required" });
    }

    const resolvedEnvironment = normalizeEnvironment(environment);
    const resolvedRegion = normalizeRegion(region);
    const adapter = getExchangeAdapter(exchangeName, resolvedEnvironment, resolvedRegion);
    const validation = await adapter.validateCredentials(apiKey, apiSecret);
    if (!validation.success) {
      c.status(401);
      return c.json(validation);
    }

    const encryptedSecret = await encrypt(apiSecret, c.env.ENCRYPTION_KEY);

    await c.env.DB.prepare(
      `UPDATE users SET exchange_name = ?, exchange_environment = ?, exchange_region = ?, exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ? WHERE id = ?`,
    )
      .bind(exchangeName, resolvedEnvironment, resolvedRegion, apiKey, encryptedSecret.iv, encryptedSecret.encrypted, userId)
      .run();

    return c.json({ success: true, message: "Exchange connected successfully", exchangeName, environment: resolvedEnvironment, region: resolvedRegion });
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to connect exchange" });
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

    const candidates = analyzeMarket(tickers);

    return c.json(candidates);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Error processing market data", message: error.message });
  }
}

export async function handleGetStrategies(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const strategies = [
    { id: "scalping", name: "Scalping", description: "Quick in-and-out trades capturing small price movements" },
    { id: "momentum", name: "Momentum Trading", description: "Ride strong price trends with volume confirmation" },
    { id: "breakout", name: "Breakout Strategy", description: "Enter on price breaks above resistance or below support" },
    { id: "mean_reversion", name: "Mean Reversion", description: "Trade price extremes expecting return to average" },
    { id: "vwap", name: "VWAP Strategy", description: "Trade around the Volume Weighted Average Price" },
  ];
  return c.json(strategies);
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

    const { symbol, strategy } = await c.req.json<{
      symbol: string;
      strategy: string;
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
    const evaluation: StrategyEvaluation = evaluateStrategy(ticker, indicators, strategy, atr, 100);

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
    const { coinId, strategy, positionSize } = await c.req.json<{ coinId: string; strategy: string; positionSize?: number }>();

    const botId = c.env.TRADING_BOTS.idFromName(userId);
    const bot = c.env.TRADING_BOTS.get(botId);

    const response = await bot.fetch(
      new Request("http://bot/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, coinId, strategy, positionSize }),
      }),
    );

    const data = await response.json<{ success: boolean; message: string }>();
    return c.json(data);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to activate trading bot" });
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
