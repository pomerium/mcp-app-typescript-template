import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from 'dotenv';
import pkg from '../package.json' with { type: 'json' };
import pino from 'pino';
import pinoHttp from 'pino-http';
import {
  createMcpHandler,
  McpServer,
  type ProtocolEra,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  EchoToolInputSchema,
  type EchoToolOutput,
  type WidgetDescriptor,
} from './types.js';
import { clientCanRenderUi } from './ui-capability.js';
import { getClientIdentity, resolveWidgetOrigin } from './widget-html.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

// The repo-root .env is the single source of dev config (the widget dev
// server reads it via Vite's envDir too). `npm run dev` runs this process
// with cwd=server/, so dotenv's default lookup would miss it.
config({ path: path.resolve(ROOT_DIR, '.env') });
const ASSETS_DIR = path.resolve(ROOT_DIR, 'assets');

const PORT = Number(process.env.PORT || '8080');
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const WIDGET_PORT = Number(process.env.WIDGET_PORT || '4444');
const { BASE_URL = '' } = process.env;
const IS_DEV = (process.env.NODE_ENV || 'development') === 'development';

const logger = pino({
  level: LOG_LEVEL,
  transport:
    NODE_ENV === 'development'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
});

const ECHO_WIDGET: WidgetDescriptor = {
  id: 'echo',
  title: 'Echo',
  uri: 'ui://echo',
};

/**
 * Read widget HTML - from Vite dev server in development, from assets in production
 */
async function readWidgetHtml(widgetId: string): Promise<string> {
  if (IS_DEV) {
    // No fallback to built assets here: `npm run dev` does not build, so a
    // missing dev server is a configuration error worth surfacing.
    const url = `http://localhost:${WIDGET_PORT}/${widgetId}.html`;
    logger.debug({ url }, 'Fetching widget HTML from Vite dev server');
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      throw new Error(
        `Widget dev server not reachable at ${url}. ` +
          'Is "npm run dev" running? (It starts the Vite dev server on WIDGET_PORT.)',
        { cause: err }
      );
    }
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(
        {
          status: response.status,
          statusText: response.statusText,
          errorText,
          url,
        },
        'Vite dev server returned error'
      );
      throw new Error(`Failed to fetch widget HTML: ${response.statusText}`);
    }
    const html = await response.text();
    logger.debug(
      { url, htmlLength: html.length },
      'Fetched widget HTML from Vite dev server'
    );
    return html;
  }

  if (BASE_URL) {
    const url = new URL(`${widgetId}.html`, BASE_URL).href;
    logger.debug({ url }, 'Fetching widget HTML from BASE_URL');
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch widget HTML from ${url}: ${response.statusText}`
      );
    }
    return response.text();
  }

  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(
      `Widget assets not found. Expected directory ${ASSETS_DIR}. Run "npm run build:widgets" before starting the server.`
    );
  }

  const htmlPath = path.join(ASSETS_DIR, `${widgetId}.html`);

  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Widget HTML not found: ${htmlPath}`);
  }

  return fs.readFileSync(htmlPath, 'utf-8');
}

/**
 * Create an MCP server instance with echo tool
 */
