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
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h1 style="color: #00b4ff; text-align: center;">CryptoPulse</h1>
      <h2 style="text-align: center;">Verify Your Email Address</h2>
      <p>Thank you for registering with CryptoPulse. To complete your registration, please verify your email address by clicking the button below:</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verificationLink}" style="background-color: #00b4ff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">Verify Email</a>
      </div>
      <p>Or copy and paste this link into your browser:</p>
      <p style="word-break: break-all; color: #666;">${verificationLink}</p>
      <p style="color: #666; font-size: 14px; margin-top: 30px;">This link will expire in 24 hours. If you did not create an account with CryptoPulse, please ignore this email.</p>
    </div>
  `;

  return { subject, html };
}
