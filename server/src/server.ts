import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from 'dotenv';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
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

config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const ASSETS_DIR = path.resolve(ROOT_DIR, 'assets');

const PORT = Number(process.env.PORT || '8080');
const NODE_ENV = process.env.NODE_ENV || 'development';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const WIDGET_PORT = Number(process.env.WIDGET_PORT || '4444');
const { BASE_URL = '' } = process.env;
const INLINE_DEV_MODE = process.env.INLINE_DEV_MODE === 'true';

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

/** Pre-inlined widget HTML cache — populated at startup when INLINE_DEV_MODE is true */
const inlinedHtmlCache = new Map<string, string>();

function buildInlinedHtml(widgetId: string): string | null {
  const htmlPath = path.join(ASSETS_DIR, `${widgetId}.html`);
  if (!fs.existsSync(htmlPath)) {
    logger.warn({ htmlPath }, 'Cannot pre-inline: HTML file not found');
    return null;
  }
  const html = fs.readFileSync(htmlPath, 'utf-8');
  const inlined = inlineWidgetAssets(html);
  logger.info(
    { widgetId, originalLength: html.length, inlinedLength: inlined.length },
    'Pre-inlined widget HTML'
  );
  return inlined;
}

function preInlineWidgets(widgetIds: string[]) {
  for (const id of widgetIds) {
    const html = buildInlinedHtml(id);
    if (html) {
      inlinedHtmlCache.set(id, html);
    }
  }
}

/**
 * Read widget HTML - from Vite dev server in development, from assets in production
 */
async function readWidgetHtml(widgetId: string): Promise<string> {
  if (NODE_ENV === 'development' && !INLINE_DEV_MODE) {
    try {
      const url = `http://localhost:${WIDGET_PORT}/${widgetId}.html`;
      logger.debug({ url }, 'Fetching widget HTML from Vite dev server');
      const response = await fetch(url);
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
        'Successfully fetched widget HTML'
      );
      return html;
    } catch (err) {
      logger.warn(
        { err, widgetId, widgetPort: WIDGET_PORT },
        'Failed to fetch from Vite dev server, falling back to built assets'
      );
    }
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

function inlineWidgetAssets(html: string): string {
  logger.debug({ htmlLength: html.length }, 'Inlining widget assets');
  let nextHtml = html;
  const scripts = Array.from(
    html.matchAll(
      /<script[^>]*type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g
    )
  );
  logger.debug(
    { scriptMatches: scripts.length },
    'Found script tags to inline'
  );
  for (const match of scripts) {
    const src = match[1];
    const filename = path.basename(src.split('?')[0]);
    const assetPath = path.join(ASSETS_DIR, filename);
    logger.debug(
      { src, filename, assetPath, exists: fs.existsSync(assetPath) },
      'Processing script'
    );
    if (!fs.existsSync(assetPath)) {
      logger.warn(
        { assetPath },
        'Inline asset missing, leaving script tag as-is'
      );
      continue;
    }
    const js = fs.readFileSync(assetPath);
    const b64 = js.toString('base64');
    const inlineTag = `<script type="module" src="data:text/javascript;base64,${b64}"></script>`;
    nextHtml = nextHtml.replace(match[0], () => inlineTag);
    logger.debug({ newLength: nextHtml.length }, 'JS inlined');
  }

  const styles = Array.from(
    html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)
  );
  for (const match of styles) {
    const href = match[1];
    const filename = path.basename(href.split('?')[0]);
    const assetPath = path.join(ASSETS_DIR, filename);
    if (!fs.existsSync(assetPath)) {
      logger.warn(
        { assetPath },
        'Inline asset missing, leaving style tag as-is'
      );
      continue;
    }

    const css = fs.readFileSync(assetPath, 'utf-8');
    const inlineTag = `<style>${css}</style>`;
    nextHtml = nextHtml.replace(match[0], () => inlineTag);
    logger.debug({ newLength: nextHtml.length }, 'CSS inlined');
  }

  nextHtml = nextHtml
    .replace(/<link[^>]*rel="modulepreload"[^>]*>/g, '')
    .replace(/<link[^>]*rel="preload"[^>]*as="style"[^>]*>/g, '');

  if (INLINE_DEV_MODE) {
    // Inject Google Fonts to replace the @fontsource @font-face rules stripped above.
    // The host proxies these through its asset proxy so they load in the sandboxed iframe.
    const googleFontsLink =
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap">';
    nextHtml = nextHtml.replace('</head>', `${googleFontsLink}\n</head>`);
    logger.debug('Injected Google Fonts link for inline mode');
  }

  logger.debug(
    {
      finalLength: nextHtml.length,
      hasLocalhost: nextHtml.includes('localhost'),
    },
    'Inlining complete'
  );

  return nextHtml;
}

