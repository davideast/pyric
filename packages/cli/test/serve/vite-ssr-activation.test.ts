/** The in-process activation the Vite plugin installs for server-rendered modules (#1123). */
import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ViteDevServer } from 'vite';
import { processActivation } from 'pyric/sandbox/internal';
import { attachViteSsrActivation, loopbackBase, viteSsrRefusal } from '../../src/serve/vite-ssr-activation.js';

/** A dev server whose HTTP server listens on `address`, or starts listening when told. */
function fakeServer(address: AddressInfo, listening = true): ViteDevServer & { listen(): void } {
  const http = Object.assign(new EventEmitter(), { listening, address: () => address });
  return {
    httpServer: http,
    listen() {
      http.listening = true;
      http.emit('listening');
    },
  } as unknown as ViteDevServer & { listen(): void };
}

const ipv4 = (address: string, port = 5173): AddressInfo => ({ address, family: 'IPv4', port });
const ipv6 = (address: string, port = 5173): AddressInfo => ({ address, family: 'IPv6', port });

let attached: Array<{ close(): void }> = [];

afterEach(() => {
  for (const activation of attached.splice(0).reverse()) activation.close();
});

function attach(server: ViteDevServer, hosted: boolean, env: Record<string, string | undefined> = {}) {
  const activation = attachViteSsrActivation(server, hosted, env);
  attached.push(activation);
  return activation;
}

describe('loopbackBase', () => {
  it('dials the address the server is bound to, and loopback for a wildcard bind', () => {
    expect(loopbackBase(ipv4('127.0.0.1'))).toBe('http://127.0.0.1:5173');
    expect(loopbackBase(ipv4('0.0.0.0', 4000))).toBe('http://127.0.0.1:4000');
    expect(loopbackBase(ipv6('::'))).toBe('http://127.0.0.1:5173');
    expect(loopbackBase(ipv6('::1'))).toBe('http://[::1]:5173');
  });
});

describe('attachViteSsrActivation', () => {
  it('names the dev server as the host once it listens', async () => {
    const server = fakeServer(ipv6('::1', 5174), false);
    attach(server, true);
    const activation = processActivation();
    expect(activation?.label).toBe("the Vite dev server's server-rendered modules");
    const host = activation!.host();
    server.listen();
    await expect(host).resolves.toBe('http://[::1]:5174');
  });

  it('answers from the newest server, so a restart replaces the host and closing the old one changes nothing', async () => {
    const first = attach(fakeServer(ipv4('127.0.0.1', 5001)), true);
    attach(fakeServer(ipv4('127.0.0.1', 5002)), true);
    first.close();
    await expect(processActivation()!.host()).resolves.toBe('http://127.0.0.1:5002');
  });

  it('removes the activation when the server in force closes', () => {
    attach(fakeServer(ipv4('127.0.0.1')), true).close();
    expect(processActivation()).toBeUndefined();
  });

  it('installs nothing when PYRIC_SANDBOX already activates the process', () => {
    attach(fakeServer(ipv4('127.0.0.1')), true, { PYRIC_SANDBOX: 'remote:http://127.0.0.1:9000' });
    expect(processActivation()).toBeUndefined();
  });

  it('refuses firebase-admin on a SharedWorker dev server without dialing, naming hosted: true', async () => {
    attach(fakeServer(ipv4('127.0.0.1')), false);
    const sandbox = processActivation()!.adminSandbox() as unknown as { ready: Promise<void> };
    await expect(sandbox.ready).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(sandbox.ready).rejects.toThrow('pyric({ hosted: true })');
  });

  it('gives the client SDKs a refusal for a host that is not the Node host', () => {
    attach(fakeServer(ipv4('127.0.0.1')), false);
    const error = processActivation()!.offHostError('the host at http://127.0.0.1:5173 is not the Node host');
    expect(error).toMatchObject({ code: 'failed-precondition' });
    expect(error.message).toBe(viteSsrRefusal('the host at http://127.0.0.1:5173 is not the Node host').message);
    expect(error.message).toContain('SharedWorker');
  });
});
