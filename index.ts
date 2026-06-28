// src/index.ts
import { Env } from './utils/types';
import { handleRegister, handleVerifyOtp } from './handlers/user';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === 'POST' && url.pathname === '/api/register') {
        return await handleRegister(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/verify-otp') {
        return await handleVerifyOtp(request, env);
      }
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};