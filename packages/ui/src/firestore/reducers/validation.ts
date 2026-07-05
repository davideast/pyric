import { Timestamp, GeoPoint, Bytes } from 'pyric/firestore';
import { asVectorView } from '../types.js';
import type { FieldType } from '../types.js';
import type { EditorTree, FieldNode } from './types.js';

/**
 * Per-type leaf validator. Returns an error message when the value
 * doesn't satisfy the type's constraints, `undefined` when valid.
 *
 * `map` and `array` aren't validated here — their integrity comes
 * from their children + (for maps) sibling-key uniqueness, which
 * is enforced in {@link validateTree}.
 */
export function validateLeaf(type: FieldType, value: unknown): string | undefined {
  switch (type) {
    case 'string':
      return typeof value === 'string' ? undefined : 'Expected a string';

    case 'number':
      if (typeof value !== 'number') return 'Expected a number';
      if (!Number.isFinite(value)) return 'Number must be finite';
      return undefined;

    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'Expected a boolean';

    case 'null':
      return value === null || value === undefined ? undefined : 'Expected null';

    case 'timestamp':
      return value instanceof Timestamp ? undefined : 'Expected a Timestamp';

    case 'geopoint':
      if (!(value instanceof GeoPoint)) return 'Expected a GeoPoint';
      if (value.latitude < -90 || value.latitude > 90)
        return 'Latitude must be between -90 and 90';
      if (value.longitude < -180 || value.longitude > 180)
        return 'Longitude must be between -180 and 180';
      return undefined;

    case 'reference':
      // Structural reference check matches `inferType`. A reference's
      // path must be non-empty and have an even segment count
      // (collection/doc/collection/doc/...).
      if (value === null || typeof value !== 'object')
        return 'Expected a DocumentReference';
      const obj = value as Record<string, unknown>;
      if (typeof obj.path !== 'string') return 'Reference missing `path`';
      if (!obj.path) return 'Reference path is empty';
      const segments = obj.path.split('/').filter(Boolean);
      if (segments.length % 2 !== 0)
        return 'Reference path must have an even segment count';
      return undefined;

    case 'bytes':
      return value instanceof Bytes ? undefined : 'Expected a Bytes value';

    case 'vector':
      return asVectorView(value) !== null ? undefined : 'Expected a vector value';

    case 'map':
    case 'array':
      return undefined; // structural; see validateTree
  }
}

/**
 * Walk the tree, attach an `error` to each node, and return the
 * mutated tree along with the total error count. The function does
 * not mutate the input; it returns a fresh tree.
 *
 * Per-leaf errors come from {@link validateLeaf}. Map nodes
 * additionally surface duplicate-key + empty-key errors on the
 * offending children (not on the parent).
 */
export function validateTree(tree: EditorTree): {
  tree: EditorTree;
  errorCount: number;
} {
  const nodes: Record<string, FieldNode> = {};
  let errorCount = 0;

  for (const [id, node] of Object.entries(tree.nodes)) {
    nodes[id] = { ...node, error: undefined };
  }

  // Leaf validation
  for (const node of Object.values(nodes)) {
    if (node.type === 'map' || node.type === 'array') continue;
    const err = validateLeaf(node.type, node.value);
    if (err) {
      nodes[node.id].error = err;
      errorCount++;
    }
  }

  // Map sibling-key checks: empty + duplicate
  for (const [parentId, parent] of Object.entries(nodes)) {
    if (parent.type !== 'map') continue;
    const childIds = tree.childIds[parentId] ?? [];
    const keys = new Map<string, string[]>(); // key -> child ids
    for (const childId of childIds) {
      const child = nodes[childId];
      if (!child) continue;
      const key = child.key ?? '';
      if (!key) {
        if (!child.error) errorCount++;
        nodes[childId].error = nodes[childId].error ?? 'Field name is required';
      }
      const bucket = keys.get(key) ?? [];
      bucket.push(childId);
      keys.set(key, bucket);
    }
    for (const [key, ids] of keys) {
      if (!key) continue; // already flagged as required
      if (ids.length > 1) {
        for (const id of ids) {
          if (!nodes[id].error) errorCount++;
          nodes[id].error = nodes[id].error ?? 'Field name must be unique';
        }
      }
    }
  }

  return {
    tree: { rootId: tree.rootId, nodes, childIds: tree.childIds },
    errorCount,
  };
}
