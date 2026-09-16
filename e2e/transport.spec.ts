import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
} from '@playwright/test';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { SERVER_URL } from '../playwright.config';

/**
 * Mirrors `server/tests/server.test.ts`'s in-process coverage, but against
 * the real production build over the network: a fresh `McpServer` per
 * request (MCP 2026-07-28 is stateless), reached through Express/Node's
 * HTTP stack rather than `handler.fetch()` directly.
 */

const MCP_URL = `${SERVER_URL}/mcp`;
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';

const textOnlyMeta = {
  [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
  [CLIENT_INFO_META_KEY]: { name: 'e2e-transport-client', version: '1.0.0' },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

const uiCapableMeta = {
  ...textOnlyMeta,
  [CLIENT_CAPABILITIES_META_KEY]: {
    extensions: {
      [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
    },
  },
};

interface ModernRequestOptions {
  method: string;
  params?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  /** Tool name or resource URI; the spec requires it in `Mcp-Name` when the body names one. */
  name?: string;
}

/** A 2026-07-28 request: no prior handshake, everything travels in `_meta` plus routing headers. */
function modernRequest(
  request: APIRequestContext,
  { method, params = {}, meta = textOnlyMeta, name }: ModernRequestOptions
) {
  return request.post(MCP_URL, {
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}),
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: meta },
    },
  });
}

/** A 2025-era request: plain JSON-RPC with no `_meta` envelope. */
function legacyRequest(request: APIRequestContext, body: unknown) {
  return request.post(MCP_URL, {
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    data: body,
  });
}

/** Legacy responses may arrive as SSE; unwrap the first `data:` line. */
async function readJsonRpc(response: APIResponse): Promise<{
  result?: Record<string, unknown> & {
    tools?: Array<Record<string, unknown>>;
    resources?: Array<Record<string, unknown>>;
    contents?: Array<Record<string, unknown>>;
  };
  error?: { code: number; message: string };
}> {
  const body = await response.text();
  const eventData = body.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(eventData ? eventData.slice('data: '.length) : body);
}

test.describe('MCP transport (production server, real HTTP)', () => {
  test.describe('2026-07-28 clients', () => {
    test('lists the echo tool with its MCP Apps UI binding, no handshake required', async ({
      request,
    }) => {
      const response = await modernRequest(request, { method: 'tools/list' });

      expect(response.status()).toBe(200);
      expect(response.headers()['mcp-session-id']).toBeUndefined();

      const { result } = await readJsonRpc(response);
      const echo = result?.tools?.find((tool) => tool.name === 'echo');
      expect(echo).toMatchObject({
        name: 'echo',
        _meta: { ui: { resourceUri: 'ui://echo' } },
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      });
    });

    test('returns structuredContent only when the request advertises MCP Apps support', async ({
      request,
    }) => {
      const uiResponse = await modernRequest(request, {
        method: 'tools/call',
        name: 'echo',
        params: { name: 'echo', arguments: { message: 'hello ui' } },
        meta: uiCapableMeta,
      });
      expect(uiResponse.status()).toBe(200);
      const uiBody = await readJsonRpc(uiResponse);
      expect(uiBody.result).toMatchObject({
        content: [{ type: 'text', text: 'Echoing: "hello ui"' }],
        structuredContent: { echoedMessage: 'hello ui' },
      });

      const textResponse = await modernRequest(request, {
        method: 'tools/call',
        name: 'echo',
        params: { name: 'echo', arguments: { message: 'hello text' } },
      });
      expect(textResponse.status()).toBe(200);
      const textBody = await readJsonRpc(textResponse);
      expect(textBody.result).toMatchObject({
        content: [{ type: 'text', text: 'Echoing: "hello text"' }],
      });
      expect(textBody.result).not.toHaveProperty('structuredContent');
    });

    test('serves the widget resource with a CSP that allows the widget origin', async ({
      request,
    }) => {
      const readResponse = await modernRequest(request, {
        method: 'resources/read',
        name: 'ui://echo',
        params: { uri: 'ui://echo' },
      });
      expect(readResponse.status()).toBe(200);

      const { result } = await readJsonRpc(readResponse);
      const [content] = result?.contents ?? [];
      expect(content).toMatchObject({
        uri: 'ui://echo',
        mimeType: RESOURCE_MIME_TYPE,
      });
      expect(content?.text).toContain('<!doctype html>');

      const csp = (
        content?._meta as
          { ui?: { csp?: { resourceDomains?: string[] } } } | undefined
      )?.ui?.csp;
      expect(csp?.resourceDomains).toBeDefined();
      expect(csp?.resourceDomains?.length).toBeGreaterThan(0);
    });
  });

  test.describe('2025-era clients (stateless legacy fallback)', () => {
    test('answers the old initialize handshake without creating a session', async ({
      request,
    }) => {
      const response = await legacyRequest(request, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'e2e-legacy-client', version: '1.0.0' },
        },
      });

      expect(response.status()).toBe(200);
      expect(response.headers()['mcp-session-id']).toBeUndefined();

      const { result } = await readJsonRpc(response);
      expect(result).toMatchObject({
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: expect.any(Object) },
      });
    });

    test('falls back to a text-only echo because no capabilities persist between requests', async ({
      request,
    }) => {
      const response = await legacyRequest(request, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'legacy hello' } },
      });

      expect(response.status()).toBe(200);
      expect(response.headers()['mcp-session-id']).toBeUndefined();

      const { result } = await readJsonRpc(response);
      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Echoing: "legacy hello"' }],
      });
      expect(result).not.toHaveProperty('structuredContent');
    });
  });
});
