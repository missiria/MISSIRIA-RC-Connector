import { Hono } from 'hono';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Deps } from '../deps.js';
import type { AuthEnv } from './auth.js';
import { createMcpServer } from './server.js';

/**
 * MCP Streamable HTTP endpoint, stateless: every POST gets a fresh McpServer bound to the
 * authenticated principal. No session ids, so nginx/Cloudflare need no affinity and a
 * revoked grant is rejected on the very next call.
 */
export function mcpRoutes(deps: Deps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post('/', async (c) => {
    const principal = c.get('principal');
    const ip = c.req.header('x-real-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const server = createMcpServer(deps, principal, ip);
    // Body bound: attachments (base64 ≈ 4/3) plus headroom for text/html bodies and JSON framing.
    const maxRequestBodySize = Math.ceil(deps.cfg.ATTACHMENT_MAX_BYTES * 1.4) + 2 * 1024 * 1024;
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize });
    try {
      await server.connect(transport);
      return await transport.handleRequest(c.req.raw, {
        authInfo: { token: 'redacted', clientId: principal.grantId, scopes: principal.scopes, extra: { username: principal.username } },
      });
    } finally {
      // Close after the response body has been produced; JSON mode means the body is complete here.
      queueMicrotask(() => void transport.close().catch(() => undefined));
    }
  });

  // Stateless servers have no server-initiated streams or sessions.
  app.get('/', (c) => c.json({ error: 'method_not_allowed', message: 'This MCP server is stateless; use POST.' }, 405));
  app.delete('/', (c) => c.body(null, 204));

  return app;
}
