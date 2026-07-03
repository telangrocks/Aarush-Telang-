// src/handlers/notification.ts

interface AlertDetails {
  tokenId: string;
  targetPrice: number;
  condition: 'ABOVE' | 'BELOW';
  currentPrice: number;
}

export async function sendPriceAlertEmail(userEmail: string, alert: AlertDetails, apiKey: string): Promise<Response> {
  const subject = `CryptoPulse Alert: ${alert.tokenId.toUpperCase()} has passed your target price!`;
  const body = `
    <p>Hello,</p>
    <p>This is an alert from CryptoPulse. Your price target for <strong>${alert.tokenId.toUpperCase()}</strong> has been reached.</p>
    <ul>
      <li><strong>Condition:</strong> Price to go ${alert.condition.toLowerCase()} $${alert.targetPrice.toFixed(2)}</li>
      <li><strong>Current Price:</strong> $${alert.currentPrice.toFixed(2)}</li>
    </ul>
    <p>You can now log in to review your portfolio.</p>
    <p>Thank you for using CryptoPulse.</p>
  `;

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'CryptoPulse <noreply@yourdomain.com>', to: [userEmail], subject, html: body }),
  });
}