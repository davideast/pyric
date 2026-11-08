/**
 * Shared per-host-context run tracker for logical clients (Node processes or
 * browser tabs) whose closed sessions the host retains briefly.
 *
 * Once a connection with a given label is open and another connection with the
 * same label has closed, the closed one is an earlier run whose attached
 * listeners should be swept immediately. Two simultaneously open connections
 * with the same label keep their own listeners.
 */
import type { HostCtx, PortLike } from '../host-context.js';

interface LabeledRuns {
  readonly byLabel: Map<string, Set<PortLike>>;
  readonly labelOf: WeakMap<PortLike, string>;
  readonly closed: WeakSet<PortLike>;
}

export interface ClientRunTracker {
  claim(ctx: HostCtx, port: PortLike, label: string): PortLike[];
  close(ctx: HostCtx, port: PortLike): PortLike[];
  resume(ctx: HostCtx, port: PortLike): void;
  forget(ctx: HostCtx, port: PortLike): void;
}

function earlierRuns(runsState: LabeledRuns, label: string): PortLike[] {
  const runs = runsState.byLabel.get(label);
  if (runs === undefined) return [];
  const all = [...runs];
  const hasOpenRun = all.some((port) => !runsState.closed.has(port));
  if (!hasOpenRun) return [];
  const earlier = all.filter((port) => runsState.closed.has(port));
  for (const port of earlier) runs.delete(port);
  return earlier;
}

export function createClientRunTracker(): ClientRunTracker {
  const store = new WeakMap<HostCtx, LabeledRuns>();

  function stateOf(ctx: HostCtx): LabeledRuns {
    const existing = store.get(ctx);
    if (existing !== undefined) return existing;
    const created: LabeledRuns = {
      byLabel: new Map(),
      labelOf: new WeakMap(),
      closed: new WeakSet(),
    };
    store.set(ctx, created);
    return created;
  }

  return {
    claim(ctx, port, label) {
      const state = stateOf(ctx);
      if (state.labelOf.has(port)) return [];
      state.labelOf.set(port, label);
      const runs = state.byLabel.get(label) ?? new Set<PortLike>();
      state.byLabel.set(label, runs);
      runs.add(port);
      return earlierRuns(state, label);
    },
    close(ctx, port) {
      const state = stateOf(ctx);
      state.closed.add(port);
      const label = state.labelOf.get(port);
      if (label === undefined) return [];
      return earlierRuns(state, label);
    },
    resume(ctx, port) {
      stateOf(ctx).closed.delete(port);
    },
    forget(ctx, port) {
      const state = stateOf(ctx);
      const label = state.labelOf.get(port);
      if (label === undefined) return;
      const runs = state.byLabel.get(label);
      runs?.delete(port);
      if (runs?.size === 0) state.byLabel.delete(label);
    },
  };
}
