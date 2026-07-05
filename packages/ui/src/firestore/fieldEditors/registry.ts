import { stringEditor } from './string.js';
import { numberEditor } from './number.js';
import { booleanEditor } from './boolean.js';
import { nullEditor } from './null.js';
import { timestampEditor } from './timestamp.js';
import { geopointEditor } from './geopoint.js';
import { referenceEditor } from './reference.js';
import { bytesEditor } from './bytes.js';
import { mapEditor } from './map.js';
import { arrayEditor } from './array.js';
import { vectorEditor } from './vector.js';
import type { FieldEditorRegistry } from './types.js';

/**
 * Default registry. Covers every {@link FieldType}. Consumers extend
 * or override by passing their own (partial) registry into
 * `<DocumentPreview>` / `<FieldRenderer>` — the components merge
 * overrides into these defaults so a consumer can swap just one
 * editor without re-declaring the rest.
 */
export const defaultFieldEditors: FieldEditorRegistry = {
  string: stringEditor,
  number: numberEditor,
  boolean: booleanEditor,
  null: nullEditor,
  timestamp: timestampEditor,
  geopoint: geopointEditor,
  reference: referenceEditor,
  bytes: bytesEditor,
  map: mapEditor,
  array: arrayEditor,
  vector: vectorEditor,
};

/**
 * Merge a consumer-supplied registry over the defaults. `undefined`
 * input returns the defaults as-is. Used internally by
 * `<DocumentPreview>` so consumers don't have to spread manually.
 */
export function mergeFieldEditors(
  override: FieldEditorRegistry | undefined,
): FieldEditorRegistry {
  if (!override) return defaultFieldEditors;
  return { ...defaultFieldEditors, ...override };
}
