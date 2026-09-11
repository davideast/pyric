/**
 * What rendered after a listener delivery, read off React's fiber tree.
 *
 * This is correlation, not data tracing. The page opens a window when the
 * worker client hands a snapshot to an application callback and closes it on
 * the next React commit; every component this module names is a component that
 * rendered inside that window. A state update the application batched into the
 * same commit is attributed to the listener too, and the badges say "rendered
 * after delivery" rather than claiming the data reached those components.
 *
 * The only entry point into React is the `__reactFiber$…` property React puts
 * on the host nodes it creates. The module reads it, walks `return` upwards,
 * and reads `child` downwards to find a component's own host node. It writes
 * nothing back, calls nothing on React, and treats every field as optional:
 * a fiber shape it does not recognise yields no components rather than an
 * error.
 */

/** The fiber fields this module reads. Everything is optional on purpose. */
export interface FiberLike {
  readonly tag?: number;
  readonly type?: unknown;
  readonly elementType?: unknown;
  readonly stateNode?: unknown;
  readonly return?: FiberLike | null;
  readonly child?: FiberLike | null;
  readonly sibling?: FiberLike | null;
  readonly alternate?: FiberLike | null;
}

/**
 * What a painted mark stands for. A `component` mark is a component fiber the
 * walk named. A `host` mark is a changed element no component named, labelled
 * by the element itself.
 */
export type FlowBoxKind = 'component' | 'host';

/** One element the flow painter marks, and what to call it. */
export interface FlowComponent {
  /** `type.displayName`, else `type.name`, else the element's own label. */
  readonly name: string;
  /** The first host element at or below the component, or the changed node. */
  readonly element: Element;
  /** How many collected marks sit above this one, root first at 0. */
  readonly depth: number;
  /** What this mark stands for. */
  readonly kind: FlowBoxKind;
}

/** A delivery's rendered subtree, as the flow painter draws it. */
export interface FlowSubtree {
  /** The mark the full label goes on, or `null` when nothing was found. */
  readonly root: FlowComponent | null;
  /** Every collected mark, outermost first, the root included. */
  readonly components: readonly FlowComponent[];
  /** The collected marks nothing else collected sits below. */
  readonly leaves: readonly FlowComponent[];
}

/** How the subtree is rooted, and which component the badge already names. */
export interface FlowSubtreeOptions {
  /**
   * The element the listener's owner registered. Flow never marks it: it is
   * the whole area the listener feeds rather than something that changed.
   */
  readonly regionElement?: Element | null;
  /**
   * The owner the first label names. A component of this name is never marked,
   * because the label already says it.
   */
  readonly ownerName?: string | null;
}

/**
 * React's fiber tags for the component kinds worth naming: a function
 * component, a class component, an unresolved component that has not settled
 * into one of those yet, and the `forwardRef` and `memo` wrappers, which carry
 * the name of the function they were given. Host components,
 * text, fragments, providers, and the internal wrappers Strict Mode and
 * Suspense insert are skipped: they carry no name the application wrote.
 */
const COMPONENT_TAGS = new Set([0, 1, 2, 11, 14, 15]);

/** React's fiber tag for a host component, whose `stateNode` is the element. */
const HOST_COMPONENT_TAG = 5;

/** How far up the `return` chain one mutated node is followed. */
const MAX_ASCENT = 60;

/** How far down `child` a component's own host node is looked for. */
const MAX_DESCENT = 30;

function isElement(value: unknown): value is Element {
  const candidate = value as { nodeType?: number; getBoundingClientRect?: unknown } | null;
  return candidate !== null
    && typeof candidate === 'object'
    && candidate.nodeType === 1
    && typeof candidate.getBoundingClientRect === 'function';
}

/**
 * What a changed element is called when no component named it: its tag name,
 * narrowed by its id when it has one and by its first class otherwise.
 */
export function elementLabel(element: Element): string {
  const tag = typeof element.tagName === 'string' && element.tagName.length > 0
    ? element.tagName.toLowerCase()
    : 'node';
  const id = element.getAttribute?.('id');
  if (typeof id === 'string' && id.length > 0) return `${tag}#${id}`;
  const className = element.getAttribute?.('class');
  if (typeof className === 'string') {
    const first = className.trim().split(/\s+/)[0];
    if (first !== undefined && first.length > 0) return `${tag}.${first}`;
  }
  return tag;
}

