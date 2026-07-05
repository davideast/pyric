import type { FieldType } from '../types.js';

/**
 * One node in the normalized editor tree. Every Firestore field —
 * leaf or container — is a node with a uuid, a parent pointer, a
 * type, and a value. Containers (map, array) carry no value of
 * their own; their children represent the value.
 */
export interface FieldNode {
  /** Stable uuid. Used as React `key` and as the action target. */
  id: string;
  /** Parent uuid; `null` for the root. */
  parentId: string | null;
  /**
   * Map children carry their key here. Array children carry `null`
   * (position comes from the parent's `childIds` order). The root
   * also carries `null` (it has no parent).
   */
  key: string | null;
  /** Discriminated type. Drives which editor renders. */
  type: FieldType;
  /**
   * Leaf value. `undefined` for `map` / `array` — those carry their
   * value as children. `null` field type has `value === null`.
   */
  value: unknown;
  /**
   * Validation error message attached to the node by the reducer
   * after every action. `undefined` when valid.
   */
  error?: string;
}

/**
 * Normalized tree of nodes. `nodes` is the lookup; `childIds` is the
 * ordered child list per parent. The root node is itself a `map`
 * node (its children are the document's top-level fields).
 */
export interface EditorTree {
  rootId: string;
  nodes: Record<string, FieldNode>;
  childIds: Record<string, string[]>;
}

/**
 * Discriminated union of every action the reducer accepts. Each
 * action carries a `type` discriminator plus the data the reducer
 * needs to apply it.
 */
export type DocumentEditorAction =
  | { type: 'setValue'; nodeId: string; value: unknown }
  | { type: 'setType'; nodeId: string; newType: FieldType }
  | { type: 'setKey'; nodeId: string; key: string }
  | { type: 'addMapEntry'; parentId: string; key: string; childType: FieldType }
  | { type: 'addArrayEntry'; parentId: string; childType: FieldType }
  | { type: 'remove'; nodeId: string }
  | { type: 'reset' };

/**
 * Reducer state. `tree` is the live document under edit; `initial`
 * is the snapshot the editor was constructed from (used to
 * implement `reset` and `isDirty`).
 */
export interface DocumentEditorState {
  tree: EditorTree;
  /** Frozen copy of the tree at construction. `reset` restores from
   *  here; `isDirty` is computed by comparing serializations. */
  initial: EditorTree;
  /**
   * Count of nodes with an active `error`. Derived after every
   * action; the reducer keeps it in state to avoid a tree walk on
   * every render.
   */
  errorCount: number;
}
