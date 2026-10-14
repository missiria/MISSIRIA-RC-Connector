import { Hono } from 'hono';
import type { Deps } from '../deps.js';
import type { AuthEnv } from './auth.js';

/** MCP Streamable HTTP endpoint. Filled in by the P3 ticket; placeholder keeps the server bootable. */
export function mcpRoutes(_deps: Deps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.all('/', (c) => c.json({ error: 'mcp_not_implemented', principal: c.get('principal').username }, 503));
  return app;
}
