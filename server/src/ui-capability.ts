import {
  CLIENT_CAPABILITIES_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  getUiCapability,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';

/**
 * Determine whether the client for this request supports MCP Apps.
 *
 * Modern requests carry capabilities in their per-request envelope. Legacy
 * stateless requests have no persisted capability view and therefore fall
 * back to text-only results.
 */
export function clientCanRenderUi(ctx: ServerContext): boolean {
  // ServerContext exposes this as Partial<RequestMetaEnvelope>. The reserved
  // envelope keys are intentionally opaque in that public type, so use a
  // record view for the SDK-exported key constant.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const clientCapabilities = envelope?.[
    CLIENT_CAPABILITIES_META_KEY
  ] as Parameters<typeof getUiCapability>[0];

  return Boolean(
    getUiCapability(clientCapabilities)?.mimeTypes?.includes(RESOURCE_MIME_TYPE)
  );
}
