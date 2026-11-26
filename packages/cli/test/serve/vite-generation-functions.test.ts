/**
 * The Origin check the Vite plane hands the Functions gateway for private
 * functions, under each `server.allowedHosts` setting.
 */
import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import type { ViteDevServer } from 'vite';
import type { BridgeMount } from '../../src/serve/bridge-mount.js';
import type { ViteFunctionsDevelopmentOptions } from '../../src/serve/vite-functions-development.js';
import { attachViteGenerationFunctions } from '../../src/serve/vite-generation-functions.js';

function captureOptions(
  allowedHosts: true | string[],
  opts: { https?: boolean; extraAllowedHosts?: string[] } = {},
): ViteFunctionsDevelopmentOptions {
  let captured: ViteFunctionsDevelopmentOptions | undefined;
  const serverConfig: Record<string, unknown> = { host: 'localhost', allowedHosts };
  if (opts.https === true) serverConfig.https = {};
  const server = {
    config: { server: serverConfig, logger: {} },
    httpServer: {},
    middlewares: { use: () => undefined },
    watcher: {},
  } as unknown as ViteDevServer;
  attachViteGenerationFunctions({
    server,
    projectDir: '/project',
    cliRoot: '/cli',
    bridge: {} as BridgeMount,
    allowedHosts: opts.extraAllowedHosts,
    resolved: { options: {}, project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' }, projectId: 'demo' },
    registerModuleUrl: () => 'file:///register.js',
    fileExists: () => false,
    attach: (options) => {
      captured = options;
      return { close: async () => undefined };
    },
  });
  if (!captured) throw new Error('attach was not called');
  return captured;
}

function originCheck(
  allowedHosts: true | string[],
  opts: { https?: boolean; extraAllowedHosts?: string[] } = {},
): ViteFunctionsDevelopmentOptions['allowsAppOrigin'] {
  return captureOptions(allowedHosts, opts).allowsAppOrigin;
}

const request = (
  host: string,
  origin?: string,
  extraHeaders: Record<string, string> = {},
  socketOpts: { encrypted?: boolean } = {},
): IncomingMessage => {
  const headers: Record<string, string> = { host, ...extraHeaders };
  if (origin !== undefined) headers.origin = origin;
  const socket: Record<string, unknown> = { localPort: 5173 };
  if (socketOpts.encrypted !== undefined) socket.encrypted = socketOpts.encrypted;
  return { headers, socket } as unknown as IncomingMessage;
};

describe('the Vite plane Origin check for private functions', () => {
  test('ignores server.allowedHosts: true on DNS-rebinding Host checks and private Origin checks', () => {
    const captured = captureOptions(true);
    const allows = captured.allowsAppOrigin;
    const isAllowed = captured.isAllowedRequest;

    // DNS-rebinding Host check ignores Vite server.allowedHosts: true.
    expect(isAllowed(request('localhost:5173'))).toBe(true);
    expect(isAllowed(request('127.0.0.1:5173'))).toBe(true);
    expect(isAllowed(request('dev.tunnel.example'))).toBe(false);
    expect(isAllowed(request('attacker.example:5173'))).toBe(false);

    // Private Origin check also ignores server.allowedHosts: true unless explicitly listed.
    expect(allows(request('localhost:5173', 'http://localhost:5173'))).toBe(true);
    expect(allows(request('localhost:5173'))).toBe(true);
    expect(allows(request('dev.tunnel.example', 'https://dev.tunnel.example'))).toBe(false);
    expect(allows(request('dev.tunnel.example', 'https://attacker.example'))).toBe(false);
    expect(allows(request('localhost:5173', 'http://localhost:3000'))).toBe(false);
    expect(allows(request('localhost:5173', 'not a url'))).toBe(false);

    // Explicit allowedHosts still work alongside server.allowedHosts: true.
    const explicit = captureOptions(true, { extraAllowedHosts: ['dev.tunnel.example'] });
    expect(explicit.isAllowedRequest(request('dev.tunnel.example'))).toBe(true);
    expect(explicit.isAllowedRequest(request('attacker.example'))).toBe(false);
    expect(explicit.allowsAppOrigin(request('dev.tunnel.example', 'https://dev.tunnel.example'))).toBe(true);

    // Fail closed on empty Origin, cross-scheme loopback Origin, userinfo/path, and cross-site metadata.
    expect(allows(request('127.0.0.1:5173', ''))).toBe(false);
    expect(allows(request('127.0.0.1:5173', '', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(allows(request('127.0.0.1:5173', 'https://127.0.0.1:5173'))).toBe(false);
    expect(allows(request('localhost:5173', 'https://localhost:5173'))).toBe(false);
    expect(allows(request('[::1]:5173', 'https://[::1]:5173'))).toBe(false);
    expect(allows(request('localhost:5173', 'http://attacker.example@localhost:5173'))).toBe(false);
    expect(allows(request('localhost:5173', 'http://localhost:5173/extra'))).toBe(false);
    expect(allows(request('localhost:5173', 'http://localhost:5173', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  test('otherwise, the Origin must be a loopback or allowed host on the dev server\'s port and scheme', () => {
    const allows = originCheck(['dev.tunnel.example']);
    expect(allows(request('localhost:5173', 'http://localhost:5173'))).toBe(true);
    expect(allows(request('localhost:5173', 'http://localhost:3000'))).toBe(false);
    expect(allows(request('dev.tunnel.example', 'https://dev.tunnel.example'))).toBe(true);
    expect(allows(request('localhost:5173', 'https://attacker.example'))).toBe(false);

    // Reject empty Origin, cross-scheme loopback Origin, and cross-site Fetch Metadata.
    expect(allows(request('127.0.0.1:5173', ''))).toBe(false);
    expect(allows(request('127.0.0.1:5173', '', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(allows(request('127.0.0.1:5173', 'https://127.0.0.1:5173'))).toBe(false);
    expect(allows(request('localhost:5173', 'https://localhost:5173'))).toBe(false);
    expect(allows(request('[::1]:5173', 'https://[::1]:5173'))).toBe(false);
    expect(allows(request('127.0.0.1:5173', 'http://127.0.0.1:5173', { 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  test('rejects http:// Origin downgrades when the Vite listener uses HTTPS', () => {
    const allowsAny = originCheck(true, { https: true });
    expect(allowsAny(request('127.0.0.1:5173', 'https://127.0.0.1:5173', {}, { encrypted: true }))).toBe(true);
    expect(allowsAny(request('127.0.0.1:5173', 'http://127.0.0.1:5173', {}, { encrypted: true }))).toBe(false);
    expect(allowsAny(request('dev.tunnel.example', 'http://dev.tunnel.example', {}, { encrypted: true }))).toBe(false);

    const allowsListed = originCheck(['dev.tunnel.example'], { https: true });
    expect(allowsListed(request('127.0.0.1:5173', 'https://127.0.0.1:5173', {}, { encrypted: true }))).toBe(true);
    expect(allowsListed(request('127.0.0.1:5173', 'http://127.0.0.1:5173', {}, { encrypted: true }))).toBe(false);
  });
});