function createMcpServer(protocolEra: ProtocolEra): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  // ext-apps 1.x is typed against the v1 SDK; bridge the v2 McpServer once
  // here. Only registerTool/registerResource are called, and those are
  // call-compatible at runtime. Drop this when ext-apps targets the v2 SDK.
  const extAppsServer = server as unknown as Parameters<
    typeof registerAppTool
  >[0] &
    Parameters<typeof registerAppResource>[0];

  const serverLogger = logger.child({ protocolEra });

  const resourceUri = ECHO_WIDGET.uri;

  registerAppResource(
    extAppsServer,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (_uri, extra) => {
      serverLogger.debug({ resourceUri }, 'Resource callback called');
      const widgetId = resourceUri.replace('ui://', '');
      // ext-apps types this callback against the v1 SDK; the v2 runtime
      // supplies ServerContext, so bridge the callback type here.
      const serverContext = extra as unknown as ServerContext;
      const clientInfo = getClientIdentity(serverContext);
      try {
        // Dev serves the live Vite module graph (with HMR) to every client.
        // Hosts render widget HTML inside a sandboxed iframe whose CSP is
        // built from the resourceDomains/connectDomains declared below, and
        // both claude.ai and ChatGPT honour them, so the dev server origin
        // just has to be reachable from the host: a public https tunnel in
        // BASE_URL for hosted clients, localhost for local ones.
        const resourceDomains: string[] = [];
        const connectDomains: string[] = [];

        const finalHtml = await readWidgetHtml(widgetId);
        const widgetOrigin = resolveWidgetOrigin(BASE_URL, WIDGET_PORT);
        resourceDomains.push(widgetOrigin.origin);
        if (IS_DEV) {
          // Vite dev server: allow module fetches plus the HMR websocket
          connectDomains.push(widgetOrigin.origin, widgetOrigin.wsOrigin);
          if (widgetOrigin.isLocalhost) {
            const altOrigin = `http://127.0.0.1:${WIDGET_PORT}`;
            resourceDomains.push(altOrigin);
            connectDomains.push(
              altOrigin,
              altOrigin.replace('http://', 'ws://')
            );
            if (clientInfo) {
              // A hosted client (claude.ai, ChatGPT) cannot load
              // http://localhost from its https sandbox.
              serverLogger.warn(
                { clientInfo, widgetOrigin: widgetOrigin.origin },
                'BASE_URL is not set; hosted clients need an https tunnel to the widget dev server (see .env.example)'
              );
            }
          }
        }

        const cspMeta =
          resourceDomains.length > 0 || connectDomains.length > 0
            ? {
                ui: {
                  csp: {
                    resourceDomains: [...new Set(resourceDomains)],
                    connectDomains: [...new Set(connectDomains)],
                  },
                },
              }
            : undefined;

        serverLogger.info(
          {
            resourceUri,
            widgetId,
            clientInfo,
            cspMeta,
          },
          'Widget resource loaded'
        );

        return {
          contents: [
            {
              uri: resourceUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: finalHtml,
              _meta: cspMeta,
            },
          ],
        };
      } catch (err) {
        serverLogger.error(
          { err, resourceUri, widgetId },
          'Failed to load widget'
        );
        throw err;
      }
    }
  );

  registerAppTool(
    extAppsServer,
    'echo',
    {
      title: 'Echo',
      description: "Echoes back the user's message in an interactive view",
      inputSchema: EchoToolInputSchema.shape,
      // Always advertised, unconditionally: per the 2026-07-28 spec, list
      // endpoints (tools/list included) no longer vary per-connection, so
      // this can't be gated on the caller's capabilities the way it once
      // was. Per-call UI-vs-text-only gating happens below instead, using
      // that call's own declared capabilities.
      _meta: {
        ui: {
          resourceUri,
        },
      },
    },
    async (args, ctx) => {
      // ext-apps still types this callback against the v1 SDK; the v2 runtime
      // supplies ServerContext, so bridge the callback type here.
      const serverContext = ctx as unknown as ServerContext;
      const canRenderUiByCapability = clientCanRenderUi(serverContext);

      serverLogger.info(
        { toolName: 'echo', args, canRenderUiByCapability },
        'Tool invoked'
      );

      try {
        const result = EchoToolInputSchema.safeParse(args);

        if (!result.success) {
          serverLogger.error(
            { err: result.error, toolName: 'echo' },
            'Validation failed'
          );
          return {
            content: [
              {
                type: 'text',
                text: `Error: ${result.error.issues.map((e) => e.message).join(', ')}`,
              },
            ],
            isError: true,
          };
        }

        const { message } = result.data;

        if (!canRenderUiByCapability) {
          serverLogger.info(
            { toolName: 'echo' },
            'Client cannot render UI; returning text-only result'
          );
          return {
            content: [
              {
                type: 'text',
                text: `Echoing: "${message}"`,
              },
            ],
          };
        }

        const output = {
          echoedMessage: message,
          timestamp: new Date().toISOString(),
        } satisfies EchoToolOutput;

        serverLogger.info({ output }, 'Tool execution successful');

        return {
          content: [
            {
              type: 'text',
              text: `Echoing: "${message}"`,
            },
          ],
          structuredContent: output,
        };
      } catch (err) {
        serverLogger.error({ err, toolName: 'echo' }, 'Tool execution failed');
        throw err;
      }
    }
  );

  return server;
}

/**
 * Main server setup
 */
async function main() {
  if (NODE_ENV === 'production' && !BASE_URL) {
    logger.fatal('BASE_URL must be set in production');
    process.exit(1);
  }

  logger.info(
    {
      port: PORT,
      nodeEnv: NODE_ENV,
      logLevel: LOG_LEVEL,
      assetsDir: ASSETS_DIR,
      baseUrl: BASE_URL,
    },
    'Starting MCP App Template server'
  );

  const app = express();

  app.use(pinoHttp({ logger }));

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', CORS_ORIGIN);
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name'
    );

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  });

  app.use(express.json());

  app.use('/assets', express.static(ASSETS_DIR));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const handler = createMcpHandler(({ era }) => createMcpServer(era), {
    legacy: 'stateless',
    onerror: (err) => {
      logger.error({ err }, 'Error handling MCP request');
    },
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (err) => {
      logger.error({ err }, 'Error adapting MCP request for Node');
    },
  });

  app.all('/mcp', (req, res) => {
    logger.info({ method: req.method, ip: req.ip }, 'MCP request');

    nodeHandler(req, res, req.body).catch((err: unknown) => {
      logger.error({ err }, 'Unhandled error serving MCP request');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      } else {
        res.end();
      }
    });
  });

  const httpServer = createServer(app);

  const shutdown = async () => {
    logger.info('Shutting down server...');

    httpServer.close(() => {
      logger.info('HTTP server closed');
    });

    await handler.close();

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  httpServer.listen(PORT, () => {
    logger.info(
      {
        port: PORT,
        mcpEndpoint: `http://localhost:${PORT}/mcp`,
        healthEndpoint: `http://localhost:${PORT}/health`,
      },
      'Server started successfully'
    );
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
