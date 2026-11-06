import { jsonEqual } from 'pyric/database/internal';

/**
 * RTDB value equality for values crossing the worker wire: the sandbox's
 * `jsonEqual`, after writing every sparse-array hole as `null`.
 */
export function sameRtdbValue(left: unknown, right: unknown): boolean {
  return jsonEqual(holesAsNull(left), holesAsNull(right));
}

/**
 * A hole and a `null` are the same RTDB value: the hosted transport's JSON
 * writes a sparse array's holes as `null` (RT-6, #1371).
 */
function holesAsNull(value: unknown): unknown {
  if (Array.isArray(value)) return Array.from(value, (item: unknown) => holesAsNull(item ?? null));
  const isObject = value !== null && typeof value === 'object';
  if (!isObject) return value;
  const entries = Object.entries(value).map(([key, child]) => [key, holesAsNull(child)] as const);
  return Object.fromEntries(entries);
}
