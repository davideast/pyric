/**
 * Sends a live Node process's unobserved lists to the live host, so the
 * host's health lists them under the process's client, beside the process's
 * own health (`process-health.ts`).
 *
 * The lists only grow. Each time one gains an entry the register calls
 * `changed`, and the forwarder sends the whole lists once the current turn
 * ends, so a burst of new entries sends one frame. Each list is bounded and
 * deduplicated (`boundNodeUnobservedList`): subpath names only. A
 * frame that would repeat the last one sent is not sent; one that fails is
 * sent again at the next change. While a send is in flight, a change waits
 * for it and then sends the lists as they are. When the connection drops
 * and attaches again (`onReattach`), as after the live host restarts, the
 * host it reaches may hold no lists, so the forwarder sends them again.
 */
import {
  NODE_UNOBSERVED_LIST_NAMES,
  boundNodeUnobservedList,
  type NodeUnobservedListName,
  type NodeUnobservedLists,
} from 'pyric/sandbox/internal';

export interface UnobservedForwarder {
  /** One of the lists gained an entry. */
  changed(): void;
  /** The connection attached again after a drop: send the lists even if they did not change. */
  reconnected(): void;
}

/** A connection's `observeConnection`: reports each attach and drop to `listener`, and returns its stop. */
type ObserveConnection = (listener: (connected: boolean) => void) => () => void;

/**
 * Calls `reattached` each time the connection attaches after it dropped
 * from an attach: not at the first attach, and once per drop. Returns the
 * stop.
 */
export function onReattach(observe: ObserveConnection, reattached: () => void): () => void {
  let wasAttached = false;
  let dropped = false;
  return observe((connected) => {
    if (!connected) {
      dropped = wasAttached;
      return;
    }
    const isReattach = dropped;
    wasAttached = true;
    dropped = false;
    if (isReattach) reattached();
  });
}

export interface UnobservedForwarderInput {
  /** The process's lists as they are now. */
  read(): NodeUnobservedLists;
  /** Sends the bounded lists to the live host; rejects when it cannot reach it. */
  send(lists: NodeUnobservedLists): Promise<void>;
  /** Runs `flush` once the current turn ends. Defaults to an unreferenced zero timer, so it never holds the process open. */
  schedule?: (flush: () => void) => void;
}

function scheduleUnreferenced(flush: () => void): void {
  setTimeout(flush, 0).unref();
}

/** The lists as the frame carries them: bounded, and each absent when empty. */
export function boundedNodeUnobservedLists(lists: NodeUnobservedLists): NodeUnobservedLists {
  const bounded: Partial<Record<NodeUnobservedListName, string[]>> = {};
  for (const name of NODE_UNOBSERVED_LIST_NAMES) {
    const list = boundNodeUnobservedList(name, lists[name] ?? []);
    if (list.length > 0) bounded[name] = list;
  }
  return bounded;
}

export function createUnobservedForwarder(input: UnobservedForwarderInput): UnobservedForwarder {
  const schedule = input.schedule ?? scheduleUnreferenced;
  let scheduled = false;
  let sending = false;
  let changedWhileSending = false;
  const nothingSent = JSON.stringify({});
  let lastSent = nothingSent;

  const flush = (): void => {
    scheduled = false;
    if (sending) {
      changedWhileSending = true;
      return;
    }
    const lists = boundedNodeUnobservedLists(input.read());
    const frame = JSON.stringify(lists);
    if (frame === lastSent) return;
    sending = true;
    input.send(lists).then(
      () => {
        lastSent = frame;
      },
      () => undefined,
    ).finally(() => {
      sending = false;
      if (!changedWhileSending) return;
      changedWhileSending = false;
      changed();
    });
  };

  const changed = (): void => {
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  };

  const reconnected = (): void => {
    lastSent = nothingSent;
    changed();
  };

  return { changed, reconnected };
}
