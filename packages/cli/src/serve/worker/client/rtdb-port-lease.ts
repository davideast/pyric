/**
 * Client-side RTDB port lease keepalive for SharedWorker connections.
 *
 * Arms a periodic idempotent `rtdb.goOnline` keepalive ONLY while a local
 * SharedWorker `(port, instance)` holds active online `onDisconnect`
 * registrations. Pauses/stops immediately on `goOffline`, cancellation, or port
 * disconnect so offline instances stay offline and Node processes never hang.
 */

import { PRESENCE_HEARTBEAT_INTERVAL_MS } from '../presence-timing.js';
import { isDisconnectedPort, nextId } from './core.js';
import type { ClientPort, ClientRtdb, ClientRtdbInstance, RtdbRefHandle } from './handles.js';
import { normalizeRtdbPath, rtdbRpc } from './rtdb-references.js';

type RtdbLeaseHandle = {
  readonly port: ClientPort;
  readonly instance?: ClientRtdbInstance;
};

interface RtdbInstanceLease {
  handle: RtdbLeaseHandle;
  online: boolean;
  armedPaths: Set<string>;
}

interface PortRtdbLeaseState {
  instances: Map<string, RtdbInstanceLease>;
  timer: ReturnType<typeof setInterval> | null;
}

const portLeases = new WeakMap<ClientPort, PortRtdbLeaseState>();
let leaseIntervalMs = PRESENCE_HEARTBEAT_INTERVAL_MS;

export function setRtdbClientLeaseIntervalMs(intervalMs: number): void {
  leaseIntervalMs = intervalMs;
}

export function resetRtdbClientLeaseIntervalMs(): void {
  leaseIntervalMs = PRESENCE_HEARTBEAT_INTERVAL_MS;
}

function instanceKeyOf(handle: RtdbLeaseHandle): string {
  if (handle.instance?.name !== undefined) {
    return handle.instance.name;
  }
  return '__default__';
}

function isLocalWorkerPort(port: ClientPort): boolean {
  return port.observeConnection === undefined;
}

function stateForPort(port: ClientPort): PortRtdbLeaseState {
  let state = portLeases.get(port);
  if (state === undefined) {
    state = {
      instances: new Map(),
      timer: null,
    };
    portLeases.set(port, state);
  }
  return state;
}

function instanceLeaseFor(state: PortRtdbLeaseState, handle: RtdbLeaseHandle): RtdbInstanceLease {
  const key = instanceKeyOf(handle);
  const existing = state.instances.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created: RtdbInstanceLease = {
    handle: { port: handle.port, instance: handle.instance },
    online: true,
    armedPaths: new Set(),
  };
  state.instances.set(key, created);
  return created;
}

function hasActiveOnlineDisconnects(state: PortRtdbLeaseState): boolean {
  for (const lease of state.instances.values()) {
    if (lease.online && lease.armedPaths.size > 0) {
      return true;
    }
  }
  return false;
}

function syncPortTimer(port: ClientPort, state: PortRtdbLeaseState): void {
  if (isDisconnectedPort(port) || !hasActiveOnlineDisconnects(state)) {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
    return;
  }
  if (state.timer !== null) {
    return;
  }
  state.timer = setInterval(() => {
    if (isDisconnectedPort(port) || !hasActiveOnlineDisconnects(state)) {
      syncPortTimer(port, state);
      return;
    }
    for (const lease of state.instances.values()) {
      if (lease.online && lease.armedPaths.size > 0) {
        void rtdbRpc(lease.handle, {
          t: 'op',
          id: nextId(),
          method: 'rtdb.goOnline',
        }).catch(() => undefined);
      }
    }
  }, leaseIntervalMs);
  const timerHandle = state.timer as { unref?: () => void };
  if (typeof timerHandle.unref === 'function') {
    timerHandle.unref();
  }
}

export function noteRtdbDisconnectArmed(ref: RtdbRefHandle): void {
  if (!isLocalWorkerPort(ref.port) || isDisconnectedPort(ref.port)) {
    return;
  }
  const state = stateForPort(ref.port);
  const lease = instanceLeaseFor(state, ref);
  lease.armedPaths.add(normalizeRtdbPath(ref.path));
  syncPortTimer(ref.port, state);
}

export function noteRtdbDisconnectCancelled(ref: RtdbRefHandle): void {
  if (!isLocalWorkerPort(ref.port)) {
    return;
  }
  const state = portLeases.get(ref.port);
  if (state === undefined) {
    return;
  }
  const lease = state.instances.get(instanceKeyOf(ref));
  if (lease === undefined) {
    return;
  }
  const normalizedTarget = normalizeRtdbPath(ref.path);
  for (const armedPath of [...lease.armedPaths]) {
    const isExact = armedPath === normalizedTarget;
    const isDescendant =
      normalizedTarget === '' || armedPath.startsWith(`${normalizedTarget}/`);
    if (isExact || isDescendant) {
      lease.armedPaths.delete(armedPath);
    }
  }
  syncPortTimer(ref.port, state);
}

export function noteRtdbInstanceOffline(db: ClientRtdb): void {
  if (!isLocalWorkerPort(db.port)) {
    return;
  }
  const state = stateForPort(db.port);
  const lease = instanceLeaseFor(state, db);
  lease.online = false;
  lease.armedPaths.clear();
  syncPortTimer(db.port, state);
}

export function noteRtdbInstanceOnline(db: ClientRtdb): void {
  if (!isLocalWorkerPort(db.port) || isDisconnectedPort(db.port)) {
    return;
  }
  const state = stateForPort(db.port);
  const lease = instanceLeaseFor(state, db);
  lease.online = true;
  syncPortTimer(db.port, state);
}
