/**
 * The boxes the chip's Listeners mode paints over the page.
 *
 * The overlay owns one absolutely positioned container appended to the page
 * body and rebuilds its boxes from a list of {@link ListenerOutline} records.
 * It derives nothing: the model decides which listeners exist, what they are
 * called, what they listen to, and which incident they are part of.
 *
 * The overlay reads page geometry and never writes it. Its only page-level
 * listener is a window resize handler, which recomputes the boxes it already
 * drew. It installs nothing on application elements.
 */
import type { ListenerOutline } from './listener-outline-model.js';

export interface ListenerOverlayOptions {
  document: Document;
  /** Called when a developer clicks a badge, for the Studio hand-off. */
  onSelect?: (outline: ListenerOutline) => void;
}

export interface ListenerOverlay {
  /** Replace every box with the ones these outlines describe. */
  update(outlines: readonly ListenerOutline[]): void;
  /** Remove the container and its resize handler. */
  dispose(): void;
}

const CONTAINER_STYLE = [
  'position:fixed',
  'inset:0',
  'pointer-events:none',
  'z-index:2147482999',
].join(';');

const BOX_STYLE = [
  'position:absolute',
  'border:1px solid #19cc61',
  'border-radius:4px',
  'background:rgba(25,204,97,.08)',
  'pointer-events:none',
].join(';');

const BADGE_STYLE = [
  'position:absolute',
  'top:-9px',
  'left:0',
  'background:#16161a',
  'border:1px solid #33333f',
  'border-radius:4px',
  'color:#fbfbfe',
  'cursor:pointer',
  'font:10px/1.6 "JetBrains Mono", ui-monospace, monospace',
  'padding:1px 6px',
  'pointer-events:auto',
  'white-space:nowrap',
].join(';');

const INCIDENT_BORDER = '#e6c79c';

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
  container.setAttribute('style', CONTAINER_STYLE);
  documentLike.body.append(container);

  let drawn: Array<{ box: HTMLElement; element: Element }> = [];

  const draw = (outlines: readonly ListenerOutline[]): void => {
    container.replaceChildren();
    drawn = [];
    for (const outline of outlines) {
      for (const element of ownedElements(documentLike, outline)) {
        const box = documentLike.createElement('div');
        box.setAttribute('data-pyric-listener-box', '');
        box.setAttribute('style', BOX_STYLE);
        box.dataset.listenerId = outline.listenerId;
        box.dataset.listenerTarget = outline.target;
        if (outline.incident !== null) box.style.borderColor = INCIDENT_BORDER;

        const badge = documentLike.createElement('button');
        badge.type = 'button';
        badge.setAttribute('data-pyric-listener-badge', '');
        badge.setAttribute('style', BADGE_STYLE);
        badge.dataset.listenerId = outline.listenerId;
        if (outline.incident !== null) {
          badge.dataset.incident = outline.incident.pattern;
          badge.style.borderColor = INCIDENT_BORDER;
        }
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

  const reposition = (): void => {
    for (const entry of drawn) positionBox(entry.box, entry.element);
  };

  const view = documentLike.defaultView;
  view?.addEventListener('resize', reposition);

  return {
    update(outlines) {
      draw(outlines);
    },
    dispose() {
      view?.removeEventListener('resize', reposition);
      drawn = [];
      container.remove();
    },
  };
}
