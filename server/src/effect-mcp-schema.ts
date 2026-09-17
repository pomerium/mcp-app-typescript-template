import { Either, JSONSchema, Schema } from 'effect';
import {
  fromJsonSchema,
  type JsonSchemaType,
  type JsonSchemaValidatorResult,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';

/**
 * Bridges an Effect `Schema` to the MCP SDK's `inputSchema`/`outputSchema`
 * contract.
 *
 * `Schema.standardSchemaV1` alone only implements `~standard.validate`; the
 * SDK's `tools/list` JSON Schema export (`standardSchemaToJsonSchema`) also
 * requires `~standard.jsonSchema`, which Effect doesn't provide (its vendor
 * tag is `"effect"`, not `"zod"`, so the SDK's Zod fallback doesn't apply
 * either). This generates the JSON Schema once via `JSONSchema.make` and
 * wires the SDK's own `fromJsonSchema` helper to Effect's decoder, so the
 * result satisfies both halves of the contract.
 *
 * Only synchronous schemas are supported (no async transforms/refinements) -
 * `decodeUnknownEither` requires that to return a result without running an
 * Effect runtime.
 */
export function toMcpSchema<A>(
  schema: Schema.Schema<A, A>
): StandardSchemaWithJSON<A, A> {
  const jsonSchema = JSONSchema.make(schema) as JsonSchemaType;
  const decode = Schema.decodeUnknownEither(schema);

  return fromJsonSchema<A>(jsonSchema, {
    // The SDK's provider interface is generic over the caller's expected
    // type `T`; we only ever get called for the `A` this schema decodes to,
    // so the cast below is safe in practice even though the signature can't
    // express that constraint.
    getValidator:
      <T>() =>
      (input: unknown): JsonSchemaValidatorResult<T> => {
        const result = decode(input);

        return Either.isRight(result)
          ? {
              valid: true,
              data: result.right as unknown as T,
              errorMessage: undefined,
            }
          : {
              valid: false,
              data: undefined,
              errorMessage: result.left.message,
            };
      },
  });
}
