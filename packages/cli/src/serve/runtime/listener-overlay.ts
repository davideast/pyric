/**
 * The boxes the chip's Listeners mode paints over the page.
 *
 * The overlay owns one fixed-position container appended to the page
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
 * Native CSS anchors follow supported targets. Other targets are measured on
 * scroll (including nested scrollers), resize, and layout changes. Anchor
 * names are restored when the diagnostic releases an application element.
 */
import type { ListenerOutline } from './listener-outline-model.js';
import { listenerHueIndex } from './listener-palette.js';
import {
  applyOverlayTheme,
  ensureOverlayStyleSheet,
  type OverlayTheme,
} from './overlay-theme.js';
import type { ListenerPaintMode } from './listener-paint-mode.js';
import { tryAnchorOverlay } from './overlay-anchor.js';

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
  /** Called after geometry changes, so a second painter can follow too. */
  onReposition(listener: () => void): () => void;
  /** Say which painting mode the container is in, for the stylesheet. */
  setMode(mode: ListenerPaintMode): void;
  /** Replace the container's custom properties with these overrides. */
  setTheme(theme: OverlayTheme | null): void;
  /** Remove the container, anchor bindings, and geometry observers. */
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
  if (box.hasAttribute('data-pyric-anchored')) return;
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

  let drawn: Array<{ box: HTMLElement; element: Element; release: (() => void) | null }> = [];

  const draw = (outlines: readonly ListenerOutline[]): void => {
    for (const entry of drawn) entry.release?.();
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
        container.append(box);
        const release = tryAnchorOverlay(box, element, true);
        positionBox(box, element);
        drawn.push({ box, element, release });
      }
    }
  };

  const followers = new Set<() => void>();

  const reposition = (): void => {
    drawn = drawn.filter((entry) => {
      if (!entry.element.isConnected) {
        entry.release?.();
        entry.box.remove();
        return false;
      }
      positionBox(entry.box, entry.element);
      return true;
    });
    for (const follower of [...followers]) follower();
  };

  const view = documentLike.defaultView;
  let frame: number | null = null;
  const scheduleReposition = (): void => {
    if (!view?.requestAnimationFrame) { reposition(); return; }
    if (frame !== null) return;
    frame = view.requestAnimationFrame(() => { frame = null; reposition(); });
  };
  view?.addEventListener('resize', reposition);
  // Element scroll events do not bubble. Capture observes nested scrollers.
  view?.addEventListener('scroll', scheduleReposition, { capture: true, passive: true });
  view?.visualViewport?.addEventListener('resize', scheduleReposition);
  view?.visualViewport?.addEventListener('scroll', scheduleReposition);
  const resize = view?.ResizeObserver ? new view.ResizeObserver(scheduleReposition) : null;
  resize?.observe(documentLike.documentElement);
  if (documentLike.body) resize?.observe(documentLike.body);
  const mutations = view?.MutationObserver ? new view.MutationObserver((records) => {
    if (records.some(record => !container.contains(record.target))) scheduleReposition();
  }) : null;
  if (documentLike.body) mutations?.observe(documentLike.body, { subtree: true, childList: true, characterData: true, attributes: true });

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
      view?.removeEventListener('scroll', scheduleReposition, true);
      view?.visualViewport?.removeEventListener('resize', scheduleReposition);
      view?.visualViewport?.removeEventListener('scroll', scheduleReposition);
      if (frame !== null) view?.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations?.disconnect();
      for (const entry of drawn) entry.release?.();
      followers.clear();
      drawn = [];
      container.remove();
    },
  };
}
