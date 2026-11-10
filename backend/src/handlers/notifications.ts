import { Context } from "hono";
import { Env } from "../index";
import { BackendDiagnosticSink } from "../telemetry/BackendDiagnosticSink";

export type DispatchOutcome = 'SUCCESS' | 'PRE_DISPATCH_FAILURE' | 'EXPLICIT_REJECTION' | 'AMBIGUOUS';

export interface FcmDispatchResult {
  success: boolean;
  outcome: DispatchOutcome;
  httpStatus: number;
  errorCode?: string | null;
  error?: string;
}

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
  signal?: AbortSignal,
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
    ...(signal ? { signal } : {}),
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


export interface TradeFillNotificationPayload {
  alertId: string;
  orderId?: string | null;
  symbol: string;
  side: "BUY" | "SELL";
  entryPrice: number;
  targetEntryPrice?: number;
  signalPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  estimatedPnl?: number;
  positionSize?: number;
  strategy?: string;
  actionType?: "TRADE_SUBMITTED" | "TRADE_FILLED";
  timestamp?: string;
}

export async function sendTradeFillNotification(
  env: Env,
  userId: string,
  fillDetails: TradeFillNotificationPayload,
  sink?: BackendDiagnosticSink,
): Promise<void> {
  const startMs = Date.now();
  const user = await env.DB.prepare(
    "SELECT fcm_token FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ fcm_token: string | null }>();

  const fcmToken = user?.fcm_token;
  const alertId = fillDetails.alertId;
  const orderId = fillDetails.orderId || "";

  if (!fcmToken) {
    sink?.emit({
      userId,
      category: "NOTIFICATION",
      component: "notifications",
      eventName: "FCM_DISPATCH_RESULT",
      severity: "WARN",
      correlationId: alertId,
      symbol: fillDetails.symbol,
      strategyId: fillDetails.strategy,
      durationMs: 0,
      payload: {
        alertId,
        orderId,
        success: false,
        transport: "fcm_v1",
        httpStatus: 0,
        errorCode: "MISSING_FCM_TOKEN",
      }
    });
    return;
  }

  const isSubmitted = fillDetails.actionType === "TRADE_SUBMITTED";
  const title = isSubmitted
    ? `Order Submitted: ${fillDetails.side} ${fillDetails.symbol}`
    : `Order Filled: ${fillDetails.side} ${fillDetails.symbol}`;
  const body = isSubmitted
    ? `${fillDetails.side} ${fillDetails.symbol} order submitted at $${fillDetails.entryPrice.toFixed(4)}`
    : `${fillDetails.side} ${fillDetails.symbol} filled at $${fillDetails.entryPrice.toFixed(4)} | Strategy: ${fillDetails.strategy || 'Autonomous'}`;

  const eventType = isSubmitted ? "TRADE_SUBMITTED" : "TRADE_FILLED";

  const dataPayload: Record<string, string> = {
    type: eventType,
    alertType: eventType,
    id: alertId,
    alertId: alertId,
    orderId: orderId,
    exchangeOrderId: orderId,
    status: isSubmitted ? "submitted" : "filled",
    entryStatus: isSubmitted ? "SUBMITTED" : "FILLED",
    isTerminal: isSubmitted ? "false" : "true",
    extra_alert: "false",
    symbol: fillDetails.symbol,
    side: fillDetails.side,
    strategy: fillDetails.strategy || "",
    entryPrice: fillDetails.entryPrice.toString(),
    stopLoss: (fillDetails.stopLoss || 0).toString(),
    takeProfit: (fillDetails.takeProfit || 0).toString(),
    estimatedPnl: (fillDetails.estimatedPnl || 3.0).toString(),
    serverTimestamp: (fillDetails.timestamp ? new Date(fillDetails.timestamp).getTime() : Date.now()).toString(),
  };

  if (fillDetails.targetEntryPrice != null) {
    dataPayload.targetEntryPrice = fillDetails.targetEntryPrice.toString();
  }
  if (fillDetails.signalPrice != null) {
    dataPayload.signalPrice = fillDetails.signalPrice.toString();
  }
  if (fillDetails.positionSize != null) {
    dataPayload.positionSize = fillDetails.positionSize.toString();
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
              channel_id: "trading_bot_channel_v2",
            },
            priority: "normal",
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
        console.error(`FCM v1 fill notification send failed: ${response.status} ${errorText}`);
        sink?.emit({
          userId,
          category: "NOTIFICATION",
          component: "notifications",
          eventName: "FCM_DISPATCH_RESULT",
          severity: "ERROR",
          correlationId: alertId,
          symbol: fillDetails.symbol,
          strategyId: fillDetails.strategy,
          durationMs,
          payload: {
            alertId,
            orderId,
            success: false,
            transport: "fcm_v1",
            httpStatus: response.status,
            errorCode: "HTTP_ERROR"
          }
        });
      } else {
        console.log(`FCM v1 fill notification sent successfully to user ${userId}`);
        sink?.emit({
          userId,
          category: "NOTIFICATION",
          component: "notifications",
          eventName: "FCM_DISPATCH_RESULT",
          severity: "INFO",
          correlationId: alertId,
          symbol: fillDetails.symbol,
          strategyId: fillDetails.strategy,
          durationMs,
          payload: {
            alertId,
            orderId,
            success: true,
            transport: "fcm_v1",
            httpStatus: response.status,
            errorCode: null
          }
        });
      }
    } catch (err) {
      console.error("FCM v1 fill notification failed:", err);
      sink?.emit({
        userId,
        category: "NOTIFICATION",
        component: "notifications",
        eventName: "FCM_DISPATCH_RESULT",
        severity: "ERROR",
        correlationId: alertId,
        symbol: fillDetails.symbol,
        strategyId: fillDetails.strategy,
        durationMs: Date.now() - startMs,
        payload: {
          alertId,
          orderId,
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
            priority: "normal",
          },
          data: dataPayload,
        }),
      });

      const durationMs = Date.now() - startMs;
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`FCM Legacy fill notification send failed: ${response.status} ${errorText}`);
        sink?.emit({
          userId,
          category: "NOTIFICATION",
          component: "notifications",
          eventName: "FCM_DISPATCH_RESULT",
          severity: "ERROR",
          correlationId: alertId,
          symbol: fillDetails.symbol,
          strategyId: fillDetails.strategy,
          durationMs,
          payload: {
            alertId,
            orderId,
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
          symbol: fillDetails.symbol,
          strategyId: fillDetails.strategy,
          durationMs,
          payload: {
            alertId,
            orderId,
            success: true,
            transport: "fcm_legacy",
            httpStatus: response.status,
            errorCode: null
          }
        });
      }
    } catch (error) {
      console.error("FCM Legacy fill notification failed:", error);
      sink?.emit({
        userId,
        category: "NOTIFICATION",
        component: "notifications",
        eventName: "FCM_DISPATCH_RESULT",
        severity: "ERROR",
        correlationId: alertId,
        symbol: fillDetails.symbol,
        strategyId: fillDetails.strategy,
        durationMs: Date.now() - startMs,
        payload: {
          alertId,
          orderId,
          success: false,
          transport: "fcm_legacy",
          httpStatus: 0,
          errorCode: "NETWORK_ERROR"
        }
      });
    }
    return;
  }

  console.warn("FCM fill notification skipped: neither FCM v1 nor FCM Legacy credentials configured.");
  sink?.emit({
    userId,
    category: "NOTIFICATION",
    component: "notifications",
    eventName: "FCM_DISPATCH_RESULT",
    severity: "WARN",
    correlationId: alertId,
    symbol: fillDetails.symbol,
    strategyId: fillDetails.strategy,
    durationMs: 0,
    payload: {
      alertId,
      orderId,
      success: false,
      transport: "none",
      httpStatus: 0,
      errorCode: "NO_FCM_CREDENTIALS"
    }
  });
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
    estimatedPnl?: number;
    positionSize?: number;
    quantity?: number;
    isExecutable?: boolean;
    ineligibilityReason?: string;
    requestedBudget?: number;
    effectiveNotional?: number;
    strategy: string;
    timeframe?: string;
    timestamp?: string;
    confidenceScore?: number;
    reasoning?: string[];
    approvalGeneration?: number;
  },
  sink?: BackendDiagnosticSink,
  remainingTtlSec?: number,
  externalSignal?: AbortSignal,
): Promise<FcmDispatchResult> {
  const startMs = Date.now();
  const dispatchController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    dispatchController.abort("DISPATCH_TIMEOUT_EXCEEDED");
  }, 10_000);

  if (externalSignal) {
    if (externalSignal.aborted) {
      dispatchController.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener("abort", () => dispatchController.abort(externalSignal.reason));
    }
  }

  let endpointContacted = false;

  try {
    let fcmToken: string | null = null;
    try {
      const user = await env.DB.prepare(
        "SELECT fcm_token FROM users WHERE id = ?",
      )
        .bind(userId)
        .first<{ fcm_token: string | null }>();
      fcmToken = user?.fcm_token ?? null;
    } catch (dbErr: any) {
      clearTimeout(timeoutHandle);
      return {
        success: false,
        outcome: 'PRE_DISPATCH_FAILURE',
        httpStatus: 0,
        errorCode: 'DB_ERROR',
        error: dbErr?.message || 'Database query failed',
      };
    }

    if (!fcmToken) {
      clearTimeout(timeoutHandle);
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
      return {
        success: false,
        outcome: 'PRE_DISPATCH_FAILURE',
        httpStatus: 0,
        errorCode: 'MISSING_FCM_TOKEN',
        error: 'User has no registered FCM token',
      };
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
      serverTimestamp: (opportunity.timestamp ? new Date(opportunity.timestamp).getTime() : Date.now()).toString(),
    };
    if (opportunity.estimatedPnl != null && Number.isFinite(opportunity.estimatedPnl)) {
      dataPayload.estimatedPnl = opportunity.estimatedPnl.toString();
    }
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
    // Authoritative Executability & Quantity Serialization:
    let fcmIsExecutable = false;
    let fcmQuantity: string | undefined = undefined;

    if (opportunity.isExecutable === false) {
      // Explicit false: serialize false and omit quantity
      fcmIsExecutable = false;
    } else if (opportunity.isExecutable === true) {
      // Explicit true: serialize true ONLY when authoritative stored quantity is positive and finite
      if (typeof opportunity.quantity === 'number' && Number.isFinite(opportunity.quantity) && opportunity.quantity > 0) {
        fcmIsExecutable = true;
        fcmQuantity = opportunity.quantity.toString();
      } else {
        fcmIsExecutable = false;
      }
    } else {
      // Legacy undefined: derive executability from the positive finite quantity on the stored alert
      if (typeof opportunity.quantity === 'number' && Number.isFinite(opportunity.quantity) && opportunity.quantity > 0) {
        fcmIsExecutable = true;
        fcmQuantity = opportunity.quantity.toString();
      } else {
        fcmIsExecutable = false;
      }
    }

    dataPayload.isExecutable = fcmIsExecutable ? "true" : "false";
    if (fcmIsExecutable && fcmQuantity) {
      dataPayload.quantity = fcmQuantity;
    }
    if (!fcmIsExecutable && opportunity.ineligibilityReason) {
      dataPayload.ineligibilityReason = opportunity.ineligibilityReason;
    }
    if (opportunity.requestedBudget != null && Number.isFinite(opportunity.requestedBudget) && opportunity.requestedBudget > 0) {
      dataPayload.requestedBudget = opportunity.requestedBudget.toString();
    }
    if (opportunity.effectiveNotional != null && Number.isFinite(opportunity.effectiveNotional) && opportunity.effectiveNotional > 0) {
      dataPayload.effectiveNotional = opportunity.effectiveNotional.toString();
    }
    if (opportunity.confidenceScore != null) {
      dataPayload.confidenceScore = opportunity.confidenceScore.toString();
    }
    if (opportunity.reasoning && opportunity.reasoning.length > 0) {
      dataPayload.reasoning = JSON.stringify(opportunity.reasoning);
    }
    if (opportunity.approvalGeneration != null && Number.isFinite(opportunity.approvalGeneration)) {
      dataPayload.approvalGeneration = opportunity.approvalGeneration.toString();
    }

    const ttlString = remainingTtlSec != null && remainingTtlSec > 0 ? `${remainingTtlSec}s` : undefined;

    // 1. Try FCM v1 HTTP API if keys are provided
    if (env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY) {
      let accessToken: string;
      try {
        accessToken = await generateGoogleAccessToken(env.FCM_CLIENT_EMAIL, env.FCM_PRIVATE_KEY, dispatchController.signal);
      } catch (tokenErr: any) {
        clearTimeout(timeoutHandle);
        console.error("FCM v1 OAuth token generation failed:", tokenErr);
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
            errorCode: "OAUTH_TOKEN_ERROR",
          }
        });
        return {
          success: false,
          outcome: 'PRE_DISPATCH_FAILURE',
          httpStatus: 0,
          errorCode: 'OAUTH_TOKEN_ERROR',
          error: tokenErr?.message || 'OAuth token exchange failed',
        };
      }

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
              channel_id: "trading_bot_channel_v2",
            },
            priority: "high",
            ...(ttlString ? { ttl: ttlString } : {}),
          },
        },
      };

      try {
        endpointContacted = true;
        const response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
          signal: dispatchController.signal,
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
              errorCode: "HTTP_ERROR",
            }
          });

          if (response.status >= 400 && response.status < 500) {
            return {
              success: false,
              outcome: 'EXPLICIT_REJECTION',
              httpStatus: response.status,
              errorCode: `HTTP_${response.status}`,
              error: errorText,
            };
          } else {
            return {
              success: false,
              outcome: 'AMBIGUOUS',
              httpStatus: response.status,
              errorCode: `HTTP_${response.status}`,
              error: errorText,
            };
          }
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
              errorCode: null,
            }
          });
          return {
            success: true,
            outcome: 'SUCCESS',
            httpStatus: response.status,
            errorCode: null,
          };
        }
      } catch (fetchErr: any) {
        const durationMs = Date.now() - startMs;
        console.error("FCM v1 trade notification failed in flight:", fetchErr);
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
            httpStatus: 0,
            errorCode: "NETWORK_ERROR",
          }
        });
        return {
          success: false,
          outcome: 'AMBIGUOUS',
          httpStatus: 0,
          errorCode: 'NETWORK_TIMEOUT_OR_RESET',
          error: fetchErr?.message || 'Network error during FCM fetch',
        };
      }
    }

    // 2. Fallback to legacy FCM if legacy keys are configured
    if (env.FCM_SERVER_KEY) {
      try {
        endpointContacted = true;
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
              android_channel_id: "trading_bot_channel_v2",
            },
            data: dataPayload,
            ...(ttlString && remainingTtlSec ? { time_to_live: remainingTtlSec } : {}),
          }),
          signal: dispatchController.signal,
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
              errorCode: "HTTP_ERROR",
            }
          });

          if (response.status >= 400 && response.status < 500) {
            return {
              success: false,
              outcome: 'EXPLICIT_REJECTION',
              httpStatus: response.status,
              errorCode: `HTTP_${response.status}`,
              error: errorText,
            };
          } else {
            return {
              success: false,
              outcome: 'AMBIGUOUS',
              httpStatus: response.status,
              errorCode: `HTTP_${response.status}`,
              error: errorText,
            };
          }
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
              errorCode: null,
            }
          });
          return {
            success: true,
            outcome: 'SUCCESS',
            httpStatus: response.status,
            errorCode: null,
          };
        }
      } catch (error: any) {
        console.error("FCM Legacy notification failed in flight:", error);
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
            errorCode: "NETWORK_ERROR",
          }
        });
        return {
          success: false,
          outcome: 'AMBIGUOUS',
          httpStatus: 0,
          errorCode: 'NETWORK_TIMEOUT_OR_RESET',
          error: error?.message || 'Network error during legacy FCM fetch',
        };
      }
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
        errorCode: "NO_FCM_CREDENTIALS",
      }
    });
    return {
      success: false,
      outcome: 'PRE_DISPATCH_FAILURE',
      httpStatus: 0,
      errorCode: 'NO_FCM_CREDENTIALS',
      error: 'Neither FCM v1 nor FCM Legacy credentials configured',
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
}
