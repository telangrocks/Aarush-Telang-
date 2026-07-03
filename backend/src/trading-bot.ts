import { Env } from './index';
import { decrypt } from './utils/crypto';

export class TradingBot {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // Handle HTTP requests from the main Worker.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/activate': {
        const { userId, coinId, strategy } = await request.json<{ userId: string; coinId: string; strategy: string }>();
        await this.state.storage.put('isActive', true);
        await this.state.storage.put('coinId', coinId);
        await this.state.storage.put('strategy', strategy);
        await this.state.storage.put('userId', userId); // Store the userId
        // In a real scenario, you would start a continuous monitoring loop here,
        // possibly using alarms.
        return new Response(JSON.stringify({ success: true, message: 'Bot activated.' }), { status: 200 });
      }
      case '/deactivate': {
        await this.state.storage.put('isActive', false);
        // In a real scenario, you would stop the monitoring loop/alarms.
        return new Response(JSON.stringify({ success: true, message: 'Bot deactivated.' }), { status: 200 });
      }
      case '/execute-trade': {
        const userId: string | undefined = await this.state.storage.get('userId');
        if (!userId) {
          return new Response(JSON.stringify({ error: 'Bot not properly initialized with a user.' }), { status: 500 });
        }

        // STEP 1: Securely fetch user's encrypted API keys from D1.
        const userKeys = await this.env.DB.prepare(
          'SELECT exchange_api_key, exchange_api_secret_iv, exchange_api_secret_encrypted FROM users WHERE id = ?'
        ).bind(userId).first<{ exchange_api_key: string; exchange_api_secret_iv: string; exchange_api_secret_encrypted: string }>();

        if (!userKeys?.exchange_api_key || !userKeys?.exchange_api_secret_encrypted) {
          return new Response(JSON.stringify({ error: 'User has not configured their exchange API keys.' }), { status: 400 });
        }

        const decryptedSecret = await decrypt({ iv: userKeys.exchange_api_secret_iv, encrypted: userKeys.exchange_api_secret_encrypted }, this.env.ENCRYPTION_KEY);

        // STEP 2: Initialize exchange library (e.g., ccxt).
        // const exchange = new ccxt.binance({ apiKey: userKeys.exchange_api_key, secret: decryptedSecret });

        // STEP 3: Place the market order.
        // const coinId = await this.state.storage.get('coinId');
        // const order = await exchange.createMarketBuyOrder(coinId, amount);

        await this.state.storage.put('tradeActive', true);
        await this.state.storage.put('tradeEntryTimestamp', new Date().toISOString());
        console.log(`Executing trade for coin: ${await this.state.storage.get('coinId')}`);

        return new Response(JSON.stringify({ success: true, message: 'Trade executed.' }), { status: 200 });
      }
      case '/stop-trade': {
        // Similar to /execute-trade, you would fetch keys, decrypt,
        // initialize the exchange library, and then close the position.
        // await exchange.createMarketSellOrder(...)

        await this.state.storage.put('tradeActive', false);
        console.log(`Manually stopping trade for coin: ${await this.state.storage.get('coinId')}`);
        return new Response(JSON.stringify({ success: true, message: 'Trade stopped.' }), { status: 200 });
      }
      case '/status': {
        const isActive = (await this.state.storage.get('isActive')) || false;
        const coinId = (await this.state.storage.get('coinId')) || null;
        const strategy = (await this.state.storage.get('strategy')) || null;
        return new Response(JSON.stringify({ isActive, coinId, strategy }), { status: 200 });
      }
      default:
        return new Response('Not found', { status: 404 });
    }
  }
}