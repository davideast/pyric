import { useState } from 'react';
import { inferType } from '../types.js';
import { FieldRenderer } from './FieldRenderer.js';
import type { FieldEditorRegistry } from '../fieldEditors/types.js';

/**
 * One row of the read-only value tree. A scalar renders `key: value` inline; a
 * map/array renders a disclosure chevron + key that toggles its nested tree
 * (collapsible, default expanded). Shared by the map + array displays so both
 * lists and objects get the same chevron behavior.
 */
export function TreeEntry({
  label,
  value,
  path,
  fieldEditors,
  kind,
}: {
  label: string;
  value: unknown;
  path: string;
  fieldEditors: FieldEditorRegistry;
  kind: 'key' | 'index';
}) {
  const type = inferType(value);
  const nested = type === 'map' || type === 'array';
  const [expanded, setExpanded] = useState(true);
  const labelAttr = kind === 'key' ? { 'data-pyric-tree-key': '' } : { 'data-pyric-tree-index': '' };
  // Stable targeting hook for the entry (map key / array index).
  const entryAttr = kind === 'key' ? { 'data-field-name': label } : { 'data-field-index': label };

  if (!nested) {
    return (
      <li data-pyric-tree-entry {...entryAttr}>
        <span data-pyric-tree-chevron data-pyric-tree-chevron-empty aria-hidden="true" />
        <span {...labelAttr}>{label}</span>
        <FieldRenderer value={value} path={path} fieldEditors={fieldEditors} />
      </li>
    );
  }

  return (
    <li data-pyric-tree-entry data-pyric-tree-nested {...entryAttr}>
      <button
        type="button"
        data-pyric-tree-toggle
        aria-expanded={expanded}
        onClick={() => setExpanded((e) => !e)}
      >
        <span data-pyric-tree-chevron aria-hidden="true">
          ›
        </span>
        <span {...labelAttr}>{label}</span>
      </button>
      {expanded ? <FieldRenderer value={value} path={path} fieldEditors={fieldEditors} /> : null}
    </li>
  );
}