/** The changed node itself as an element, or the element that holds it. */
function nearestElement(node: unknown, maxAscent = 4): Element | null {
  let current = node as { parentNode?: unknown } | null;
  for (let step = 0; step < maxAscent && current !== null && current !== undefined; step += 1) {
    if (isElement(current)) return current;
    current = current.parentNode as { parentNode?: unknown } | null;
  }
  return null;
}

/**
 * The fiber React attached to this node, or `null`. React names the property
 * `__reactFiber$<random>`, so the key is found by prefix rather than spelled
 * out. The older `__reactInternalInstance$` name is read too, because a page
 * may be running a renderer that still writes it.
 */
export function fiberFromNode(node: unknown): FiberLike | null {
  if (node === null || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactInternalInstance$')) continue;
    const fiber = record[key];
    if (fiber !== null && typeof fiber === 'object') return fiber as FiberLike;
  }
  return null;
}

/** The nearest node at or above this one that React created, or `null`. */
export function nearestFiber(node: unknown, maxAscent = MAX_ASCENT): FiberLike | null {
  let current = node as { parentNode?: unknown } | null;
  for (let step = 0; step <= maxAscent && current !== null && current !== undefined; step += 1) {
    const fiber = fiberFromNode(current);
    if (fiber !== null) return fiber;
    current = (current as { parentNode?: unknown }).parentNode as { parentNode?: unknown } | null;
  }
  return null;
}

/** `displayName`, else `name`, else `null` when the type names nothing. */
export function componentName(fiber: FiberLike): string | null {
  const type = (fiber.type ?? fiber.elementType) as
    | { displayName?: unknown; name?: unknown; type?: unknown; render?: unknown }
    | string
    | null
    | undefined;
  if (type === null || type === undefined) return null;
  if (typeof type === 'string') return null;
  if (typeof type.displayName === 'string' && type.displayName.length > 0) return type.displayName;
  if (typeof type.name === 'string' && type.name.length > 0) return type.name;
  // `memo(Component)` and `forwardRef(Component)` keep the named function one
  // level in.
  const inner = (type.type ?? type.render) as { displayName?: unknown; name?: unknown } | undefined;
  if (inner !== undefined && inner !== null && (typeof inner === 'object' || typeof inner === 'function')) {
    if (typeof inner.displayName === 'string' && inner.displayName.length > 0) return inner.displayName;
    if (typeof inner.name === 'string' && inner.name.length > 0) return inner.name;
  }
  if (typeof type === 'function' && typeof (type as { name?: unknown }).name === 'string') {
    const name = (type as { name: string }).name;
    return name.length > 0 ? name : null;
  }
  return null;
}

/** `true` when this fiber is a component the application itself named. */
export function isNamedComponent(fiber: FiberLike): boolean {
  const tag = fiber.tag;
  if (typeof tag === 'number' && !COMPONENT_TAGS.has(tag)) return false;
  return componentName(fiber) !== null;
}

/**
 * The first host element at or below this fiber, in render order. A component
 * that renders no host node of its own borrows the nearest host node above it,
 * so a wrapper still has somewhere to draw.
 */
export function hostElementFor(fiber: FiberLike, maxDescent = MAX_DESCENT): Element | null {
  const queue: Array<{ fiber: FiberLike; depth: number }> = [{ fiber, depth: 0 }];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    const candidate = entry.fiber;
    if (candidate.tag === HOST_COMPONENT_TAG && isElement(candidate.stateNode)) {
      return candidate.stateNode;
    }
    if (entry.depth >= maxDescent) continue;
    let child = candidate.child ?? null;
    while (child !== null && child !== undefined) {
      queue.push({ fiber: child, depth: entry.depth + 1 });
      child = child.sibling ?? null;
    }
  }
  let parent = fiber.return ?? null;
  for (let step = 0; step < maxDescent && parent !== null && parent !== undefined; step += 1) {
    if (parent.tag === HOST_COMPONENT_TAG && isElement(parent.stateNode)) return parent.stateNode;
    parent = parent.return ?? null;
  }
  return null;
}

/** Every named component from this fiber up to the root, outermost first. */
export function componentChain(fiber: FiberLike, maxAscent = MAX_ASCENT): FiberLike[] {
  const chain: FiberLike[] = [];
  let current: FiberLike | null | undefined = fiber;
  for (let step = 0; step <= maxAscent && current !== null && current !== undefined; step += 1) {
    if (isNamedComponent(current)) chain.push(current);
    current = current.return ?? null;
  }
  return chain.reverse();
}

