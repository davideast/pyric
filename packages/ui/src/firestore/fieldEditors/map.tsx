import { TreeEntry } from '../components/TreeEntry.js';
import type { FieldEditorContract, FieldDisplayProps } from './types.js';

/**
 * Read-only map renderer as an indented tree (not a key/value grid): each entry
 * is `key: value` inline for scalars, or a collapsible disclosure (chevron +
 * key) whose nested tree indents below for maps/arrays. {@link TreeEntry} owns
 * the per-node collapse state + chevron.
 */
function MapDisplay({ value, path, fieldEditors }: FieldDisplayProps<Record<string, unknown>>) {
  // Lexicographic key order so fields render in a stable sequence regardless of
  // JS object enumeration order (matches firebase-tools-ui).
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return (
    <ul data-pyric-field-type="map" data-pyric-tree data-pyric-field-path={path}>
      {entries.map(([key, childValue]) => (
        <TreeEntry
          key={key}
          label={key}
          value={childValue}
          path={path ? `${path}.${key}` : key}
          fieldEditors={fieldEditors ?? {}}
          kind="key"
        />
      ))}
    </ul>
  );
}

export const mapEditor: FieldEditorContract<Record<string, unknown>> = {
  type: 'map',
  Display: MapDisplay,
};
