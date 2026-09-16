import fs from 'node:fs';
import path from 'node:path';
import {
  CLIENT_INFO_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';

/** Minimal logger surface so these helpers stay testable without pino */
export interface WidgetHtmlLogger {
  debug: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn: (obj: Record<string, unknown> | string, msg?: string) => void;
}

const noopLogger: WidgetHtmlLogger = {
  debug: () => {},
  warn: () => {},
};

export interface ClientIdentity {
  name?: string;
  title?: string;
  version?: string;
}

/**
 * Extract the client identity from a per-request envelope.
 *
 * Modern (2026-07-28) requests carry `clientInfo` in `_meta`; legacy
 * stateless requests have no persisted identity and return undefined.
 */
export function getClientIdentity(
  ctx: ServerContext | undefined
): ClientIdentity | undefined {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const info = envelope?.[CLIENT_INFO_META_KEY];
  if (!info || typeof info !== 'object') {
    return undefined;
  }
  const { name, title, version } = info as Record<string, unknown>;
  const identity: ClientIdentity = {
    name: typeof name === 'string' ? name : undefined,
    title: typeof title === 'string' ? title : undefined,
    version: typeof version === 'string' ? version : undefined,
  };
  return identity.name || identity.title ? identity : undefined;
}

export interface WidgetOrigin {
  origin: string;
  wsOrigin: string;
  isLocalhost: boolean;
}

/**
 * Resolve the public origin the widget dev server is reachable at.
 *
 * When BASE_URL is set (e.g. an `ssh -R 0 pom.run` tunnel to the widget dev
 * server), widget HTML and CSP domains use it; otherwise localhost.
 */
export function resolveWidgetOrigin(
  baseUrl: string | undefined,
  widgetPort: number
): WidgetOrigin {
  const trimmed = baseUrl?.trim();
  const url = new URL(
    trimmed && trimmed.length > 0 ? trimmed : `http://localhost:${widgetPort}`
  );
  const origin = url.origin;
  return {
    origin,
    wsOrigin: origin.replace(/^http/, 'ws'),
    isLocalhost: url.hostname === 'localhost' || url.hostname === '127.0.0.1',
  };
}

const GOOGLE_FONTS_LINK =
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap">';

export const GOOGLE_FONTS_DOMAINS = [
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

/**
 * Inline built JS/CSS assets into widget HTML so it renders in hosts that
 * cannot reach the widget origin (INLINE_DEV_MODE). Local @fontsource fonts
 * cannot survive inlining, so Google Fonts are injected as a replacement —
 * remember to allow GOOGLE_FONTS_DOMAINS in the resource CSP.
 */
export function inlineWidgetAssets(
  html: string,
  assetsDir: string,
  logger: WidgetHtmlLogger = noopLogger
): string {
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
    const assetPath = path.join(assetsDir, filename);
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
  }

  const styles = Array.from(
    html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)
  );
  for (const match of styles) {
    const href = match[1];
    const filename = path.basename(href.split('?')[0]);
    const assetPath = path.join(assetsDir, filename);
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
  }

  nextHtml = nextHtml
    .replace(/<link[^>]*rel="modulepreload"[^>]*>/g, '')
    .replace(/<link[^>]*rel="preload"[^>]*as="style"[^>]*>/g, '')
    .replace('</head>', `${GOOGLE_FONTS_LINK}\n</head>`);

  logger.debug(
    {
      finalLength: nextHtml.length,
      hasLocalhost: nextHtml.includes('localhost'),
    },
    'Inlining complete'
  );

  return nextHtml;
}
