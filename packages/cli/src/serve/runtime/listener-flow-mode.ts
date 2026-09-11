/**
 * The chip's Flow painting mode: where a listener's data went, as it arrives.
 *
 * The mode joins four pieces that each know one thing. The worker client says
 * when a listener handed a snapshot to the application. A `MutationObserver`
 * says which nodes the page changed. React's commit hook says when a render
 * finished. The fiber walk says which components own those nodes. The
 * correlation window holds them together, and the painter draws the result in
 * the listener's colour.
 *
 * The order matters and is why the mode drains the observer itself. React
 * calls the commit hook synchronously inside the commit; a `MutationObserver`
 * callback runs a microtask later. So on every commit the mode takes the
 * records the observer is holding, feeds them to the window, and only then
 * closes it.
 *
 * What comes out is "these components rendered after that delivery". It is
 * correlation, not data tracing: a state update the application batched into
 * the same commit is attributed to the listener too.
 */
import { flowSubtree } from './fiber-flow.js';
import { createDeliveryCorrelation, type DeliveryCorrelation } from './delivery-correlation.js';
import { createFlowPainter, type FlowPainter } from './listener-flow-painter.js';
import type { ReactCommitSource } from './react-commit-source.js';
import type { ListenerOutline } from './listener-outline-model.js';
import { onListenerDelivery } from '../worker/client/listener-delivery.js';

/** A source of changed nodes the mode can drain on demand. */
export interface ChangedNodeSource {
  /** Every node changed since the last drain. */
  drain(): readonly unknown[];
  stop(): void;
}

export interface FlowModeOptions {
  document: Document;
  /** The overlay's container. Flow draws into the layer Overview owns. */
  container: HTMLElement;
  /** React's commits, already installed on the page. */
  commits: ReactCommitSource;
  /** The listener's outline record, for the badge words. */
  outlineFor: (listenerId: string) => ListenerOutline | null;
  /** `false` hides this listener's paint, in either mode. */
  isVisible: (listenerId: string) => boolean;
  /** Deliveries. Defaults to the worker client's own hook. */
  subscribeDeliveries?: (listener: (listenerId: string) => void) => () => void;
  /** Changed nodes. Defaults to a `MutationObserver` over the page body. */
  changedNodes?: (documentLike: Document, container: HTMLElement) => ChangedNodeSource;
  /** How long a delivery waits for a commit. */
  windowMs?: number;
  /** How long a delivery's boxes stay on the page. */
  fadeMs?: number;
}

export interface FlowMode {
  /** Take every box away without stopping the mode. */
  clear(): void;
  /** Take one listener's boxes away, for a listener switched off. */
  clearListener(listenerId: string): void;
  /** Recompute the boxes already drawn against the page's current geometry. */
  reposition(): void;
  dispose(): void;
}

/** The chip's own chrome, which is never part of an application's render. */
function isChipOwned(node: unknown, container: HTMLElement): boolean {
  const element = node as Node | null;
  if (element === null || element === undefined) return true;
  if (container.contains(element)) return true;
  const owner = (element.nodeType === 1 ? element : element.parentNode) as Element | null;
  if (owner === null) return false;
  try {
    return owner.closest('[data-pyric-runtime-chip-host], pyric-runtime-chip') !== null;
  } catch {
    return false;
  }
}

/** A `MutationObserver` over the page body, drained rather than subscribed to. */
function observePageChanges(documentLike: Document, container: HTMLElement): ChangedNodeSource {
  const view = documentLike.defaultView as { MutationObserver?: typeof MutationObserver } | null;
  const Observer = view?.MutationObserver
    ?? (typeof MutationObserver === 'function' ? MutationObserver : undefined);
  const body = documentLike.body;
  if (Observer === undefined || body === null) {
    return { drain: () => [], stop: () => {} };
  }
  // The callback does nothing: the mode drains on the commit, so what the
  // observer holds between commits is exactly the window's evidence.
  const observer = new Observer(() => {});
  try {
    observer.observe(body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  } catch {
    return { drain: () => [], stop: () => {} };
  }
  return {
    drain() {
      const nodes: unknown[] = [];
      for (const record of observer.takeRecords()) {
        if (!isChipOwned(record.target, container)) nodes.push(record.target);
        for (const added of record.addedNodes) {
          if (!isChipOwned(added, container)) nodes.push(added);
        }
      }
      return nodes;
    },
    stop() {
      observer.disconnect();
    },
  };
}

/** Start painting flows. The caller owns the overlay container. */
export function startFlowMode(options: FlowModeOptions): FlowMode {
  const painter: FlowPainter = createFlowPainter({
    document: options.document,
    container: options.container,
    ...(options.fadeMs === undefined ? {} : { fadeMs: options.fadeMs }),
  });

  const correlation: DeliveryCorrelation = createDeliveryCorrelation({
    ...(options.windowMs === undefined ? {} : { windowMs: options.windowMs }),
    onFlow: (flow) => {
      if (!options.isVisible(flow.listenerId)) return;
      const outline = options.outlineFor(flow.listenerId);
      if (outline === null) return;
      const subtree = flowSubtree(flow.nodes);
      if (subtree.components.length === 0) return;
      painter.paint({
        listenerId: flow.listenerId,
        label: outline.label,
        target: outline.isQuery ? `${outline.target} (query)` : outline.target,
        deliveryCount: outline.deliveryCount,
        subtree,
      });
    },
  });

  const changes = (options.changedNodes ?? observePageChanges)(options.document, options.container);
  const subscribeDeliveries = options.subscribeDeliveries ?? onListenerDelivery;

  const stopDeliveries = subscribeDeliveries((listenerId) => {
    correlation.delivered(listenerId);
  });
  const stopCommits = options.commits.subscribe(() => {
    correlation.changed(changes.drain());
    correlation.committed();
  });

  return {
    clear() {
      painter.clear();
    },
    clearListener(listenerId) {
      painter.clearListener(listenerId);
    },
    reposition() {
      painter.reposition();
    },
    dispose() {
      stopDeliveries();
      stopCommits();
      changes.stop();
      correlation.dispose();
      painter.dispose();
    },
  };
}
