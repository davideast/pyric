/**
 * The boxes the chip's Listeners mode paints over the page.
 *
 * The overlay owns one absolutely positioned container appended to the page
 * body and rebuilds its boxes from a list of {@link ListenerOutline} records.
 * It derives nothing: the model decides which listeners exist, what they are
 * called, what they listen to, and which incident they are part of.
 *
 * The overlay puts structure in the DOM and nothing else. Each box says what
 * it is, which listener it belongs to, which hue that listener draws in, and
 * whether an incident is on it; the drawing comes from the stylesheet in
 * `overlay-theme.ts`, which the container carries. Position and size stay
 * inline, because they are measured from the page rather than chosen.
 *
 * The overlay reads page geometry and never writes it. Its only page-level
 * listener is a window resize handler, which recomputes the boxes it already
 * drew. It installs nothing on application elements.
 */
import type { ListenerOutline } from './listener-outline-model.js';
import { listenerHueIndex } from './listener-palette.js';
import {
  applyOverlayTheme,
  ensureOverlayStyleSheet,
  type OverlayTheme,
} from './overlay-theme.js';
import type { ListenerPaintMode } from './listener-paint-mode.js';

export interface ListenerOverlayOptions {
  document: Document;
  /** Called when a developer clicks a badge, for the Studio hand-off. */
  onSelect?: (outline: ListenerOutline) => void;
  /** Custom property overrides for the container. See `overlay-theme.ts`. */
  theme?: OverlayTheme | null;
  /** Which painting mode the container starts in, for the mode attribute. */
  mode?: ListenerPaintMode;
}

export interface ListenerOverlay {
  /** Replace every box with the ones these outlines describe. */
  update(outlines: readonly ListenerOutline[]): void;
  /**
   * The container both painting modes draw into. The Flow painter appends its
   * own boxes here, so the two modes share one layer and one z-index.
   */
  container(): HTMLElement;
  /** Recompute the boxes already drawn against the page's current geometry. */
  reposition(): void;
  /** Called after a resize, so a second painter can follow the page too. */
  onReposition(listener: () => void): () => void;
  /** Say which painting mode the container is in, for the stylesheet. */
  setMode(mode: ListenerPaintMode): void;
  /** Replace the container's custom properties with these overrides. */
  setTheme(theme: OverlayTheme | null): void;
  /** Remove the container and its resize handler. */
  dispose(): void;
}

const CONTAINER_STYLE = [
  'position:fixed',
  'inset:0',
  'pointer-events:none',
  'z-index:2147482999',
].join(';');

/**
 * The container is a layer both painting modes draw into, so the boxes an
 * Overview pass replaces are addressed by their own attribute rather than by
 * clearing the container.
 */
const BOX_ATTRIBUTE = 'data-pyric-listener-box';

/** The words on a badge: what owns the listener, and what it listens to. */
function badgeText(outline: ListenerOutline): string {
  const target = outline.isQuery ? `${outline.target} (query)` : outline.target;
  const base = `${outline.label} · ${target} · ${outline.deliveryCount}`;
  if (outline.incident === null) return base;
  const word = outline.incident.pattern === 'duplicate-listener' ? 'duplicate' : 'churn';
  return `${base} · ${word} ×${outline.incident.count}`;
}

/** Every element an outline claims, in the order its selectors name them. */
function ownedElements(documentLike: Document, outline: ListenerOutline): Element[] {
  const elements: Element[] = [];
  for (const selector of outline.selectors) {
    let found: Element | null = null;
    try {
      found = documentLike.querySelector(selector);
    } catch {
      found = null;
    }
    if (found !== null) elements.push(found);
  }
  return elements;
}

function positionBox(box: HTMLElement, element: Element): void {
  const rect = element.getBoundingClientRect();
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

/** Mount the outline container this mode draws into. */
export function createListenerOverlay(options: ListenerOverlayOptions): ListenerOverlay {
  const documentLike = options.document;
  const container = documentLike.createElement('div');
  container.setAttribute('data-pyric-listener-overlay', '');
  container.setAttribute('data-pyric-mode', options.mode ?? 'overview');
  container.setAttribute('style', CONTAINER_STYLE);
  ensureOverlayStyleSheet(documentLike, container);
  applyOverlayTheme(container, options.theme);
  documentLike.body.append(container);

  let drawn: Array<{ box: HTMLElement; element: Element }> = [];

  const draw = (outlines: readonly ListenerOutline[]): void => {
    for (const previous of [...container.querySelectorAll(`[${BOX_ATTRIBUTE}]`)]) previous.remove();
    drawn = [];
    for (const outline of outlines) {
      const hue = String(listenerHueIndex(outline.listenerId));
      for (const element of ownedElements(documentLike, outline)) {
        const box = documentLike.createElement('div');
        box.setAttribute(BOX_ATTRIBUTE, '');
        box.dataset.pyricRole = 'region';
        box.dataset.listenerId = outline.listenerId;
        box.dataset.listenerTarget = outline.target;
        box.dataset.hue = hue;
        // An incident outranks the listener's own colour: the warm border the
        // stylesheet gives an incident is what a duplicate or a churn reads as
        // everywhere else in the chip.
        if (outline.incident !== null) box.dataset.incident = outline.incident.pattern;

        const badge = documentLike.createElement('button');
        badge.type = 'button';
        badge.setAttribute('data-pyric-listener-badge', '');
        badge.dataset.pyricRole = 'badge';
        badge.dataset.listenerId = outline.listenerId;
        badge.dataset.hue = hue;
        if (outline.incident !== null) badge.dataset.incident = outline.incident.pattern;
        badge.textContent = badgeText(outline);
        badge.addEventListener('click', () => {
          options.onSelect?.(outline);
        });

        box.append(badge);
        positionBox(box, element);
        container.append(box);
        drawn.push({ box, element });
      }
    }
  };

  const followers = new Set<() => void>();

  const reposition = (): void => {
    for (const entry of drawn) positionBox(entry.box, entry.element);
    for (const follower of [...followers]) follower();
  };

  const view = documentLike.defaultView;
  view?.addEventListener('resize', reposition);

  return {
    update(outlines) {
      draw(outlines);
    },
    container() {
      return container;
    },
    reposition,
    setMode(mode) {
      container.setAttribute('data-pyric-mode', mode);
    },
    setTheme(theme) {
      applyOverlayTheme(container, theme);
    },
    onReposition(listener) {
      followers.add(listener);
      return () => {
        followers.delete(listener);
      };
    },
    dispose() {
      view?.removeEventListener('resize', reposition);
      followers.clear();
      drawn = [];
      container.remove();
    },
  };
}
