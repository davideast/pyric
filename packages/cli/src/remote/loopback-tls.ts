/**
 * Trust for the loopback dials a process makes to a Vite dev server in the
 * same process that serves HTTPS (#1220).
 *
 * Server-rendered modules reach the dev server they run in over loopback
 * (`vite-ssr-activation.ts`). When that server serves HTTPS with a
 * self-signed certificate, the default trust store refuses it. This module
 * trusts that one server's own certificate, read from `server.https`, for
 * dials to that one origin: the chain must verify against the server's own
 * certificates, and the leaf it presents must be the configured one (pinned
 * by its SHA-256 fingerprint, in place of the hostname check a loopback
 * address cannot pass). Every other dial, and the process's default TLS
 * verification, are left alone.
 *
 * The pin runs in `checkServerIdentity`, which Node calls and Bun (1.3)
 * does not, so a Bun process is refused this trust (`honorsCertificatePin`).
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { ConnectionOptions, PeerCertificate } from 'node:tls';
import type { HostTrust } from 'pyric/sandbox/internal';
import { httpOriginOf } from '../serve/worker/client/http-origin.js';

/** The fetch shape the hosted client calls. */
export type HostFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Reads a file named in `server.https`, or undefined when there is none. */
export type ReadCertificateFile = (path: string) => string | undefined;

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----/;

/** As Vite reads `server.https` files: a path resolved against the working directory. */
const readFromWorkingDirectory: ReadCertificateFile = (path) => {
  try {
    return readFileSync(resolve(path), 'utf8');
  } catch {
    return undefined;
  }
};

/** A string with no PEM block is a file path, as Vite reads it; a file that cannot be read leaves the string. */
function pemText(value: string, readFile: ReadCertificateFile): string {
  const isPem = PEM_BLOCK.test(value);
  if (isPem) return value;
  return readFile(value) ?? value;
}

function pemTexts(value: unknown, readFile: ReadCertificateFile): string[] {
  if (typeof value === 'string') return [pemText(value, readFile)];
  if (value instanceof Uint8Array) return [Buffer.from(value).toString('utf8')];
  if (Array.isArray(value)) return value.flatMap((item) => pemTexts(item, readFile));
  const isPemObject = typeof value === 'object' && value !== null && 'pem' in value;
  if (isPemObject) return pemTexts((value as { pem: unknown }).pem, readFile);
  return [];
}

function certificatesOf(value: unknown, readFile: ReadCertificateFile): string[] {
  return pemTexts(value, readFile).flatMap((text) => text.match(PEM_CERTIFICATE) ?? []);
}

function fingerprintOf(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint256;
  } catch {
    return null;
  }
}

/**
 * The trust for a server at `origin` configured with `httpsOptions`
 * (`server.config.server.https`), or null when they carry no PEM
 * certificate pyric can read (a `pfx` bundle, a malformed certificate).
 * Only the first certificate of `cert` is pinned.
 */
export function hostTrustFor(
  origin: string,
  httpsOptions: unknown,
  readFile: ReadCertificateFile = readFromWorkingDirectory,
): HostTrust | null {
  const hasOptions = typeof httpsOptions === 'object' && httpsOptions !== null;
  const options = hasOptions ? (httpsOptions as { cert?: unknown; ca?: unknown }) : {};
  const presented = certificatesOf(options.cert, readFile);
  const leaf = presented[0];
  const hasNoCertificate = leaf === undefined;
  if (hasNoCertificate) return null;
  const fingerprint256 = fingerprintOf(leaf);
  const isMalformed = fingerprint256 === null;
  if (isMalformed) return null;
  const ca = [...presented, ...certificatesOf(options.ca, readFile)];
  return { origin: new URL(origin).origin, ca, fingerprint256 };
}

/** Whether this runtime runs `checkServerIdentity`, where the pin is checked. Bun does not. */
export function honorsCertificatePin(): boolean {
  return !('Bun' in globalThis);
}

/** Whether `url` is on the origin `trust` covers. */
export function isTrustedOrigin(trust: HostTrust, url: string | URL): boolean {
  return httpOriginOf(url) === trust.origin;
}

/** TLS options for one dial to the trusted server: its own certificates, its pinned leaf. */
export function tlsOptionsFor(trust: HostTrust): ConnectionOptions {
  const options: ConnectionOptions & { allowPartialTrustChain: boolean } = {
    ca: [...trust.ca],
    // A leaf issued by a local CA (mkcert) is trusted as configured, without its root.
    allowPartialTrustChain: true,
    checkServerIdentity: (_host: string, certificate: PeerCertificate) => {
      const isPinnedLeaf = certificate.fingerprint256 === trust.fingerprint256;
      if (isPinnedLeaf) return undefined;
      return new Error(`pyric: ${trust.origin} presented a certificate other than the dev server's own (server.https.cert).`);
    },
  };
  return options;
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(name, item);
  }
  return result;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/**
 * A fetch that sends requests for the trusted origin over `node:https` with
 * {@link tlsOptionsFor}, and every other request through the global fetch.
 * The response body streams as the global fetch's does; redirects are not
 * followed (the host's routes answer without them).
 */
export function trustedFetch(trust: HostTrust): HostFetch {
  const agent = new Agent(tlsOptionsFor(trust));
  return async (input, init = {}) => {
    const isOtherOrigin = !isTrustedOrigin(trust, input);
    if (isOtherOrigin) return fetch(input, init);
    const hasBody = init.body !== undefined && init.body !== null;
    const body = hasBody ? Buffer.from(await new Response(init.body).arrayBuffer()) : undefined;
    const headers = Object.fromEntries(new Headers(init.headers));
    return new Promise<Response>((resolveResponse, reject) => {
      const request = httpsRequest(new URL(input), {
        method: init.method ?? 'GET',
        headers,
        agent,
        signal: init.signal ?? undefined,
      }, (response) => {
        const status = response.statusCode ?? 502;
        const hasNoBody = NULL_BODY_STATUSES.has(status);
        if (hasNoBody) response.resume();
        const stream: BodyInit | null = hasNoBody ? null : (Readable.toWeb(response) as unknown as BodyInit);
        resolveResponse(new Response(stream, {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders(response.headers),
        }));
      });
      request.on('error', reject);
      request.end(body);
    });
  };
}
