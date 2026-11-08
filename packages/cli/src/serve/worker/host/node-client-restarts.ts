/**
 * Which Node connections are runs of one process, so the host can tell a
 * restart from a second process.
 *
 * A live Node process names its project root and entry script with a label
 * (`nodeClient` on its observe frames). The host retains a closed
 * connection's session for a while, so a process killed or restarted under
 * `node --watch` or nodemon leaves its reported listeners active while the
 * next run attaches them again. Once a connection with a label is open and
 * another with the same label has closed, the closed one is an earlier run:
 * its ports are returned here for the caller to sweep. Two open connections
 * with one label, such as two workers of one script, are two processes and
 * keep their own listeners.
 */
import type { HostCtx, PortLike } from '../host-context.js';
import { createClientRunTracker } from './client-run-tracker.js';

const NODE_CLIENTS = createClientRunTracker();

/** Record that `port` is a run under `label`; returns the earlier runs to sweep. */
export function claimNodeClient(ctx: HostCtx, port: PortLike, label: string): PortLike[] {
  return NODE_CLIENTS.claim(ctx, port, label);
}

/** Record that `port`'s connection closed; returns the earlier runs to sweep, itself included when a later run is open. */
export function closeNodeClient(ctx: HostCtx, port: PortLike): PortLike[] {
  return NODE_CLIENTS.close(ctx, port);
}

/** Record that `port`'s connection resumed its session. */
export function resumeNodeClient(ctx: HostCtx, port: PortLike): void {
  NODE_CLIENTS.resume(ctx, port);
}

/** Forget `port`, once the host has ended it. */
export function forgetNodeClient(ctx: HostCtx, port: PortLike): void {
  NODE_CLIENTS.forget(ctx, port);
}
