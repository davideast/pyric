/**
 * The chip's Listeners mode: what on the page has a listener, what it listens
 * to, and where its data goes.
 *
 * The mode folds the sandbox event stream the page already receives into
 * outline records and paints them one of two ways. Overview paints one box per
 * attached listener and leaves it there. Flow paints, for each delivery, the
 * component subtree that rendered after it, and fades it away. The two share
 * the fold, the owners, the colours, the overlay container, and the
 * per-listener toggles; only the painting differs.
 *
 * The mode observes from the moment it exists, so the chip's count and summary
 * read the fold whether or not anything is painted. It holds an overlay only
 * while it is on, so a page that never turns the painting on pays only for the
 * fold.
 *
 * Listener attribution is a development diagnostic. When the production switch
 * has it off there are no owners to place, so the mode refuses to turn on and
 * draws nothing.
 */
import type { SandboxEvent } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { listenerOutlines, type ListenerOutline } from './listener-outline-model.js';
import { createListenerOverlay, type ListenerOverlay } from './listener-overlay.js';
import { incidentsFromEvents } from './listener-incidents.js';
import { startFlowMode, type FlowMode } from './listener-flow-mode.js';
import {
  installReactCommitSource,
  reactRendered,
  type ReactCommitSource,
} from './react-commit-source.js';
import {
  pagePaintModeStorage,
  readListenerPaintMode,
  writeListenerPaintMode,
  type ListenerPaintMode,
  type PaintModeStorage,
} from './listener-paint-mode.js';

export type { ListenerPaintMode } from './listener-paint-mode.js';

export interface ListenerModeOptions {
  document: Document;
  /**
   * The page's sandbox event source. The first delivery carries history, each
   * later delivery carries the events since the last one, which is exactly
   * the shape the worker client's `subscribeEvents` already has.
   */
  subscribeEvents: (callback: (events: readonly SandboxEvent[]) => void) => () => void;
  /** Whether listener attribution is recording owners. */
  attributionEnabled?: () => boolean;
  /** Incident source. Defaults to raising them from the page's own history. */
  incidents?: (events: readonly SandboxEvent[]) => readonly ActivityIncident[];
  /** Studio's base URL, when the page has one. */
  studioUrl?: string | null;
  /** How a badge click reaches Studio. Defaults to a new browser tab. */
  openStudio?: (url: string) => void;
  /** Called after every recomputation, for the chip's own panel. */
  onChange?: (outlines: readonly ListenerOutline[]) => void;
  /**
   * React's commits. Defaults to installing the hook on this page's window,
   * which only reports commits when it got there before the application's
   * script.
   */
  commits?: ReactCommitSource;
  /** Where the painting mode is remembered. Defaults to the page's storage. */
  paintStorage?: PaintModeStorage | null;
  /** How the Flow mode watches the page. Passed through for tests. */
  flow?: Partial<Pick<Parameters<typeof startFlowMode>[0], 'changedNodes' | 'subscribeDeliveries' | 'windowMs' | 'fadeMs'>>;
}

export interface ListenerMode {
  setEnabled(enabled: boolean): void;
  enabled(): boolean;
  /** Which way the listeners are painted. */
  mode(): ListenerPaintMode;
  /** Switch the painting. Remembered for the page. */
  setMode(mode: ListenerPaintMode): void;
  /** `true` when this page has a React whose commits the mode can read. */
  flowAvailable(): boolean;
  /** Why Flow is unavailable, or `null` when it is available. */
  flowUnavailableReason(): string | null;
  /** Every outlined listener, drawn or not. */
  outlines(): readonly ListenerOutline[];
  /** The listeners nothing on the page could be outlined for. */
  unattributed(): readonly ListenerOutline[];
  /** `false` when this listener's paint is hidden in both modes. */
  isListenerVisible(listenerId: string): boolean;
  /** Show or hide one listener's paint. Remembered for this page session. */
  setListenerVisible(listenerId: string, visible: boolean): void;
  dispose(): void;
}

const NO_REACT_REASON = 'Flow needs a React renderer on this page.';
const LATE_HOOK_REASON = 'React loaded before pyric could watch its renders, so Flow has nothing to follow.';

/**
 * Studio's listeners view, filtered to one listener. Studio has no listeners
 * view yet, so the filter travels in the query string for the view that will
 * read it; a Studio that does not know these parameters ignores them and
 * opens its default view.
 */
export function studioListenerUrl(studioUrl: string, outline: ListenerOutline): string {
  const separator = studioUrl.includes('?') ? '&' : '?';
  const listener = encodeURIComponent(outline.listenerId);
  const target = encodeURIComponent(outline.target);
  return `${studioUrl}${separator}view=listeners&listener=${listener}&target=${target}`;
}

