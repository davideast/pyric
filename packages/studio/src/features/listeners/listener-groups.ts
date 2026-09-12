/**
 * Listener grouping (feature: Listeners).
 *
 * PURE. Folds the sandbox's active listeners into groups keyed by who owns
 * them. The label is the `component` owner's name, else the `tag` owner's
 * name, else the listener's target on its own. A frame's function name is
 * never a label: a stack frame identifies code, not the thing on screen the
 * reader is looking for, so the frame stays secondary detail on the row.
 * There is no "unattributed" group either — a listener with no named owner
 * is filed under its target, which the app did write.
 *
 * Filtering (service, target prefix) narrows the listener set before
 * grouping so a group with zero surviving listeners disappears.
 */

import {
  activeListenerTargetStartsWith,
  type ActiveListener,
  type ActiveListenerTarget,
  type ListenerOwner,
} from 'pyric/sandbox';

/** The `component` owner, narrowed off the union. */
export interface ComponentOwner {
  readonly kind: 'component';
  readonly name: string;
  readonly path?: readonly string[];
  readonly element?: string;
}

/** The `tag` owner, narrowed off the union. */
export interface TagOwner {
  readonly kind: 'tag';
  readonly name: string;
  readonly element?: string;
}

/** The `frame` owner, narrowed off the union. */
export interface FrameOwner {
  readonly kind: 'frame';
  readonly file: string;
  readonly line: number;
  readonly column?: number;
  readonly function?: string;
}

export function componentOwnerOf(
  owners: readonly ListenerOwner[] | undefined,
): ComponentOwner | null {
  for (const owner of owners ?? []) {
    if (owner.kind === 'component') return owner;
  }
  return null;
}

export function tagOwnerOf(owners: readonly ListenerOwner[] | undefined): TagOwner | null {
  for (const owner of owners ?? []) {
    if (owner.kind === 'tag') return owner;
  }
  return null;
}

export function frameOwnerOf(owners: readonly ListenerOwner[] | undefined): FrameOwner | null {
  for (const owner of owners ?? []) {
    if (owner.kind === 'frame') return owner;
  }
  return null;
}

/** The element selector a listener's owners re-identify, when one was
 *  recorded. A listener with nothing to outline simply has none. */
export function elementOf(owners: readonly ListenerOwner[] | undefined): string | undefined {
  const component = componentOwnerOf(owners);
  if (component?.element !== undefined) return component.element;
  const tag = tagOwnerOf(owners);
  if (tag?.element !== undefined) return tag.element;
  return undefined;
}

/** Render a listener's target as one line, the way the app wrote it: a
 *  document or database path, or a collection with a query mark when the
 *  target carried a query. */
export function formatListenerTarget(target: ActiveListenerTarget): string {
  if (typeof target === 'string') return target;
  return target.query !== undefined ? `${target.collection} (query)` : target.collection;
}

export interface ListenerGroupIdentity {
  readonly key: string;
  readonly label: string;
}

/** The owner one set of owners names, over one target: the component's name,
 *  else the tag's name, else the target itself. Read off the owners rather
 *  than off a folded listener so an attach event answers it too. */
export function ownerLabelFor(
  owners: readonly ListenerOwner[] | undefined,
  target: ActiveListenerTarget,
): string {
  const component = componentOwnerOf(owners);
  if (component) return component.name;
  const tag = tagOwnerOf(owners);
  if (tag) return tag.name;
  return formatListenerTarget(target);
}

/** The group a listener belongs to: its component owner, else its tag owner,
 *  else its target alone. */
export function groupIdentityFor(listener: ActiveListener): ListenerGroupIdentity {
  const component = componentOwnerOf(listener.owners);
  if (component) return { key: `component:${component.name}`, label: component.name };
  const tag = tagOwnerOf(listener.owners);
  if (tag) return { key: `tag:${tag.name}`, label: tag.name };
  const target = formatListenerTarget(listener.target);
  return { key: `target:${target}`, label: target };
}

export interface ListenerGroup {
  readonly identity: ListenerGroupIdentity;
  readonly listeners: readonly ActiveListener[];
}

export interface ListenerFilters {
  readonly service?: ActiveListener['service'];
  readonly targetPrefix?: string;
}

function matchesFilters(listener: ActiveListener, filters: ListenerFilters): boolean {
  if (filters.service !== undefined && listener.service !== filters.service) return false;
  if (filters.targetPrefix !== undefined && filters.targetPrefix !== '') {
    if (!activeListenerTargetStartsWith(listener.target, filters.targetPrefix)) return false;
  }
  return true;
}

/** Group active listeners, attach order within a group, groups ordered by
 *  their earliest listener's attach time. Row ordering within a group is the
 *  sort model's job (`listener-rows.ts`). */
export function groupListeners(
  listeners: readonly ActiveListener[],
  filters: ListenerFilters = {},
): readonly ListenerGroup[] {
  const groups = new Map<string, { identity: ListenerGroupIdentity; listeners: ActiveListener[] }>();
  for (const listener of listeners) {
    if (!matchesFilters(listener, filters)) continue;
    const identity = groupIdentityFor(listener);
    const existing = groups.get(identity.key);
    if (existing) existing.listeners.push(listener);
    else groups.set(identity.key, { identity, listeners: [listener] });
  }
  return [...groups.values()]
    .map((group) =>
      Object.freeze({ identity: group.identity, listeners: Object.freeze(group.listeners) }),
    )
    .sort((a, b) => a.listeners[0]!.attachedAt - b.listeners[0]!.attachedAt);
}
