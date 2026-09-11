/**
 * The chip's Listeners mode: what on the page has a listener, and what it
 * listens to.
 *
 * The mode folds the sandbox event stream the page already receives into
 * outline records, paints them, and lists the listeners nothing on the page
 * could be outlined for. It holds a subscription only while it is on, so a
 * page that never opens the mode pays nothing for it.
 *
 * Listener attribution is a development diagnostic. When the production
 * switch has it off there are no owners to place, so the mode refuses to turn
 * on and draws nothing.
 */
import type { SandboxEvent } from 'pyric/sandbox';
import type { ActivityIncident } from 'pyric/firestore/internal';
import { listenerOutlines, type ListenerOutline } from './listener-outline-model.js';
import { createListenerOverlay, type ListenerOverlay } from './listener-overlay.js';
import { incidentsFromEvents } from './listener-incidents.js';

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
}

export interface ListenerMode {
  setEnabled(enabled: boolean): void;
  enabled(): boolean;
  /** Every outlined listener, drawn or not. */
  outlines(): readonly ListenerOutline[];
  /** The listeners nothing on the page could be outlined for. */
  unattributed(): readonly ListenerOutline[];
  dispose(): void;
}

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

  const events: SandboxEvent[] = [];
  let current: readonly ListenerOutline[] = [];
  let overlay: ListenerOverlay | null = null;
  let unsubscribe: (() => void) | null = null;

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

  const recompute = (): void => {
    current = listenerOutlines(events, readIncidents(events));
    overlay?.update(current);
    options.onChange?.(current);
  };

  const stop = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    overlay?.dispose();
    overlay = null;
    events.length = 0;
    current = [];
  };

  const start = (): void => {
    overlay = createListenerOverlay({ document: documentLike, onSelect: openStudio });
    unsubscribe = options.subscribeEvents((batch) => {
      events.push(...batch);
      recompute();
    });
    recompute();
  };

  return {
    setEnabled(next) {
      const isOn = overlay !== null;
      if (next === isOn) return;
      if (!next) {
        stop();
        return;
      }
      if (!readAttribution()) return;
      start();
    },
    enabled() {
      return overlay !== null;
    },
    outlines() {
      return current;
    },
    unattributed() {
      return current.filter((outline) => outline.selectors.length === 0);
    },
    dispose() {
      stop();
    },
  };
}
