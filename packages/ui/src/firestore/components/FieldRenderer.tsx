import { inferType } from '../types.js';
import type { FieldEditorRegistry } from '../fieldEditors/types.js';

export interface FieldRendererProps {
  value: unknown;
  path?: string;
  /** Registry to dispatch through. Pass the merged registry — this
   *  component does not fall back to defaults on its own (to avoid
   *  a circular import with the editors). `<DocumentPreview>` is
   *  the entry point that merges user overrides into defaults. */
  fieldEditors: FieldEditorRegistry;
}

/**
 * Dispatches a single value to its registered display component.
 * Recursive editors (Map, Array) re-enter through this component
 * for their children, threading the same registry.
 */
export function FieldRenderer({ value, path, fieldEditors }: FieldRendererProps) {
  const type = inferType(value);
  const contract = fieldEditors[type];
  if (!contract) return null;
  const { Display } = contract;
  return <Display value={value} path={path} fieldEditors={fieldEditors} />;
}
