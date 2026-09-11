/**
 * Listener grouping (feature: Listeners).
 *
 * PURE. Folds the sandbox's active listeners into groups keyed by who owns
 * them, with a fixed label preference: a `component` owner (added by a
 * sibling unit; read defensively since the type may not carry it yet), then
 * a `tag` owner, then a `frame` owner's function or file, then
 * "Unattributed". Filtering (service, target prefix) narrows the listener
 * set before grouping so a group with zero surviving listeners disappears.
 */

import {
  activeListenerTargetStartsWith,
  type ActiveListener,
  type ActiveListenerTarget,
} from 'pyric/sandbox';
import type { ListenerOwner } from 'pyric/sandbox';

/** The `component` owner kind. Added by a sibling unit; `ListenerOwner`
 *  may not declare it yet, so this reads it off the value defensively
 *  rather than widening the imported union. */
interface ComponentOwner {
  readonly kind: 'component';
  readonly name: string;
  readonly path?: string;
  readonly element?: string;
}

function asComponentOwner(owner: ListenerOwner): ComponentOwner | null {
  const candidate = owner as unknown as { kind?: unknown; name?: unknown; path?: unknown };
  if (candidate.kind === 'component' && typeof candidate.name === 'string') {
    return {
      kind: 'component',
      name: candidate.name,
      path: typeof candidate.path === 'string' ? candidate.path : undefined,
    };
  }
  return null;
}

function asTagOwner(owner: ListenerOwner): { name: string } | null {
  return owner.kind === 'tag' ? { name: owner.name } : null;
}

function asFrameOwner(
  owner: ListenerOwner,
): { file: string; function?: string } | null {
  return owner.kind === 'frame' ? { file: owner.file, function: owner.function } : null;
}

export interface ListenerGroupIdentity {
  readonly key: string;
  readonly label: string;
  readonly subtitle?: string;
}

const UNATTRIBUTED: ListenerGroupIdentity = { key: 'unattributed', label: 'Unattributed' };

/** The group a listener's owners resolve to, by the fixed preference order:
 *  component, then tag, then frame, then unattributed. */
export function groupIdentityFor(owners: readonly ListenerOwner[] | undefined): ListenerGroupIdentity {
  for (const owner of owners ?? []) {
    const component = asComponentOwner(owner);
    if (component) {
      return {
        key: `component:${component.path ?? ''}:${component.name}`,
        label: component.name,
        subtitle: component.path,
      };
    }
  }
  for (const owner of owners ?? []) {
    const tag = asTagOwner(owner);
    if (tag) return { key: `tag:${tag.name}`, label: tag.name };
  }
  for (const owner of owners ?? []) {
    const frame = asFrameOwner(owner);
    if (frame) {
      const label = frame.function ?? frame.file;
      return { key: `frame:${frame.file}:${frame.function ?? ''}`, label };
    }
  }
  return UNATTRIBUTED;
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

/** Group active listeners, newest-attach order within a group, groups ordered
 *  by their earliest listener's attach time. */
export function groupListeners(
  listeners: readonly ActiveListener[],
  filters: ListenerFilters = {},
): readonly ListenerGroup[] {
  const groups = new Map<string, { identity: ListenerGroupIdentity; listeners: ActiveListener[] }>();
  for (const listener of listeners) {
    if (!matchesFilters(listener, filters)) continue;
    const identity = groupIdentityFor(listener.owners);
    const existing = groups.get(identity.key);
    if (existing) {
      existing.listeners.push(listener);
    } else {
      groups.set(identity.key, { identity, listeners: [listener] });
    }
  }
  return [...groups.values()]
    .map((group) => Object.freeze({ identity: group.identity, listeners: Object.freeze(group.listeners) }))
    .sort((a, b) => a.listeners[0].attachedAt - b.listeners[0].attachedAt);
}

/** Render a listener's target as one line: a document/database path, or a
 *  collection with a query mark when the target carried a query. */
export function formatListenerTarget(target: ActiveListenerTarget): string {
  if (typeof target === 'string') return target;
  return target.query !== undefined ? `${target.collection} (query)` : target.collection;
}
