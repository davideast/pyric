import { useCallback, useMemo, useReducer, useRef } from 'react';
import type { FieldType } from '../types.js';
import { initState, reducer } from '../reducers/documentEditor.js';
import { treeToData } from '../reducers/tree.js';
import type {
  DocumentEditorAction,
  DocumentEditorState,
} from '../reducers/types.js';

export interface UseDocumentEditorOptions {
  /** Initial document data — the same shape a `DocumentSnapshot.data()`
   *  call returns. */
  initial?: Record<string, unknown>;
}

export interface UseDocumentEditorResult extends DocumentEditorState {
  /** Convenience: `errorCount === 0`. */
  isValid: boolean;
  /** `true` once any modifying action has fired since the last
   *  `reset`. Cleared by `reset`. Does NOT clear when the user
   *  manually re-enters the original values — checking that would
   *  require a full serialization comparison on every dispatch. */
  isDirty: boolean;
  /** Raw dispatch — drops to the reducer-action surface. Prefer the
   *  named helpers below. */
  dispatch: (action: DocumentEditorAction) => void;
  /** Update a leaf value. */
  setValue: (nodeId: string, value: unknown) => void;
  /** Switch a node's type. Map/array nodes drop their children. */
  setType: (nodeId: string, newType: FieldType) => void;
  /** Set a map-child's key. */
  setKey: (nodeId: string, key: string) => void;
  /** Append a child to a map. */
  addMapEntry: (parentId: string, key: string, childType: FieldType) => void;
  /** Append a child to an array. Nested arrays are silently
   *  rejected by the reducer (Firestore disallows them). */
  addArrayEntry: (parentId: string, childType: FieldType) => void;
  /** Remove a node (and all its descendants). Removing the root is
   *  a no-op. */
  remove: (nodeId: string) => void;
  /** Restore the tree to its initial state. Clears `isDirty`. */
  reset: () => void;
  /** Serialize the tree back to a Firestore-shaped object suitable
   *  for `setDoc` / `updateDoc`. */
  toData: () => Record<string, unknown>;
}

/**
 * Headless document editor. Owns the entire edit state for one
 * document via a pure reducer. Consumers either render the bundled
 * `<DocumentEditor>` compound component over this hook, or render
 * their own tree using the returned state.
 *
 * The hook builds its tree from `initial` on first mount. Changing
 * `initial` later does NOT rebuild the tree — call `reset()` and
 * re-initialize if you need that semantics (or remount the hook).
 * This matches the firebase-tools-ui pattern of treating the
 * editor as a stateful workspace.
 */
export function useDocumentEditor(
  options: UseDocumentEditorOptions = {},
): UseDocumentEditorResult {
  const initial = options.initial ?? {};
  // `useRef` so the initial snapshot is computed once. The reducer
  // owns the live tree from there on.
  const initialRef = useRef<DocumentEditorState | null>(null);
  if (initialRef.current == null) {
    initialRef.current = initState(initial);
  }

  const [state, dispatch] = useReducer(reducer, initialRef.current);

  const setValue = useCallback(
    (nodeId: string, value: unknown) =>
      dispatch({ type: 'setValue', nodeId, value }),
    [],
  );
  const setType = useCallback(
    (nodeId: string, newType: FieldType) =>
      dispatch({ type: 'setType', nodeId, newType }),
    [],
  );
  const setKey = useCallback(
    (nodeId: string, key: string) => dispatch({ type: 'setKey', nodeId, key }),
    [],
  );
  const addMapEntry = useCallback(
    (parentId: string, key: string, childType: FieldType) =>
      dispatch({ type: 'addMapEntry', parentId, key, childType }),
    [],
  );
  const addArrayEntry = useCallback(
    (parentId: string, childType: FieldType) =>
      dispatch({ type: 'addArrayEntry', parentId, childType }),
    [],
  );
  const remove = useCallback(
    (nodeId: string) => dispatch({ type: 'remove', nodeId }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const toData = useCallback(() => treeToData(state.tree), [state.tree]);

  const isDirty = state.tree !== state.initial;
  const isValid = state.errorCount === 0;

  return useMemo<UseDocumentEditorResult>(
    () => ({
      ...state,
      isDirty,
      isValid,
      dispatch,
      setValue,
      setType,
      setKey,
      addMapEntry,
      addArrayEntry,
      remove,
      reset,
      toData,
    }),
    [
      state,
      isDirty,
      isValid,
      setValue,
      setType,
      setKey,
      addMapEntry,
      addArrayEntry,
      remove,
      reset,
      toData,
    ],
  );
}
