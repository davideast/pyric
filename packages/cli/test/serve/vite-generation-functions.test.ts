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

function originCheck(allowedHosts: true | string[]): ViteFunctionsDevelopmentOptions['allowsAppOrigin'] {
  let captured: ViteFunctionsDevelopmentOptions | undefined;
  const server = {
    config: { server: { host: 'localhost', allowedHosts }, logger: {} },
    httpServer: {},
    middlewares: { use: () => undefined },
    watcher: {},
  } as unknown as ViteDevServer;
  attachViteGenerationFunctions({
    server,
    projectDir: '/project',
    cliRoot: '/cli',
    bridge: {} as BridgeMount,
    resolved: { options: {}, project: { sourceDir: '/project/functions', entry: '/project/functions/index.js' }, projectId: 'demo' },
    registerModuleUrl: () => 'file:///register.js',
    fileExists: () => false,
    attach: (options) => {
      captured = options;
      return { close: async () => undefined };
    },
  });
  if (!captured) throw new Error('attach was not called');
  return captured.allowsAppOrigin;
}

const request = (host: string, origin?: string): IncomingMessage =>
  ({ headers: { host, ...(origin === undefined ? {} : { origin }) }, socket: { localPort: 5173 } }) as unknown as IncomingMessage;

describe('the Vite plane Origin check for private functions', () => {
  test('with allowedHosts: true, only a page on the host the request names is the app', () => {
    const allows = originCheck(true);
    expect(allows(request('dev.tunnel.example', 'https://dev.tunnel.example'))).toBe(true);
    expect(allows(request('localhost:5173', 'http://localhost:5173'))).toBe(true);
    expect(allows(request('dev.tunnel.example'))).toBe(true);
    expect(allows(request('dev.tunnel.example', 'https://attacker.example'))).toBe(false);
    expect(allows(request('localhost:5173', 'http://localhost:3000'))).toBe(false);
    expect(allows(request('localhost:5173', 'not a url'))).toBe(false);
  });

  test('otherwise, the Origin must be a loopback or allowed host on the dev server\'s port', () => {
    const allows = originCheck(['dev.tunnel.example']);
    expect(allows(request('localhost:5173', 'http://localhost:5173'))).toBe(true);
    expect(allows(request('localhost:5173', 'http://localhost:3000'))).toBe(false);
    expect(allows(request('dev.tunnel.example', 'https://dev.tunnel.example'))).toBe(true);
    expect(allows(request('localhost:5173', 'https://attacker.example'))).toBe(false);
  });
});
