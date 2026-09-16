import {
  AppBridge,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
  getToolUiResourceUri,
  type McpUiRequestDisplayModeRequest,
  type McpUiMessageRequest,
  type McpUiOpenLinkRequest,
  type McpUiUpdateModelContextRequest,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { EXTENSION_ID } from '@modelcontextprotocol/ext-apps/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const HOST_INFO = { name: 'mcp-app-e2e-test-host', version: '1.0.0' };

export interface HostEvents {
  initialized: boolean;
  ready: boolean;
  error: string | null;
  messages: McpUiMessageRequest['params'][];
  openLinks: McpUiOpenLinkRequest['params'][];
  contextUpdates: McpUiUpdateModelContextRequest['params'][];
  displayModeRequests: McpUiRequestDisplayModeRequest['params'][];
}

declare global {
  interface Window {
    __e2e: HostEvents;
  }
}

const events: HostEvents = {
  initialized: false,
  ready: false,
  error: null,
  messages: [],
  openLinks: [],
  contextUpdates: [],
  displayModeRequests: [],
};
window.__e2e = events;

async function main() {
  const params = new URLSearchParams(location.search);
  const serverUrl = params.get('server');
  const initialMessage = params.get('message') ?? 'Hello from the e2e host';
  if (!serverUrl) {
    throw new Error('Missing required "server" query parameter');
  }

  const client = new Client(HOST_INFO, {
    capabilities: {
      extensions: {
        [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
      },
    },
    // Real MCP Apps hosts (MCPJam, Claude.ai, ChatGPT) speak 2026-07-28
    // straight away: probe via `server/discover`, no `initialize` handshake.
    // Without this, the SDK defaults to the legacy handshake, and this
    // template's stateless server can only ever answer a legacy client with
    // text-only results (capabilities don't persist between requests).
    versionNegotiation: { mode: 'auto' },
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(serverUrl)));

  const { tools } = await client.listTools();
  const echoTool = tools.find((tool) => tool.name === 'echo');
  if (!echoTool) {
    throw new Error('Server did not advertise an "echo" tool');
  }

  const resourceUri = getToolUiResourceUri(echoTool);
  if (!resourceUri) {
    throw new Error('"echo" tool has no bound UI resource');
  }

  const resource = await client.readResource({ uri: resourceUri });
  const content = resource.contents[0];
  if (
    !content ||
    content.mimeType !== RESOURCE_MIME_TYPE ||
    !('text' in content) ||
    !content.text
  ) {
    throw new Error(
      `Unexpected widget resource contents: ${JSON.stringify(content)}`
    );
  }

  const iframe = document.createElement('iframe');
  iframe.id = 'widget-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.width = '960px';
  iframe.style.height = '720px';
  iframe.style.border = '0';
  document.getElementById('app-root')?.appendChild(iframe);

  const serverCapabilities = client.getServerCapabilities();
  const bridge = new AppBridge(
    client,
    HOST_INFO,
    {
      openLinks: {},
      serverTools: serverCapabilities?.tools,
      serverResources: serverCapabilities?.resources,
      updateModelContext: { text: {}, structuredContent: {} },
      message: { text: {} },
    },
    {
      hostContext: {
        theme: 'light',
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
        containerDimensions: { maxHeight: 900 },
      },
    }
  );

  bridge.onmessage = async (messageParams) => {
    events.messages.push(messageParams);
    return {};
  };

  bridge.onopenlink = async (openLinkParams) => {
    events.openLinks.push(openLinkParams);
    return {};
  };

  bridge.onupdatemodelcontext = async (contextParams) => {
    events.contextUpdates.push(contextParams);
    return {};
  };

  bridge.onrequestdisplaymode = async (displayModeParams) => {
    events.displayModeRequests.push(displayModeParams);
    const mode = displayModeParams.mode;
    bridge.sendHostContextChange({ displayMode: mode });
    return { mode };
  };

  const initialized = new Promise<void>((resolve) => {
    bridge.oninitialized = () => {
      events.initialized = true;
      resolve();
    };
  });

  // Register the transport (and its message listener) on the still-blank
  // iframe *before* loading the widget's HTML: `contentWindow` is a stable
  // WindowProxy across navigations of this frame, but a message posted
  // before a listener exists is dropped, not queued.
  await bridge.connect(
    new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)
  );

  iframe.srcdoc = content.text;

  await initialized;

  const result = await client.callTool({
    name: 'echo',
    arguments: { message: initialMessage },
  });
  await bridge.sendToolInput({ arguments: { message: initialMessage } });
  await bridge.sendToolResult(result);

  events.ready = true;
}

main().catch((err) => {
  events.error = err instanceof Error ? err.message : String(err);
  console.error('[e2e host] failed to initialize', err);
});
