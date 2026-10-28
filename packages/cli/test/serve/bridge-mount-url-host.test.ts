/** The bridge's socket and MCP urls for a dev server bound to an IPv6 literal (`server.host: '::1'`). */
import { describe, expect, it } from 'bun:test';
import { createBridgeMount, originUrl, urlHost } from '../../src/serve/bridge-mount.js';

describe('bridge urls', () => {
  it('writes an IPv6 literal in brackets and leaves other hosts alone', () => {
    expect(urlHost('::1')).toBe('[::1]');
    expect(urlHost('[::1]')).toBe('[::1]');
    expect(urlHost('127.0.0.1')).toBe('127.0.0.1');
    expect(urlHost('localhost')).toBe('localhost');
  });

  it('gives a dev server on ::1 a socket url that parses', async () => {
    const mount = createBridgeMount({ projectDir: process.cwd() });
    try {
      const url = mount.wsUrl({ host: '::1', port: 5173 });
      expect(url).toBe('ws://[::1]:5173/__pyric/sandbox');
      expect(new URL(url).hostname).toBe('[::1]');
      expect(mount.mcpUrl({ host: '::1', port: 5173 })).toBe('http://[::1]:5173/__pyric/mcp');
    } finally {
      await mount.close();
    }
  });

  it('gives a dev server that serves HTTPS wss and https urls (#1220)', async () => {
    const mount = createBridgeMount({ projectDir: process.cwd() });
    try {
      expect(mount.wsUrl({ host: 'localhost', port: 5173, secure: true })).toBe('wss://localhost:5173/__pyric/sandbox');
      expect(mount.mcpUrl({ host: '::1', port: 5173, secure: true })).toBe('https://[::1]:5173/__pyric/mcp');
      expect(originUrl({ host: '127.0.0.1', port: 5173, secure: true })).toBe('https://127.0.0.1:5173');
      expect(originUrl({ host: '127.0.0.1', port: 5173 })).toBe('http://127.0.0.1:5173');
    } finally {
      await mount.close();
    }
  });
});
