import { describe, it, expect } from 'vitest';
import { Schema } from 'effect';
import { EchoMessageSchema } from '../src/types.js';

const decode = Schema.decodeUnknownSync(EchoMessageSchema);

describe('Echo Tool', () => {
  describe('Input validation', () => {
    it('should accept valid message', () => {
      const input = { message: 'Hello, World!' };
      const result = decode(input);

      expect(result).toEqual(input);
      expect(result.message).toBe('Hello, World!');
    });

    it('should reject empty message', () => {
      const input = { message: '' };

      expect(() => decode(input)).toThrow();
    });

    it('should reject missing message', () => {
      const input = {};

      expect(() => decode(input)).toThrow();
    });

    it('should reject non-string message', () => {
      const input = { message: 123 };

      expect(() => decode(input)).toThrow();
    });
  });

  describe('Tool output structure', () => {
    it('should match expected output format', () => {
      const input = { message: 'Test message' };
      const validated = decode(input);

      const output = {
        echoedMessage: validated.message,
        timestamp: new Date().toISOString(),
      };

      expect(output).toHaveProperty('echoedMessage');
      expect(output).toHaveProperty('timestamp');
      expect(output.echoedMessage).toBe('Test message');
      expect(output.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
