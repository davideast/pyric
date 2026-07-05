import { useCallback, useMemo, useReducer } from 'react';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import {
  authUserEditorReducer,
  initAuthUserEditorState,
  isDirty as computeDirty,
  toCreateRequest,
  toUpdateRequest,
  validateAuthUserFields,
  type AuthUserEditorAction,
  type AuthUserEditorErrors,
  type AuthUserEditorFields,
} from '../reducers/userEditor.js';

export interface UseAuthUserEditorOptions {
  /** Existing record to edit. Omit for create mode. */
  initial?: AuthUserRecord;
}

export interface UseAuthUserEditorResult {
  fields: AuthUserEditorFields;
  /** Per-field validation messages (emulator-UI wording). Empty when valid. */
  errors: AuthUserEditorErrors;
  isDirty: boolean;
  isValid: boolean;
  setField: <K extends keyof AuthUserEditorFields>(
    field: K,
    value: AuthUserEditorFields[K],
  ) => void;
  /** Back to the initial snapshot. */
  reset: () => void;
  /** Full payload for `createUser` (every non-empty field). */
  toCreateRequest: () => CreateUserRequest;
  /** Delta payload for `updateUser` (only changed fields). */
  toUpdateRequest: () => UpdateUserRequest;
  /** Raw reducer access for advanced consumers. */
  dispatch: (action: AuthUserEditorAction) => void;
}

/**
 * Headless add/edit-user state machine (reducer-based, like
 * `useDocumentEditor`): field edits, claims-JSON validation with
 * emulator-grade messages, dirtiness vs the initial record, and payload
 * builders for `useAuthUsers`' `createUser` / `updateUser`.
 */
export function useAuthUserEditor(
  options: UseAuthUserEditorOptions = {},
): UseAuthUserEditorResult {
  const [state, dispatch] = useReducer(
    authUserEditorReducer,
    options.initial,
    initAuthUserEditorState,
  );

  const errors = useMemo(() => validateAuthUserFields(state.fields), [state.fields]);
  const dirty = useMemo(() => computeDirty(state), [state]);

  const setField = useCallback(
    <K extends keyof AuthUserEditorFields>(field: K, value: AuthUserEditorFields[K]) =>
      dispatch({ type: 'setField', field, value }),
    [],
  );
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);

  return {
    fields: state.fields,
    errors,
    isDirty: dirty,
    isValid: Object.keys(errors).length === 0,
    setField,
    reset,
    toCreateRequest: () => toCreateRequest(state),
    toUpdateRequest: () => toUpdateRequest(state),
    dispatch,
  };
}
