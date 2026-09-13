/**
 * The marks the chip's Flow mode puts on the page, and how they fade.
 *
 * Overview draws one measured box per listener and leaves it there. Flow marks
 * the elements themselves. An element that changed after a delivery is given
 * `data-pyric-flow` attributes, and the stylesheet in `overlay-theme.ts` draws
 * an outline and a badge through those attributes. Nothing is measured, so the
 * mark moves with the element, survives a scroll or a reflow, and goes away
 * with the element when the application removes it.
 *
 * The outline is what draws the mark, because it takes no space. The badge is
 * an `::after` pseudo-element reading its words out of `data-pyric-flow-label`,
 * so no node is added to the application's tree either. An element that cannot
 * carry a pseudo-element (an `img`, an `input`, and the other replaced
 * elements) gets a positioned badge in the overlay container instead, which is
 * the one thing here that is measured.
 *
 * The listener's registered region is not marked. Flow says where a delivery
 * landed, and the region is the whole area the listener feeds rather than
 * something that changed. The listener is named in the labels instead: the
 * first element of a delivery carries the full owner, target, and delivery
 * count, and every other element carries its own component or element name.
 *
 * Bursts accumulate. A delivery adds to what its listener already has on the
 * page rather than replacing it, so ten deliveries in a second leave ten
 * marked elements, each running its own fade. When a fade ends, the mark is
 * held dimmed if it belongs to the listener's most recent delivery and is
 * taken away otherwise, so the last delivery stays readable while the ones
 * before it clear themselves. A delivery that marks an element that is already
 * marked restarts that element's fade rather than adding a second mark.
 */
import { listenerHueIndex } from './listener-palette.js';
import { ensureFlowStyleSheet, ensureOverlayStyleSheet } from './overlay-theme.js';
import type { FlowSubtree } from './fiber-flow.js';
import { tryAnchorOverlay } from './overlay-anchor.js';

/** One delivery, ready to draw. */
export interface FlowPaint {
  readonly listenerId: string;
  /** The owner label the Listeners panel uses. */
  readonly label: string;
  /** The target the way the application wrote it. */
  readonly target: string;
  /** The listener's delivery count at this delivery. */
  readonly deliveryCount: number;
  readonly subtree: FlowSubtree;
}

export interface FlowPainterOptions {
  document: Document;
  /**
   * The overlay's container. The painter uses it only for the badges of
   * elements that cannot carry a pseudo-element, and never replaces it.
   */
  container: HTMLElement;
  /**
   * How long a mark stays at full strength before the painter either holds it
   * dimmed or takes it away. The fade the page runs is the theme's
   * `--pyric-overlay-fade-duration`, which defaults to the same length.
   */
  fadeMs?: number;
  /** How the fade's end is scheduled. Returns the cancel function. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface FlowPainter {
  /** Mark one delivery, adding to what this listener already has on the page. */
  paint(paint: FlowPaint): void;
  /** Take this listener's marks away now. */
  clearListener(listenerId: string): void;
  /** Take every mark away now. */
  clear(): void;
  /** Recompute the measured badges against the page's current geometry. */
  reposition(): void;
  dispose(): void;
}

/** How long a mark stays at full strength, in milliseconds. */
const DEFAULT_FADE_MS = 3000;

/**
 * The elements that render content of their own instead of their children, and
 * so have no box a pseudo-element can be placed in. These get a measured badge
 * in the overlay container.
 */
const REPLACED_TAGS = new Set([
  'AREA', 'AUDIO', 'BR', 'CANVAS', 'COL', 'EMBED', 'HR', 'IFRAME', 'IMG', 'INPUT',
  'OBJECT', 'PARAM', 'PROGRESS', 'SELECT', 'SOURCE', 'TEXTAREA', 'TRACK', 'VIDEO', 'WBR',
]);

/** What the first element's label says: owner, target, deliveries. */
export function flowBadgeText(paint: FlowPaint): string {
  return `${paint.label} · ${paint.target} · ${paint.deliveryCount}`;
}

/** `true` when a badge cannot be drawn on this element as a pseudo-element. */
export function needsMeasuredBadge(element: Element): boolean {
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return REPLACED_TAGS.has(tag);
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
}

