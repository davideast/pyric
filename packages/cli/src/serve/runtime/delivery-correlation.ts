/**
 * The window between a listener delivery and the render that follows it.
 *
 * A delivery is the moment the worker client hands a snapshot to the
 * application's own callback. The page cannot see what the application then
 * does with the data, so this module states a weaker and honest thing: it
 * opens a window at the delivery, collects the nodes the page changed while
 * the window is open, and closes the window at the next React commit. What
 * comes out is "these nodes changed after that delivery", which is
 * correlation, not data tracing.
 *
 * Two consequences are deliberate and are what the badges say rather than
 * hide. A state update the application batched into the same commit is
 * attributed to the listener whose delivery opened the window. Two deliveries
 * that land before one commit are both attributed to that commit's changes,
 * and each gets its own flow record, because nothing on the page can separate
 * them.
 *
 * The module is pure apart from the timer it is handed: it holds no DOM, no
 * React, and no sandbox types, and every clock it reads is injectable.
 */

/** One delivery and the nodes the page changed after it. */
export interface DeliveryFlow {
  /** The sandbox listener id, which is the worker subscription id. */
  readonly listenerId: string;
  /** When the delivery arrived, on the injected clock. */
  readonly at: number;
  /** How long the window stayed open, in milliseconds. */
  readonly elapsedMs: number;
  /** The nodes the page changed while the window was open. */
  readonly nodes: readonly unknown[];
}

export interface DeliveryCorrelationOptions {
  /** Called once per delivery whose window closed on a commit that changed something. */
  onFlow: (flow: DeliveryFlow) => void;
  /**
   * How long a delivery waits for a commit. A window that expires is dropped:
   * a commit that far from the delivery says nothing about it.
   */
  windowMs?: number;
  /** The clock. Defaults to `Date.now`. */
  now?: () => number;
  /** How the sweep is scheduled. Returns the cancel function. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface DeliveryCorrelation {
  /** A listener handed a snapshot to the application. Opens a window. */
  delivered(listenerId: string): void;
  /** Nodes the page changed. Ignored when no window is open. */
  changed(nodes: Iterable<unknown>): void;
  /** React finished a commit. Closes every open window. */
  committed(): void;
  /** The listener ids whose windows are still open, oldest first. */
  pending(): readonly string[];
  /** Close every window without reporting, and cancel the sweep. */
  dispose(): void;
}

/** How long a delivery waits for a commit, in milliseconds. */
const DEFAULT_WINDOW_MS = 250;

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
}

/** Build the correlation. It starts with no window open. */
export function createDeliveryCorrelation(
  options: DeliveryCorrelationOptions,
): DeliveryCorrelation {
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;

  let open: Array<{ listenerId: string; at: number }> = [];
  let changedNodes: unknown[] = [];
  let cancelSweep: (() => void) | null = null;

  const stopSweep = (): void => {
    cancelSweep?.();
    cancelSweep = null;
  };

  const closeAll = (): void => {
    open = [];
    changedNodes = [];
    stopSweep();
  };

  function sweep(): void {
    cancelSweep = null;
    const deadline = now() - windowMs;
    open = open.filter((entry) => entry.at > deadline);
    if (open.length === 0) {
      changedNodes = [];
      return;
    }
    startSweep();
  }

  function startSweep(): void {
    if (cancelSweep !== null) return;
    cancelSweep = schedule(sweep, windowMs);
  }

  return {
    delivered(listenerId) {
      open.push({ listenerId, at: now() });
      startSweep();
    },
    changed(nodes) {
      if (open.length === 0) return;
      for (const node of nodes) changedNodes.push(node);
    },
    committed() {
      if (open.length === 0) return;
      const at = now();
      const deadline = at - windowMs;
      const live = open.filter((entry) => entry.at > deadline);
      const nodes = changedNodes.slice();
      closeAll();
      if (nodes.length === 0) return;
      for (const entry of live) {
        options.onFlow({
          listenerId: entry.listenerId,
          at: entry.at,
          elapsedMs: at - entry.at,
          nodes,
        });
      }
    },
    pending() {
      return open.map((entry) => entry.listenerId);
    },
    dispose() {
      closeAll();
    },
  };
}
