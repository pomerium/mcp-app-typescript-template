import { Schema } from 'effect';
import { toMcpSchema } from './effect-mcp-schema.js';

/**
 * Echo tool input shape (Effect Schema)
 */
export const EchoMessageSchema = Schema.Struct({
  message: Schema.String.annotations({
    description: 'The message to echo back',
  }).pipe(Schema.minLength(1, { message: () => 'Message cannot be empty' })),
});

export type EchoToolInput = Schema.Schema.Type<typeof EchoMessageSchema>;

/**
 * MCP-facing echo tool input schema, bridged to the SDK's
 * Standard-Schema-plus-JSON-Schema `inputSchema` contract.
 */
export const EchoToolInputSchema = toMcpSchema(EchoMessageSchema);

/**
 * Echo tool structured content output
 */
export interface EchoToolOutput {
  echoedMessage: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Widget descriptor for tool metadata
 */
export interface WidgetDescriptor {
  id: string;
  title: string;
  uri: string;
}
