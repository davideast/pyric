import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import {
  ref as refFn,
  updateMetadata,
  type FirebaseStorage,
  type FullMetadata,
  type SettableMetadata,
} from 'pyric/storage';
import { normalizeStoragePath } from './usePathState.js';

/** One `customMetadata` row. `id` is a stable render key — keys are
 *  user-editable, so they can't key the rows themselves. */
export interface CustomMetadataEntry {
  id: string;
  key: string;
  value: string;
  /** Validation error (`'Key is required'` / `'Duplicate key'`). */
  error?: string;
}

interface MetadataDraft {
  contentType: string;
  cacheControl: string;
  custom: CustomMetadataEntry[];
}

export interface MetadataEditorState {
  draft: MetadataDraft;
  /** Snapshot for `isDirty` / `reset` — same reference-compare
   *  semantics as the document editor's `tree !== initial`. */
  initial: MetadataDraft;
  errorCount: number;
}

export type MetadataEditorAction =
  | { type: 'setContentType'; value: string }
  | { type: 'setCacheControl'; value: string }
  | { type: 'setCustomKey'; id: string; key: string }
  | { type: 'setCustomValue'; id: string; value: string }
  | { type: 'addCustomEntry'; key?: string; value?: string }
  | { type: 'removeCustomEntry'; id: string }
  | { type: 'reset' }
  /** Internal — a successful save makes the draft the new baseline. */
  | { type: 'commit' };

/** Re-validate the k/v rows: empty keys and duplicate keys error. */
function validateCustom(custom: CustomMetadataEntry[]): {
  custom: CustomMetadataEntry[];
  errorCount: number;
} {
  const counts = new Map<string, number>();
  for (const entry of custom) {
    counts.set(entry.key, (counts.get(entry.key) ?? 0) + 1);
  }
  let errorCount = 0;
  const next = custom.map((entry) => {
    let error: string | undefined;
    if (entry.key.trim() === '') error = 'Key is required';
    else if ((counts.get(entry.key) ?? 0) > 1) error = 'Duplicate key';
    if (error) errorCount++;
    if (error === entry.error) return entry;
    return { ...entry, error };
  });
  return { custom: next, errorCount };
}

function applyDraft(
  state: MetadataEditorState,
  mutate: (draft: MetadataDraft) => MetadataDraft,
): MetadataEditorState {
  const mutated = mutate(state.draft);
  const { custom, errorCount } = validateCustom(mutated.custom);
  return { ...state, draft: { ...mutated, custom }, errorCount };
}

/** Pure reducer — exported (with {@link initMetadataEditorState}) so
 *  the edit state is testable without React, mirroring the document
 *  editor's reducer/hook split. */
export function metadataEditorReducer(
  state: MetadataEditorState,
  action: MetadataEditorAction,
): MetadataEditorState {
  switch (action.type) {
    case 'setContentType':
      return applyDraft(state, (d) => ({ ...d, contentType: action.value }));
    case 'setCacheControl':
      return applyDraft(state, (d) => ({ ...d, cacheControl: action.value }));
    case 'setCustomKey':
      return applyDraft(state, (d) => ({
        ...d,
        custom: d.custom.map((e) => (e.id === action.id ? { ...e, key: action.key } : e)),
      }));
    case 'setCustomValue':
      return applyDraft(state, (d) => ({
        ...d,
        custom: d.custom.map((e) =>
          e.id === action.id ? { ...e, value: action.value } : e,
        ),
      }));
    case 'addCustomEntry':
      return applyDraft(state, (d) => ({
        ...d,
        custom: [
          ...d.custom,
          { id: crypto.randomUUID(), key: action.key ?? '', value: action.value ?? '' },
        ],
      }));
    case 'removeCustomEntry':
      return applyDraft(state, (d) => ({
        ...d,
        custom: d.custom.filter((e) => e.id !== action.id),
      }));
    case 'reset':
      return {
        draft: state.initial,
        initial: state.initial,
        errorCount: validateCustom(state.initial.custom).errorCount,
      };
    case 'commit':
      return { ...state, initial: state.draft };
  }
}

/** Build the edit state from the metadata a `getMetadata` /
 *  `useStorageObject` read returned. */
export function initMetadataEditorState(
  initial: SettableMetadata | undefined,
): MetadataEditorState {
  const draft: MetadataDraft = {
    contentType: initial?.contentType ?? '',
    cacheControl: initial?.cacheControl ?? '',
    custom: Object.entries(initial?.customMetadata ?? {}).map(([key, value]) => ({
      id: crypto.randomUUID(),
      key,
      value,
    })),
  };
  const { custom, errorCount } = validateCustom(draft.custom);
  // One shared object: `isDirty` is `draft !== initial` by reference.
  const validated: MetadataDraft = { ...draft, custom };
  return { draft: validated, initial: validated, errorCount };
}

export interface UseMetadataEditorOptions {
  /** The metadata being edited — the same shape `useStorageObject`'s
   *  `metadata` carries. Read once on mount (the editor is a
   *  stateful workspace, like the document editor); `reset()` +
   *  remount to re-initialize. */
  initial?: SettableMetadata;
}

