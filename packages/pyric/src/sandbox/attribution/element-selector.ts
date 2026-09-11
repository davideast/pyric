/**
 * Turning a DOM element into a string that names it again later.
 *
 * Two callers want slightly different things, so this file offers two
 * entry points over one identity ladder:
 *
 * - {@link ownerSelectorFor} is for an element the caller handed to pyric as
 *   a listener's owner. The caller asked to be identified, so an element with
 *   no identity of its own is GIVEN one: a generated `data-pyric-owner`
 *   attribute that survives re-render and makes the selector stable.
 * - {@link regionSelectorFor} is for an element pyric observed a callback
 *   mutating. Observation must not change the page, so an element with no
 *   identity of its own gets a structural path instead of a new attribute.
 *
 * Both prefer, in order: the element's `id`, then an existing
 * `data-pyric-owner`, then their respective fallback.
 */

/** The attribute pyric reads, and mints, to name an owning element. */
export const OWNER_ATTRIBUTE = 'data-pyric-owner';

let mintedOwnerCount = 0;

/** The minimal element shape this file needs. Keeps the module DOM-free. */
export interface SelectableElement {
  readonly tagName?: string;
  readonly id?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  readonly parentElement?: SelectableElement | null;
  readonly children?: ArrayLike<SelectableElement>;
}

/** `true` when `value` responds to the element methods this file calls. */
export function isSelectableElement(value: unknown): value is SelectableElement {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<SelectableElement>;
  if (typeof candidate.getAttribute !== 'function') return false;
  return typeof candidate.tagName === 'string';
}

/** The element's lower-case tag name, or `'element'` when it reports none. */
export function tagNameOf(element: SelectableElement): string {
  const tag = element.tagName;
  if (typeof tag !== 'string' || tag.length === 0) return 'element';
  return tag.toLowerCase();
}

/**
 * A selector the element already earns on its own: its `id`, or a
 * `data-pyric-owner` someone already set. `undefined` when it has neither.
 */
function existingIdentitySelector(element: SelectableElement): string | undefined {
  const id = element.id;
  if (typeof id === 'string' && id.length > 0) return `#${id}`;
  const owner = element.getAttribute(OWNER_ATTRIBUTE);
  if (typeof owner === 'string' && owner.length > 0) {
    return `[${OWNER_ATTRIBUTE}="${owner}"]`;
  }
  return undefined;
}

/** Position of `element` among its parent's children, 1-based. */
function childIndexOf(element: SelectableElement): number {
  const parent = element.parentElement;
  if (!parent) return 1;
  const siblings = parent.children;
  if (!siblings) return 1;
  for (let index = 0; index < siblings.length; index += 1) {
    if (siblings[index] === element) return index + 1;
  }
  return 1;
}

/**
 * A structural path from the nearest identified ancestor down to `element`,
 * such as `#board > div:nth-child(2) > li:nth-child(3)`. Walks at most eight
 * levels so a deep tree produces a bounded string rather than the whole
 * document path.
 */
function structuralPathFor(element: SelectableElement): string {
  const steps: string[] = [];
  let current: SelectableElement | null | undefined = element;
  let depth = 0;
  while (current && depth < 8) {
    const identity = existingIdentitySelector(current);
    if (identity !== undefined) {
      steps.unshift(identity);
      return steps.join(' > ');
    }
    steps.unshift(`${tagNameOf(current)}:nth-child(${childIndexOf(current)})`);
    current = current.parentElement;
    depth += 1;
  }
  return steps.join(' > ');
}

/**
 * Name an element the caller nominated as a listener's owner, minting a
 * `data-pyric-owner` attribute when it has no identity of its own.
 */
export function ownerSelectorFor(element: SelectableElement): string {
  const existing = existingIdentitySelector(element);
  if (existing !== undefined) return existing;
  mintedOwnerCount += 1;
  const minted = `${tagNameOf(element)}-${mintedOwnerCount.toString(36)}`;
  element.setAttribute(OWNER_ATTRIBUTE, minted);
  return `[${OWNER_ATTRIBUTE}="${minted}"]`;
}

/**
 * Name an element a callback mutated, without writing to the document.
 */
export function regionSelectorFor(element: SelectableElement): string {
  const existing = existingIdentitySelector(element);
  if (existing !== undefined) return existing;
  return structuralPathFor(element);
}
