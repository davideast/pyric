/**
 * Placeholder-to-finished-image upgrade for `/__pyric/assets/avatar/<uid>`,
 * owned by the dev runtime rather than by application code.
 *
 * A configured avatar source that does not answer synchronously makes the
 * server serve a placeholder immediately and cache the generated image when
 * it lands. Without this module the browser keeps showing the placeholder
 * until something re-requests the URL, which would push a poll into every
 * application that renders `<img src={user.photoURL}>`. Instead the server
 * broadcasts `avatar-ready` on the session event stream and the page reloads
 * the images that point at that uid. Application source stays plain Firebase.
 *
 * The page opens this connection in BOTH serve modes: in worker mode the
 * SharedWorker owns the rules stream and tabs open none, so this is the only
 * push channel a page has. It is spent deliberately — one per tab, against a
 * browser budget of roughly six connections per origin — which is why it
 * opens only when the payload's `avatarUpgrades` says a source is configured.
 * The generated default and static sets are final on their first request and
 * open nothing.
 *
 * There is deliberately no MutationObserver. An `img` added to the DOM after
 * generation finished fetches the finished image on its own first request;
 * only an element already showing a placeholder needs telling.
 */
import { AVATAR_ROUTE_PREFIX } from '../assets/avatar-url.js';

/** The session event stream `namespace.ts` serves. */
const EVENTS_URL = '/__pyric/events';

/** The cache-busting parameter a reload adds. The route ignores unknown
 *  query parameters, so it changes the URL without changing the request. */
const RELOAD_PARAM = 'pyric-upgrade';

/** The slice of `EventSource` this module uses, so a test can drive the
 *  listener without opening a connection. */
export interface AvatarEventStream {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export interface AvatarUpgradeHost {
  /** Defaults to the ambient `document`. */
  document?: Document;
  /** Defaults to opening a real `EventSource`. */
  openEventStream?: (url: string) => AvatarEventStream;
}

/** Distinct per reload, so two upgrades of one image both change its `src`
 *  (an unchanged `src` assignment fetches nothing). */
let reloadCounter = 0;

function openRealEventStream(url: string): AvatarEventStream {
  return new EventSource(url);
}

/** The document's own base for resolving an `img` src. A document with no
 *  window (a fragment parsed outside a browser) has no location to resolve
 *  against, so nothing can match and the caller stops. */
function documentBaseUrl(doc: Document): string | null {
  const view = doc.defaultView;
  if (!view) return null;
  return view.location.href;
}

/** The uid an avatar URL names, or `null` when the URL is not one of this
 *  server's avatar URLs. The segment is decoded before comparison, so a uid
 *  spelled with percent-encoding still matches the key the server sent. */
function avatarKeyOf(src: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(src, base);
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(AVATAR_ROUTE_PREFIX)) return null;
  const segment = url.pathname.slice(AVATAR_ROUTE_PREFIX.length);
  if (segment.length === 0 || segment.includes('/')) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null; // malformed percent-encoding: not a uid this server minted
  }
}

/** The key an `avatar-ready` frame names, or `null` for anything that is not
 *  one — a listener never throws on a payload it did not write. */
function avatarKeyFromEventData(data: unknown): string | null {
  if (typeof data !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const key = (parsed as { key?: unknown }).key;
  if (typeof key !== 'string' || key.length === 0) return null;
  return key;
}

/** Re-request the same avatar, preserving every parameter the mint put in the
 *  URL — the hints a source reads travel in the query string. */
function reloadImage(img: HTMLImageElement, base: string): void {
  const url = new URL(img.src, base);
  reloadCounter += 1;
  url.searchParams.set(RELOAD_PARAM, String(reloadCounter));
  img.src = url.toString();
}

function reloadAvatarImages(doc: Document, key: string): void {
  const base = documentBaseUrl(doc);
  if (base === null) return;
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    if (avatarKeyOf(img.src, base) === key) reloadImage(img, base);
  }
}

/**
 * Listen for finished avatar generations and refresh the images showing that
 * user's placeholder. A no-op when the server reports no configured source,
 * when there is no document, or in a host without `EventSource`.
 */
export function installAvatarUpgrades(enabled: boolean, host: AvatarUpgradeHost = {}): void {
  if (!enabled) return;

  let doc = host.document;
  if (!doc && typeof document !== 'undefined') doc = document;
  if (!doc) return;

  let open = host.openEventStream;
  if (!open && typeof EventSource !== 'undefined') open = openRealEventStream;
  if (!open) return;

  const stream = open(EVENTS_URL);
  const target = doc;
  stream.addEventListener('avatar-ready', (event) => {
    const key = avatarKeyFromEventData(event.data);
    if (key === null) return;
    reloadAvatarImages(target, key);
  });
}
