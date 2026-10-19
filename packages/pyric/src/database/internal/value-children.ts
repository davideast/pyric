import { nameCompare } from './query-projection.js';

/** One child of an RTDB value: its key and its value. */
export interface ValueChild {
  readonly key: string;
  readonly value: unknown;
}

function isAbsent(value: unknown): boolean {
  return value === null || value === undefined;
}

function arrayChildren(value: readonly unknown[]): ValueChild[] {
  const children: ValueChild[] = [];
  value.forEach((element, index) => {
    if (!isAbsent(element)) children.push({ key: String(index), value: element });
  });
  return children;
}

function objectChildren(value: object): ValueChild[] {
  return Object.entries(value)
    .filter(([, child]) => !isAbsent(child))
    .sort(([a], [b]) => nameCompare(a, b))
    .map(([key, child]) => ({ key, value: child }));
}

/**
 * The children of an RTDB value, in the order `DataSnapshot.forEach` visits
 * them without a query (`nameCompare`, no priorities). A value `val()`
 * renders as an array still has children: its indexes as string keys,
 * skipping holes and nulls, since an array is an integer-keyed node
 * (`ChildrenNode.val`). A primitive or null has none.
 */
export function valueChildren(value: unknown): ValueChild[] {
  const isNode = value !== null && typeof value === 'object';
  if (!isNode) return [];
  if (Array.isArray(value)) return arrayChildren(value);
  return objectChildren(value);
}

/** The child of an RTDB value under `key`, or null. An array's child is
 *  addressed by its index as a string key. Own properties only. */
function childValue(value: unknown, key: string): unknown {
  const isNode = value !== null && typeof value === 'object';
  if (!isNode || !Object.hasOwn(value, key)) return null;
  return (value as Record<string, unknown>)[key] ?? null;
}

/** The value at the child path `segments` below an RTDB value, or null. */
export function valueAtChildPath(value: unknown, segments: readonly string[]): unknown {
  return segments.reduce<unknown>(childValue, value);
}