/**
 * Give a statically positioned element something to hang its badge off.
 *
 * The badge is absolutely positioned against the marked element, which only
 * works when that element is positioned. This is read per element rather than
 * written in the stylesheet, because a rule would override the position an
 * application chose. Returns what puts the element back, or `null` when
 * nothing was changed.
 */
function anchorElement(documentLike: Document, element: Element): (() => void) | null {
  const style = (element as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (style === undefined) return null;
  const view = documentLike.defaultView;
  let position = 'static';
  try {
    position = view?.getComputedStyle(element).position ?? 'static';
  } catch {
    position = 'static';
  }
  if (position !== 'static') return null;
  const previous = style.getPropertyValue('position');
  const priority = style.getPropertyPriority('position');
  style.setProperty('position', 'relative');
  return () => {
    if (previous === '') style.removeProperty('position');
    else style.setProperty('position', previous, priority);
  };
}

/** Build the Flow painter. The container is only for the measured badges. */
export function createFlowPainter(options: FlowPainterOptions): FlowPainter {
  const documentLike = options.document;
  const fadeMs = options.fadeMs ?? DEFAULT_FADE_MS;
  const schedule = options.schedule ?? defaultSchedule;
  ensureOverlayStyleSheet(documentLike, options.container);
  ensureFlowStyleSheet(documentLike);

  /** One marked element, with the delivery that last marked it. */
  interface Mark {
    readonly element: Element;
    /** The delivery this mark is currently running on. */
    paintId: number;
    /** Stops the fade's end from arriving. */
    cancel: () => void;
    /** The measured badge, for an element that cannot carry a pseudo one. */
    badge: HTMLElement | null;
    /** Puts an element's own `position` back, when the painter set one. */
    restore: (() => void) | null;
    /** Release a native anchor held by a detached photo/input badge. */
    releaseAnchor: (() => void) | null;
  }

  /** One listener's marks, keyed by the element each is on. */
  interface Group {
    readonly marks: Map<Element, Mark>;
    /** The newest delivery from this listener, which is the one retained. */
    latestPaintId: number;
  }

  const groups = new Map<string, Group>();
  let paintCounter = 0;

  const removeMark = (group: Group, listenerId: string, mark: Mark): void => {
    mark.cancel();
    const element = mark.element as HTMLElement;
    mark.badge?.remove();
    mark.releaseAnchor?.();
    mark.restore?.();
    group.marks.delete(mark.element);
    // Two listeners can land on the same element. The attributes name one of
    // them, so only the listener they name takes them off.
    if (element.getAttribute('data-pyric-flow-listener') !== listenerId) return;
    element.removeAttribute('data-pyric-flow');
    element.removeAttribute('data-pyric-flow-listener');
    element.removeAttribute('data-pyric-flow-role');
    element.removeAttribute('data-pyric-flow-label');
    element.removeAttribute('data-pyric-flow-fading');
    element.removeAttribute('data-pyric-flow-retained');
  };

  const removeGroup = (listenerId: string): void => {
    const group = groups.get(listenerId);
    if (group === undefined) return;
    for (const mark of [...group.marks.values()]) removeMark(group, listenerId, mark);
    groups.delete(listenerId);
  };

  const positionBadge = (badge: HTMLElement, element: Element): void => {
    if (badge.hasAttribute('data-pyric-anchored')) return;
    const rect = element.getBoundingClientRect();
    badge.style.left = `${rect.left}px`;
    badge.style.top = `${rect.top}px`;
  };

  /**
   * The end of one element's fade. The mark is held dimmed when it belongs to
   * this listener's newest delivery, so the page still shows where the last
   * delivery went, and is taken away when an older delivery in a burst put it
   * there. A restart has already moved the mark on to a newer delivery, which
   * is what the identity check reads.
   */
  const fadeEnded = (listenerId: string, element: Element, paintId: number): void => {
    const group = groups.get(listenerId);
    if (group === undefined) return;
    const mark = group.marks.get(element);
    if (mark === undefined || mark.paintId !== paintId) return;
    if (paintId === group.latestPaintId) {
      (element as HTMLElement).setAttribute('data-pyric-flow-retained', '');
      mark.badge?.setAttribute('data-pyric-flow-retained', '');
      return;
    }
    removeMark(group, listenerId, mark);
    if (group.marks.size === 0) groups.delete(listenerId);
  };

  return {
    paint(paint) {
      if (paint.subtree.components.length === 0) return;
      const hue = String(listenerHueIndex(paint.listenerId));
      const existing = groups.get(paint.listenerId);
      const group: Group = existing ?? { marks: new Map<Element, Mark>(), latestPaintId: 0 };
      if (existing === undefined) groups.set(paint.listenerId, group);

      paintCounter += 1;
      const paintId = paintCounter;
      group.latestPaintId = paintId;
      const painted: Mark[] = [];

      paint.subtree.components.forEach((component, index) => {
        const element = component.element as HTMLElement;
        // The listener is named once per delivery, on the first element it
        // marked; everything else says what it is.
        const label = index === 0 ? flowBadgeText(paint) : component.name;
        const measured = needsMeasuredBadge(element);

        let mark = group.marks.get(component.element);
        if (mark === undefined) {
          mark = {
            element: component.element,
            paintId,
            cancel: () => {},
            badge: null,
            restore: measured ? null : anchorElement(documentLike, component.element),
            releaseAnchor: null,
          };
          group.marks.set(component.element, mark);
        } else {
          // A newer delivery on an element that is still marked restarts that
          // element's fade rather than marking it twice.
          mark.cancel();
          element.removeAttribute('data-pyric-flow-fading');
          element.removeAttribute('data-pyric-flow-retained');
          mark.badge?.removeAttribute('data-pyric-flow-fading');
          mark.badge?.removeAttribute('data-pyric-flow-retained');
          mark.paintId = paintId;
        }

        element.setAttribute('data-pyric-flow', hue);
        element.setAttribute('data-pyric-flow-listener', paint.listenerId);
        element.setAttribute('data-pyric-flow-role', component.kind);

        if (measured) {
          element.removeAttribute('data-pyric-flow-label');
          if (mark.badge === null) {
            const badge = documentLike.createElement('span');
            badge.setAttribute('data-pyric-flow-badge', '');
            badge.dataset.pyricRole = 'leaf-badge';
            badge.dataset.hue = hue;
            badge.dataset.listenerId = paint.listenerId;
            options.container.append(badge);
            mark.releaseAnchor = tryAnchorOverlay(badge, component.element, false);
            mark.badge = badge;
          }
          mark.badge.textContent = label;
          mark.badge.title = `${component.name} changed after a delivery from ${paint.target}`;
          positionBadge(mark.badge, component.element);
        } else {
          element.setAttribute('data-pyric-flow-label', label);
        }

        mark.paintId = paintId;
        mark.cancel = schedule(() => {
          fadeEnded(paint.listenerId, component.element, paintId);
        }, fadeMs);
        painted.push(mark);
      });

      // Hand the fade to the page on the next frame, so the browser has the
      // starting colour to transition away from. The attribute is what the
      // stylesheet reads; the timer above is what decides how the fade ends.
      const view = documentLike.defaultView;
      const fade = (): void => {
        for (const mark of painted) {
          if (mark.paintId !== paintId) continue;
          (mark.element as HTMLElement).setAttribute('data-pyric-flow-fading', '');
          mark.badge?.setAttribute('data-pyric-flow-fading', '');
        }
      };
      if (view?.requestAnimationFrame) view.requestAnimationFrame(fade);
      else schedule(fade, 0);
    },
    clearListener(listenerId) {
      removeGroup(listenerId);
    },
    clear() {
      for (const listenerId of [...groups.keys()]) removeGroup(listenerId);
    },
    reposition() {
      for (const [listenerId, group] of groups) {
        for (const mark of [...group.marks.values()]) {
          if (!mark.element.isConnected) { removeMark(group, listenerId, mark); continue; }
          if (mark.badge !== null) positionBadge(mark.badge, mark.element);
        }
        if (group.marks.size === 0) groups.delete(listenerId);
      }
    },
    dispose() {
      for (const listenerId of [...groups.keys()]) removeGroup(listenerId);
    },
  };
}
