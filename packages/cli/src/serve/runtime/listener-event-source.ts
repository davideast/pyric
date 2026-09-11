/**
 * Where the chip's Listeners mode reads sandbox events.
 *
 * The page already has both shapes of stream. When the sandbox lives in the
 * SharedWorker the events arrive over the worker client's existing `events`
 * subscription, whose first delivery is the history batch. When the sandbox
 * runs in the page the events come off the in-page sandbox's own `history` and
 * `onEvent`. This module states which one a page has, so nothing downstream
 * has to know which runtime it is talking to, and so no new worker protocol
 * operation is needed for the chip.
 */
import type { SandboxEvent } from 'pyric/sandbox';
import { subscribeEvents } from '../worker/client/studio.js';
import type { ClientDb } from '../worker/client/handles.js';

/** The in-page sandbox's event stream, as this module reads it. */
export interface SandboxEventFeed {
  history(): readonly SandboxEvent[];
  onEvent(listener: (event: SandboxEvent) => void): () => void;
}

/** Subscribe to batches of sandbox events, history first. */
export type SandboxEventSource = (
  callback: (events: readonly SandboxEvent[]) => void,
) => () => void;

export interface EventSourceBindings {
  /** The worker-backed sandbox handle, when the page has a worker. */
  workerDb?: ClientDb | null;
  /** The in-page sandbox, when the page runs one. */
  sandbox?: SandboxEventFeed | null;
}

/** The page's event source, or `null` when it has neither runtime. */
export function sandboxEventSource(bindings: EventSourceBindings): SandboxEventSource | null {
  const workerDb = bindings.workerDb;
  if (workerDb !== null && workerDb !== undefined) {
    return (callback) => subscribeEvents(workerDb, callback);
  }
  const feed = bindings.sandbox;
  if (feed !== null && feed !== undefined) {
    return (callback) => {
      callback(feed.history());
      return feed.onEvent((event) => callback([event]));
    };
  }
  return null;
}
