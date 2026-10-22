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
 */
import { X509Certificate } from 'node:crypto';
import { Agent, request as httpsRequest } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import type { ConnectionOptions, PeerCertificate } from 'node:tls';
import type { HostTrust } from 'pyric/sandbox/internal';

/** The fetch shape the hosted client calls. */
export type HostFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function pemTexts(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value instanceof Uint8Array) return [Buffer.from(value).toString('utf8')];
  if (Array.isArray(value)) return value.flatMap(pemTexts);
  const isPemObject = typeof value === 'object' && value !== null && 'pem' in value;
  if (isPemObject) return pemTexts((value as { pem: unknown }).pem);
  return [];
}

function certificatesOf(value: unknown): string[] {
  return pemTexts(value).flatMap((text) => text.match(PEM_CERTIFICATE) ?? []);
}

/**
 * The trust for a server at `origin` configured with `httpsOptions`
 * (`server.config.server.https`), or null when they carry no PEM
 * certificate pyric can read (a `pfx` bundle, say).
 */
export function hostTrustFor(origin: string, httpsOptions: unknown): HostTrust | null {
  const hasOptions = typeof httpsOptions === 'object' && httpsOptions !== null;
  const options = hasOptions ? (httpsOptions as { cert?: unknown; ca?: unknown }) : {};
  const presented = certificatesOf(options.cert);
  const leaf = presented[0];
  const hasNoCertificate = leaf === undefined;
  if (hasNoCertificate) return null;
  const ca = [...presented, ...certificatesOf(options.ca)];
  return { origin: new URL(origin).origin, ca, fingerprint256: new X509Certificate(leaf).fingerprint256 };
}

/** The origin a url is served from, with a socket's scheme read as its HTTP one. */
function httpOrigin(url: string | URL): string {
  const parsed = new URL(url);
  const isSocket = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  if (isSocket) parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return parsed.origin;
}

/** Whether `url` is on the origin `trust` covers. */
export function isTrustedOrigin(trust: HostTrust, url: string | URL): boolean {
  return httpOrigin(url) === trust.origin;
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

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A fetch that sends requests for the trusted origin over `node:https` with
 * {@link tlsOptionsFor}, and every other request through the global fetch.
 */
export function trustedFetch(trust: HostTrust): HostFetch {
  const agent = new Agent(tlsOptionsFor(trust));
  return async (input, init = {}) => {
    const isOtherOrigin = !isTrustedOrigin(trust, input);
    if (isOtherOrigin) return fetch(input, init);
    const hasBody = init.body !== undefined && init.body !== null;
    const body = hasBody ? Buffer.from(await new Response(init.body).arrayBuffer()) : undefined;
    const headers = Object.fromEntries(new Headers(init.headers));
    return new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(new URL(input), {
        method: init.method ?? 'GET',
        headers,
        agent,
        signal: init.signal ?? undefined,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 502;
          const hasNoBody = NULL_BODY_STATUSES.has(status);
          resolve(new Response(hasNoBody ? null : Buffer.concat(chunks), {
            status,
            statusText: response.statusMessage,
            headers: responseHeaders(response.headers),
          }));
        });
      });
      request.on('error', reject);
      request.end(body);
    });
  };
}
