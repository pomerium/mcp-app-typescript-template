import { describe, expect, it } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { clientCanRenderUi } from '../src/ui-capability.js';

const modernMeta = {
  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
  [CLIENT_INFO_META_KEY]: {
    name: 'ui-capability-test-client',
    version: '1.0.0',
  },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

const modernUiMeta = {
  ...modernMeta,
  [CLIENT_CAPABILITIES_META_KEY]: {
    extensions: {
      [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
    },
  },
};

function createModernRequest(body: unknown): Request {
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

function createLegacyRequest(body: unknown): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function createCapabilityAwareHandler() {
  return createMcpHandler(
    () => {
      const server = new McpServer({
        name: 'capability-test-server',
        version: '1.0.0',
      });
      server.registerTool(
        'echo',
        { inputSchema: z.object({ message: z.string() }) },
        async ({ message }, ctx) => {
          if (!clientCanRenderUi(ctx as ServerContext)) {
            return {
              content: [{ type: 'text', text: `Echoing: "${message}"` }],
            };
          }

          return {
            content: [{ type: 'text', text: `Echoing: "${message}"` }],
            structuredContent: { echoedMessage: message },
          };
        }
      );
      return server;
    },
    { legacy: 'stateless' }
  );
}

async function readResponseBody(response: Response): Promise<unknown> {
  const body = await response.text();
  const eventData = body.split('\n').find((line) => line.startsWith('data: '));

  return JSON.parse(eventData ? eventData.slice('data: '.length) : body);
}

describe('UI capability negotiation', () => {
  it('returns structured content only for UI-capable modern requests', async () => {
    const handler = createCapabilityAwareHandler();

    const uiResponse = await handler.fetch(
      createModernRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'ui request' },
          _meta: modernUiMeta,
        },
      })
    );
    const uiBody = await uiResponse.json();
    expect(uiBody).toMatchObject({
      result: {
        structuredContent: { echoedMessage: 'ui request' },
      },
    });

    const textResponse = await handler.fetch(
      createModernRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'text request' },
          _meta: modernMeta,
        },
      })
    );
    const textBody = await textResponse.json();
    expect(textBody).toMatchObject({
      result: { content: [{ type: 'text', text: 'Echoing: "text request"' }] },
    });
    expect(textBody.result).not.toHaveProperty('structuredContent');

    await handler.close();
  });

  it('returns text-only content through the legacy stateless fallback', async () => {
    const handler = createCapabilityAwareHandler();

    const response = await handler.fetch(
      createLegacyRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'legacy request' },
        },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = await readResponseBody(response);
    expect(body).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'Echoing: "legacy request"' }],
      },
    });
    expect(body.result).not.toHaveProperty('structuredContent');

    await handler.close();
  });
});
