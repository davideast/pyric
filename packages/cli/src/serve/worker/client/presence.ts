/**
 * Worker-client connected-page presence (#227).
 *
 * Each served page (app or Studio) identifies itself with a stable-per-page
 * `clientId`, registers with the SharedWorker, heartbeats on a bounded
 * interval, updates route/visibility, and best-effort disconnects on
 * `pagehide`. Studio also subscribes for live snapshots.
 *
 * Presence is independent of auth sessions and Firestore subscriptions.
 */

import type {
  InboundMessage,
  PresenceClientKind,
  PresenceSnapshot,
  PresenceVisibility,
} from '../protocol.js';
import {
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_STALE_MS,
} from '../presence-timing.js';
import { nextId, nextSubId, rpc, _snapSubs } from './core.js';
import type { ClientDb, Unsubscribe } from './handles.js';

export type { PresenceClientKind, PresenceSnapshot, PresenceVisibility };
export { PRESENCE_HEARTBEAT_INTERVAL_MS, PRESENCE_STALE_MS };

/** Mint a random client id (page-lifetime). */
export function mintPresenceClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function currentRoute(): string {
  if (typeof location === 'undefined') return '/';
  return `${location.pathname}${location.search}${location.hash}`;
}

function currentVisibility(): PresenceVisibility {
  if (typeof document === 'undefined') return 'visible';
  return document.visibilityState === 'hidden' ? 'hidden' : 'visible';
}

export interface PresenceSession {
  /** Logical page id — Studio uses this to label "This page". */
  readonly clientId: string;
  readonly kind: PresenceClientKind;
  /** Stop heartbeats, listeners, and send a best-effort disconnect. */
  stop(): void;
}

export interface StartPresenceOptions {
  db: ClientDb;
  kind: PresenceClientKind;
  /** Override client id (tests / reconnect). Default: mint a new one. */
  clientId?: string;
  /** Heartbeat interval. Default: {@link PRESENCE_HEARTBEAT_INTERVAL_MS}. */
  heartbeatIntervalMs?: number;
}

/**
 * Register this page with the worker and keep the lease alive until
 * {@link PresenceSession.stop} or `pagehide`.
 */
export function startPresence(opts: StartPresenceOptions): PresenceSession {
  const { db, kind } = opts;
  const clientId = opts.clientId ?? mintPresenceClientId();
  const intervalMs = opts.heartbeatIntervalMs ?? PRESENCE_HEARTBEAT_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const register = (): void => {
    void rpc(db.port, {
      t: 'op',
      id: nextId(),
      method: 'presence.register',
      clientId,
      kind,
      route: currentRoute(),
      visibility: currentVisibility(),
    }).catch(() => {});
  };

  const heartbeat = (): void => {
    void rpc(db.port, {
      t: 'op',
      id: nextId(),
      method: 'presence.heartbeat',
      clientId,
    }).catch(() => {});
  };

  const update = (): void => {
    void rpc(db.port, {
      t: 'op',
      id: nextId(),
      method: 'presence.update',
      clientId,
      route: currentRoute(),
      visibility: currentVisibility(),
    }).catch(() => {});
  };

  const disconnect = (): void => {
    void rpc(db.port, {
      t: 'op',
      id: nextId(),
      method: 'presence.disconnect',
      clientId,
    }).catch(() => {});
  };

  register();

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', update);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    // Best-effort clean disconnect; lease expiry covers unclean shutdown.
    window.addEventListener('pagehide', onPageHide);
    // Heartbeats only in a real page — unit shims have no document lifecycle.
    timer = setInterval(() => {
      if (!stopped) heartbeat();
    }, intervalMs);
  }

  function onPageHide(): void {
    stop();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', update);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
      window.removeEventListener('pagehide', onPageHide);
    }
    disconnect();
  }

  return { clientId, kind, stop };
}

/**
 * Subscribe to the worker's authoritative presence snapshot. The callback
 * fires immediately with the current snapshot, then on every change.
 */
export function subscribePresence(
  db: ClientDb,
  callback: (snapshot: PresenceSnapshot) => void,
): Unsubscribe {
  const subId = nextSubId();
  _snapSubs.set(subId, {
    next: (value) => {
      callback(value as PresenceSnapshot);
    },
  });
  db.port.postMessage({ t: 'sub', subId, target: 'presence' } satisfies InboundMessage);
  return () => {
    _snapSubs.delete(subId);
    db.port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  };
}
