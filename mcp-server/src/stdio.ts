/**
 * Local stdio ↔ Streamable HTTP proxy for MCP clients that only speak stdio
 * (older Claude Desktop configs, some IDE integrations).
 *
 * Each newline-delimited JSON-RPC message from stdin is POSTed to the remote
 * /mcp endpoint with the bearer token; the JSON response is written to stdout.
 * The remote server is stateless, so no session header handling is needed.
 */
import { createInterface } from 'node:readline';

export interface ProxyOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  out?: (line: string) => void;
}

export async function forward(message: unknown, opts: ProxyOptions): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(message),
  });
  if (res.status === 202 || res.status === 204) return null; // notification accepted
  const text = await res.text();
  if (!res.ok) {
    const id = typeof message === 'object' && message !== null && 'id' in message ? (message as { id: unknown }).id : null;
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `HTTP ${res.status} from MCP server`, data: text.slice(0, 500) } });
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    // Collect data: lines from the SSE body and emit each JSON payload.
    const payloads = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    return payloads.join('\n') || null;
  }
  return text.trim() || null;
}

export async function runStdioProxy(url: string, token: string, opts: Partial<ProxyOptions> = {}): Promise<void> {
  const out = opts.out ?? ((line: string) => process.stdout.write(line + '\n'));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      out(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      continue;
    }
    try {
      const reply = await forward(msg, { url, token, fetchImpl: opts.fetchImpl, out });
      if (reply) out(reply);
    } catch (e) {
      const id = typeof msg === 'object' && msg !== null && 'id' in msg ? (msg as { id: unknown }).id : null;
      out(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: `proxy error: ${e instanceof Error ? e.message : String(e)}` } }));
    }
  }
}
