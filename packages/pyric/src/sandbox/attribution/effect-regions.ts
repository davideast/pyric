/**
 * Attributing a snapshot delivery to the part of the page it changed.
 *
 * The window is the SYNCHRONOUS run of the application's snapshot callback,
 * and nothing else. `MutationObserver` is started immediately before the
 * callback, drained with `takeRecords()` immediately after it returns, and
 * disconnected. There is no debounce, no timer, and no microtask wait.
 *
 * That is deliberate, and it is also the limit of what this owner kind can
 * claim. A callback that writes into a framework's state rather than into the
 * DOM renders LATER, on the framework's own schedule, outside this window, so
 * this owner sees nothing for it. Waiting longer would not fix that: it would
 * start attributing unrelated renders that happened to land in the same
 * interval, which is worse than reporting nothing. Listeners whose effects are
 * mediated by a framework are attributed by their creation `frame` and by the
 * `owner` tag instead, which is exactly why both exist.
 *
 * Outside a browser there is no `MutationObserver` and no `document`, so this
 * is a pure pass-through and the delivery carries no regions.
 */

import type { ListenerOwner } from '../types/events.js';
import { listenerAttributionEnabled } from './attribution-mode.js';
import {
  isSelectableElement,
  regionSelectorFor,
  type SelectableElement,
} from './element-selector.js';

/** The `MutationObserver` surface this file uses, and nothing more. */
interface ObserverLike {
  observe(target: unknown, options: Record<string, boolean>): void;
  takeRecords(): ReadonlyArray<{
    target?: unknown;
    addedNodes?: ArrayLike<unknown>;
  }>;
  disconnect(): void;
}

type ObserverConstructor = new (callback: () => void) => ObserverLike;

const OBSERVED_MUTATIONS = {
  childList: true,
  attributes: true,
  characterData: true,
  subtree: true,
};

/** The observer constructor and document to watch, when both are present. */
function domUnderObservation(): { Observer: ObserverConstructor; document: unknown } | undefined {
  const host = globalThis as {
    MutationObserver?: ObserverConstructor;
    document?: unknown;
  };
  const Observer = host.MutationObserver;
  const doc = host.document;
  if (typeof Observer !== 'function') return undefined;
  if (doc === undefined || doc === null) return undefined;
  return { Observer, document: doc };
}

/**
 * The nearest element a mutated node belongs to. A text node reports its
 * parent; an element reports itself; anything else is skipped.
 */
function nearestElement(node: unknown): SelectableElement | undefined {
  if (isSelectableElement(node)) return node;
  if (node === null || typeof node !== 'object') return undefined;
  const parent = (node as { parentElement?: unknown }).parentElement;
  if (isSelectableElement(parent)) return parent;
  return undefined;
}

/**
 * Run `run` and report which elements it mutated, as a `regions` owner.
 *
 * Anything `run` throws propagates unchanged, after the observer is torn down:
 * attribution never changes what a callback does or what its caller sees.
 */
export function recordEffectRegions(run: () => void): ListenerOwner | undefined {
  if (!listenerAttributionEnabled()) {
    run();
    return undefined;
  }
  const dom = domUnderObservation();
  if (dom === undefined) {
    run();
    return undefined;
  }
  const observer = new dom.Observer(() => {});
  let records: ReadonlyArray<{ target?: unknown; addedNodes?: ArrayLike<unknown> }> = [];
  try {
    observer.observe(dom.document, OBSERVED_MUTATIONS);
    run();
  } finally {
    records = observer.takeRecords();
    observer.disconnect();
  }
  return regionsFromRecords(records);
}

/**
 * Reduce mutation records to a de-duplicated, source-ordered selector list.
 * Exported for the test, which builds records directly.
 */
export function regionsFromRecords(
  records: ReadonlyArray<{ target?: unknown; addedNodes?: ArrayLike<unknown> }>,
): ListenerOwner | undefined {
  const selectors: string[] = [];
  const seen = new Set<string>();
  const remember = (node: unknown): void => {
    const element = nearestElement(node);
    if (element === undefined) return;
    const selector = regionSelectorFor(element);
    if (selector.length === 0) return;
    if (seen.has(selector)) return;
    seen.add(selector);
    selectors.push(selector);
  };
  for (const record of records) {
    remember(record.target);
    const added = record.addedNodes;
    if (!added) continue;
    for (let index = 0; index < added.length; index += 1) {
      remember(added[index]);
    }
  }
  if (selectors.length === 0) return undefined;
  return { kind: 'regions', selectors };
}
