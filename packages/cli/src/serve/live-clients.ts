/**
 * The clients connected to a live host, as the `clients` field of its health
 * report lists them: each browser profile, service worker and Node process,
 * with the page it is on, the user its last observed call ran as, and when
 * the host last heard from it.
 *
 * The host learns them from the frames the bridge hands it
 * (`live-host-state.ts`). The bridge stamps each frame with the platform the
 * connection attached as, and a page or service worker names its client in
 * its `appConfig`, or a page that sends none on its event subscription: the
 * browser profile's id, or the service worker realm's. A client is keyed by
 * kind and client id, so a service worker is never grouped with the pages of
 * its profile, and the tabs of one profile are one client. A Node process is
 * one connection, and the Node sandbox names it by that connection's
 * activity journey id (`worker/host/caller.ts`); the list names it by the
 * same id, read from the sandbox once it runs (`readClientIds`), so a
 * client's id is the `caller.clientId` its events carry. Until then its
 * connection id stands in. Studio and any other platform is not a client of
 * the app, and is left out.
 *
 * The page path comes from the page's presence frames; the client lists the
 * last one any of its pages reported. Each id is a label, never an authority.
 *
 * A Node process under the live register sends what it left unobserved, the
 * whole lists each time one changes (the `unobserved` frame). Its client
 * lists the last ones it sent, each absent when empty, and they go with the
 * client when it disconnects. Lists that are not names in their shape and
 * bounds (`readNodeUnobservedLists`) are not kept, and the Node sandbox
 * refuses that frame.
 *
 * A page sends its signed-in user's email with its presence register frame,
 * and again with an update when the user changes. The host keeps it in this
 * module's memory only: it deletes the field from the frame before the frame
 * goes on to the Node sandbox, so it never reaches call records, the event
 * stream or a capture. A page's presence disconnect (a closed or reloaded
 * tab) drops its connection at once, as the bridge's own disconnect does.
 */
import { readNodeUnobservedLists, readObservedCall, type LiveHostStatus, type NodeUnobservedLists } from 'pyric/sandbox/internal';
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
  email?: string;
  lastSeen: number;
  /** The connections this client has open. */
  sessions: Set<string>;
  /** What a Node process last reported it left unobserved. */
  unobserved?: NodeUnobservedLists;
}

/** The client id the Node sandbox stamps on one connection's events, or undefined when it names none. */
export type SandboxClientIds = (clientSessionId: string) => string | undefined;

export interface LiveClients {
  /** One frame on its way from the bridge to the Node sandbox. */
  inbound(message: BridgeMessage): void;
  /** Name each Node process by the client id the Node sandbox stamps on its events. */
  readClientIds(lookup: SandboxClientIds): void;
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

/**
 * Whether a frame declares its connection's client: an `appConfig`, or the
 * event subscription of a page that sends no `appConfig`, which names its
 * profile's id there (`worker/client/studio.ts`).
 */
function declaresClient(inner: Record<string, unknown>): boolean {
  if (inner.t === 'appConfig') return true;
  return inner.t === 'sub' && typeof inner.clientId === 'string' && inner.clientId !== '';
}

/** The route a presence register or update frame reports, if any. */
function presenceRoute(inner: Record<string, unknown>): string | undefined {
  const isPresence = inner.t === 'op' && (inner.method === 'presence.register' || inner.method === 'presence.update');
  const route = inner.route;
  return isPresence && typeof route === 'string' ? route : undefined;
}

/** Whether a frame is a page's presence disconnect. */
function isPresenceDisconnect(inner: Record<string, unknown>): boolean {
  return inner.t === 'op' && inner.method === 'presence.disconnect';
}

/**
 * The email a presence frame carries, taken off the frame: a string, null
 * for signed out, or undefined when the frame carries none.
 */
function takePresenceEmail(inner: Record<string, unknown>): string | null | undefined {
  const isPresence = inner.t === 'op' && (inner.method === 'presence.register' || inner.method === 'presence.update');
  const carriesEmail = isPresence && 'email' in inner;
  if (!carriesEmail) return undefined;
  const email = inner.email;
  delete inner.email;
  const isEmail = typeof email === 'string' && email !== '';
  return isEmail ? bounded(email) : null;
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

/** The lists an `unobserved` frame from a Node process carries, or undefined for another frame or malformed lists. */
function unobservedLists(kind: LiveClientKind, inner: Record<string, unknown>): NodeUnobservedLists | undefined {
  const isNodeLists = kind === 'node' && inner.t === 'unobserved';
  if (!isNodeLists) return undefined;
  return readNodeUnobservedLists(inner) ?? undefined;
}

/** A Node process's id as its events carry it: the one the Node sandbox stamps, once it names one. */
function reportedClientId(record: ClientRecord, sandboxIds: SandboxClientIds): string {
  if (record.kind !== 'node') return record.clientId;
  const [session] = record.sessions;
  const stamped = session === undefined ? undefined : sandboxIds(session);
  return stamped === undefined ? record.clientId : bounded(stamped);
}

function entryOf(record: ClientRecord, sandboxIds: SandboxClientIds): LiveClient {
  const label = record.label === undefined ? {} : { label: record.label };
  const email = record.email === undefined ? {} : { email: record.email };
  const clientId = reportedClientId(record, sandboxIds);
  return { kind: record.kind, clientId, ...label, user: record.user, ...email, lastSeen: record.lastSeen, ...record.unobserved };
}

export function createLiveClients(now: () => number): LiveClients {
  const clients = new Map<string, ClientRecord>();
  const sessionKeys = new Map<string, string>();
  let sandboxIds: SandboxClientIds = () => undefined;

  const forget = (clientSessionId: string): void => {
    const key = sessionKeys.get(clientSessionId);
    if (key === undefined) return;
    sessionKeys.delete(clientSessionId);
    const record = clients.get(key);
    record?.sessions.delete(clientSessionId);
    if (record?.sessions.size === 0) clients.delete(key);
  };

  /** The client a connection belongs to: the one it last declared, else the one it first sent a frame as. */
  const recordFor = (clientSessionId: string, kind: LiveClientKind, inner: Record<string, unknown>): ClientRecord | undefined => {
    const declares = declaresClient(inner);
    const clientId = declaredClientId(declares ? inner : {}, clientSessionId, kind);
    const isNewDeclaration = declares && sessionKeys.get(clientSessionId) !== clientKey(kind, clientId);
    if (isNewDeclaration) forget(clientSessionId);
    const known = sessionKeys.get(clientSessionId);
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
    const email = takePresenceEmail(inner);
    if (isPresenceDisconnect(inner)) return forget(clientSessionId);
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
    const lists = unobservedLists(kind, inner);
    if (lists !== undefined) record.unobserved = lists;
    const isBrowser = kind === 'browser';
    if (isBrowser && email === null) delete record.email;
    if (isBrowser && typeof email === 'string') record.email = email;
  };

  return {
    inbound(message) {
      if (message.type === 'worker-client-disconnect') return forget(message.clientSessionId);
      const isClientFrame = message.type === 'worker-message' && message.clientSessionId !== undefined;
      if (!isClientFrame) return;
      noteFrame(message.clientSessionId as string, message.platform, message.message as unknown as Record<string, unknown>);
    },
    readClientIds(lookup) {
      sandboxIds = lookup;
    },
    field() {
      const entries = [...clients.values()].map((record) => entryOf(record, sandboxIds));
      return entries.length === 0 ? {} : { clients: entries };
    },
  };
}