export interface UseMetadataEditorResult {
  contentType: string;
  cacheControl: string;
  custom: CustomMetadataEntry[];
  /** Convenience: `errorCount === 0`. */
  isValid: boolean;
  /** `true` once any modifying action fired since the last
   *  `reset`/successful `save`. Reference-compare semantics — manual
   *  re-entry of the original values does NOT clear it. */
  isDirty: boolean;
  errorCount: number;
  /** Raw dispatch — prefer the named helpers. */
  dispatch: (action: MetadataEditorAction) => void;
  setContentType: (value: string) => void;
  setCacheControl: (value: string) => void;
  setCustomKey: (id: string, key: string) => void;
  setCustomValue: (id: string, value: string) => void;
  addCustomEntry: (key?: string, value?: string) => void;
  removeCustomEntry: (id: string) => void;
  /** Restore the initial values. Clears `isDirty`. */
  reset: () => void;
  /**
   * Serialize the draft to an `updateMetadata` patch. Empty
   * `contentType`/`cacheControl` become `undefined` — which LEAVES
   * the previous value (the sandbox doesn't model null-clears; see
   * `@pyric/storage`'s `updateMetadata` doc). `customMetadata` is
   * always included and replaces wholesale, so row removal works.
   */
  toPatch: () => SettableMetadata;
  /**
   * `updateMetadata(ref(storage, path), toPatch())`. Errors surface
   * via `saveError` (typed `StorageError`), not throws — resolves
   * `undefined` on failure or when the draft is invalid. On success
   * the draft becomes the new baseline (`isDirty` clears) and the
   * fresh `FullMetadata` is returned.
   */
  save: () => Promise<FullMetadata | undefined>;
  isSaving: boolean;
  saveError: Error | undefined;
}

/**
 * Headless metadata editor — the `useDocumentEditor` reducer pattern
 * over `updateMetadata`: a pure reducer owns the draft (contentType,
 * cacheControl, customMetadata k/v rows with stable ids +
 * empty/duplicate-key validation); the hook adds named dispatch
 * helpers and the save half.
 */
export function useMetadataEditor(
  storage: FirebaseStorage | null | undefined,
  path: string | null | undefined,
  options: UseMetadataEditorOptions = {},
): UseMetadataEditorResult {
  // Computed once — the reducer owns the live draft from here on
  // (same `useRef` seed as `useDocumentEditor`).
  const initialRef = useRef<MetadataEditorState | null>(null);
  if (initialRef.current == null) {
    initialRef.current = initMetadataEditorState(options.initial);
  }
  const [state, dispatch] = useReducer(metadataEditorReducer, initialRef.current);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | undefined>(undefined);
  // Stale-run protection for overlapping saves (generation token,
  // house style).
  const generationRef = useRef(0);

  const setContentType = useCallback(
    (value: string) => dispatch({ type: 'setContentType', value }),
    [],
  );
  const setCacheControl = useCallback(
    (value: string) => dispatch({ type: 'setCacheControl', value }),
    [],
  );
  const setCustomKey = useCallback(
    (id: string, key: string) => dispatch({ type: 'setCustomKey', id, key }),
    [],
  );
  const setCustomValue = useCallback(
    (id: string, value: string) => dispatch({ type: 'setCustomValue', id, value }),
    [],
  );
  const addCustomEntry = useCallback(
    (key?: string, value?: string) => dispatch({ type: 'addCustomEntry', key, value }),
    [],
  );
  const removeCustomEntry = useCallback(
    (id: string) => dispatch({ type: 'removeCustomEntry', id }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  const { draft, initial, errorCount } = state;

  const toPatch = useCallback((): SettableMetadata => {
    return {
      contentType: draft.contentType.trim() === '' ? undefined : draft.contentType,
      cacheControl: draft.cacheControl.trim() === '' ? undefined : draft.cacheControl,
      customMetadata: Object.fromEntries(
        draft.custom.filter((e) => e.key.trim() !== '').map((e) => [e.key, e.value]),
      ),
    };
  }, [draft]);

  const save = useCallback(async (): Promise<FullMetadata | undefined> => {
    const myGen = ++generationRef.current;
    if (storage == null || path == null) {
      setSaveError(new Error('useMetadataEditor: storage or path is null'));
      return undefined;
    }
    if (errorCount > 0) {
      setSaveError(new Error('useMetadataEditor: draft has validation errors'));
      return undefined;
    }
    setSaveError(undefined);
    setIsSaving(true);
    try {
      const next = await updateMetadata(
        refFn(storage, normalizeStoragePath(path)),
        toPatch(),
      );
      if (myGen === generationRef.current) {
        dispatch({ type: 'commit' });
      }
      return next;
    } catch (e) {
      if (myGen === generationRef.current) {
        setSaveError(e instanceof Error ? e : new Error(String(e)));
      }
      return undefined;
    } finally {
      if (myGen === generationRef.current) setIsSaving(false);
    }
  }, [storage, path, errorCount, toPatch]);

  const isDirty = draft !== initial;
  const isValid = errorCount === 0;

  return useMemo<UseMetadataEditorResult>(
    () => ({
      contentType: draft.contentType,
      cacheControl: draft.cacheControl,
      custom: draft.custom,
      isValid,
      isDirty,
      errorCount,
      dispatch,
      setContentType,
      setCacheControl,
      setCustomKey,
      setCustomValue,
      addCustomEntry,
      removeCustomEntry,
      reset,
      toPatch,
      save,
      isSaving,
      saveError,
    }),
    [
      draft,
      isValid,
      isDirty,
      errorCount,
      setContentType,
      setCacheControl,
      setCustomKey,
      setCustomValue,
      addCustomEntry,
      removeCustomEntry,
      reset,
      toPatch,
      save,
      isSaving,
      saveError,
    ],
  );
}
