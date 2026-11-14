/**
 * Shared `(path, queryId, eventType)` listener registry used by both the local
 * and remote `pyric-admin/database` arms so `off()` scopes identically across
 * queries, event types, callbacks, and `this`-binding contexts.
 */

import { queryIdentifier, type QuerySpec } from 'pyric/database/internal';
import type { EventType, SnapshotCallback } from './types.js';

export interface AdminListenerEntry {
  readonly path: string;
  readonly queryId: string;
  readonly eventType: EventType;
  readonly callback: SnapshotCallback;
  readonly context: unknown;
  active: boolean;
  detach: () => void;
}

type ByEventMap = Map<EventType, AdminListenerEntry[]>;
type ByQueryMap = Map<string, ByEventMap>;

function resolveCandidateQueryIds(queriesAtPath: ByQueryMap, spec: QuerySpec): string[] {
  const targetQueryId = queryIdentifier(spec);
  if (targetQueryId === 'default') {
    return [...queriesAtPath.keys()];
  }
  return [targetQueryId];
}

function resolveCandidateEvents(
  eventsForQuery: ByEventMap,
  eventType: EventType | undefined,
): EventType[] {
  if (eventType === undefined) {
    return [...eventsForQuery.keys()];
  }
  return [eventType];
}

export class AdminListenerTable {
  private readonly byPath = new Map<string, ByQueryMap>();

  register(
    path: string,
    spec: QuerySpec,
    eventType: EventType,
    callback: SnapshotCallback,
    context: unknown,
  ): AdminListenerEntry {
    const queryId = queryIdentifier(spec);
    const entry: AdminListenerEntry = {
      path,
      queryId,
      eventType,
      callback,
      context,
      active: true,
      detach: () => {},
    };

    let queriesAtPath = this.byPath.get(path);
    if (queriesAtPath === undefined) {
      queriesAtPath = new Map();
      this.byPath.set(path, queriesAtPath);
    }
    let eventsForQuery = queriesAtPath.get(queryId);
    if (eventsForQuery === undefined) {
      eventsForQuery = new Map();
      queriesAtPath.set(queryId, eventsForQuery);
    }
    let list = eventsForQuery.get(eventType);
    if (list === undefined) {
      list = [];
      eventsForQuery.set(eventType, list);
    }
    list.push(entry);
    return entry;
  }

  detachExact(target: AdminListenerEntry): void {
    const queriesAtPath = this.byPath.get(target.path);
    const eventsForQuery = queriesAtPath?.get(target.queryId);
    const list = eventsForQuery?.get(target.eventType);
    target.active = false;
    if (queriesAtPath !== undefined && eventsForQuery !== undefined && list !== undefined) {
      const idx = list.indexOf(target);
      if (idx !== -1) {
        list.splice(idx, 1);
      }
      if (list.length === 0) {
        eventsForQuery.delete(target.eventType);
      }
      if (eventsForQuery.size === 0) {
        queriesAtPath.delete(target.queryId);
      }
      if (queriesAtPath.size === 0) {
        this.byPath.delete(target.path);
      }
    }
    target.detach();
  }

  detachMatching(
    path: string,
    spec: QuerySpec,
    eventType?: EventType,
    callback?: SnapshotCallback,
    context?: unknown,
  ): void {
    const queriesAtPath = this.byPath.get(path);
    if (queriesAtPath === undefined) return;

    // Upstream Firebase contract (`syncTreeRemoveEventRegistration`):
    // `ref.off(...)` on a default unconstrained reference searches every query
    // view at `path`; `query.off(...)` on a constrained/ordered query removes
    // only registrations from that specific query view.
    const candidateQueryIds = resolveCandidateQueryIds(queriesAtPath, spec);

    const removed: AdminListenerEntry[] = [];

    for (const qId of candidateQueryIds) {
      const eventsForQuery = queriesAtPath.get(qId);
      if (eventsForQuery === undefined) continue;

      const candidateEvents = resolveCandidateEvents(eventsForQuery, eventType);

      for (const ev of candidateEvents) {
        const list = eventsForQuery.get(ev);
        if (list === undefined) continue;

        const removesAllInBucket = eventType === undefined || callback === undefined;
        if (removesAllInBucket) {
          removed.push(...list);
          eventsForQuery.delete(ev);
          continue;
        }

        const kept: AdminListenerEntry[] = [];
        let detachedFirstMatch = false;
        for (const entry of list) {
          const matchesPair = entry.callback === callback && entry.context === context;
          if (!detachedFirstMatch && matchesPair) {
            detachedFirstMatch = true;
            removed.push(entry);
          } else {
            kept.push(entry);
          }
        }
        if (kept.length === 0) {
          eventsForQuery.delete(ev);
        } else {
          eventsForQuery.set(ev, kept);
        }
      }

      if (eventsForQuery.size === 0) {
        queriesAtPath.delete(qId);
      }
    }

    if (queriesAtPath.size === 0) {
      this.byPath.delete(path);
    }

    // Mark every removed entry inactive first so synchronous teardown or
    // in-turn sibling fanout cannot deliver to a detached observer.
    for (const entry of removed) {
      entry.active = false;
    }
    for (const entry of removed) {
      entry.detach();
    }
  }

  detachAll(): void {
    const removed: AdminListenerEntry[] = [];
    for (const queriesAtPath of this.byPath.values()) {
      for (const eventsForQuery of queriesAtPath.values()) {
        for (const list of eventsForQuery.values()) {
          removed.push(...list);
        }
      }
    }
    this.byPath.clear();
    for (const entry of removed) {
      entry.active = false;
    }
    for (const entry of removed) {
      entry.detach();
    }
  }
}
