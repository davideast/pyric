/**
 * SharedWorker host — event-stream subsystem (Pyric Studio keystone).
 *
 * Surfaces the sandbox's unified cross-service `onEvent`/`history()` stream over
 * the port so Studio's Action Center / traffic / rules-debug denial feed see
 * real activity. Imports only from `./host-context.js` + external packages (no
 * circular imports).
 */

import { type HostCtx, type PortLike, post } from './host-context.js';
import type { SandboxEvent } from 'pyric/sandbox';
import type { EventSubMessage } from './protocol.js';

// ─── Event-stream subscription (Pyric Studio keystone) ─────────────────────
//
// Surfaces the sandbox's unified cross-service `onEvent`/`history()` stream over
// the port so Studio's Action Center / traffic / rules-debug denial feed see
// real activity. Architecture mirrors the AUTH fan-out: ONE real
// `sandbox.onEvent` subscription per worker (lazily wired in {@link ensureEventStream}),
// and a per-port routing registry telling the host which ports want events. On
// any event the single sandbox subscription fires once and we fan it out to
// EVERY subscribed port — so multiple Studio/app tabs share the one backend
// stream. Events are plain JSON (no codec round-trip; see EventSubMessage).

/** Per-port event-stream subscription registry. Map<port, Set<subId>>. The
 *  WeakMap is keyed by ctx so multiple in-process hosts (tests) don't collide. */
const _eventSubs = new WeakMap<HostCtx, Map<PortLike, Set<string>>>();

/** Tracks whether the single real `sandbox.onEvent` subscription is wired. */
const _eventStreamWired = new WeakSet<HostCtx>();

export function eventSubsFor(ctx: HostCtx): Map<PortLike, Set<string>> {
  let m = _eventSubs.get(ctx);
  if (!m) {
    m = new Map();
    _eventSubs.set(ctx, m);
  }
  return m;
}

/**
 * Lazily wire the ONE real `sandbox.onEvent` subscription for this ctx. On every
 * sandbox event it fans the event out (as a single-element batch) to every port
 * subscribed to the stream. Idempotent — only the first event sub wires it; the
 * subscription then lives for the worker's lifetime (cheap, observational).
 */
function ensureEventStream(ctx: HostCtx): void {
  if (_eventStreamWired.has(ctx)) return;
  _eventStreamWired.add(ctx);
  ctx.sandbox.onEvent((event) => {
    broadcastEvents(ctx, [event]);
  });
}

/** Fan a batch of events out to every port subscribed to the event stream. */
function broadcastEvents(ctx: HostCtx, events: readonly SandboxEvent[]): void {
  const subs = eventSubsFor(ctx);
  for (const [port, subIds] of subs) {
    for (const subId of subIds) {
      post(port, { t: 'event', subId, events });
    }
  }
}

/**
 * Register an event-stream subscription for a port (Pyric Studio keystone).
 * Records the (port, subId) so live events reach it, ensures the single real
 * sandbox subscription is wired, and immediately delivers `sandbox.history()`
 * (every event so far) as the initial batch — so a late subscriber folds the
 * full backlog then streams uniformly (mirrors `onEvent` + `history`).
 */
export function handleEventSub(ctx: HostCtx, port: PortLike, msg: EventSubMessage): void {
  ensureEventStream(ctx);
  const subs = eventSubsFor(ctx);
  let subIds = subs.get(port);
  if (!subIds) {
    subIds = new Set();
    subs.set(port, subIds);
  }
  if (subIds.has(msg.subId)) return; // idempotent
  subIds.add(msg.subId);

  // Initial fire: the full history snapshot (a defensive copy from the sandbox).
  post(port, { t: 'event', subId: msg.subId, events: ctx.sandbox.history() });
}

export function handleEventUnsub(ctx: HostCtx, port: PortLike, subId: string): boolean {
  const subs = eventSubsFor(ctx);
  const subIds = subs.get(port);
  if (!subIds || !subIds.has(subId)) return false;
  subIds.delete(subId);
  if (subIds.size === 0) subs.delete(port);
  return true;
}
