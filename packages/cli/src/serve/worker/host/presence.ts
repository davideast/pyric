/**
 * SharedWorker host — connected-page presence (#227).
 *
 * Ephemeral, worker-lifetime registry of logical pages attached to this
 * sandbox worker. Distinct from per-port subscription / auth-session /
 * messaging maps: the user-facing count is keyed by `clientId`, so one page
 * with multiple MessagePorts still counts as one client.
 *
 * Correctness rests on heartbeats + lease expiry (MessagePort `close` is
 * best-effort and unreliable in Chrome). `cleanupPort` is an optimization
 * that removes a client when its last associated port disappears.
 */

import type { OpMessage, PresenceClientRecord, PresenceSnapshot, PresenceSubMessage } from '../protocol.js';
import { type HostCtx, type PortLike, ok, fail, post } from '../host-context.js';
import { PRESENCE_HEARTBEAT_INTERVAL_MS, PRESENCE_STALE_MS } from '../presence-timing.js';

export { PRESENCE_HEARTBEAT_INTERVAL_MS, PRESENCE_STALE_MS };

/** Controllable clock for deterministic lease tests. */
let _now: () => number = () => Date.now();

export function setPresenceNow(fn: () => number): void {
  _now = fn;
}

export function resetPresenceNow(): void {
  _now = () => Date.now();
}

export function presenceNow(): number {
  return _now();
}

interface PresenceEntry extends PresenceClientRecord {
  /** Ports currently associated with this logical client. */
  ports: Set<PortLike>;
}

interface PresenceState {
  clients: Map<string, PresenceEntry>;
  /** Reverse index: port → clientId (for cleanupPort optimization). */
  portToClient: Map<PortLike, string>;
  /** Presence subscribers: Map<port, Set<subId>>. */
  subs: Map<PortLike, Set<string>>;
  /** Periodic expiry timer (worker-global; tests drive expiry via {@link expireStalePresence}). */
  timer: ReturnType<typeof setInterval> | null;
}

const _state = new WeakMap<HostCtx, PresenceState>();

function stateFor(ctx: HostCtx): PresenceState {
  let s = _state.get(ctx);
  if (!s) {
    s = {
      clients: new Map(),
      portToClient: new Map(),
      subs: new Map(),
      timer: null,
    };
    _state.set(ctx, s);
  }
  return s;
}

function ensureExpiryTimer(ctx: HostCtx): void {
  const s = stateFor(ctx);
  if (s.timer != null) return;
  // Sweep at half the stale window so expiry is prompt without busy-polling.
  s.timer = setInterval(() => {
    expireStalePresence(ctx);
  }, Math.max(5_000, Math.floor(PRESENCE_STALE_MS / 2)));
  // Workers may not have unref; guard for Node/test hosts that do.
  const t = s.timer as { unref?: () => void };
  if (typeof t.unref === 'function') t.unref();
}

