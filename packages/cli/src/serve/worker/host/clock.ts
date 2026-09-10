/**
 * Streaming the sandbox clock's state to the ports that mirror it.
 *
 * A page mints two values before the worker can answer: a push id and an
 * in-flight upload's stamp. Both claim to be "when this happened", so both
 * belong to the sandbox clock, which lives here rather than there. The page
 * therefore keeps a mirror (`client/clock.ts`) and this module keeps it
 * current: a port that asks is answered with the state now, and again on every
 * move, for as long as it is connected.
 *
 * One watcher per host context, not one per port. The clock notifies its
 * watchers, and this module fans that out to the ports the context holds.
 */
import { getClock } from 'pyric/sandbox';
import type { SandboxClockState } from 'pyric/sandbox';
import type { OpMessage } from '../protocol.js';
import { ok, post, type HostCtx, type PortLike } from '../host-context.js';

/** Send one port the clock's state as it stands. */
function sendState(port: PortLike, state: SandboxClockState): void {
  post(port, { t: 'clock', state });
}

/**
 * Register `port` as a mirror of this sandbox's clock and send it the current
 * state. The first registration on a context installs the watcher that fans
 * later moves out to every registered port.
 */
export function subscribeClock(ctx: HostCtx, port: PortLike): void {
  let ports = ctx.clockPorts;
  if (ports === undefined) {
    ports = new Set<PortLike>();
    ctx.clockPorts = ports;
    const registered = ports;
    getClock(ctx.sandbox).onChange((state) => {
      for (const mirror of [...registered]) sendState(mirror, state);
    });
  }
  ports.add(port);
  sendState(port, getClock(ctx.sandbox).capture());
}

/** Stop mirroring the clock to a port that is going away. */
export function unsubscribeClock(ctx: HostCtx, port: PortLike): void {
  ctx.clockPorts?.delete(port);
}

/** Does this op read the clock? */
export function isClockOp(method: string): boolean {
  return method === 'sandbox.clock';
}

/**
 * Answer one clock read. A caller in another process (the Functions child, the
 * `pyric-admin` remote arm) cannot hold the mirror a page port gets, so it asks
 * and waits. The reply carries both the state and the instant it derives, so
 * the caller neither re-implements the three modes nor races the wall clock.
 */
export function handleClockOp(ctx: HostCtx, port: PortLike, msg: OpMessage): void {
  const clock = getClock(ctx.sandbox);
  ok(port, msg.id, { state: clock.capture(), now: clock.now() });
}
