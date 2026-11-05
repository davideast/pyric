/**
 * RTDB write normalization as security rules read it (`newData`): arrays
 * become integer-keyed objects, null and empty nodes are pruned, and inline
 * `.priority` metadata is kept on the nodes that survive. The sandbox's
 * write boundary in `database/sandbox/normalize.ts` validates first and
 * then uses the same functions.
 */
import type { JsonValue } from './json-value.js';
import { SDK_VERSION } from './sdk-version.js';

/**
 * Normalize a validated value into storage shape. No validation here —
 * call {@link validateWrite} first (or use {@link normalizeWrite}).
 * Returns `null` for a value that prunes away.
 */
export function normalizeNode(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value as JsonValue;

  // Array → integer-keyed object. Holes / null / undefined elements are
  // dropped (upstream `each` over an array skips them).
  if (Array.isArray(value)) {
    const out: Record<string, JsonValue> = {};
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) continue;
      const child = normalizeNode(value[i]);
      if (child === null) continue;
      out[String(i)] = child;
    }
    return Object.keys(out).length === 0 ? null : out;
  }

  // Plain object → unwrap `.value` when present, strip `.priority` metadata,
  // and prune null children + empty subtrees.
  if (Object.hasOwn(value as object, '.value')) {
    return normalizeNode((value as Record<string, unknown>)['.value']);
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === '.priority') {
      continue;
    }
    if (key === '.sv') {
      // Server-value wrapper that survived (shouldn't normally reach
      // here post-sentinel-resolution) — keep verbatim.
      out[key] = child as JsonValue;
      continue;
    }
    const normalized = normalizeNode(child);
    if (normalized === null) continue;
    out[key] = normalized;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** A `.priority` a write value carries, at its path relative to the value. */
export interface InlinePriority {
  segments: string[];
  priority: string | number | null;
}

/**
 * Every `.priority` key in a write value, at its path relative to the value
 * (`[]` for the value itself). The SDK reads these while it builds the
 * written node (`nodeFromJSON`), so a priority of any other type fails its
 * assertion with that text. A server-value priority is not modeled and is
 * left out.
 */
export function inlinePriorities(value: unknown): InlinePriority[] {
  const found: InlinePriority[] = [];
  const walk = (node: unknown, segments: string[]): void => {
    if (node === null || typeof node !== 'object') return;
    const isObject = !Array.isArray(node);
    if (isObject && Object.hasOwn(node, '.priority')) {
      const priority = (node as Record<string, unknown>)['.priority'];
      const isServerValue = typeof priority === 'object' && priority !== null && '.sv' in priority;
      if (priority !== null && typeof priority !== 'string' && typeof priority !== 'number' && !isServerValue) {
        throw new Error(`Firebase Database (${SDK_VERSION}) INTERNAL ASSERT FAILED: Invalid priority type found: ${typeof priority}`);
      }
      if (!isServerValue) found.push({ segments, priority: priority as string | number | null });
    }
    if (isObject && Object.hasOwn(node, '.value')) {
      walk((node as Record<string, unknown>)['.value'], segments);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('.')) continue;
      walk(child, [...segments, key]);
    }
  };
  walk(value, []);
  return found;
}

/**
 * The priority a write gives its target: the value's own `.priority` when it
 * carries one, which the SDK lets override the priority argument, else the
 * argument. `nested` holds the priorities below the target.
 */
export function writePriority(value: unknown, argument: string | number | null): {
  priority: string | number | null;
  inline: boolean;
  nested: InlinePriority[];
} {
  const all = inlinePriorities(value);
  const own = all.find((entry) => entry.segments.length === 0);
  return {
    priority: own ? own.priority : argument,
    inline: own !== undefined,
    nested: all.filter((entry) => entry.segments.length > 0),
  };
}

function withOwnPriority(node: unknown, priority: string | number): unknown {
  if (typeof node === 'object' && node !== null && !Array.isArray(node)) return { ...node, '.priority': priority };
  return { '.value': node, '.priority': priority };
}

/**
 * The value as rules read it: each non-null priority in `entries` is written
 * back as a `.priority` key on its node, and a leaf with a priority becomes
 * `{ ".value", ".priority" }`, so `getPriority()` reports it. An entry whose
 * node is absent is skipped. The value is not modified.
 */
export function withPriorities(value: JsonValue, entries: readonly InlinePriority[]): JsonValue {
  const present = entries.filter((entry) => entry.priority !== null);
  if (present.length === 0 || value === null) return value;
  let root: unknown = structuredClone(value);
  for (const { segments, priority } of present) {
    if (segments.length === 0) {
      root = withOwnPriority(root, priority!);
      continue;
    }
    let parent: unknown = root;
    for (const segment of segments.slice(0, -1)) {
      const isNode = typeof parent === 'object' && parent !== null && !Object.hasOwn(parent, '.value');
      parent = isNode ? (parent as Record<string, unknown>)[segment] : undefined;
    }
    const last = segments[segments.length - 1]!;
    if (typeof parent !== 'object' || parent === null || !Object.hasOwn(parent, last)) continue;
    const container = parent as Record<string, unknown>;
    if (container[last] === null) continue;
    container[last] = withOwnPriority(container[last], priority!);
  }
  return root as JsonValue;
}

/**
 * Normalize a resolved write value into the shape RTDB security rules read
 * (`newData`), converting arrays to integer-keyed objects, pruning null and
 * empty nodes, and re-attaching inline `.priority` metadata on surviving nodes.
 */
export function normalizeRuleWrite(value: unknown, priority: string | number | null = null): JsonValue {
  const written = writePriority(value, priority);
  const normalized = normalizeNode(value);
  return withPriorities(normalized, [{ segments: [], priority: written.priority }, ...written.nested]);
}
