import {
  arrayRemove,
  arrayUnion,
  deleteField,
  increment,
  serverTimestamp,
  vector,
} from 'pyric/firestore';
import { FirebaseError } from 'pyric/app';
import { isSentinelMarker, type SentinelMarker } from '../protocol.js';

function resolveSentinel(marker: SentinelMarker): unknown {
  switch (marker.__sentinel) {
    case 'serverTimestamp': return serverTimestamp();
    case 'increment':       return increment(marker.n);
    case 'arrayUnion':      return arrayUnion(...marker.values);
    case 'arrayRemove':     return arrayRemove(...marker.values);
    case 'deleteField':     return deleteField();
    case 'vector': {
      const isNumberList =
        Array.isArray(marker.values) &&
        marker.values.every((v) => typeof v === 'number' && Number.isFinite(v));
      if (!isNumberList) {
        throw new FirebaseError('invalid-argument', 'Vector sentinel values must be an array of finite numbers.');
      }
      return vector(marker.values as number[]);
    }
    default: {
      const name = String((marker as { __sentinel?: unknown }).__sentinel);
      throw new FirebaseError('invalid-argument', `Unsupported FieldValue sentinel: ${name}.`);
    }
  }
}

/**
 * Walk a write payload and replace every `SentinelMarker` with the
 * corresponding pyric/firestore FieldValue sentinel or VectorValue object.
 */
export function resolveSentinels(value: unknown): unknown {
  if (isSentinelMarker(value)) {
    return resolveSentinel(value);
  }
  if (Array.isArray(value)) {
    return value.map(resolveSentinels);
  }
  if (value !== null && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      return value;
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveSentinels(v);
    }
    return out;
  }
  return value;
}
