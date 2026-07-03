// src/services/email.ts

/**
 * Sends a One-Time Password (OTP) to a user's email address using the Resend API.
 * @param apiKey The Resend API key.
 * @param email The recipient's email address.
 * @param otp The 6-digit OTP to send.
 * @returns The response from the fetch call to the Resend API.
 */
export async function sendOtpEmail(apiKey: string, email: string, otp: string): Promise<Response> {
  const from = 'CryptoPulse <onboarding@yourdomain.com>'; // Replace with your verified Resend domain
  const subject = 'Your CryptoPulse Verification Code';
  const html = `
    <h1>Welcome to CryptoPulse!</h1>
    <p>Your verification code is: <strong>${otp}</strong></p>
    <p>This code will expire in 10 minutes.</p>
  `;

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [email], subject, html }),
  });
}