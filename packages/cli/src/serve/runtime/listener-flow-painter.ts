/**
 * The boxes the chip's Flow mode paints, and how they fade.
 *
 * Overview draws one box per listener and leaves it there. Flow draws a box
 * per element that changed after a delivery and fades it to a dimmed state
 * over a few seconds, so the page shows where the data went as it arrives
 * rather than what is attached. The dimmed subtree stays until that listener
 * delivers again or is switched off, so the last flow is still readable after
 * the movement stops.
 *
 * The painter puts structure in the DOM and nothing else. Each box says what
 * kind of thing it outlines, which listener it belongs to, which hue that
 * listener draws in, and how far through its fade it is; the drawing comes
 * from the stylesheet in `overlay-theme.ts`, which the container carries.
 *
 * The painter derives nothing. It is handed a listener, the words for its
 * badge, and the subtree {@link FlowSubtree} already named, and it draws that
 * in the listener's own colour into the container the overlay owns. A second
 * delivery from the same listener replaces that listener's boxes rather than
 * stacking on them.
 *
 * The root badge reads the way the Overview badge does: owner, target,
 * deliveries. Its title says these components rendered after the delivery,
 * which is the only claim the correlation supports.
 */
import { listenerHueIndex } from './listener-palette.js';
import { ensureOverlayStyleSheet } from './overlay-theme.js';
import type { FlowSubtree } from './fiber-flow.js';

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
  /** The overlay's container. The painter appends to it and never replaces it. */
  container: HTMLElement;
  /**
   * How long a delivery's boxes stay at full strength before the painter
   * marks them retained. The fade the page runs is the theme's
   * `--pyric-overlay-fade-duration`, which defaults to the same length.
   */
  fadeMs?: number;
  /** How the removal is scheduled. Returns the cancel function. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface FlowPainter {
  /** Draw one delivery, replacing whatever that listener last drew. */
  paint(paint: FlowPaint): void;
  /** Take this listener's boxes away now. */
  clearListener(listenerId: string): void;
  /** Take every box away now. */
  clear(): void;
  /** Recompute the boxes already drawn against the page's current geometry. */
  reposition(): void;
  dispose(): void;
}

/** How long a delivery's boxes stay at full strength, in milliseconds. */
const DEFAULT_FADE_MS = 3000;

/** What the root badge says: owner, target, deliveries. */
export function flowBadgeText(paint: FlowPaint): string {
  return `${paint.label} · ${paint.target} · ${paint.deliveryCount}`;
}

function positionBox(box: HTMLElement, element: Element): void {
  const rect = element.getBoundingClientRect();
  box.style.left = `${rect.left}px`;
  box.style.top = `${rect.top}px`;
  box.style.width = `${rect.width}px`;
  box.style.height = `${rect.height}px`;
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
}

/** Build the Flow painter over an overlay container. */
export function createFlowPainter(options: FlowPainterOptions): FlowPainter {
  const documentLike = options.document;
  const fadeMs = options.fadeMs ?? DEFAULT_FADE_MS;
  const schedule = options.schedule ?? defaultSchedule;
  ensureOverlayStyleSheet(documentLike, options.container);

  interface Group {
    boxes: Array<{ box: HTMLElement; element: Element }>;
    cancel: () => void;
    /** `true` once the fade finished and the boxes are held dimmed. */
    retained: boolean;
  }
  const groups = new Map<string, Group>();

  const removeGroup = (listenerId: string): void => {
    const group = groups.get(listenerId);
    if (group === undefined) return;
    group.cancel();
    for (const entry of group.boxes) entry.box.remove();
    groups.delete(listenerId);
  };

  return {
    paint(paint) {
      removeGroup(paint.listenerId);
      if (paint.subtree.components.length === 0) return;
      const hue = String(listenerHueIndex(paint.listenerId));
      const boxes: Array<{ box: HTMLElement; element: Element }> = [];
      const leafElements = new Set(paint.subtree.leaves.map((leaf) => leaf.element));

      for (const component of paint.subtree.components) {
        const box = documentLike.createElement('div');
        box.setAttribute('data-pyric-flow-box', '');
        box.dataset.listenerId = paint.listenerId;
        box.dataset.component = component.name;
        box.dataset.depth = String(component.depth);
        box.dataset.flowKind = component.kind;
        box.dataset.pyricRole = component.kind;
        box.dataset.hue = hue;

        const root = paint.subtree.root;
        const isRoot = root !== null
          && (root === component || (root.name === component.name && root.element === component.element));
        if (isRoot) {
          const badge = documentLike.createElement('span');
          badge.setAttribute('data-pyric-flow-badge', '');
          badge.dataset.pyricRole = 'badge';
          badge.dataset.hue = hue;
          badge.dataset.listenerId = paint.listenerId;
          badge.title = `${component.name} rendered after a delivery from ${paint.target}`;
          badge.textContent = flowBadgeText(paint);
          box.append(badge);
        } else if (leafElements.has(component.element)) {
          const badge = documentLike.createElement('span');
          badge.setAttribute('data-pyric-flow-leaf-badge', '');
          badge.dataset.pyricRole = 'leaf-badge';
          badge.dataset.hue = hue;
          badge.dataset.listenerId = paint.listenerId;
          badge.dataset.flowKind = component.kind;
          badge.title = component.kind === 'host'
            ? `${component.name} changed after a delivery from ${paint.target}`
            : `${component.name} rendered after a delivery from ${paint.target}`;
          badge.textContent = component.name;
          box.append(badge);
        }

        positionBox(box, component.element);
        options.container.append(box);
        boxes.push({ box, element: component.element });
      }

      // The fade ends at the dimmed state rather than at nothing: the last
      // subtree a listener painted stays on the page until that listener
      // delivers again, so a developer who looks after the delivery still
      // sees where it went. The timer is what marks the group retained
      // whether or not transitions run here.
      const cancel = schedule(() => {
        const group = groups.get(paint.listenerId);
        if (group === undefined) return;
        group.retained = true;
        for (const entry of group.boxes) entry.box.dataset.flowRetained = '';
      }, fadeMs);
      groups.set(paint.listenerId, { boxes, cancel, retained: false });

      // Hand the fade to the page on the next frame, so the browser has the
      // starting opacity to transition away from. The attribute is what the
      // stylesheet reads; the timer above is what marks the fade over.
      const view = documentLike.defaultView;
      const fade = (): void => {
        for (const entry of boxes) entry.box.dataset.flowFading = '';
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
      for (const group of groups.values()) {
        for (const entry of group.boxes) positionBox(entry.box, entry.element);
      }
    },
    dispose() {
      for (const listenerId of [...groups.keys()]) removeGroup(listenerId);
    },
  };
}
