import { Timestamp, GeoPoint, Bytes } from 'pyric/firestore';
import type { FieldType } from '../types.js';

/**
 * Default value used when a new field of this type is added (or
 * when an existing field's type is switched). The reducer applies
 * these so a fresh node always starts in a valid state for its type
 * — except that map/array start empty (children come from add
 * actions).
 */
export function defaultValueFor(type: FieldType): unknown {
  switch (type) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'timestamp':
      return Timestamp.now();
    case 'geopoint':
      return new GeoPoint(0, 0);
    case 'reference':
      // No default — a fresh reference is invalid until the user
      // sets a path. The validator will surface that.
      return { path: '', id: '', firestore: {} };
    case 'bytes':
      return Bytes.fromUint8Array(new Uint8Array());
    case 'vector':
      // The wire-sentinel both inferType and the vector editor speak.
      return { __type__: '__vector__', value: [] };
    case 'map':
    case 'array':
      return undefined; // children carry the value
  }
}
