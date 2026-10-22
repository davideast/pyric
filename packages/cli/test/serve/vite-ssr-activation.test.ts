/** The in-process activation the Vite plugin installs for server-rendered modules (#1123). */
import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ViteDevServer } from 'vite';
import { processActivation } from 'pyric/sandbox/internal';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachViteSsrActivation, httpsCertificateRefusal, httpsUnderBunRefusal, loopbackBase, viteSsrRefusal } from '../../src/serve/vite-ssr-activation.js';

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

/** A dev server configured with `server.https`, as `@vitejs/plugin-basic-ssl` configures one. */
function fakeHttpsServer(address: AddressInfo, https: unknown): ViteDevServer & { listen(): void } {
  return Object.assign(fakeServer(address), { config: { server: { https } } }) as ViteDevServer & { listen(): void };
}

function selfSignedCert(): { cert: string; certPath: string; keyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-ssr-https-'));
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  return { cert: readFileSync(certPath, 'utf8'), certPath, keyPath };
}

const ipv4 = (address: string, port = 5173): AddressInfo => ({ address, family: 'IPv4', port });
const ipv6 = (address: string, port = 5173): AddressInfo => ({ address, family: 'IPv6', port });

let attached: Array<{ close(): void }> = [];

afterEach(() => {
  for (const activation of attached.splice(0).reverse()) activation.close();
});

/** Node checks the certificate pin; these tests run under Bun, which does not, so each says which it stands for. */
const NODE = { honorsCertificatePin: () => true };
const BUN = { honorsCertificatePin: () => false };

function attach(server: ViteDevServer, hosted: boolean, env: Record<string, string | undefined> = {}, runtime = NODE) {
  const activation = attachViteSsrActivation(server, hosted, env, runtime);
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

  it('dials https for a server that serves TLS', () => {
    expect(loopbackBase(ipv4('0.0.0.0', 4000), true)).toBe('https://127.0.0.1:4000');
    expect(loopbackBase(ipv6('::1'), true)).toBe('https://[::1]:5173');
  });
});

describe('an HTTPS dev server', () => {
  const { cert, certPath, keyPath } = selfSignedCert();

  it('is the host at its https url, and trusts its own certificate for that origin only', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { cert, key: 'unused' }), true);
    const activation = processActivation()!;
    await expect(activation.host()).resolves.toBe('https://127.0.0.1:5443');
    const trust = activation.hostTrust?.('wss://127.0.0.1:5443/__pyric/sandbox');
    expect(trust?.origin).toBe('https://127.0.0.1:5443');
    expect(trust?.ca).toEqual([cert.trim()]);
    expect(activation.hostTrust?.('https://127.0.0.1:5444/')).toBeUndefined();
    expect(activation.hostTrust?.('https://example.com/')).toBeUndefined();
  });

  it('reads a certificate given as a file path, as Vite does', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { cert: certPath, key: keyPath }), true);
    const activation = processActivation()!;
    await expect(activation.host()).resolves.toBe('https://127.0.0.1:5443');
    expect(activation.hostTrust?.('https://127.0.0.1:5443/')?.ca).toEqual([cert.trim()]);
  });

  it('refuses under Bun, naming HTTPS and Bun, and trusts nothing', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { cert, key: 'unused' }), true, {}, BUN);
    const activation = processActivation()!;
    await expect(activation.host()).rejects.toThrow(httpsUnderBunRefusal().message);
    expect(httpsUnderBunRefusal().message).toContain('serves HTTPS under Bun');
    expect(activation.hostTrust?.('https://127.0.0.1:5443/')).toBeUndefined();
  });

  it('refuses, naming HTTPS, when server.https.cert holds no readable PEM certificate', async () => {
    attach(fakeHttpsServer(ipv4('127.0.0.1', 5443), { pfx: Buffer.from('bundle') }), true);
    const activation = processActivation()!;
    await expect(activation.host()).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(activation.host()).rejects.toThrow(httpsCertificateRefusal().message);
    expect(httpsCertificateRefusal().message).toContain('serves HTTPS');
    expect(activation.hostTrust?.('https://127.0.0.1:5443/')).toBeUndefined();
  });

  it('trusts nothing for a plain HTTP server', async () => {
    attach(fakeServer(ipv4('127.0.0.1', 5173)), true);
    const activation = processActivation()!;
    await expect(activation.host()).resolves.toBe('http://127.0.0.1:5173');
    expect(activation.hostTrust?.('http://127.0.0.1:5173/')).toBeUndefined();
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

  it('gives firebase-admin one handle for the process, kept across dev servers', () => {
    const firstServer = attach(fakeServer(ipv4('127.0.0.1', 5001)), true);
    const first = processActivation()!.adminSandbox();
    firstServer.close();
    attach(fakeServer(ipv4('127.0.0.1', 5002)), true);
    expect(processActivation()!.adminSandbox()).toBe(first);
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
