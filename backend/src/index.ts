import { Hono } from 'hono';

type Bindings = {
  ENVIRONMENT: string;
  API_TIMEOUT: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT,
  });
});

// Root endpoint
app.get('/', (c) => {
  return c.json({
    name: 'Crypto Pulse Backend',
    version: '1.0.0',
    status: 'running',
    environment: c.env.ENVIRONMENT,
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json(
    {
      error: 'Internal Server Error',
      message: err.message,
    },
    500
  );
});

export default app;
