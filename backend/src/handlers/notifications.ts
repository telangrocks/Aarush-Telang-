import { Context } from "hono";
import { Env } from "../index";

export interface FcmTokenPayload {
  fcmToken: string;
}

export async function handleRegisterFcmToken(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  try {
    const payload = c.get("jwtPayload") as { sub: string } | undefined;
    const userId = payload?.sub;

    if (!userId) {
      c.status(401);
      return c.json({ error: "Unauthorized" });
    }

    const { fcmToken } = await c.req.json<FcmTokenPayload>();

    if (!fcmToken || typeof fcmToken !== "string") {
      c.status(400);
      return c.json({ error: "fcmToken is required" });
    }

    await c.env.DB.prepare(
      "UPDATE users SET fcm_token = ? WHERE id = ?",
    )
      .bind(fcmToken, userId)
      .run();

    return c.json({ success: true, message: "FCM token registered" });
  } catch (e: unknown) {
    const error = e as Error;
    c.status(500);
    return c.json({ error: "Failed to register FCM token", message: error.message });
  }
}

export async function sendPriceAlertNotification(
  env: Env,
  userId: string,
  alert: {
    tokenId: string;
    targetPrice: number;
    condition: "ABOVE" | "BELOW";
    currentPrice: number;
  },
): Promise<void> {
  if (!env.FCM_SERVER_KEY) {
    return;
  }

  const user = await env.DB.prepare(
    "SELECT fcm_token FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ fcm_token: string | null }>();

  const fcmToken = user?.fcm_token;
  if (!fcmToken) {
    return;
  }

  const title = "Price Alert Triggered";
  const body = `${alert.tokenId} is now ${alert.condition === "ABOVE" ? "above" : "below"} $${alert.targetPrice.toFixed(2)} (current: $${alert.currentPrice.toFixed(2)})`;

  try {
    await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        Authorization: `key=${env.FCM_SERVER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: fcmToken,
        notification: {
          title,
          body,
          sound: "default",
          priority: "high",
        },
        data: {
          type: "price_alert",
          tokenId: alert.tokenId,
          targetPrice: alert.targetPrice.toString(),
          condition: alert.condition,
          currentPrice: alert.currentPrice.toString(),
        },
      }),
    });
  } catch (error) {
    console.error("FCM price alert notification failed:", error);
  }
}

export async function sendTradeNotification(
  env: Env,
  userId: string,
  opportunity: {
    symbol: string;
    side: "BUY" | "SELL";
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    estimatedPnl: number;
    strategy: string;
  },
): Promise<void> {
  if (!env.FCM_SERVER_KEY) {
    return;
  }

  const user = await env.DB.prepare(
    "SELECT fcm_token FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ fcm_token: string | null }>();

  const fcmToken = user?.fcm_token;
  if (!fcmToken) {
    return;
  }

  const title = "Trade Detected";
  const body = `${opportunity.side} ${opportunity.symbol} | ${opportunity.strategy} | Entry: ${opportunity.entryPrice.toFixed(2)}`;

  try {
    await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        Authorization: `key=${env.FCM_SERVER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: fcmToken,
        notification: {
          title,
          body,
          sound: "default",
          priority: "high",
        },
        data: {
          type: "trade_alert",
          symbol: opportunity.symbol,
          side: opportunity.side,
          strategy: opportunity.strategy,
          entryPrice: opportunity.entryPrice.toString(),
          stopLoss: opportunity.stopLoss.toString(),
          takeProfit: opportunity.takeProfit.toString(),
          estimatedPnl: opportunity.estimatedPnl.toString(),
        },
      }),
    });
  } catch (error) {
    console.error("FCM notification failed:", error);
  }
}
