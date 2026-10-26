/**
 * `pyric/storage/sw` — answers production Storage URLs from the sandbox, for an
 * app's own service worker.
 *
 * A page that loads a production download URL directly (`<img src>`, `fetch`)
 * never reaches the sandbox. The app's service worker sees that request, and
 * {@link sandboxStorageFetch} answers it from the host's byte route for the
 * same bucket and object, as {@link localStorageUrl} maps it.
 *
 * It answers every production Storage URL, so register it only in dev:
 *
 * ```ts
 * import { sandboxStorageFetch } from 'pyric/storage/sw';
 * self.addEventListener('fetch', (event) => {
 *   if (import.meta.env.DEV && sandboxStorageFetch(event)) return;
 * });
 * ```
 */
import { localStorageUrl } from './byte-route.js';

/** The part of a service worker `FetchEvent` the helper reads and answers. */
export interface StorageFetchEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

export interface SandboxStorageFetchOptions {
  /** The origin serving the sandbox's byte route. Defaults to the service worker's own origin. */
  readonly origin?: string;
}

/** The methods that read an object. Uploads and deletes go to production as written. */
const READ_METHODS = new Set(['GET', 'HEAD']);

/**
 * Answers `event` from the sandbox when it reads a production Storage object,
 * and returns whether it did. Any other request is left untouched for the
 * browser or the app's own handlers.
 *
 * The answer keeps the URL's `token` and drops production-only parameters such
 * as `generation`, as {@link localStorageUrl} documents. The request's method
 * and headers, such as `Range`, are carried to the byte route.
 */
export function sandboxStorageFetch(event: StorageFetchEvent, options: SandboxStorageFetchOptions = {}): boolean {
  const { request } = event;
  const reads = READ_METHODS.has(request.method);
  if (!reads) return false;
  const origin = options.origin ?? globalThis.location.origin;
  const localUrl = localStorageUrl(request.url, origin);
  if (localUrl === undefined) return false;
  event.respondWith(fetch(localUrl, { method: request.method, headers: request.headers }));
  return true;
}
