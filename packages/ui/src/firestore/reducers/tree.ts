import { inferType, type FieldType } from '../types.js';
import type { EditorTree, FieldNode } from './types.js';

/** Web-standard uuid generator. Browser-only target. */
function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Build a normalized editor tree from a Firestore-shaped object.
 * The root node is a virtual `map` that holds the document's
 * top-level fields. Order of children mirrors `Object.entries` (the
 * renderer is responsible for any sort it wants).
 */
export function treeFromData(data: Record<string, unknown>): EditorTree {
  const rootId = uuid();
  const tree: EditorTree = {
    rootId,
    nodes: {
      [rootId]: { id: rootId, parentId: null, key: null, type: 'map', value: undefined },
    },
    childIds: { [rootId]: [] },
  };
  for (const [key, value] of Object.entries(data)) {
    addSubtree(tree, rootId, key, value);
  }
  return tree;
}

function addSubtree(
  tree: EditorTree,
  parentId: string,
  key: string | null,
  value: unknown,
): string {
  const type = inferType(value);
  const id = uuid();
  const node: FieldNode = {
    id,
    parentId,
    key,
    type,
    value: isContainer(type) ? undefined : value,
  };
  tree.nodes[id] = node;
  tree.childIds[id] = [];
  tree.childIds[parentId].push(id);

  if (type === 'map' && value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      addSubtree(tree, id, childKey, childValue);
    }
  } else if (type === 'array' && Array.isArray(value)) {
    for (const childValue of value) {
      addSubtree(tree, id, null, childValue);
    }
  }
  return id;
}

function isContainer(type: FieldType): boolean {
  return type === 'map' || type === 'array';
}

/**
 * Serialize a tree back to a Firestore-shaped object. Leaf values
 * pass through unchanged (so a `Timestamp` round-trips as the same
 * `Timestamp` instance). Maps recurse with their sorted keys; arrays
 * recurse in `childIds` order.
 */
export function treeToData(tree: EditorTree): Record<string, unknown> {
  const root = tree.nodes[tree.rootId];
  if (!root || root.type !== 'map') {
    throw new Error('treeToData: tree root must be a map node');
  }
  const result = serializeNode(tree, tree.rootId);
  return result as Record<string, unknown>;
}

function serializeNode(tree: EditorTree, nodeId: string): unknown {
  const node = tree.nodes[nodeId];
  if (!node) throw new Error(`serializeNode: missing node ${nodeId}`);

  switch (node.type) {
    case 'map': {
      const out: Record<string, unknown> = {};
      for (const childId of tree.childIds[nodeId] ?? []) {
        const child = tree.nodes[childId];
        if (!child) continue;
        if (child.key == null) continue; // map child must have a key
        out[child.key] = serializeNode(tree, childId);
      }
      return out;
    }
    case 'array': {
      const out: unknown[] = [];
      for (const childId of tree.childIds[nodeId] ?? []) {
        out.push(serializeNode(tree, childId));
      }
      return out;
    }
    default:
      return node.value;
  }
}

/**
 * Deep-clone a tree. Cheap because nodes are flat — no
 * Firestore values traverse this path (`Timestamp`, `Bytes` etc.
 * are stored as references, not copies, and that's fine because
 * the reducer never mutates the value, only replaces the node).
 */
export function cloneTree(tree: EditorTree): EditorTree {
  const nodes: Record<string, FieldNode> = {};
  for (const [id, node] of Object.entries(tree.nodes)) {
    nodes[id] = { ...node };
  }
  const childIds: Record<string, string[]> = {};
  for (const [id, ids] of Object.entries(tree.childIds)) {
    childIds[id] = [...ids];
  }
  return { rootId: tree.rootId, nodes, childIds };
}

/**
 * Collect a node and all its descendants. Used by `remove` to wipe
 * an entire subtree from the lookup tables in one pass.
 */
export function collectDescendants(tree: EditorTree, nodeId: string): string[] {
  const out: string[] = [nodeId];
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const childId of tree.childIds[current] ?? []) {
      out.push(childId);
      queue.push(childId);
    }
  }
  return out;
}
