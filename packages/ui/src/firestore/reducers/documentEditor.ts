import type {
  DocumentEditorAction,
  DocumentEditorState,
  EditorTree,
  FieldNode,
} from './types.js';
import { Timestamp, GeoPoint } from 'pyric/firestore';
import { cloneTree, collectDescendants, treeFromData } from './tree.js';
import { validateTree } from './validation.js';
import { defaultValueFor } from './defaults.js';
import { isTimestampShape, isGeoPointShape, asVectorView } from '../types.js';

/**
 * Rehydrate serialized Firestore values back into class instances. Over a
 * worker / postMessage boundary, a Timestamp/GeoPoint loses its class and
 * arrives as a plain `{ seconds, nanoseconds }` / `{ latitude, longitude }`;
 * the editor's validators check `instanceof`, so without this the editor opens
 * with false "Expected a Timestamp/GeoPoint" errors. Vectors stay as their wire
 * sentinel (there is no Vector constructor; the editor speaks the sentinel).
 * The prototype guard stops the recursion from walking INTO instances and
 * shredding them into plain maps.
 */
export function rehydrateFirestoreValues(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (asVectorView(value) !== null) return value; // wire-sentinel vector: leave as-is
  if (isTimestampShape(value)) {
    const o = value as Record<string, number>;
    return new Timestamp(o.seconds ?? o._seconds ?? 0, o.nanoseconds ?? o._nanoseconds ?? 0);
  }
  if (isGeoPointShape(value)) {
    const o = value as Record<string, number>;
    return new GeoPoint(o.latitude, o.longitude);
  }
  if (Array.isArray(value)) return value.map(rehydrateFirestoreValues);
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rehydrateFirestoreValues(v);
    return out;
  }
  return value; // a class instance (Timestamp, GeoPoint, DocumentReference, …): leave intact
}

/** Initial state factory. Builds tree + initial snapshot + error count. */
export function initState(initial: Record<string, unknown>): DocumentEditorState {
  const fresh = treeFromData(rehydrateFirestoreValues(initial) as Record<string, unknown>);
  const { tree, errorCount } = validateTree(fresh);
  return { tree, initial: tree, errorCount };
}

/**
 * Pure reducer. Every action returns a fresh state — no in-place
 * mutation of `state.tree`. Validation re-runs after the structural
 * change so `errorCount` is always current. Container nodes (map /
 * array) ignore actions that don't apply to them rather than
 * throwing; the components only render valid affordances per type.
 */
export function reducer(
  state: DocumentEditorState,
  action: DocumentEditorAction,
): DocumentEditorState {
  switch (action.type) {
    case 'setValue':
      return applyAndValidate(state, (t) => setValue(t, action.nodeId, action.value));

    case 'setType':
      return applyAndValidate(state, (t) => setType(t, action.nodeId, action.newType));

    case 'setKey':
      return applyAndValidate(state, (t) => setKey(t, action.nodeId, action.key));

    case 'addMapEntry':
      return applyAndValidate(state, (t) =>
        addMapEntry(t, action.parentId, action.key, action.childType),
      );

    case 'addArrayEntry':
      return applyAndValidate(state, (t) =>
        addArrayEntry(t, action.parentId, action.childType),
      );

    case 'remove':
      return applyAndValidate(state, (t) => removeNode(t, action.nodeId));

    case 'reset':
      return {
        tree: state.initial,
        initial: state.initial,
        errorCount: countErrors(state.initial),
      };
  }
}

function applyAndValidate(
  state: DocumentEditorState,
  mutate: (tree: EditorTree) => EditorTree,
): DocumentEditorState {
  const next = mutate(cloneTree(state.tree));
  const { tree, errorCount } = validateTree(next);
  return { ...state, tree, errorCount };
}

function countErrors(tree: EditorTree): number {
  let n = 0;
  for (const node of Object.values(tree.nodes)) {
    if (node.error) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Structural transformations. Each takes a cloned tree (mutable here),
// mutates it, and returns it. validateTree runs in applyAndValidate.

function setValue(tree: EditorTree, nodeId: string, value: unknown): EditorTree {
  const node = tree.nodes[nodeId];
  if (!node) return tree;
  if (node.type === 'map' || node.type === 'array') return tree;
  tree.nodes[nodeId] = { ...node, value };
  return tree;
}

function setType(
  tree: EditorTree,
  nodeId: string,
  newType: FieldNode['type'],
): EditorTree {
  const node = tree.nodes[nodeId];
  if (!node) return tree;
  // Don't allow switching the root away from `map` — the
  // serializer assumes the root is a map.
  if (node.id === tree.rootId && newType !== 'map') return tree;
  if (node.type === newType) return tree;

  // If switching away from a container, drop its children.
  if (node.type === 'map' || node.type === 'array') {
    const toRemove = (tree.childIds[nodeId] ?? []).slice();
    for (const childId of toRemove) {
      for (const descId of collectDescendants(tree, childId)) {
        delete tree.nodes[descId];
        delete tree.childIds[descId];
      }
    }
    tree.childIds[nodeId] = [];
  }

  const value =
    newType === 'map' || newType === 'array' ? undefined : defaultValueFor(newType);
  tree.nodes[nodeId] = { ...node, type: newType, value };
  return tree;
}

function setKey(tree: EditorTree, nodeId: string, key: string): EditorTree {
  const node = tree.nodes[nodeId];
  if (!node) return tree;
  // Only map children carry a key. Array children's positions come
  // from the parent's child list order.
  if (node.parentId == null) return tree; // root has no key
  const parent = tree.nodes[node.parentId];
  if (!parent || parent.type !== 'map') return tree;
  tree.nodes[nodeId] = { ...node, key };
  return tree;
}

function addMapEntry(
  tree: EditorTree,
  parentId: string,
  key: string,
  childType: FieldNode['type'],
): EditorTree {
  const parent = tree.nodes[parentId];
  if (!parent || parent.type !== 'map') return tree;
  const id = crypto.randomUUID();
  const value =
    childType === 'map' || childType === 'array'
      ? undefined
      : defaultValueFor(childType);
  tree.nodes[id] = { id, parentId, key, type: childType, value };
  tree.childIds[id] = [];
  tree.childIds[parentId] = [...(tree.childIds[parentId] ?? []), id];
  return tree;
}

function addArrayEntry(
  tree: EditorTree,
  parentId: string,
  childType: FieldNode['type'],
): EditorTree {
  const parent = tree.nodes[parentId];
  if (!parent || parent.type !== 'array') return tree;
  // Firestore disallows nested arrays — guard at the reducer level.
  if (childType === 'array') return tree;
  const id = crypto.randomUUID();
  const value =
    childType === 'map' ? undefined : defaultValueFor(childType);
  tree.nodes[id] = { id, parentId, key: null, type: childType, value };
  tree.childIds[id] = [];
  tree.childIds[parentId] = [...(tree.childIds[parentId] ?? []), id];
  return tree;
}

function removeNode(tree: EditorTree, nodeId: string): EditorTree {
  const node = tree.nodes[nodeId];
  if (!node) return tree;
  // Removing the root is forbidden — it would invalidate the
  // serializer.
  if (node.id === tree.rootId) return tree;

  const ids = collectDescendants(tree, nodeId);
  for (const id of ids) {
    delete tree.nodes[id];
    delete tree.childIds[id];
  }
  if (node.parentId != null) {
    tree.childIds[node.parentId] = (tree.childIds[node.parentId] ?? []).filter(
      (id) => id !== nodeId,
    );
  }
  return tree;
}
