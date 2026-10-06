import { Context } from "hono";
import { Env } from "../index";
import { BackendDiagnosticSink } from "../telemetry/BackendDiagnosticSink";

export interface FcmTokenPayload {
  fcmToken: string;
}

// Global cache for OAuth2 access token
let cachedAccessToken: string | null = null;
let cachedExpiry = 0;

function pemToDer(pem: string): Uint8Array {
  const pemHeader = "-----BEGIN PRIVATE KEY-----";
  const pemFooter = "-----END PRIVATE KEY-----";
  const pemContents = pem
    .replace(pemHeader, "")
    .replace(pemFooter, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const binary = atob(pemContents);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

function base64url(arr: Uint8Array | string): string {
  const str = typeof arr === "string" ? arr : String.fromCharCode(...arr);
  return btoa(str)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function generateGoogleAccessToken(
  clientEmail: string,
  privateKeyPem: string,
): Promise<string> {
  // Check memory cache (reuse token if valid for >60 seconds)
  if (cachedAccessToken && Date.now() < cachedExpiry - 60000) {
    return cachedAccessToken;
  }

  const key = await importPrivateKey(privateKeyPem);
  
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600; // 1 hour token validity
  const claim = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp,
    iat,
  };

  const headerEncoded = base64url(JSON.stringify(header));
  const claimEncoded = base64url(JSON.stringify(claim));
  const signatureInput = `${headerEncoded}.${claimEncoded}`;
  
  const encoder = new TextEncoder();
  const signatureInputBytes = encoder.encode(signatureInput);
  
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    signatureInputBytes,
  );
  
  const signatureEncoded = base64url(new Uint8Array(signature));
  const assertion = `${signatureInput}.${signatureEncoded}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google token exchange failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as { access_token: string; expires_in?: number };
  cachedAccessToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;

  return cachedAccessToken;
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


export async function sendTradeNotification(
  env: Env,
  userId: string,
  alertId: string,
  opportunity: {
    symbol: string;
    side: "BUY" | "SELL";
    entryPrice: number;
    targetEntryPrice?: number;
    signalPrice?: number;
    stopLoss: number;
    takeProfit: number;
    estimatedPnl: number;
    positionSize?: number;
    strategy: string;
    timeframe?: string;
    timestamp?: string;
    confidenceScore?: number;
    reasoning?: string[];
  },
  sink?: BackendDiagnosticSink,
): Promise<void> {
  const startMs = Date.now();
  const user = await env.DB.prepare(
    "SELECT fcm_token FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ fcm_token: string | null }>();

  const fcmToken = user?.fcm_token;
  if (!fcmToken) {
    sink?.emit({
      userId,
      category: "NOTIFICATION",
      component: "notifications",
      eventName: "FCM_DISPATCH_RESULT",
      severity: "WARN",
      correlationId: alertId,
      symbol: opportunity.symbol,
      strategyId: opportunity.strategy,
      durationMs: 0,
      payload: {
        alertId,
        success: false,
        transport: "fcm_v1",
        httpStatus: 0,
        errorCode: "MISSING_FCM_TOKEN",
      }
    });
    return;
  }

  const title = `Trade Signal: ${opportunity.side} ${opportunity.symbol}`;
  const body = `${opportunity.side} ${opportunity.symbol} | Strategy: ${opportunity.strategy} | Entry: $${opportunity.entryPrice.toFixed(4)} | SL: $${opportunity.stopLoss.toFixed(4)} | TP: $${opportunity.takeProfit.toFixed(4)}`;

  const dataPayload: Record<string, string> = {
    type: "TRADE_ALERT",
    alertType: "TRADE_ALERT",
    id: alertId,
    alertId: alertId,
    extra_alert: "true",
    symbol: opportunity.symbol,
    side: opportunity.side,
    strategy: opportunity.strategy,
    entryPrice: opportunity.entryPrice.toString(),
    stopLoss: opportunity.stopLoss.toString(),
    takeProfit: opportunity.takeProfit.toString(),
    estimatedPnl: opportunity.estimatedPnl.toString(),
    serverTimestamp: (opportunity.timestamp ? new Date(opportunity.timestamp).getTime() : Date.now()).toString(),
  };
  if (opportunity.timeframe) {
    dataPayload.timeframe = opportunity.timeframe;
  }
  if (opportunity.targetEntryPrice != null) {
    dataPayload.targetEntryPrice = opportunity.targetEntryPrice.toString();
  }
  if (opportunity.signalPrice != null) {
    dataPayload.signalPrice = opportunity.signalPrice.toString();
  }
  if (opportunity.positionSize != null) {
    dataPayload.positionSize = opportunity.positionSize.toString();
  }
  if (opportunity.confidenceScore != null) {
    dataPayload.confidenceScore = opportunity.confidenceScore.toString();
  }
  if (opportunity.reasoning && opportunity.reasoning.length > 0) {
    dataPayload.reasoning = JSON.stringify(opportunity.reasoning);
  }

  // 1. Try FCM v1 HTTP API if keys are provided
  if (env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY) {
    try {
      const accessToken = await generateGoogleAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY);
      
      const payload = {
        message: {
          token: fcmToken,
          notification: {
            title,
            body,
          },
          data: dataPayload,
          android: {
            notification: {
              sound: "default",
              channel_id: "trading_bot_channel",
            },
            priority: "high",
          },
        },
      };

      const response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const durationMs = Date.now() - startMs;
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`FCM v1 trade notification send failed: ${response.status} ${errorText}`);
        sink?.emit({
          userId,
          category: "NOTIFICATION",
          component: "notifications",
          eventName: "FCM_DISPATCH_RESULT",
          severity: "ERROR",
          correlationId: alertId,
          symbol: opportunity.symbol,
          strategyId: opportunity.strategy,
          durationMs,
          payload: {
            alertId,
            success: false,
            transport: "fcm_v1",
            httpStatus: response.status,
            errorCode: "HTTP_ERROR"
          }
        });
      } else {
        console.log(`FCM v1 trade notification sent successfully to user ${userId}`);
        sink?.emit({
          userId,
          category: "NOTIFICATION",
          component: "notifications",
          eventName: "FCM_DISPATCH_RESULT",
          severity: "INFO",
          correlationId: alertId,
          symbol: opportunity.symbol,
          strategyId: opportunity.strategy,
          durationMs,
          payload: {
            alertId,
            success: true,
            transport: "fcm_v1",
            httpStatus: response.status,
            errorCode: null
          }
        });
      }
    } catch (err) {
      console.error("FCM v1 trade notification failed:", err);
      sink?.emit({
        userId,
        category: "NOTIFICATION",
        component: "notifications",
        eventName: "FCM_DISPATCH_RESULT",
        severity: "ERROR",
        correlationId: alertId,
        symbol: opportunity.symbol,
        strategyId: opportunity.strategy,
        durationMs: Date.now() - startMs,
        payload: {
          alertId,
          success: false,
          transport: "fcm_v1",
          httpStatus: 0,
          errorCode: "NETWORK_ERROR"
        }
      });
    }
    return;
  }

  // 2. Fallback to legacy FCM if legacy keys are configured
  if (env.FCM_SERVER_KEY) {
    try {
      const response = await fetch("https://fcm.googleapis.com/fcm/send", {
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
          data: dataPayload,
        }),
      });

      const durationMs = Date.now() - startMs;
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`FCM Legacy trade notification send failed: ${response.status} ${errorText}`);
        sink?.emit({
          userId,
          category: "NOTIFICATION",
          component: "notifications",
          eventName: "FCM_DISPATCH_RESULT",
          severity: "ERROR",
          correlationId: alertId,
          symbol: opportunity.symbol,
          strategyId: opportunity.strategy,
          durationMs,
          payload: {
            alertId,
            success: false,
            transport: "fcm_legacy",
            httpStatus: response.status,
            errorCode: "HTTP_ERROR"
          }
        });
      } else {
        sink?.emit({
          userId,
          category: "NOTIFICATION",
          component: "notifications",
          eventName: "FCM_DISPATCH_RESULT",
          severity: "INFO",
          correlationId: alertId,
          symbol: opportunity.symbol,
          strategyId: opportunity.strategy,
          durationMs,
          payload: {
            alertId,
            success: true,
            transport: "fcm_legacy",
            httpStatus: response.status,
            errorCode: null
          }
        });
      }
    } catch (error) {
      console.error("FCM Legacy notification failed:", error);
      sink?.emit({
        userId,
        category: "NOTIFICATION",
        component: "notifications",
        eventName: "FCM_DISPATCH_RESULT",
        severity: "ERROR",
        correlationId: alertId,
        symbol: opportunity.symbol,
        strategyId: opportunity.strategy,
        durationMs: Date.now() - startMs,
        payload: {
          alertId,
          success: false,
          transport: "fcm_legacy",
          httpStatus: 0,
          errorCode: "NETWORK_ERROR"
        }
      });
    }
    return;
  }

  console.warn("FCM notification skipped: neither FCM v1 nor FCM Legacy credentials configured.");
  sink?.emit({
    userId,
    category: "NOTIFICATION",
    component: "notifications",
    eventName: "FCM_DISPATCH_RESULT",
    severity: "WARN",
    correlationId: alertId,
    symbol: opportunity.symbol,
    strategyId: opportunity.strategy,
    durationMs: Date.now() - startMs,
    payload: {
      alertId,
      success: false,
      transport: "fcm_v1",
      httpStatus: 0,
      errorCode: "NO_FCM_CREDENTIALS"
    }
  });
}
