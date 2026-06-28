// src/services/email.ts

/**
 * Sends a verification OTP to a user's email address using the Resend API.
 * @param apiKey The Resend API key.
 * @param email The recipient's email address.
 * @param otp The one-time password.
 * @returns The fetch Response object from the Resend API call.
 */
export async function sendOtpEmail(apiKey: string, email: string, otp: string): Promise<Response> {
  const resendUrl = 'https://api.resend.com/emails';

  const emailHtml = `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2>Welcome to CryptoPulse!</h2>
      <p>Your one-time verification code is:</p>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; margin: 20px 0;">${otp}</p>
      <p>This code will expire in 10 minutes.</p>
      <hr/>
      <p style="font-size: 12px; color: #888;">If you did not request this, you can safely ignore this email.</p>
    </div>
  `;

  return fetch(resendUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'onboarding@resend.dev', to: email, subject: 'Your CryptoPulse Verification Code', html: emailHtml }),
  });
}