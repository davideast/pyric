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
  pageOverlayThemeStorage,
  OVERLAY_THEME_KEY,
  readStoredOverlayTheme,
  type OverlayTheme,
  type OverlayThemeStorage,
} from './overlay-theme.js';
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
  /**
   * The served page's overlay theme. The page's own stored overrides win over
   * it. See `overlay-theme.ts` for the contract.
   */
  overlayTheme?: OverlayTheme | null;
  /** Where the page's overrides are kept. Defaults to the page's storage. */
  themeStorage?: OverlayThemeStorage | null;
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
  /**
   * `true` while Flow is on and nothing has been painted since the switch, so
   * the panel can say what it is waiting for.
   */
  flowWaiting(): boolean;
  /** Every outlined listener, drawn or not. */
  outlines(): readonly ListenerOutline[];
  /** The listeners nothing on the page could be outlined for. */
  unattributed(): readonly ListenerOutline[];
  /** `false` when this listener's paint is hidden in both modes. */
  isListenerVisible(listenerId: string): boolean;
  /** Show or hide one listener's paint. Remembered for this page session. */
  setListenerVisible(listenerId: string, visible: boolean): void;
  /** The overrides in effect, page storage over the served page's option. */
  overlayTheme(): OverlayTheme;
  /**
   * Draw with these overrides from now on. Passing `null` goes back to the
   * served page's option, and from there to the contract's defaults.
   */
  setOverlayTheme(theme: OverlayTheme | null): void;
  dispose(): void;
}

const NO_REACT_REASON = 'Flow needs a React renderer on this page.';
const LATE_HOOK_REASON = 'React loaded before pyric could watch its renders, so Flow has nothing to follow.';

/**
 * The Listeners tab's address, with `?view=listeners` already on it.
 *
 * The tab is a Traffic view, so the link names the sibling `traffic` route
 * rather than the Studio hub, and it keeps the trailing slash. Both avoid the
 * served host's redirect to the trailing-slash form, so no hop can drop the
 * query the link carries.
 */
export function studioListenersUrl(studioUrl: string): string {
  const queryStart = studioUrl.indexOf('?');
  const base = queryStart === -1 ? studioUrl : studioUrl.slice(0, queryStart);
  const existing = queryStart === -1 ? '' : studioUrl.slice(queryStart + 1);
  const segments = base.replace(/\/+$/, '').split('/');
  if (segments[segments.length - 1] === 'studio') segments.pop();
  segments.push('traffic');
  const query = existing === '' ? 'view=listeners' : `${existing}&view=listeners`;
  return `${segments.join('/')}/?${query}`;
}

/**
 * Studio's Listeners tab, filtered to one listener. The filter travels in the
 * query string; a Studio that does not know these parameters ignores them and
 * opens its default view.
 */
export function studioListenerUrl(studioUrl: string, outline: ListenerOutline): string {
  const listener = encodeURIComponent(outline.listenerId);
  const target = encodeURIComponent(outline.target);
  return `${studioListenersUrl(studioUrl)}&listener=${listener}&target=${target}`;
}

/** Build the chip's Listeners mode. It starts off and draws nothing. */
export function createListenerMode(options: ListenerModeOptions): ListenerMode {
  const documentLike = options.document;
  const readAttribution = options.attributionEnabled ?? (() => true);
  const readIncidents = options.incidents ?? incidentsFromEvents;
  const paintStorage = options.paintStorage === undefined
    ? pagePaintModeStorage(documentLike)
    : options.paintStorage;
  const themeStorage = options.themeStorage === undefined
    ? pageOverlayThemeStorage(documentLike)
    : options.themeStorage;
  // The served page's option is the floor, the page's own overrides the
  // ceiling. A theme is resolved on the container, so both layers travel.
  let storedTheme: OverlayTheme | null = readStoredOverlayTheme(themeStorage);
  const effectiveTheme = (): OverlayTheme => ({
    ...(options.overlayTheme ?? {}),
    ...(storedTheme ?? {}),
  });

  const events: SandboxEvent[] = [];
  let current: readonly ListenerOutline[] = [];
  let overlay: ListenerOverlay | null = null;
  let flow: FlowMode | null = null;
  let stopFollowing: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let paintMode: ListenerPaintMode = readListenerPaintMode(paintStorage);
  /** `true` once Flow painted a delivery since the switch into Flow. */
  let flowPainted = false;
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
    const previous = current;
    current = listenerOutlines(events, readIncidents(events));
    // A detached listener keeps no paint. Flow holds its last subtree until
    // the next delivery, and for a listener that is gone there will not be
    // one.
    for (const outline of previous) {
      if (current.some((next) => next.listenerId === outline.listenerId)) continue;
      flow?.clearListener(outline.listenerId);
    }
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
    flowPainted = false;
    flow = startFlowMode({
      document: documentLike,
      container: overlay.container(),
      commits,
      // A delivery observed on the page carries the client's subscription id;
      // the outline knows both ids.
      outlineFor: (listenerId) => current.find((outline) => outline.listenerId === listenerId || outline.clientListenerId === listenerId) ?? null,
      isVisible: (listenerId) => !hidden.has(listenerId),
      // The switch into Flow replays what the fold already recorded, so the
      // developer sees the latest flow rather than waiting for the next
      // delivery on a page that may be idle.
      recentDeliveries: () => visibleOutlines()
        .filter((outline) => outline.lastDeliveryAt !== undefined)
        .map((outline) => ({ listenerId: outline.listenerId, at: outline.lastDeliveryAt! })),
      onPaint: () => {
        if (flowPainted) return;
        flowPainted = true;
        // The panel's waiting hint is gone as of this paint, and the panel
        // only rebuilds when the mode says something changed.
        options.onChange?.(current);
      },
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
    overlay = createListenerOverlay({
      document: documentLike,
      onSelect: openStudio,
      theme: effectiveTheme(),
      mode: paintMode,
    });
    paint();
    if (paintMode === 'flow') startFlow();
  };

  // Another tab, or this page's own Theme dialog, writes the overrides; the
  // event is what puts them on a container that is already drawing.
  const view = documentLike.defaultView;
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== OVERLAY_THEME_KEY) return;
    storedTheme = readStoredOverlayTheme(themeStorage);
    overlay?.setTheme(effectiveTheme());
  };
  view?.addEventListener('storage', onStorage);

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
      overlay.setMode(next);
      if (next === 'overview') stopFlow();
      paint();
      if (next === 'flow') startFlow();
    },
    flowAvailable,
    flowUnavailableReason() {
      if (flowAvailable()) return null;
      return reactRendered(documentLike) ? LATE_HOOK_REASON : NO_REACT_REASON;
    },
    flowWaiting() {
      return flow !== null && !flowPainted;
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
      // Switching a listener off takes its paint away now rather than only
      // suppressing the next one: Flow holds its last subtree on the page, so
      // leaving it there would leave a box no row is checked for. Switching
      // back on leaves the page empty until the next delivery.
      if (!visible) flow?.clearListener(listenerId);
    },
    overlayTheme() {
      return effectiveTheme();
    },
    setOverlayTheme(theme) {
      storedTheme = theme;
      overlay?.setTheme(effectiveTheme());
    },
    dispose() {
      view?.removeEventListener('storage', onStorage);
      hidePainting();
      unsubscribe?.();
      unsubscribe = null;
      events.length = 0;
      current = [];
      hidden.clear();
    },
  };
}
