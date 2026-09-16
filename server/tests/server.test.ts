import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';

// server.ts reads its configuration at import time, so pin the environment
// before importing it: a fake widget origin (so `resources/read` goes through
// the BASE_URL fetch path instead of the on-disk assets) and silent logs.
const WIDGET_BASE_URL = 'https://widgets.example.test';
process.env.BASE_URL = WIDGET_BASE_URL;
process.env.LOG_LEVEL = 'silent';

const { createHandler } = await import('../src/server.js');

const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';

const textOnlyMeta = {
  [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
  [CLIENT_INFO_META_KEY]: { name: 'modern-test-client', version: '1.0.0' },
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

/**
 * A 2026-07-28 request: no prior handshake, protocol version / client identity /
 * capabilities travel in `_meta`, plus the routing headers the spec defines.
 */
function modernRequest({
  method,
  params = {},
  meta = textOnlyMeta,
  name,
}: ModernRequestOptions): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
      'mcp-method': method,
      ...(name ? { 'mcp-name': name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { ...params, _meta: meta },
    }),
  });
}

/** A 2025-era request: plain JSON-RPC with no `_meta` envelope. */
function legacyRequest(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/** Legacy responses may arrive as SSE; unwrap the first `data:` line. */
async function readJsonRpc(response: Response): Promise<{
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

describe('MCP App server (stateless handler)', () => {
  let handler: ReturnType<typeof createHandler>;

  beforeAll(() => {
    handler = createHandler();
  });

  afterAll(async () => {
    await handler.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('2026-07-28 clients', () => {
    it('lists the echo tool with its MCP Apps UI binding, no handshake required', async () => {
      const response = await handler.fetch(
        modernRequest({ method: 'tools/list' })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();

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

    it('returns structuredContent only when the request advertises MCP Apps support', async () => {
      const uiResponse = await handler.fetch(
        modernRequest({
          method: 'tools/call',
          name: 'echo',
          params: { name: 'echo', arguments: { message: 'hello ui' } },
          meta: uiCapableMeta,
        })
      );
      expect(uiResponse.status).toBe(200);
      const uiBody = await readJsonRpc(uiResponse);
      expect(uiBody.result).toMatchObject({
        content: [{ type: 'text', text: 'Echoing: "hello ui"' }],
        structuredContent: { echoedMessage: 'hello ui' },
      });

      const textResponse = await handler.fetch(
        modernRequest({
          method: 'tools/call',
          name: 'echo',
          params: { name: 'echo', arguments: { message: 'hello text' } },
        })
      );
      expect(textResponse.status).toBe(200);
      const textBody = await readJsonRpc(textResponse);
      expect(textBody.result).toMatchObject({
        content: [{ type: 'text', text: 'Echoing: "hello text"' }],
      });
      expect(textBody.result).not.toHaveProperty('structuredContent');
    });

    it('rejects invalid tool input as a tool error', async () => {
      const response = await handler.fetch(
        modernRequest({
          method: 'tools/call',
          name: 'echo',
          params: { name: 'echo', arguments: { message: '' } },
          meta: uiCapableMeta,
        })
      );

      const { result } = await readJsonRpc(response);
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: 'text',
            text: expect.stringContaining('Message cannot be empty'),
          },
        ],
      });
      expect(result).not.toHaveProperty('structuredContent');
    });

    it('serves the widget resource with a CSP that allows the widget origin', async () => {
      const widgetHtml = '<!doctype html><div id="echo-root"></div>';
      const fetchMock = vi.fn(
        async () =>
          new Response(widgetHtml, {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
      );
      vi.stubGlobal('fetch', fetchMock);

      const listResponse = await handler.fetch(
        modernRequest({ method: 'resources/list' })
      );
      const { result: listResult } = await readJsonRpc(listResponse);
      expect(listResult?.resources).toContainEqual(
        expect.objectContaining({
          uri: 'ui://echo',
          mimeType: RESOURCE_MIME_TYPE,
        })
      );

      const readResponse = await handler.fetch(
        modernRequest({
          method: 'resources/read',
          name: 'ui://echo',
          params: { uri: 'ui://echo' },
        })
      );
      expect(readResponse.status).toBe(200);
      const { result: readResult } = await readJsonRpc(readResponse);

      expect(fetchMock).toHaveBeenCalledWith(`${WIDGET_BASE_URL}/echo.html`);
      expect(readResult?.contents?.[0]).toMatchObject({
        uri: 'ui://echo',
        mimeType: RESOURCE_MIME_TYPE,
        text: widgetHtml,
        _meta: {
          ui: {
            csp: {
              resourceDomains: [WIDGET_BASE_URL],
              connectDomains: [],
            },
          },
        },
      });
    });
  });

  describe('2025-era clients (stateless legacy fallback)', () => {
    it('answers the old initialize handshake without creating a session', async () => {
      const response = await handler.fetch(
        legacyRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LEGACY_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'legacy-test-client', version: '1.0.0' },
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const { result } = await readJsonRpc(response);
      expect(result).toMatchObject({
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: { tools: expect.any(Object) },
      });
    });

    it('falls back to a text-only echo because no capabilities persist between requests', async () => {
      const response = await handler.fetch(
        legacyRequest({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'echo', arguments: { message: 'legacy hello' } },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('mcp-session-id')).toBeNull();
      const { result } = await readJsonRpc(response);
      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'Echoing: "legacy hello"' }],
      });
      expect(result).not.toHaveProperty('structuredContent');
    });
  });
});
