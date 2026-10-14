import { Hono } from 'hono';
import type { Deps } from './deps.js';
import { oauthRoutes } from './oauth/routes.js';
import { internalRoutes } from './internal/routes.js';
import { requireBearer, type AuthEnv } from './mcp/auth.js';
import { VERSION } from './version.js';

export function createApp(deps: Deps, mcpHandler?: (deps: Deps) => Hono<AuthEnv>): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true, version: VERSION, keysLoaded: Boolean(deps.keys) }));
  app.route('/', oauthRoutes(deps));
  app.route('/internal', internalRoutes(deps));

  const mcp = new Hono<AuthEnv>();
  mcp.use('*', requireBearer(deps));
  if (mcpHandler) mcp.route('/', mcpHandler(deps));
  else mcp.all('/', (c) => c.json({ error: 'mcp_not_mounted' }, 503));
  app.route('/mcp', mcp);

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    deps.log.error({ err }, 'unhandled error');
    return c.json({ error: 'server_error' }, 500);
  });
  return app;
}