function stopExpiryTimerIfIdle(ctx: HostCtx): void {
  const s = stateFor(ctx);
  if (s.clients.size > 0 || s.subs.size > 0) return;
  if (s.timer != null) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

function toSnapshot(s: PresenceState): PresenceSnapshot {
  const clients: PresenceClientRecord[] = [];
  for (const e of s.clients.values()) {
    clients.push({
      clientId: e.clientId,
      kind: e.kind,
      route: e.route,
      visibility: e.visibility,
      connectedAt: e.connectedAt,
      lastSeen: e.lastSeen,
    });
  }
  clients.sort((a, b) => a.connectedAt - b.connectedAt || a.clientId.localeCompare(b.clientId));
  return { clients };
}

function broadcast(ctx: HostCtx): void {
  const s = stateFor(ctx);
  const snap = toSnapshot(s);
  for (const [port, subIds] of s.subs) {
    for (const subId of subIds) {
      post(port, { t: 'snap', subId, value: snap });
    }
  }
}

/**
 * Drop clients whose lease is older than {@link PRESENCE_STALE_MS}.
 * Returns true when any client was removed (and subscribers were notified).
 * Tests call this with a controllable {@link setPresenceNow}.
 */
export function expireStalePresence(ctx: HostCtx, now: number = presenceNow()): boolean {
  const s = stateFor(ctx);
  let removed = false;
  for (const [id, entry] of s.clients) {
    if (now - entry.lastSeen > PRESENCE_STALE_MS) {
      for (const port of entry.ports) {
        if (s.portToClient.get(port) === id) s.portToClient.delete(port);
      }
      s.clients.delete(id);
      removed = true;
    }
  }
  if (removed) {
    broadcast(ctx);
    stopExpiryTimerIfIdle(ctx);
  }
  return removed;
}

/** Authoritative presence snapshot for diagnostics / tests. */
export function getPresenceSnapshot(ctx: HostCtx): PresenceSnapshot {
  expireStalePresence(ctx);
  return toSnapshot(stateFor(ctx));
}

const PRESENCE_METHODS = new Set<string>([
  'presence.register',
  'presence.heartbeat',
  'presence.update',
  'presence.disconnect',
]);

export function isPresenceOp(method: OpMessage['method']): boolean {
  return PRESENCE_METHODS.has(method);
}

export async function handlePresenceOp(
  ctx: HostCtx,
  port: PortLike,
  msg: OpMessage,
): Promise<void> {
  const s = stateFor(ctx);
  expireStalePresence(ctx);

  switch (msg.method) {
    case 'presence.register': {
      const { clientId, kind, route, visibility } = msg;
      if (!clientId || (kind !== 'app' && kind !== 'studio')) {
        fail(port, msg.id, new Error('presence.register: invalid clientId/kind'));
        return;
      }
      const now = presenceNow();
      const existing = s.clients.get(clientId);
      if (existing) {
        // Re-register (reload / reconnect): one logical entry, refresh metadata,
        // associate this port, drop stale port associations for this clientId.
        for (const p of existing.ports) {
          if (s.portToClient.get(p) === clientId) s.portToClient.delete(p);
        }
        existing.ports.clear();
        existing.ports.add(port);
        existing.kind = kind;
        existing.route = route;
        existing.visibility = visibility;
        existing.lastSeen = now;
        // Keep original connectedAt across reconnects within the worker lifetime
        // so the UI does not flicker "just connected" on a soft reload — but a
        // full reconnect after disconnect/expiry starts fresh (new entry below).
      } else {
        s.clients.set(clientId, {
          clientId,
          kind,
          route,
          visibility,
          connectedAt: now,
          lastSeen: now,
          ports: new Set([port]),
        });
      }
      s.portToClient.set(port, clientId);
      ensureExpiryTimer(ctx);
      ok(port, msg.id, { ok: true });
      broadcast(ctx);
      break;
    }

    case 'presence.heartbeat': {
      const entry = s.clients.get(msg.clientId);
      if (!entry) {
        // Unknown / already expired — client should re-register.
        ok(port, msg.id, { ok: false, reason: 'unknown' });
        return;
      }
      entry.lastSeen = presenceNow();
      entry.ports.add(port);
      s.portToClient.set(port, msg.clientId);
      ok(port, msg.id, { ok: true });
      // Heartbeats renew the lease without broadcasting — lastSeen freshness
      // is only needed for expiry; subscribers care about connect/disconnect/
      // route/visibility. Still broadcast so Studio can show freshness if it
      // wants; cheap for small N.
      broadcast(ctx);
      break;
    }

    case 'presence.update': {
      const entry = s.clients.get(msg.clientId);
      if (!entry) {
        ok(port, msg.id, { ok: false, reason: 'unknown' });
        return;
      }
      if (msg.route !== undefined) entry.route = msg.route;
      if (msg.visibility !== undefined) entry.visibility = msg.visibility;
      entry.lastSeen = presenceNow();
      entry.ports.add(port);
      s.portToClient.set(port, msg.clientId);
      ok(port, msg.id, { ok: true });
      broadcast(ctx);
      break;
    }

    case 'presence.disconnect': {
      const entry = s.clients.get(msg.clientId);
      if (entry) {
        for (const p of entry.ports) {
          if (s.portToClient.get(p) === msg.clientId) s.portToClient.delete(p);
        }
        s.clients.delete(msg.clientId);
        ok(port, msg.id, { ok: true });
        broadcast(ctx);
        stopExpiryTimerIfIdle(ctx);
      } else {
        ok(port, msg.id, { ok: true });
      }
      break;
    }

    default: {
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}

export function handlePresenceSub(ctx: HostCtx, port: PortLike, msg: PresenceSubMessage): void {
  expireStalePresence(ctx);
  const s = stateFor(ctx);
  let subIds = s.subs.get(port);
  if (!subIds) {
    subIds = new Set();
    s.subs.set(port, subIds);
  }
  if (subIds.has(msg.subId)) return;
  subIds.add(msg.subId);
  ensureExpiryTimer(ctx);
  post(port, { t: 'snap', subId: msg.subId, value: toSnapshot(s) });
}

export function handlePresenceUnsub(ctx: HostCtx, port: PortLike, subId: string): boolean {
  const s = stateFor(ctx);
  const subIds = s.subs.get(port);
  if (!subIds || !subIds.has(subId)) return false;
  subIds.delete(subId);
  if (subIds.size === 0) s.subs.delete(port);
  stopExpiryTimerIfIdle(ctx);
  return true;
}

/**
 * Port-close optimization: if this port was the last association for a
 * logical client, remove that client. Lease expiry remains the correctness
 * path when close events are missing.
 */
export function cleanupPortPresence(ctx: HostCtx, port: PortLike): void {
  const s = stateFor(ctx);
  // Drop presence subscriptions on this port.
  s.subs.delete(port);

  const clientId = s.portToClient.get(port);
  s.portToClient.delete(port);
  if (!clientId) {
    stopExpiryTimerIfIdle(ctx);
    return;
  }
  const entry = s.clients.get(clientId);
  if (!entry) {
    stopExpiryTimerIfIdle(ctx);
    return;
  }
  entry.ports.delete(port);
  if (entry.ports.size === 0) {
    s.clients.delete(clientId);
    broadcast(ctx);
  }
  stopExpiryTimerIfIdle(ctx);
}
