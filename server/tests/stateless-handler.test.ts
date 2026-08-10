import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

const modernMeta = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: { name: 'stateless-test-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

function createRequest(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'echo',
    },
    body: JSON.stringify(body),
  });
}

describe('stateless MCP handler', () => {
  it('serves 2026-07-28 requests without sessions or handshakes', async () => {
    let factoryCalls = 0;
    const handler = createMcpHandler(() => {
      factoryCalls += 1;

      const server = new McpServer({
        name: 'stateless-test-server',
        version: '1.0.0',
      });
      server.registerTool(
        'echo',
        { inputSchema: z.object({ message: z.string() }) },
        async ({ message }) => ({
          content: [{ type: 'text', text: message }],
        })
      );
      return server;
    });

    const firstResponse = await handler.fetch(
      createRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'first request' },
          _meta: modernMeta,
        },
      })
    );

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('mcp-session-id')).toBeNull();
    await expect(firstResponse.json()).resolves.toMatchObject({
      result: { content: [{ type: 'text', text: 'first request' }] },
    });

    const secondResponse = await handler.fetch(
      createRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'second request' },
          _meta: modernMeta,
        },
      })
    );

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get('mcp-session-id')).toBeNull();
    expect(factoryCalls).toBe(2);

    await handler.close();
  });

  it('serves older 2025-era clients through the stateless fallback', async () => {
    let factoryCalls = 0;
    const handler = createMcpHandler(
      () => {
        factoryCalls += 1;

        const server = new McpServer({
          name: 'legacy-stateless-test-server',
          version: '1.0.0',
        });
        server.registerTool(
          'echo',
          { inputSchema: z.object({ message: z.string() }) },
          async ({ message }) => ({
            content: [{ type: 'text', text: message }],
          })
        );
        return server;
      },
      { legacy: 'stateless' }
    );

    const initializeResponse = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'legacy-test-client', version: '1.0.0' },
          },
        }),
      })
    );

    expect(initializeResponse.status).toBe(200);
    expect(initializeResponse.headers.get('mcp-session-id')).toBeNull();

    const toolResponse = await handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'echo',
            arguments: { message: 'legacy request' },
          },
        }),
      })
    );

    expect(toolResponse.status).toBe(200);
    expect(toolResponse.headers.get('mcp-session-id')).toBeNull();
    await expect(toolResponse.text()).resolves.toContain('legacy request');
    expect(factoryCalls).toBe(2);

    await handler.close();
  });
});
