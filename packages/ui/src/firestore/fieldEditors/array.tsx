import { TreeEntry } from '../components/TreeEntry.js';
import type { FieldEditorContract, FieldDisplayProps } from './types.js';

/**
 * Read-only array renderer as an indented tree: each element is `index value`
 * inline for scalars, or a collapsible disclosure (chevron + index) whose
 * nested tree indents below for maps/arrays (so arrays-of-maps render through
 * the same recursion). {@link TreeEntry} owns the collapse state + chevron.
 */
function ArrayDisplay({ value, path, fieldEditors }: FieldDisplayProps<unknown[]>) {
  return (
    <ul data-pyric-field-type="array" data-pyric-tree data-pyric-field-path={path}>
      {value.map((item, i) => (
        <TreeEntry
          key={i}
          label={String(i)}
          value={item}
          path={path ? `${path}[${i}]` : `[${i}]`}
          fieldEditors={fieldEditors ?? {}}
          kind="index"
        />
      ))}
    </ul>
  );
}

export const arrayEditor: FieldEditorContract<unknown[]> = {
  type: 'array',
  Display: ArrayDisplay,
};
