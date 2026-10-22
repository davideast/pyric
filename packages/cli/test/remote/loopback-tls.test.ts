/** Trust for one loopback dial to an HTTPS dev server in the same process (#1220). */
import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostTrustFor, isTrustedOrigin } from '../../src/remote/loopback-tls.js';

/** A self-signed certificate for `localhost`, as `@vitejs/plugin-basic-ssl` generates one. */
function selfSigned(dir: string, name: string): { key: string; cert: string } {
  const keyPath = join(dir, `${name}.key`);
  const certPath = join(dir, `${name}.pem`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

const dir = mkdtempSync(join(tmpdir(), 'pyric-loopback-tls-'));
const own = selfSigned(dir, 'own');
selfSigned(dir, 'other');

describe('hostTrustFor', () => {
  it('reads the certificate from server.https.cert, whether it is a string, a Buffer, or a PEM that also holds the key', () => {
    const fromString = hostTrustFor('https://127.0.0.1:5173/', { cert: own.cert, key: own.key });
    expect(fromString?.origin).toBe('https://127.0.0.1:5173');
    expect(fromString?.ca).toHaveLength(1);
    const fromBuffer = hostTrustFor('https://127.0.0.1:5173', { cert: Buffer.from(own.cert) });
    expect(fromBuffer?.fingerprint256).toBe(fromString!.fingerprint256);
    const combined = `${own.key}\n${own.cert}`;
    expect(hostTrustFor('https://127.0.0.1:5173', { cert: combined, key: combined })?.ca).toEqual(fromString!.ca);
  });

  it('has nothing to trust without a PEM certificate', () => {
    expect(hostTrustFor('https://127.0.0.1:5173', { pfx: Buffer.from('bundle') })).toBeNull();
    expect(hostTrustFor('https://127.0.0.1:5173', true)).toBeNull();
  });

  it('covers its own origin, over https and wss, and no other', () => {
    const trust = hostTrustFor('https://127.0.0.1:5173', { cert: own.cert })!;
    expect(isTrustedOrigin(trust, 'https://127.0.0.1:5173/__pyric/init.json')).toBe(true);
    expect(isTrustedOrigin(trust, 'wss://127.0.0.1:5173/__pyric/sandbox')).toBe(true);
    expect(isTrustedOrigin(trust, 'https://127.0.0.1:5174/')).toBe(false);
    expect(isTrustedOrigin(trust, 'http://127.0.0.1:5173/')).toBe(false);
    expect(isTrustedOrigin(trust, 'https://example.com/')).toBe(false);
  });
});

// The dials run under Node, the runtime a Vite dev server and its
// server-rendered modules use, against the built module.
describe('the dials, under Node', () => {
  const run = spawnSync(process.env.PYRIC_TEST_NODE ?? 'node', [join(import.meta.dir, 'fixtures', 'loopback-tls-node.mjs'), dir], {
    encoding: 'utf8', timeout: 20_000,
  });
  const outcomes = (): Record<string, { ok: boolean; value?: unknown; message?: string }> => {
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout.trim()) as Record<string, { ok: boolean; value?: unknown; message?: string }>;
  };

  it('a fetch reaches the server presenting its own certificate, with method, headers and body', () => {
    expect(outcomes().fetch).toEqual({
      ok: true,
      value: { status: 200, method: 'PUT', body: { path: '/upload?x=1', body: 'bytes', token: 't' } },
    });
  });

  it('a socket reaches the server over wss trusting its own certificate', () => {
    expect(outcomes().socket).toEqual({ ok: true, value: 'hello' });
  });

  it('a server on the trusted origin presenting another certificate is refused, by fetch and socket', () => {
    expect(outcomes().fetchImpostor.ok).toBe(false);
    expect(outcomes().socketImpostor.ok).toBe(false);
  });

  it('every other dial verifies as before: another origin, the global fetch, a socket without the trust', () => {
    expect(outcomes().fetchOtherOrigin.ok).toBe(false);
    expect(outcomes().globalFetch.ok).toBe(false);
    expect(outcomes().socketWithoutTrust.ok).toBe(false);
  });
});