/** Build the chip's Listeners mode. It starts off and draws nothing. */
export function createListenerMode(options: ListenerModeOptions): ListenerMode {
  const documentLike = options.document;
  const readAttribution = options.attributionEnabled ?? (() => true);
  const readIncidents = options.incidents ?? incidentsFromEvents;
  const paintStorage = options.paintStorage === undefined
    ? pagePaintModeStorage(documentLike)
    : options.paintStorage;

  const events: SandboxEvent[] = [];
  let current: readonly ListenerOutline[] = [];
  let overlay: ListenerOverlay | null = null;
  let flow: FlowMode | null = null;
  let stopFollowing: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let paintMode: ListenerPaintMode = readListenerPaintMode(paintStorage);
  /** Listeners the developer switched off. Page session only, never stored. */
  const hidden = new Set<string>();

  // The commit source is installed once, whether or not Flow is ever turned
  // on: React reads the hook global while its own module first evaluates, so
  // installing it later would be too late to matter.
  const commits = options.commits ?? installReactCommitSource(documentLike.defaultView);

  const visibleOutlines = (): readonly ListenerOutline[] =>
    current.filter((outline) => !hidden.has(outline.listenerId));

  const openStudio = (outline: ListenerOutline): void => {
    const studioUrl = options.studioUrl;
    if (studioUrl === null || studioUrl === undefined) return;
    const url = studioListenerUrl(studioUrl, outline);
    if (options.openStudio) {
      options.openStudio(url);
      return;
    }
    documentLike.defaultView?.open(url, '_blank', 'noopener');
  };

  const paint = (): void => {
    if (overlay === null) return;
    // Overview owns the boxes in the container; Flow owns its own and is
    // driven by deliveries rather than by the fold, so an Overview pass in
    // Flow mode clears the Overview boxes and leaves the flows alone.
    overlay.update(paintMode === 'overview' ? visibleOutlines() : []);
  };

  const recompute = (): void => {
    current = listenerOutlines(events, readIncidents(events));
    paint();
    options.onChange?.(current);
  };

  // Flow needs commits, not just a React. A React that loaded before the hook
  // was installed renders without ever calling it, and saying so is more use
  // than a mode that is on and paints nothing.
  const flowAvailable = (): boolean => commits.available();

  const startFlow = (): void => {
    if (flow !== null || overlay === null) return;
    if (!flowAvailable()) return;
    flow = startFlowMode({
      document: documentLike,
      container: overlay.container(),
      commits,
      outlineFor: (listenerId) => current.find((outline) => outline.listenerId === listenerId) ?? null,
      isVisible: (listenerId) => !hidden.has(listenerId),
      ...(options.flow ?? {}),
    });
    const followFlow = flow;
    stopFollowing = overlay.onReposition(() => {
      followFlow.reposition();
    });
  };

  const stopFlow = (): void => {
    stopFollowing?.();
    stopFollowing = null;
    flow?.dispose();
    flow = null;
  };

  // The mode observes from the moment it exists: the chip's count and summary
  // read the fold whether or not anything is painted. Enabling the mode only
  // adds the overlay on top of a fold that is already current.
  unsubscribe = options.subscribeEvents((batch) => {
    events.push(...batch);
    recompute();
  });
  recompute();

  const hidePainting = (): void => {
    stopFlow();
    overlay?.dispose();
    overlay = null;
  };

  const showPainting = (): void => {
    overlay = createListenerOverlay({ document: documentLike, onSelect: openStudio });
    paint();
    if (paintMode === 'flow') startFlow();
  };

  return {
    setEnabled(next) {
      const isOn = overlay !== null;
      if (next === isOn) return;
      if (!next) {
        hidePainting();
        return;
      }
      if (!readAttribution()) return;
      showPainting();
    },
    enabled() {
      return overlay !== null;
    },
    mode() {
      return paintMode;
    },
    setMode(next) {
      if (next === paintMode) return;
      if (next === 'flow' && !flowAvailable()) return;
      paintMode = next;
      writeListenerPaintMode(paintStorage, next);
      if (overlay === null) return;
      if (next === 'overview') stopFlow();
      paint();
      if (next === 'flow') startFlow();
    },
    flowAvailable,
    flowUnavailableReason() {
      if (flowAvailable()) return null;
      return reactRendered(documentLike) ? LATE_HOOK_REASON : NO_REACT_REASON;
    },
    outlines() {
      return current;
    },
    unattributed() {
      return current.filter((outline) => outline.selectors.length === 0);
    },
    isListenerVisible(listenerId) {
      return !hidden.has(listenerId);
    },
    setListenerVisible(listenerId, visible) {
      if (visible) hidden.delete(listenerId);
      else hidden.add(listenerId);
      paint();
      if (!visible) flow?.clearListener(listenerId);
    },
    dispose() {
      hidePainting();
      unsubscribe?.();
      unsubscribe = null;
      events.length = 0;
      current = [];
      hidden.clear();
    },
  };
}
