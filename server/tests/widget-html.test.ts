import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIENT_INFO_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';
import {
  buildDevBootstrapHtml,
  clientMatches,
  getClientIdentity,
  inlineWidgetAssets,
  parseClientList,
  resolveWidgetOrigin,
  shouldInlineWidgetHtml,
} from '../src/widget-html.js';

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

describe('parseClientList', () => {
  it('falls back when unset', () => {
    expect(parseClientList(undefined, ['claude'])).toEqual(['claude']);
  });

  it('splits, trims, and lowercases entries', () => {
    expect(parseClientList(' Claude , LibreChat ,', [])).toEqual([
      'claude',
      'librechat',
    ]);
  });

  it('returns an empty list for an explicitly empty value', () => {
    expect(parseClientList('', ['claude'])).toEqual([]);
  });
});

describe('shouldInlineWidgetHtml', () => {
  const inlineClients = ['claude'];

  it('inlines when forced', () => {
    expect(
      shouldInlineWidgetHtml({
        clientInfo: { name: 'chatgpt' },
        inlineClients,
        forceInline: true,
      })
    ).toBe(true);
  });

  it('inlines for unidentified clients', () => {
    expect(
      shouldInlineWidgetHtml({ clientInfo: undefined, inlineClients })
    ).toBe(true);
  });

  it('inlines for clients matching the list (case-insensitive substring)', () => {
    expect(
      shouldInlineWidgetHtml({
        clientInfo: { name: 'Claude-AI' },
        inlineClients,
      })
    ).toBe(true);
    expect(
      shouldInlineWidgetHtml({
        clientInfo: { title: 'claude.ai web' },
        inlineClients,
      })
    ).toBe(true);
  });

  it('serves dev-server HTML to identified non-matching clients', () => {
    expect(
      shouldInlineWidgetHtml({ clientInfo: { name: 'chatgpt' }, inlineClients })
    ).toBe(false);
  });
});

describe('clientMatches', () => {
  it('matches on name or title, case-insensitive substring', () => {
    expect(clientMatches({ name: 'Claude-AI' }, ['claude'])).toBe(true);
    expect(clientMatches({ title: 'claude.ai web' }, ['claude'])).toBe(true);
    expect(clientMatches({ name: 'chatgpt' }, ['claude'])).toBe(false);
  });

  it('never matches unidentified clients or empty lists', () => {
    expect(clientMatches(undefined, ['claude'])).toBe(false);
    expect(clientMatches({ name: 'claude-ai' }, [])).toBe(false);
  });
});

describe('buildDevBootstrapHtml', () => {
  it('loads the widget module via dynamic import, not a static script src', () => {
    const html = buildDevBootstrapHtml(
      'echo',
      'https://widgets.example.pom.run'
    );

    expect(html).toContain(
      'import("https://widgets.example.pom.run/virtual:widget-echo.js")'
    );
    expect(html).toContain('id="echo-root"');
    expect(html).not.toMatch(/<script[^>]*src=/);
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

describe('inlineWidgetAssets', () => {
  let assetsDir: string;

  beforeAll(() => {
    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-html-test-'));
    fs.writeFileSync(path.join(assetsDir, 'echo-abc123.js'), 'console.log(1);');
    fs.writeFileSync(path.join(assetsDir, 'echo-def456.css'), 'body{margin:0}');
  });

  afterAll(() => {
    fs.rmSync(assetsDir, { recursive: true, force: true });
  });

  const html = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<link rel="modulepreload" href="http://localhost:4444/echo-abc123.js">',
    '<link rel="preload" href="http://localhost:4444/echo-def456.css" as="style">',
    '<script type="module" src="http://localhost:4444/echo-abc123.js"></script>',
    '<link rel="stylesheet" href="http://localhost:4444/echo-def456.css">',
    '</head>',
    '<body><div id="echo-root"></div></body>',
    '</html>',
  ].join('\n');

  it('inlines JS and CSS, strips preloads, and injects Google Fonts', () => {
    const result = inlineWidgetAssets(html, assetsDir);

    expect(result).toContain('data:text/javascript;base64,');
    expect(result).toContain('<style>body{margin:0}</style>');
    expect(result).not.toContain('modulepreload');
    expect(result).not.toContain('rel="preload"');
    expect(result).not.toContain('localhost');
    expect(result).toContain('fonts.googleapis.com');
  });

  it('leaves tags referencing missing assets untouched', () => {
    const missing = html.replaceAll('echo-abc123.js', 'gone.js');
    const result = inlineWidgetAssets(missing, assetsDir);

    expect(result).toContain('src="http://localhost:4444/gone.js"');
  });
});
