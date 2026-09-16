import { describe, expect, it } from 'vitest';
import {
  CLIENT_INFO_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { getClientIdentity, resolveWidgetOrigin } from '../src/widget-html.js';

function contextWithClientInfo(info: unknown): ServerContext {
  return {
    mcpReq: {
      envelope: info === undefined ? {} : { [CLIENT_INFO_META_KEY]: info },
    },
  } as unknown as ServerContext;
}

describe('getClientIdentity', () => {
  it('extracts name, title, and version from the request envelope', () => {
    const ctx = contextWithClientInfo({
      name: 'claude-ai',
      title: 'Claude',
      version: '2.0.0',
    });

    expect(getClientIdentity(ctx)).toEqual({
      name: 'claude-ai',
      title: 'Claude',
      version: '2.0.0',
    });
  });

  it('returns undefined when the envelope has no client info', () => {
    expect(getClientIdentity(contextWithClientInfo(undefined))).toBeUndefined();
    expect(getClientIdentity(undefined)).toBeUndefined();
  });

  it('returns undefined for malformed client info', () => {
    expect(getClientIdentity(contextWithClientInfo('claude'))).toBeUndefined();
    expect(
      getClientIdentity(contextWithClientInfo({ name: 123 }))
    ).toBeUndefined();
  });
});

describe('resolveWidgetOrigin', () => {
  it('falls back to localhost with the widget port', () => {
    expect(resolveWidgetOrigin(undefined, 4444)).toEqual({
      origin: 'http://localhost:4444',
      wsOrigin: 'ws://localhost:4444',
      isLocalhost: true,
    });
  });

  it('uses BASE_URL and maps https to wss', () => {
    expect(
      resolveWidgetOrigin('https://widgets.example.pom.run/', 4444)
    ).toEqual({
      origin: 'https://widgets.example.pom.run',
      wsOrigin: 'wss://widgets.example.pom.run',
      isLocalhost: false,
    });
  });
});
