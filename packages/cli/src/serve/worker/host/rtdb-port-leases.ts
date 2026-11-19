/**
 * Host-owned RTDB disconnect port leases for SharedWorker page connections.
 *
 * Chrome MessagePort close delivery and window pagehide events are absent on
 * abrupt renderer termination (crash, SIGKILL, OOM). Whenever a page port holds
 * armed RTDB onDisconnect registrations on the SharedWorker host, it maintains
 * a host-owned lease refreshed by inbound RTDB traffic and periodic client
 * keepalives. Expired leases drain queued RTDB onDisconnect operations and
 * flush durable persistence without touching non-RTDB services.
 */

import type { HostCtx, PortLike } from '../host-context.js';
import { PRESENCE_STALE_MS } from '../presence-timing.js';

type RtdbPortDisconnectDrainer = (ctx: HostCtx, port: PortLike) => Promise<void>;

interface RtdbPortLeaseState {
  lastSeenByPort: Map<PortLike, number>;
  timer: ReturnType<typeof setInterval> | null;
  drainer: RtdbPortDisconnectDrainer | null;
}

let currentNow: () => number = () => Date.now();

export function setRtdbLeaseNow(fn: () => number): void {
  currentNow = fn;
}

export function resetRtdbLeaseNow(): void {
  currentNow = () => Date.now();
}

function rtdbLeaseNow(): number {
  return currentNow();
}

export const RTDB_PORT_LEASE_STALE_MS = PRESENCE_STALE_MS;

const leaseStates = new WeakMap<HostCtx, RtdbPortLeaseState>();

function stateFor(ctx: HostCtx): RtdbPortLeaseState {
  let state = leaseStates.get(ctx);
  if (state === undefined) {
    state = {
      lastSeenByPort: new Map(),
      timer: null,
      drainer: null,
    };
    leaseStates.set(ctx, state);
  }
  return state;
}

function isLeasablePagePort(ctx: HostCtx, port: PortLike): boolean {
  if (ctx.disconnectedPorts?.has(port) === true) {
    return false;
  }
  const connection = ctx.portConnections?.get(port);
  if (connection !== undefined && connection !== 'page') {
    return false;
  }
  return true;
}

function ensureSweepTimer(ctx: HostCtx, state: RtdbPortLeaseState): void {
  if (state.timer !== null) {
    return;
  }
  const intervalMs = Math.max(5_000, Math.floor(RTDB_PORT_LEASE_STALE_MS / 2));
  state.timer = setInterval(() => {
    void expireStaleRtdbPortLeases(ctx);
  }, intervalMs);
  const timerHandle = state.timer as { unref?: () => void };
  if (typeof timerHandle.unref === 'function') {
    timerHandle.unref();
  }
}

function stopSweepTimerIfIdle(state: RtdbPortLeaseState): void {
  if (state.lastSeenByPort.size > 0) {
    return;
  }
  if (state.timer !== null) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

export function armRtdbPortLease(
  ctx: HostCtx,
  port: PortLike,
  drainer: RtdbPortDisconnectDrainer,
): void {
  if (!isLeasablePagePort(ctx, port)) {
    return;
  }
  const state = stateFor(ctx);
  state.drainer = drainer;
  state.lastSeenByPort.set(port, rtdbLeaseNow());
  ensureSweepTimer(ctx, state);
}

export function touchRtdbPortLease(ctx: HostCtx, port: PortLike): void {
  const state = stateFor(ctx);
  if (!state.lastSeenByPort.has(port)) {
    return;
  }
  if (ctx.disconnectedPorts?.has(port) === true) {
    state.lastSeenByPort.delete(port);
    stopSweepTimerIfIdle(state);
    return;
  }
  state.lastSeenByPort.set(port, rtdbLeaseNow());
}

export function syncRtdbPortLease(
  ctx: HostCtx,
  port: PortLike,
  hasQueuedDisconnects: boolean,
): void {
  if (hasQueuedDisconnects) {
    return;
  }
  const state = stateFor(ctx);
  state.lastSeenByPort.delete(port);
  stopSweepTimerIfIdle(state);
}

export function clearRtdbPortLeases(ctx: HostCtx): void {
  const state = stateFor(ctx);
  state.lastSeenByPort.clear();
  stopSweepTimerIfIdle(state);
}

export async function expireStaleRtdbPortLeases(
  ctx: HostCtx,
  now: number = rtdbLeaseNow(),
): Promise<number> {
  const state = stateFor(ctx);
  const expired: PortLike[] = [];
  for (const [port, lastSeen] of state.lastSeenByPort) {
    if (now - lastSeen > RTDB_PORT_LEASE_STALE_MS) {
      expired.push(port);
    }
  }
  if (expired.length === 0) {
    return 0;
  }
  for (const port of expired) {
    state.lastSeenByPort.delete(port);
  }
  stopSweepTimerIfIdle(state);
  const drainer = state.drainer;
  if (drainer === null) {
    return expired.length;
  }
  const tasks: Array<Promise<void>> = [];
  for (const port of expired) {
    tasks.push(drainer(ctx, port));
  }
  await Promise.allSettled(tasks);
  return expired.length;
}
