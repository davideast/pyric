import { describe, expect, it } from 'bun:test';
import { advertisedHost, advertisedUrl, formatUrlHost } from '../../src/serve/advertised-host.js';

describe('advertisedHost', () => {
  it('maps wildcard bind hosts to localhost', () => {
    for (const host of [
      '',
      '   ',
      '0',
      '0.0.0.0',
      '0.0.0.0.',
      '::',
      '[::]',
      '::0',
      '[::0]',
      '0:0:0:0:0:0:0:0',
      '[0:0:0:0:0:0:0:0]',
      '::ffff:0.0.0.0',
      '[::ffff:0.0.0.0]',
      '::ffff:0:0',
      '[::ffff:0:0]',
      '::FFFF:0.0.0.0',
    ]) {
      expect(advertisedHost(host), `host=${host}`).toBe('localhost');
    }
  });

  it('preserves explicit non-wildcard hosts', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]', '192.168.1.5', 'dev.local']) {
      expect(advertisedHost(host), `host=${host}`).toBe(host);
    }
  });
});

describe('formatUrlHost', () => {
  it('maps wildcard hosts to localhost and brackets bare IPv6 literals', () => {
    expect(formatUrlHost('0.0.0.0')).toBe('localhost');
    expect(formatUrlHost('::')).toBe('localhost');
    expect(formatUrlHost('[::]')).toBe('localhost');
    expect(formatUrlHost('::ffff:0.0.0.0')).toBe('localhost');
    expect(formatUrlHost('::1')).toBe('[::1]');
    expect(formatUrlHost('[::1]')).toBe('[::1]');
    expect(formatUrlHost('127.0.0.1')).toBe('127.0.0.1');
    expect(formatUrlHost('localhost')).toBe('localhost');
  });
});

describe('advertisedUrl', () => {
  it('rewrites wildcard hostnames to localhost while preserving scheme, port, path, and query', () => {
    expect(advertisedUrl('http://0.0.0.0:3473')).toBe('http://localhost:3473');
    expect(advertisedUrl('http://0.0.0.0:3473/')).toBe('http://localhost:3473/');
    expect(advertisedUrl('http://0.0.0.0:3473/__pyric/mcp')).toBe('http://localhost:3473/__pyric/mcp');
    expect(advertisedUrl('ws://[::]:5173/__pyric/sandbox?token=abc')).toBe('ws://localhost:5173/__pyric/sandbox?token=abc');
    expect(advertisedUrl('https://[::ffff:0.0.0.0]:8443/items#top')).toBe('https://localhost:8443/items#top');
  });

  it('leaves non-wildcard and unparseable strings unchanged', () => {
    expect(advertisedUrl('http://localhost:3473')).toBe('http://localhost:3473');
    expect(advertisedUrl('http://127.0.0.1:3473/__pyric/mcp')).toBe('http://127.0.0.1:3473/__pyric/mcp');
    expect(advertisedUrl('http://[::1]:5173')).toBe('http://[::1]:5173');
    expect(advertisedUrl('not a url')).toBe('not a url');
  });
});
