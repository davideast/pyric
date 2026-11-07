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

interface NodeClients {
  readonly byLabel: Map<string, Set<PortLike>>;
  readonly labelOf: WeakMap<PortLike, string>;
  readonly closed: WeakSet<PortLike>;
}

const CLIENTS = new WeakMap<HostCtx, NodeClients>();

function clientsOf(ctx: HostCtx): NodeClients {
  const existing = CLIENTS.get(ctx);
  if (existing !== undefined) return existing;
  const created: NodeClients = { byLabel: new Map(), labelOf: new WeakMap(), closed: new WeakSet() };
  CLIENTS.set(ctx, created);
  return created;
}

/** The closed runs under `label`, once one run under it is open; they leave the set. */
function earlierRuns(clients: NodeClients, label: string): PortLike[] {
  const runs = clients.byLabel.get(label);
  if (runs === undefined) return [];
  const all = [...runs];
  const hasOpenRun = all.some((port) => !clients.closed.has(port));
  if (!hasOpenRun) return [];
  const earlier = all.filter((port) => clients.closed.has(port));
  for (const port of earlier) runs.delete(port);
  return earlier;
}

/** Record that `port` is a run under `label`; returns the earlier runs to sweep. */
export function claimNodeClient(ctx: HostCtx, port: PortLike, label: string): PortLike[] {
  const clients = clientsOf(ctx);
  const known = clients.labelOf.get(port);
  if (known !== undefined) return [];
  clients.labelOf.set(port, label);
  const runs = clients.byLabel.get(label) ?? new Set<PortLike>();
  clients.byLabel.set(label, runs);
  runs.add(port);
  return earlierRuns(clients, label);
}

/** Record that `port`'s connection closed; returns the earlier runs to sweep, itself included when a later run is open. */
export function closeNodeClient(ctx: HostCtx, port: PortLike): PortLike[] {
  const clients = clientsOf(ctx);
  clients.closed.add(port);
  const label = clients.labelOf.get(port);
  if (label === undefined) return [];
  return earlierRuns(clients, label);
}

/** Record that `port`'s connection resumed its session. */
export function resumeNodeClient(ctx: HostCtx, port: PortLike): void {
  clientsOf(ctx).closed.delete(port);
}

/** Forget `port`, once the host has ended it. */
export function forgetNodeClient(ctx: HostCtx, port: PortLike): void {
  const clients = clientsOf(ctx);
  const label = clients.labelOf.get(port);
  if (label === undefined) return;
  const runs = clients.byLabel.get(label);
  runs?.delete(port);
  if (runs?.size === 0) clients.byLabel.delete(label);
}
