import { serve } from '@hono/node-server';
import { buildDeps } from './bootstrap.js';
import { createApp } from './app.js';
import { mcpRoutes } from './mcp/routes.js';
import { VERSION } from './version.js';

export function startServer(env: NodeJS.ProcessEnv = process.env) {
  const deps = buildDeps(env, { requireKeys: false });
  const app = createApp(deps, mcpRoutes);
  const server = serve({ fetch: app.fetch, port: deps.cfg.PORT, hostname: deps.cfg.BIND }, (info) => {
    deps.log.info({ version: VERSION, bind: info.address, port: info.port, publicUrl: deps.cfg.PUBLIC_URL, keysLoaded: Boolean(deps.keys) }, 'MISSIRIA RC Connector listening');
  });
  const shutdown = (signal: string) => {
    deps.log.info({ signal }, 'shutting down');
    server.close(() => {
      deps.store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return { deps, server };
}

const isMain = process.argv[1] && /server\.(js|ts)$/.test(process.argv[1]);
if (isMain) startServer();