/**
 * A listener's region on its own, with no changed nodes under it.
 *
 * This is what the switch into Flow replays. The fold records when each
 * listener last delivered but not what the page then changed, so a replayed
 * delivery can only say which region the listener registered, which is the one
 * claim the fold supports on its own.
 */
export function regionSubtree(element: Element, ownerName?: string | null): FlowSubtree {
  const name = ownerName !== null && ownerName !== undefined && ownerName.length > 0
    ? ownerName
    : elementLabel(element);
  const root: FlowComponent = { name, element, depth: 0, kind: 'component' };
  return { root, components: [root], leaves: [] };
}

/**
 * The subtree of marks above the nodes that changed.
 *
 * Every node is resolved to its fiber and the `return` chain above it is
 * collected, but the owner is never marked. On a page whose owning component
 * renders its list, header, and thread as inline JSX, that component is the
 * only one between the page root and a new list item, so outlining it outlines
 * the whole page. The registered region is not marked either, for the same
 * reason; a changed node no component named becomes a mark of its own,
 * labelled by the element.
 *
 * Strict Mode renders a component twice into the same fiber and React keeps
 * two alternates of every fiber, so components are deduplicated by the pair of
 * name and host element rather than by fiber identity.
 */
export function flowSubtree(
  nodes: Iterable<unknown>,
  options: FlowSubtreeOptions = {},
): FlowSubtree {
  const region = options.regionElement ?? null;
  const ownerName = options.ownerName ?? null;
  const collected: Array<{ name: string; element: Element; distance: number }> = [];
  const hosts: Element[] = [];

  // The owner is already spelled on the first label and the region is the
  // whole area the listener feeds, so neither earns a mark of its own.
  const isAlreadyDrawn = (name: string, element: Element): boolean =>
    (ownerName !== null && name === ownerName) || (region !== null && element === region);

  for (const node of nodes) {
    const fiber = nearestFiber(node);
    if (fiber === null) continue;
    const chain = componentChain(fiber);
    let named = 0;
    for (let index = 0; index < chain.length; index += 1) {
      const name = componentName(chain[index]!);
      if (name === null) continue;
      const element = hostElementFor(chain[index]!);
      if (element === null) continue;
      if (isAlreadyDrawn(name, element)) continue;
      named += 1;
      if (collected.some((entry) => entry.name === name && entry.element === element)) continue;
      collected.push({ name, element, distance: index });
    }
    // Nothing between the root and this node named it, so the node speaks for
    // itself.
    if (named > 0) continue;
    const host = nearestElement(node);
    if (host === null || host === region) continue;
    if (!hosts.includes(host)) hosts.push(host);
  }

  collected.sort((a, b) => a.distance - b.distance);
  const distances = [...new Set(collected.map((entry) => entry.distance))].sort((a, b) => a - b);

  // A changed subtree paints once at its top: a host box inside another host
  // box says nothing the outer box does not already say.
  const topHosts = hosts.filter((element) => !hosts.some(
    (other) => other !== element && other.contains(element),
  ));

  // Nothing on the page was attributable to this delivery. The region is not
  // marked on its own here: a mark with no changed element under it would
  // claim a render the walk never found. {@link regionSubtree} is what marks a
  // region by itself, for the replay that has no changed nodes to read.
  if (collected.length === 0 && topHosts.length === 0) {
    return { root: null, components: [], leaves: [] };
  }

  const boxes: FlowComponent[] = [];
  for (const entry of collected) {
    boxes.push({
      name: entry.name,
      element: entry.element,
      depth: distances.indexOf(entry.distance),
      kind: 'component',
    });
  }
  const hostDepth = distances.length;
  for (const element of topHosts) {
    boxes.push({ name: elementLabel(element), element, depth: hostDepth, kind: 'host' });
  }

  const root = boxes.length === 0 ? null : boxes[0]!;

  // A leaf is a mark with no other mark under it. Nesting is read off the page
  // rather than off the fibers, so a mark reached from two mutated nodes at
  // once is still counted once.
  const leaves = boxes.filter((box) => box !== root && !boxes.some((other) => (
    other !== box
    && other.element !== box.element
    && box.element.contains(other.element)
  )));

  return { root, components: boxes, leaves };
}

