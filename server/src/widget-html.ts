import {
  CLIENT_INFO_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';

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
