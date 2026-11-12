import type { DocumentData } from './document-store.js';
import { isPlainObject } from './value-resolver.js';
import { copyUnescapedUserMapTag } from './unescaped-map.js';
import { Timestamp } from '../timestamp.js';
import { registeredReferenceQueryValuePath } from './query-value-registry.js';

/** Copy document inputs, validating Dates without resolving write transforms. */
export function cloneDoc(data: DocumentData): DocumentData {
  const copy: DocumentData = {};
  for (const [field, value] of Object.entries(data)) {
    Object.defineProperty(copy, field, {
      value: cloneValue(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copyUnescapedUserMapTag(data, copy);
}

function cloneValue(value: unknown): unknown {
  const isDate = value instanceof Date;
  if (isDate) return Timestamp.fromDate(value).toDate();
  const isArray = Array.isArray(value);
  if (isArray) return value.map(cloneValue);
  const isMap = isPlainObject(value);
  if (isMap) {
    const isReference = registeredReferenceQueryValuePath(value) !== undefined;
    if (isReference) return value;
    return cloneDoc(value);
  }
  return value;
}
