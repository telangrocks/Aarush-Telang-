import { Context } from "hono";
import { Env } from "../index";
import { encrypt } from "../crypto";
import { getExchangeAdapter, ExchangeName } from "../exchanges";
import { analyzeMarket } from "../market-analysis";

export async function handleValidateExchange(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const { exchangeName, apiKey, apiSecret } = await c.req.json<{
      exchangeName: ExchangeName;
      apiKey: string;
      apiSecret: string;
    }>();

    if (!exchangeName || !apiKey || !apiSecret) {
      c.status(400);
      return c.json({ error: "exchangeName, apiKey, and apiSecret are required" });
    }

    const adapter = getExchangeAdapter(exchangeName);
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

    const { exchangeName, apiKey, apiSecret } = await c.req.json<{
      exchangeName: ExchangeName;
      apiKey: string;
      apiSecret: string;
    }>();

    if (!exchangeName || !apiKey || !apiSecret) {
      c.status(400);
      return c.json({ error: "exchangeName, apiKey, and apiSecret are required" });
    }

    const adapter = getExchangeAdapter(exchangeName);
    const validation = await adapter.validateCredentials(apiKey, apiSecret);
    if (!validation.success) {
      c.status(401);
      return c.json(validation);
    }

    const encryptedSecret = await encrypt(apiSecret, c.env.ENCRYPTION_KEY);

    await c.env.DB.prepare(
      `UPDATE users SET exchange_name = ?, exchange_api_key = ?, exchange_api_secret_iv = ?, exchange_api_secret_encrypted = ? WHERE id = ?`,
    )
      .bind(exchangeName, apiKey, encryptedSecret.iv, encryptedSecret.encrypted, userId)
      .run();

    return c.json({ success: true, message: "Exchange connected successfully", exchangeName });
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ success: false, message: error.message || "Failed to connect exchange" });
  }
}

export async function handleGetPersonalizedMarketCandidates(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string };
    const userId = payload.sub;

    const user = await c.env.DB.prepare(
      "SELECT exchange_name, exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted FROM users WHERE id = ?",
    )
      .bind(userId)
      .first<{
        exchange_name: string | null;
        exchange_api_key: string | null;
        exchange_api_secret_iv: string | null;
        exchange_api_secret_encrypted: string | null;
      }>();

    if (!user?.exchange_name || !user?.exchange_api_key || !user?.exchange_api_secret_encrypted) {
      c.status(400);
      return c.json({ error: "No exchange connected. Please connect an exchange first." });
    }

    const adapter = getExchangeAdapter(user.exchange_name as ExchangeName);
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
