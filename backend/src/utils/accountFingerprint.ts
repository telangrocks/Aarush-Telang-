// src/utils/accountFingerprint.ts

export async function computeAccountFingerprint(params: {
  userId: string;
  exchangeName: string;
  environment?: string | null;
  accountIdentifier?: string | null;
  serverSecret?: string | null;
}): Promise<string> {
  const enc = new TextEncoder();
  const secret = params.serverSecret || "cryptopulse_account_binding_server_secret_default";
  const canonicalExchange = (params.exchangeName || "").toLowerCase().trim();
  const canonicalEnv = (params.environment || "mainnet").toLowerCase().trim();
  const rawId = (params.accountIdentifier || "").trim();

  // Hash raw account credential identifier with SHA-256 so raw keys are never in plaintext HMAC input
  const identifierHash = rawId
    ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rawId))))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    : "NO_CREDENTIALS";

  const message = `${params.userId}:${canonicalExchange}:${canonicalEnv}:${identifierHash}`;

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", hmacKey, enc.encode(message));
  const hex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `fp_${hex.substring(0, 32)}`;
}
