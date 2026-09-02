import { Env } from "../index";

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(env: Env, options: SendEmailOptions): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
    throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL must be configured");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: options.to,
      subject: options.subject,
      html: options.html,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Resend API error: ${response.status} ${errorText}`);
  }
}

export function buildVerificationEmail(verificationLink: string): { subject: string; html: string } {
  const subject = "Verify your CryptoPulse account";
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px 24px; background-color: #050D1F; color: #E8F0FF; border-radius: 12px; border: 1px solid #1A3057;">
      <div style="text-align: center; margin-bottom: 24px;">
        <h1 style="color: #FFFFFF; font-size: 28px; margin: 0; letter-spacing: 2px;">CRYPTO<span style="color: #00B4FF;">PULSE</span></h1>
        <p style="color: #6A84A8; font-size: 11px; margin: 4px 0 0 0; letter-spacing: 1.5px; text-transform: uppercase;">Trade Smart. Stay Ahead.</p>
      </div>
      <h2 style="text-align: center; color: #E8F0FF; font-size: 20px; margin-bottom: 16px;">Verify Your Email Address</h2>
      <p style="color: #A0B4D0; font-size: 15px; line-height: 1.5; text-align: center;">Thank you for registering with CryptoPulse. To complete your registration, please verify your email address by clicking the button below:</p>
      <div style="text-align: center; margin: 32px 0;">
        <a href="${verificationLink}" style="background: linear-gradient(90deg, #1A6FFF, #7B2FE0); color: #FFFFFF; padding: 14px 36px; text-decoration: none; border-radius: 10px; font-weight: bold; font-size: 15px; display: inline-block; letter-spacing: 1px;">VERIFY EMAIL</a>
      </div>
      <p style="color: #6A84A8; font-size: 13px; text-align: center;">Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #00B4FF; font-size: 12px; text-align: center;">${verificationLink}</p>
      <p style="color: #3A5478; font-size: 12px; margin-top: 32px; text-align: center; border-top: 1px solid #1A3057; padding-top: 16px;">This link will expire in 24 hours. If you did not create an account with CryptoPulse, please ignore this email.</p>
    </div>
  `;

  return { subject, html };
}