/**
 * Create an MCP server instance with echo tool
 */
function createMcpServer(protocolEra: 'modern' | 'legacy'): McpServer {
  const server = new McpServer({
    name: 'mcp-app-template',
    version: '1.0.0',
  });

  const serverLogger = logger.child({ protocolEra });

  const resourceUri = ECHO_WIDGET.uri;

  registerAppResource(
    server as unknown as Parameters<typeof registerAppResource>[0],
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async () => {
      serverLogger.debug({ resourceUri }, 'Resource callback called');
      const widgetId = resourceUri.replace('ui://', '');
      try {
        const html = await readWidgetHtml(widgetId);
        const devWidgetOrigin = `http://localhost:${WIDGET_PORT}`;
        const devWidgetOriginAlt = `http://127.0.0.1:${WIDGET_PORT}`;
        const baseUrlOrigin = new URL(BASE_URL || devWidgetOrigin).origin;

        const resourceDomains: string[] = INLINE_DEV_MODE
          ? []
          : [baseUrlOrigin];
        const connectDomains: string[] = [];

        if (NODE_ENV === 'development' && !INLINE_DEV_MODE) {
          resourceDomains.push(devWidgetOrigin, devWidgetOriginAlt);
          connectDomains.push(
            devWidgetOrigin,
            devWidgetOriginAlt,
            devWidgetOrigin.replace('http://', 'ws://'),
            devWidgetOriginAlt.replace('http://', 'ws://')
          );
        }

        if (INLINE_DEV_MODE) {
          // Google Fonts — needed in inline dev mode where @fontsource local fonts
          // can't load in sandboxed iframes. Remove if you self-host fonts.
          resourceDomains.push(
            'https://fonts.googleapis.com',
            'https://fonts.gstatic.com'
          );
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
          { cspMeta },
          'Constructed CSP meta for widget resource'
        );
        serverLogger.info({ resourceUri, widgetId }, 'Widget resource loaded');

        const finalHtml = INLINE_DEV_MODE
          ? (inlinedHtmlCache.get(widgetId) ?? inlineWidgetAssets(html))
          : html;

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
    server as unknown as Parameters<typeof registerAppTool>[0],
    'echo',
    {
      title: 'Echo',
      description: "Echoes back the user's message in an interactive view",
      inputSchema: EchoToolInputSchema.shape,
      _meta: {
        ui: {
          resourceUri,
        },
      },
    },
    async (args) => {
      serverLogger.info({ toolName: 'echo', args }, 'Tool invoked');

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
      inlineDevMode: INLINE_DEV_MODE,
    },
    'Starting MCP App Template server'
  );

  const widgetIds = [ECHO_WIDGET.id];

  if (INLINE_DEV_MODE) {
    preInlineWidgets(widgetIds);

    // Watch for rebuilds from widget watch mode
    if (fs.existsSync(ASSETS_DIR)) {
      fs.watch(ASSETS_DIR, (eventType, filename) => {
        if (filename?.endsWith('.html')) {
          const widgetId = filename.replace('.html', '');
          if (widgetIds.includes(widgetId)) {
            logger.info({ widgetId, eventType }, 'Asset changed, re-inlining');
            const html = buildInlinedHtml(widgetId);
            if (html) {
              inlinedHtmlCache.set(widgetId, html);
            }
          }
        }
      });
      logger.info('Watching assets directory for rebuild changes');
    }
  }

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
