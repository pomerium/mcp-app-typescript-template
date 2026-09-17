import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Effect, Either, Schema } from 'effect';
import pkg from '../package.json' with { type: 'json' };
import {
  createMcpHandler,
  McpServer,
  type ProtocolEra,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import {
  EchoMessageSchema,
  EchoToolInputSchema,
  type EchoToolOutput,
  type WidgetDescriptor,
} from './types.js';
import { clientCanRenderUi } from './ui-capability.js';
import { getClientIdentity, resolveWidgetOrigin } from './widget-html.js';
import { appConfig, ASSETS_DIR, IS_DEV } from './config.js';
import { logError, logFatal, logInfo, runtime } from './logger.js';

const ECHO_WIDGET: WidgetDescriptor = {
  id: 'echo',
  title: 'Echo',
  uri: 'ui://echo',
};

/**
 * Read widget HTML - from Vite dev server in development, from assets in production
 */
function readWidgetHtml(widgetId: string): Effect.Effect<string, Error> {
  if (IS_DEV) {
    // No fallback to built assets here: `npm run dev` does not build, so a
    // missing dev server is a configuration error worth surfacing.
    const url = `http://localhost:${appConfig.widgetPort}/${widgetId}.html`;
    return Effect.gen(function* () {
      yield* Effect.logDebug('Fetching widget HTML from Vite dev server').pipe(
        Effect.annotateLogs({ url })
      );
      const response = yield* Effect.tryPromise({
        try: () => fetch(url),
        catch: (cause) =>
          new Error(
            `Widget dev server not reachable at ${url}. ` +
              'Is "npm run dev" running? (It starts the Vite dev server on WIDGET_PORT.)',
            { cause }
          ),
      });
      if (!response.ok) {
        const errorText = yield* Effect.promise(() => response.text());
        yield* Effect.logError('Vite dev server returned error').pipe(
          Effect.annotateLogs({
            status: response.status,
            statusText: response.statusText,
            errorText,
            url,
          })
        );
        return yield* Effect.fail(
          new Error(`Failed to fetch widget HTML: ${response.statusText}`)
        );
      }
      const html = yield* Effect.promise(() => response.text());
      yield* Effect.logDebug('Fetched widget HTML from Vite dev server').pipe(
        Effect.annotateLogs({ url, htmlLength: html.length })
      );
      return html;
    });
  }

  if (appConfig.baseUrl) {
    const url = new URL(`${widgetId}.html`, appConfig.baseUrl).href;
    return Effect.gen(function* () {
      yield* Effect.logDebug('Fetching widget HTML from BASE_URL').pipe(
        Effect.annotateLogs({ url })
      );
      const response = yield* Effect.tryPromise({
        try: () => fetch(url),
        catch: (cause) =>
          new Error(`Failed to fetch widget HTML from ${url}`, { cause }),
      });
      if (!response.ok) {
        return yield* Effect.fail(
          new Error(
            `Failed to fetch widget HTML from ${url}: ${response.statusText}`
          )
        );
      }
      return yield* Effect.promise(() => response.text());
    });
  }

  return Effect.gen(function* () {
    if (!fs.existsSync(ASSETS_DIR)) {
      return yield* Effect.fail(
        new Error(
          `Widget assets not found. Expected directory ${ASSETS_DIR}. Run "npm run build:widgets" before starting the server.`
        )
      );
    }

    const htmlPath = path.join(ASSETS_DIR, `${widgetId}.html`);

    if (!fs.existsSync(htmlPath)) {
      return yield* Effect.fail(
        new Error(`Widget HTML not found: ${htmlPath}`)
      );
    }

    return fs.readFileSync(htmlPath, 'utf-8');
  });
}

/**
 * Create an MCP server instance with echo tool.
 *
 * `createMcpHandler` calls this once per HTTP request (MCP 2026-07-28 is
 * stateless), so nothing registered here survives beyond that request.
 */
export function createMcpServer(protocolEra: ProtocolEra): McpServer {
  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  const resourceUri = ECHO_WIDGET.uri;

  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    (_uri, ctx) => {
      const widgetId = resourceUri.replace('ui://', '');
      const clientInfo = getClientIdentity(ctx);

      const program = Effect.gen(function* () {
        yield* Effect.logDebug('Resource callback called').pipe(
          Effect.annotateLogs({ resourceUri })
        );

        // Dev serves the live Vite module graph (with HMR) to every client.
        // Hosts render widget HTML inside a sandboxed iframe whose CSP is
        // built from the resourceDomains/connectDomains declared below, and
        // both claude.ai and ChatGPT honour them, so the dev server origin
        // just has to be reachable from the host: a public https tunnel in
        // BASE_URL for hosted clients, localhost for local ones.
        const resourceDomains: string[] = [];
        const connectDomains: string[] = [];

        const finalHtml = yield* readWidgetHtml(widgetId);
        const widgetOrigin = resolveWidgetOrigin(
          appConfig.baseUrl,
          appConfig.widgetPort
        );
        resourceDomains.push(widgetOrigin.origin);
        if (IS_DEV) {
          // Vite dev server: allow module fetches plus the HMR websocket
          connectDomains.push(widgetOrigin.origin, widgetOrigin.wsOrigin);
          if (widgetOrigin.isLocalhost) {
            const altOrigin = `http://127.0.0.1:${appConfig.widgetPort}`;
            resourceDomains.push(altOrigin);
            connectDomains.push(
              altOrigin,
              altOrigin.replace('http://', 'ws://')
            );
            if (clientInfo) {
              // A hosted client (claude.ai, ChatGPT) cannot load
              // http://localhost from its https sandbox.
              yield* Effect.logWarning(
                'BASE_URL is not set; hosted clients need an https tunnel to the widget dev server (see .env.example)'
              ).pipe(
                Effect.annotateLogs({
                  clientInfo,
                  widgetOrigin: widgetOrigin.origin,
                })
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

        yield* Effect.logInfo('Widget resource loaded').pipe(
          Effect.annotateLogs({
            resourceUri,
            widgetId,
            clientInfo,
            cspMeta,
          })
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
      }).pipe(
        Effect.annotateLogs({ protocolEra }),
        Effect.tapError((err) =>
          Effect.logError('Failed to load widget').pipe(
            Effect.annotateLogs({ err, resourceUri, widgetId })
          )
        )
      );

      return runtime.runPromise(program);
    }
  );

  registerAppTool(
    server,
    'echo',
    {
      title: 'Echo',
      description: "Echoes back the user's message in an interactive view",
      inputSchema: EchoToolInputSchema,
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
    (args, ctx) => {
      const canRenderUiByCapability = clientCanRenderUi(ctx);

      // The SDK already validates `args` against `inputSchema` before this
      // handler runs (see `validateToolInput`), so this decode only ever
      // sees valid input in practice; it's kept as the handler's own
      // boundary check rather than trusting that upstream behavior.
      const program = Effect.gen(function* () {
        yield* Effect.logInfo('Tool invoked').pipe(
          Effect.annotateLogs({
            toolName: 'echo',
            args,
            canRenderUiByCapability,
          })
        );

        const result = Schema.decodeUnknownEither(EchoMessageSchema)(args);

        if (Either.isLeft(result)) {
          yield* Effect.logError('Validation failed').pipe(
            Effect.annotateLogs({ err: result.left, toolName: 'echo' })
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: ${result.left.message}`,
              },
            ],
            isError: true,
          };
        }

        const { message } = result.right;

        if (!canRenderUiByCapability) {
          yield* Effect.logInfo(
            'Client cannot render UI; returning text-only result'
          ).pipe(Effect.annotateLogs({ toolName: 'echo' }));
          return {
            content: [
              {
                type: 'text' as const,
                text: `Echoing: "${message}"`,
              },
            ],
          };
        }

        const output = {
          echoedMessage: message,
          timestamp: new Date().toISOString(),
        } satisfies EchoToolOutput;

        yield* Effect.logInfo('Tool execution successful').pipe(
          Effect.annotateLogs({ output })
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: `Echoing: "${message}"`,
            },
          ],
          structuredContent: output,
        };
      }).pipe(Effect.annotateLogs({ protocolEra }));

      return runtime.runPromise(program);
    }
  );

  return server;
}

/**
 * Build the stateless MCP request handler used by the `/mcp` route.
 *
 * Every request gets a fresh `McpServer` from `createMcpServer`. The
 * `legacy: 'stateless'` option lets older 2025-era clients (which still send
 * an `initialize` handshake) be served by the same handler with no session.
 */
export function createHandler() {
  return createMcpHandler(({ era }) => createMcpServer(era), {
    legacy: 'stateless',
    onerror: (err) => {
      logError('Error handling MCP request', { err });
    },
  });
}

/**
 * Main server setup
 */
async function main() {
  if (appConfig.nodeEnv === 'production' && !appConfig.baseUrl) {
    logFatal('BASE_URL must be set in production');
    process.exit(1);
  }

  logInfo('Starting MCP App Template server', {
    port: appConfig.port,
    nodeEnv: appConfig.nodeEnv,
    logLevel: appConfig.logLevel,
    assetsDir: ASSETS_DIR,
    baseUrl: appConfig.baseUrl,
  });

  const app = express();

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logInfo('Request handled', {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
      });
    });
    next();
  });

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', appConfig.corsOrigin);
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

  const handler = createHandler();
  const nodeHandler = toNodeHandler(handler, {
    onerror: (err) => {
      logError('Error adapting MCP request for Node', { err });
    },
  });

  app.all('/mcp', (req, res) => {
    nodeHandler(req, res, req.body).catch((err: unknown) => {
      logError('Unhandled error serving MCP request', { err });
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
    logInfo('Shutting down server...');

    httpServer.close(() => {
      logInfo('HTTP server closed');
    });

    await handler.close();

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  httpServer.listen(appConfig.port, () => {
    logInfo('Server started successfully', {
      port: appConfig.port,
      mcpEndpoint: `http://localhost:${appConfig.port}/mcp`,
      healthEndpoint: `http://localhost:${appConfig.port}/health`,
    });
  });
}

// Only start listening when run directly (`node dist/server.js`, `tsx watch
// src/server.ts`). Tests import `createMcpServer` / `createHandler` without
// binding a port.
if (import.meta.main) {
  main().catch((err) => {
    logFatal('Failed to start server', { err });
    process.exit(1);
  });
}
