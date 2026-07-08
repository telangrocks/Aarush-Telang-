// src/services/email.ts

/**
 * Sends a One-Time Password (OTP) to a user's email address using the Resend API.
 *
 * `from` should be a verified sender such as:
 * `CryptoPulse <auth@yourdomain.com>`.
 */
export async function sendOtpEmail(
  apiKey: string | undefined,
  from: string | undefined,
  email: string,
  otp: string,
): Promise<Response> {
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("RESEND_API_KEY is missing or invalid");
  }

  if (
    !from ||
    typeof from !== "string" ||
    from.includes("yourdomain.com") ||
    from.trim().length === 0
  ) {
    throw new Error("RESEND_FROM_EMAIL is missing or invalid");
  }

  const subject = "Your CryptoPulse Verification Code";
  const html = `
    <h1>Welcome to CryptoPulse!</h1>
    <p>Your verification code is: <strong>${otp}</strong></p>
    <p>This code will expire in 10 minutes.</p>
    <p>If you did not request this, you can safely ignore this email.</p>
  `;

  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [email], subject, html }),
  });
}
