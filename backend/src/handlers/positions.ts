import { Context } from "hono";
import { Env } from "../index";
import { getExchangeAdapter, ExchangeName, ExchangeEnvironment } from "../exchanges";

function normalizeEnvironment(value: unknown): ExchangeEnvironment {
  return value === "testnet" ? "testnet" : "mainnet";
}

export async function handleGetPositions(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;

    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const { results } = await c.env.DB.prepare(
      "SELECT * FROM trade_positions WHERE user_id = ? ORDER BY created_at DESC"
    )
      .bind(userId)
      .all();

    const positions = await Promise.all((results ?? []).map(async (position: any) => {
      let livePnl: number | null = null;
      let currentPrice: number | null = null;

      if (position.status === "OPEN") {
        try {
          const adapter = getExchangeAdapter(
            position.exchange as ExchangeName,
            normalizeEnvironment(position.environment)
          );
          const ticker = await adapter.fetchTicker(position.symbol);
          if (ticker) {
            currentPrice = ticker.price;
            const priceDiff = position.side === "BUY"
              ? currentPrice - position.entry_price
              : position.entry_price - currentPrice;
            livePnl = (priceDiff / position.entry_price) * position.quantity * position.entry_price;
          }
        } catch {
          // ignore live price fetch errors
        }
      }

      return {
        ...position,
        current_price: currentPrice,
        live_pnl: livePnl,
      };
    }));

    return c.json(positions);
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Failed to get positions", message: error.message });
  }
}

export async function handleClosePosition(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;

    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const positionId = c.req.param("id");

    if (!positionId) {
      c.status(400);
      return c.json({ error: "positionId is required" });
    }

    const position = await c.env.DB.prepare(
      "SELECT * FROM trade_positions WHERE id = ? AND user_id = ? AND status = 'OPEN'"
    )
      .bind(positionId, userId)
      .first<any>();

    if (!position) {
      c.status(404);
      return c.json({ error: "Open position not found" });
    }

    const adapter = getExchangeAdapter(
      position.exchange as ExchangeName,
      normalizeEnvironment(position.environment)
    );

    // Cancel exchange-native protection orders prior to manual market exit
    if (adapter.cancelOrder) {
      const userKeys = await c.env.DB.prepare(
        "SELECT exchange_api_key, exchange_api_secret_encrypted, exchange_api_secret_iv FROM users WHERE id = ?"
      ).bind(userId).first<any>();

      if (userKeys && userKeys.exchange_api_key) {
        const decryptedSecret = await decrypt(
          { iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted },
          c.env.ENCRYPTION_KEY
        ).catch(() => "");

        if (decryptedSecret) {
          const cancelTargets = [
            position.oco_group_id,
            position.tp_exchange_order_id,
            position.sl_exchange_order_id,
            position.entry_exchange_order_id
          ].filter(Boolean);

          for (const targetId of cancelTargets) {
            await adapter.cancelOrder(targetId, position.symbol, userKeys.exchange_api_key, decryptedSecret).catch(() => null);
          }
        }
      }
    }

    const ticker = await adapter.fetchTicker(position.symbol);

    const closePrice = ticker?.price ?? position.entry_price;
    const priceDiff = position.side === "BUY"
      ? closePrice - position.entry_price
      : position.entry_price - closePrice;
    const realizedPnl = (priceDiff / position.entry_price) * position.quantity * position.entry_price;
    const now = new Date().toISOString();

    await c.env.DB.prepare(
      "UPDATE trade_positions SET status = 'CLOSED', closed_at = ?, close_price = ?, realized_pnl = ?, close_reason = ?, updated_at = ? WHERE id = ?"
    )
      .bind(now, closePrice, realizedPnl, "manual", now, positionId)
      .run();

    return c.json({
      success: true,
      position: {
        ...position,
        status: "CLOSED",
        closed_at: now,
        close_price: closePrice,
        realized_pnl: realizedPnl,
        close_reason: "manual",
      },
    });
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Failed to close position", message: error.message });
  }
}
