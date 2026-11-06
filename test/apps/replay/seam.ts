// Points the real `firebase` SDK at a replay server with no change to the
// app's code: `globalThis.fetch` is wrapped so a request for a replayed Google
// host goes to `<origin>/<host><path>` instead. Every other request to a host
// that is not loopback is refused, so nothing reaches Google even when the
// network is up.
//
// Install it before the SDK loads. `@firebase/auth` takes `fetch` when it is
// imported, and the Firestore web SDK's WebChannel reads `globalThis.fetch`
// on each request. This lives in the test harness only: no package a user
// installs has a host seam.
import { REPLAYED_HOSTS } from './server.ts';

/** `fetch` as it was before the seam, for a recorder's own upstream calls. */
export const passThroughFetch: typeof fetch = globalThis.fetch.bind(globalThis);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

let target: string | null = null;
let installed = false;

/** Sends replayed Google hosts to `origin` from now on. Returns a function that stops routing them. */
export function routeFirebaseTo(origin: string): () => void {
  installSeam();
  target = origin;
  return () => {
    if (target === origin) target = null;
  };
}

/** The URL a request for `url` goes to under the seam. Throws for a host it refuses. */
export function rewrite(url: string): string {
  const parsed = new URL(url);
  if (LOOPBACK.has(parsed.hostname)) return url;
  if (!REPLAYED_HOSTS.includes(parsed.hostname)) throw new Error(`pyric replay seam: refused a request to ${parsed.host}`);
  if (target === null) throw new Error(`pyric replay seam: no replay server is routed for ${parsed.host}`);
  return `${target}/${parsed.hostname}${parsed.pathname}${parsed.search}`;
}

function installSeam(): void {
  if (installed) return;
  installed = true;
  const routed = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    try {
      return passThroughFetch(new Request(rewrite(request.url), request));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  globalThis.fetch = Object.assign(routed, { preconnect: () => {} }) as typeof fetch;
}
