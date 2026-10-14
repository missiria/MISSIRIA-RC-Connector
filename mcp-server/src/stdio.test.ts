import { describe, it, expect } from 'vitest';
import { forward } from './stdio.js';

const fakeFetch = (status: number, body: string, ct = 'application/json'): typeof fetch =>
  (async () => new Response(body, { status, headers: { 'content-type': ct } })) as unknown as typeof fetch;

describe('stdio proxy forward()', () => {
  it('posts the message with the bearer and returns JSON responses', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init! };
      return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const out = await forward({ jsonrpc: '2.0', id: 1, method: 'ping' }, { url: 'https://mcp.example.test/mcp', token: 'rcc_x', fetchImpl: f });
    expect(out).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(seen!.url).toBe('https://mcp.example.test/mcp');
    expect((seen!.init.headers as Record<string, string>).authorization).toBe('Bearer rcc_x');
  });

  it('returns null for accepted notifications and unwraps SSE data lines', async () => {
    expect(await forward({ jsonrpc: '2.0', method: 'notifications/initialized' }, { url: 'u', token: 't', fetchImpl: fakeFetch(202, '') })).toBeNull();
    const sse = await forward({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { url: 'u', token: 't', fetchImpl: fakeFetch(200, 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n', 'text/event-stream') });
    expect(sse).toBe('{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}');
  });

  it('maps HTTP errors to JSON-RPC errors with the request id', async () => {
    const out = await forward({ jsonrpc: '2.0', id: 7, method: 'tools/list' }, { url: 'u', token: 'bad', fetchImpl: fakeFetch(401, '{"error":"invalid_token"}') });
    const parsed = JSON.parse(out!);
    expect(parsed.id).toBe(7);
    expect(parsed.error.message).toContain('401');
  });
});
