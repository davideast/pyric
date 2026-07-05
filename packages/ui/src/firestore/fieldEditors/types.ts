import type { ComponentType } from 'react';
import type { FieldType } from '../types.js';

export interface FieldDisplayProps<V = unknown> {
  /** Value to display. The component's `V` generic narrows this. */
  value: V;
  /** Dotted/bracketed path from the document root, e.g. `users.alice`
   *  or `tags[0]`. Forwarded so consumer styles can target nested
   *  positions via `[data-field-path="users.alice"]`. */
  path?: string;
  /** Recursive editors (Map, Array) need the registry to dispatch
   *  on their children. Leaf editors (String, Number, …) can ignore
   *  this prop. Required-but-optional because the consumer of the
   *  component (`<FieldRenderer>`, `<DocumentPreview>`) always
   *  threads it through. */
  fieldEditors?: FieldEditorRegistry;
}

/**
 * Props passed to a per-type `Edit` component. The leaf editors
 * (string, number, …) consume this directly. Map/array editing is
 * handled by the `<DocumentEditor>` compound component itself, not
 * by individual editors — Firestore's container shapes are special
 * enough that pushing them through the registry costs more than
 * it's worth.
 */
export interface FieldEditProps<V = unknown> {
  /** Current value. */
  value: V;
  /** Commit a new value. The hook wires this to the reducer's
   *  `setValue` action. */
  onChange: (next: V) => void;
  /** Validation error attached by the reducer. Editors render it
   *  inline alongside the input. */
  error?: string;
  /** Dotted/bracketed path from the document root. */
  path?: string;
}

/**
 * Contract for one Firestore value type. `Display` (read-mode) is
 * required; `Edit` + `validate` + `defaultValue` are required for
 * leaf types that participate in M3's editor. Map/array contracts
 * supply only `Display` — their edit affordances come from the
 * `<DocumentEditor>` compound component.
 */
export interface FieldEditorContract<V = unknown> {
  type: FieldType;
  Display: ComponentType<FieldDisplayProps<V>>;
  Edit?: ComponentType<FieldEditProps<V>>;
}

/**
 * Map of field-type to editor contract. `Partial<…>` so consumers
 * can override one type without re-supplying the rest — the merge
 * happens at the `<DocumentPreview>` boundary.
 *
 * The stored value type is `FieldEditorContract<any>` rather than
 * `FieldEditorContract<unknown>` because each per-type contract
 * narrows its generic (e.g., `FieldEditorContract<Timestamp>` for
 * timestamp) and TypeScript's `ComponentType` is invariant in
 * props. `any` at the registry layer means the type-safety lives
 * at the per-contract definition site, not in the dispatch map.
 * `FieldRenderer` narrows back from `unknown` -> the right contract
 * via `inferType` at dispatch time.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FieldEditorRegistry = Partial<Record<FieldType, FieldEditorContract<any>>>;
