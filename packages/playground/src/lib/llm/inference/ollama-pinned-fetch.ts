/**
 * Node-only fetch that connects to a caller-vetted address.
 *
 * The SSRF guard resolves the base URL's hostname and classifies every
 * answer. A plain `fetch` afterwards resolves the name a second time, and
 * a hostile DNS server can answer differently (DNS rebinding). This
 * request instead supplies a `lookup` that always returns the vetted
 * address, so the connection goes to the address that was checked. The
 * request still addresses the original hostname, so the Host header and
 * the TLS server name are those of the URL.
 *
 * Imported lazily from the server path only; the browser bundle never
 * references `node:*`.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export interface PinnedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type PinnedFetch = (
  url: string,
  init: PinnedFetchInit,
  address: string,
) => Promise<Response>;

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

export const pinnedFetch: PinnedFetch = (url, init, address) =>
  new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const family = isIP(address) === 6 ? 6 : 4;
    const req = send(
      target,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(init.signal ? { signal: init.signal } : {}),
        lookup: (_hostname, options, callback) => {
          if (options && (options as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
              null,
              [{ address, family }],
            );
          } else {
            callback(null, address, family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          reject(new Error(`redirect not followed (${status})`));
          return;
        }
        resolve(
          new Response(
            status === 204 || status === 205
              ? null
              : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
            {
              status,
              statusText: res.statusMessage ?? '',
              headers: toHeaders(res.headers),
            },
          ),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
