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
import { listenerColors } from './listener-palette.js';
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
  /** How long a delivery's boxes stay on the page. */
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

/**
 * What a faded subtree is left at. The last flow stays readable so a developer
 * who looks at the page after the delivery still sees where it went, and the
 * next delivery from the same listener replaces it.
 */
const RETAINED_OPACITY = '0.3';

const BOX_STYLE = [
  'position:absolute',
  'border-radius:4px',
  'pointer-events:none',
].join(';');

const BADGE_STYLE = [
  'position:absolute',
  'top:-9px',
  'left:0',
  'background:#16161a',
  'border:1px solid #33333f',
  'border-radius:4px',
  'font:10px/1.6 "JetBrains Mono", ui-monospace, monospace',
  'padding:1px 6px',
  'pointer-events:none',
  'white-space:nowrap',
].join(';');

const LEAF_BADGE_STYLE = [
  'position:absolute',
  'bottom:-9px',
  'right:0',
  'background:#16161a',
  'border:1px solid #33333f',
  'border-radius:4px',
  'font:9px/1.6 "JetBrains Mono", ui-monospace, monospace',
  'padding:0 4px',
  'pointer-events:none',
  'white-space:nowrap',
].join(';');

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
      const colors = listenerColors(paint.listenerId);
      const boxes: Array<{ box: HTMLElement; element: Element }> = [];
      const leafElements = new Set(paint.subtree.leaves.map((leaf) => leaf.element));

      for (const component of paint.subtree.components) {
        const box = documentLike.createElement('div');
        box.setAttribute('data-pyric-flow-box', '');
        box.setAttribute('style', BOX_STYLE);
        box.dataset.listenerId = paint.listenerId;
        box.dataset.component = component.name;
        box.dataset.depth = String(component.depth);
        box.dataset.flowKind = component.kind;
        box.style.border = `1px solid ${colors.border}`;
        box.style.background = colors.fill;
        // The fade is a style the page carries out; the removal below is what
        // takes the box off the page whether or not transitions run here.
        box.style.transition = `opacity ${fadeMs}ms linear`;
        box.style.opacity = '1';

        const root = paint.subtree.root;
        const isRoot = root !== null
          && (root === component || (root.name === component.name && root.element === component.element));
        if (isRoot) {
          const badge = documentLike.createElement('span');
          badge.setAttribute('data-pyric-flow-badge', '');
          badge.setAttribute('style', BADGE_STYLE);
          badge.style.borderColor = colors.border;
          badge.style.color = colors.accent;
          badge.dataset.listenerId = paint.listenerId;
          badge.title = `${component.name} rendered after a delivery from ${paint.target}`;
          badge.textContent = flowBadgeText(paint);
          box.append(badge);
        } else if (leafElements.has(component.element)) {
          const badge = documentLike.createElement('span');
          badge.setAttribute('data-pyric-flow-leaf-badge', '');
          badge.setAttribute('style', LEAF_BADGE_STYLE);
          badge.style.borderColor = colors.border;
          badge.style.color = colors.accent;
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
        for (const entry of group.boxes) {
          entry.box.dataset.flowRetained = '';
          entry.box.style.opacity = RETAINED_OPACITY;
        }
      }, fadeMs);
      groups.set(paint.listenerId, { boxes, cancel, retained: false });

      // Hand the fade to the page on the next frame, so the browser has the
      // starting opacity to transition away from.
      const view = documentLike.defaultView;
      const fade = (): void => {
        for (const entry of boxes) entry.box.style.opacity = RETAINED_OPACITY;
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
