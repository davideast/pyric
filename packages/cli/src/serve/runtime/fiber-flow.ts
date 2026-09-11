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

/** One component the page rendered, and the element it owns. */
export interface FlowComponent {
  /** `type.displayName`, else `type.name`. */
  readonly name: string;
  /** The first host element at or below the component. */
  readonly element: Element;
  /** How many collected components sit above this one, root first at 0. */
  readonly depth: number;
}

/** A delivery's rendered subtree, as the flow painter draws it. */
export interface FlowSubtree {
  /** The outermost collected component, or `null` when none was found. */
  readonly root: FlowComponent | null;
  /** Every collected component, outermost first. */
  readonly components: readonly FlowComponent[];
  /** The collected components nothing else collected sits below. */
  readonly leaves: readonly FlowComponent[];
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
 * The subtree of components above the nodes that changed.
 *
 * Every node is resolved to its fiber, the `return` chain above it is
 * collected, and the collected components are ordered by how far each sits
 * from the root. Strict Mode renders a component twice into the same fiber and
 * React keeps two alternates of every fiber, so components are deduplicated by
 * the pair of name and host element rather than by fiber identity.
 */
export function flowSubtree(nodes: Iterable<unknown>): FlowSubtree {
  const collected: Array<{ name: string; element: Element; distance: number }> = [];
  const seen = (name: string, element: Element): boolean =>
    collected.some((entry) => entry.name === name && entry.element === element);

  for (const node of nodes) {
    const fiber = nearestFiber(node);
    if (fiber === null) continue;
    const chain = componentChain(fiber);
    for (let index = 0; index < chain.length; index += 1) {
      const name = componentName(chain[index]);
      if (name === null) continue;
      const element = hostElementFor(chain[index]);
      if (element === null) continue;
      if (seen(name, element)) continue;
      collected.push({ name, element, distance: index });
    }
  }

  collected.sort((a, b) => a.distance - b.distance);
  const distances = [...new Set(collected.map((entry) => entry.distance))].sort((a, b) => a - b);
  const components: FlowComponent[] = collected.map((entry) => ({
    name: entry.name,
    element: entry.element,
    depth: distances.indexOf(entry.distance),
  }));

  // A leaf is a collected component with no other collected component under
  // it. Nesting is read off the page rather than off the fibers, so a
  // component reached from two mutated nodes at once is still counted once.
  const leaves = components.filter((component) => !components.some((other) => (
    other !== component
    && other.element !== component.element
    && component.element.contains(other.element)
  )));

  return {
    root: components.length === 0 ? null : components[0],
    components,
    leaves: components.length <= 1 ? [] : leaves,
  };
}
