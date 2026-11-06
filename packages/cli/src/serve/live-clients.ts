/**
 * The clients connected to a live host, as the `clients` field of its health
 * report lists them: each browser profile, service worker and Node process,
 * with the page it is on, the user its last observed call ran as, and when
 * the host last heard from it.
 *
 * The host learns them from the frames the bridge hands it
 * (`live-host-state.ts`). The bridge stamps each frame with the platform the
 * connection attached as, and a page or service worker names its client in
 * its `appConfig`: the browser profile's id, or the service worker realm's.
 * A client is keyed by kind and client id, so a service worker is never
 * grouped with the pages of its profile, and the tabs of one profile are one
 * client. A Node process is one connection, so its connection id stands in.
 * Studio and any other platform is not a client of the app, and is left out.
 *
 * The page path comes from the page's presence frames; the client lists the
 * last one any of its pages reported. Each id is a label, never an authority.
 */
import { readObservedCall, type LiveHostStatus } from 'pyric/sandbox/internal';
import type { BridgeMessage } from '../bridge/protocol.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];
type LiveClientKind = LiveClient['kind'];

/** The most clients a host lists; a bound on what connections can grow. */
const MAX_CLIENTS = 64;
/** The longest client id or page path kept; a longer one is cut. */
const MAX_LABEL_LENGTH = 256;

const KINDS: ReadonlyMap<string, LiveClientKind> = new Map<string, LiveClientKind>([
  ['browser', 'browser'],
  ['service-worker', 'service-worker'],
  ['node', 'node'],
]);

interface ClientRecord {
  kind: LiveClientKind;
  clientId: string;
  label?: string;
  user: string | null;
  lastSeen: number;
  /** The connections this client has open. */
  sessions: Set<string>;
}

export interface LiveClients {
  /** One frame on its way from the bridge to the Node sandbox. */
  inbound(message: BridgeMessage): void;
  /** The clients field of the host's report: absent when none is connected. */
  field(): { clients?: LiveClient[] };
}

function clientKey(kind: LiveClientKind, clientId: string): string {
  return `${kind}\u0000${clientId}`;
}

function bounded(text: string): string {
  return text.slice(0, MAX_LABEL_LENGTH);
}

/** The path of a presence route: `/orders/7?tab=open#top` is `/orders/7`. */
function pagePath(route: string): string {
  return bounded(route.split(/[?#]/, 1)[0] ?? '');
}

/** The client id a frame's `appConfig` declares, or the connection's own. */
function declaredClientId(inner: Record<string, unknown>, clientSessionId: string, kind: LiveClientKind): string {
  const declared = inner.clientId;
  const isDeclared = kind !== 'node' && typeof declared === 'string' && declared !== '';
  return bounded(isDeclared ? (declared as string) : clientSessionId);
}

/** The route a presence register or update frame reports, if any. */
function presenceRoute(inner: Record<string, unknown>): string | undefined {
  const isPresence = inner.t === 'op' && (inner.method === 'presence.register' || inner.method === 'presence.update');
  const route = inner.route;
  return isPresence && typeof route === 'string' ? route : undefined;
}

/** The uid an observe frame's call ran as, null when signed out, or undefined for another frame or a malformed record. */
function observedUser(inner: Record<string, unknown>): string | null | undefined {
  if (inner.t !== 'observe') return undefined;
  try {
    return readObservedCall(inner.call).account?.uid ?? null;
  } catch {
    return undefined;
  }
}

function entryOf(record: ClientRecord): LiveClient {
  const label = record.label === undefined ? {} : { label: record.label };
  return { kind: record.kind, clientId: record.clientId, ...label, user: record.user, lastSeen: record.lastSeen };
}

export function createLiveClients(now: () => number): LiveClients {
  const clients = new Map<string, ClientRecord>();
  const sessionKeys = new Map<string, string>();

  const forget = (clientSessionId: string): void => {
    const key = sessionKeys.get(clientSessionId);
    if (key === undefined) return;
    sessionKeys.delete(clientSessionId);
    const record = clients.get(key);
    record?.sessions.delete(clientSessionId);
    if (record?.sessions.size === 0) clients.delete(key);
  };

  /** The client a connection belongs to: the one its `appConfig` named, else the one it first sent a frame as. */
  const recordFor = (clientSessionId: string, kind: LiveClientKind, inner: Record<string, unknown>): ClientRecord | undefined => {
    const isAppConfig = inner.t === 'appConfig';
    if (isAppConfig) forget(clientSessionId);
    const known = sessionKeys.get(clientSessionId);
    const clientId = declaredClientId(isAppConfig ? inner : {}, clientSessionId, kind);
    const key = known ?? clientKey(kind, clientId);
    const existing = clients.get(key);
    if (existing !== undefined) {
      existing.sessions.add(clientSessionId);
      sessionKeys.set(clientSessionId, key);
      return existing;
    }
    if (clients.size >= MAX_CLIENTS) return undefined;
    const record: ClientRecord = { kind, clientId, user: null, lastSeen: now(), sessions: new Set([clientSessionId]) };
    clients.set(key, record);
    sessionKeys.set(clientSessionId, key);
    return record;
  };

  const noteFrame = (clientSessionId: string, platform: string | undefined, inner: Record<string, unknown>): void => {
    const kind = platform === undefined ? undefined : KINDS.get(platform);
    if (kind === undefined) return;
    const record = recordFor(clientSessionId, kind, inner);
    if (record === undefined) return;
    record.lastSeen = now();
    const route = presenceRoute(inner);
    const isPage = kind === 'browser' && route !== undefined;
    if (isPage) record.label = pagePath(route);
    const user = observedUser(inner);
    if (user !== undefined) record.user = user;
  };

  return {
    inbound(message) {
      if (message.type === 'worker-client-disconnect') return forget(message.clientSessionId);
      const isClientFrame = message.type === 'worker-message' && message.clientSessionId !== undefined;
      if (!isClientFrame) return;
      noteFrame(message.clientSessionId as string, message.platform, message.message as unknown as Record<string, unknown>);
    },
    field() {
      const entries = [...clients.values()].map(entryOf);
      return entries.length === 0 ? {} : { clients: entries };
    },
  };
}
