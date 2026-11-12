/**
 * Window-to-child-delta diffing for remote `pyric-admin/database` child
 * listeners (`child_added`, `child_changed`, `child_removed`, `child_moved`).
 *
 * The worker host streams whole-window snapshots (`wire.entries` in query
 * order). Keeping one `ChildWindowDiffer` instance per admin listener across
 * channel reconnects turns initial snapshots into an ordered `child_added`
 * burst and turns subsequent snapshots (including post-reconnect snapshots)
 * into true child deltas without replaying surviving keys.
 */

import {
  extractOrderValue,
  jsonEqual,
  normalizeNode,
  valueChildren,
  type Priority,
  type QuerySpec,
} from 'pyric/database/internal';
import type { EventType, JsonValue } from './types.js';

export type ChildEventType = Exclude<EventType, 'value'>;

const VALID_EVENT_TYPES = new Set<string>([
  'value',
  'child_added',
  'child_changed',
  'child_removed',
  'child_moved',
]);

export function isChildEventType(eventType: EventType): eventType is ChildEventType {
  return eventType !== 'value';
}

export function assertValidEventType(
  method: 'on' | 'once' | 'off',
  eventType: string,
): asserts eventType is EventType {
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new Error(
      `Query.${method} failed: eventType argument must be a valid event type = ` +
        '"value", "child_added", "child_removed", "child_changed", or "child_moved".',
    );
  }
}

export interface WireChildSource {
  readonly value: unknown;
  readonly entries?: ReadonlyArray<{
    readonly key: string;
    readonly value: unknown;
    readonly priority?: string | number | null;
    readonly exportValue?: unknown;
  }>;
}

interface ChildWindowEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly priority: Priority;
  readonly exportValue: unknown;
}

export interface ChildDeltaEvent {
  readonly key: string;
  readonly value: JsonValue;
  readonly exportValue: unknown;
  readonly previousChildName: string | null;
}

function normalizePriority(raw: unknown): Priority {
  const isStringOrNumber = typeof raw === 'string' || typeof raw === 'number';
  return isStringOrNumber ? raw : null;
}

function extractWindowEntries(wire: WireChildSource): ChildWindowEntry[] {
  if (wire.entries !== undefined) {
    return wire.entries.map((entry) => {
      const normalized = normalizeNode(entry.value ?? null) as JsonValue;
      const hasExport = entry.exportValue !== undefined;
      return {
        key: entry.key,
        value: normalized,
        priority: normalizePriority(entry.priority),
        exportValue: hasExport ? entry.exportValue : normalized,
      };
    });
  }
  const normalizedParent = normalizeNode(wire.value ?? null) as JsonValue;
  return valueChildren(normalizedParent).map((child) => ({
    key: child.key,
    value: child.value as JsonValue,
    priority: null,
    exportValue: child.value,
  }));
}

function precedingKey(entries: readonly ChildWindowEntry[], index: number): string | null {
  return index > 0 ? entries[index - 1]!.key : null;
}

export class ChildWindowDiffer {
  private initialized = false;
  private previous: ChildWindowEntry[] = [];

  constructor(
    private readonly spec: QuerySpec,
    private readonly eventType: ChildEventType,
  ) {}

  consume(wire: WireChildSource): ChildDeltaEvent[] {
    const current = extractWindowEntries(wire);
    if (!this.initialized) {
      this.initialized = true;
      this.previous = current;
      if (this.eventType !== 'child_added') {
        return [];
      }
      return current.map((entry, index) => ({
        key: entry.key,
        value: entry.value,
        exportValue: entry.exportValue,
        previousChildName: precedingKey(current, index),
      }));
    }

    const priorWindow = this.previous;
    this.previous = current;

    if (this.eventType === 'child_removed') {
      const currentKeys = new Set(current.map((entry) => entry.key));
      const removed: ChildDeltaEvent[] = [];
      for (const prior of priorWindow) {
        if (!currentKeys.has(prior.key)) {
          removed.push({
            key: prior.key,
            value: prior.value,
            exportValue: prior.exportValue,
            previousChildName: null,
          });
        }
      }
      return removed;
    }

    const priorByKey = new Map(priorWindow.map((entry) => [entry.key, entry]));
    const deltas: ChildDeltaEvent[] = [];
    const effectiveOrderBy = this.spec.orderBy ?? ({ kind: 'priority' } as const);

    for (let index = 0; index < current.length; index++) {
      const entry = current[index]!;
      const prior = priorByKey.get(entry.key);
      const previousChildName = precedingKey(current, index);

      if (this.eventType === 'child_added') {
        if (prior === undefined) {
          deltas.push({
            key: entry.key,
            value: entry.value,
            exportValue: entry.exportValue,
            previousChildName,
          });
        }
        continue;
      }

      if (prior === undefined) continue;

      if (this.eventType === 'child_changed') {
        const valueChanged = !jsonEqual(prior.value, entry.value);
        const priorityChanged = prior.priority !== entry.priority;
        const hasChildChange = valueChanged || priorityChanged;
        if (hasChildChange) {
          deltas.push({
            key: entry.key,
            value: entry.value,
            exportValue: entry.exportValue,
            previousChildName,
          });
        }
        continue;
      }

      if (effectiveOrderBy.kind === 'key') {
        continue;
      }
      const beforeIndexed = extractOrderValue(effectiveOrderBy, prior.key, prior.value, prior.priority);
      const afterIndexed = extractOrderValue(effectiveOrderBy, entry.key, entry.value, entry.priority);
      const indexedValueChanged = !jsonEqual(beforeIndexed, afterIndexed);
      const priorityChangedUnderValue =
        effectiveOrderBy.kind === 'value' && prior.priority !== entry.priority;
      const hasChildMoved = indexedValueChanged || priorityChangedUnderValue;
      if (hasChildMoved) {
        deltas.push({
          key: entry.key,
          value: entry.value,
          exportValue: entry.exportValue,
          previousChildName,
        });
      }
    }

    return deltas;
  }
}
