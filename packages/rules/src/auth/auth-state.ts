/**
 * The rules engine's auth module: the identity a request carries into rules
 * evaluation, and the normalization that folds its tenant into the token. The
 * sandbox and the rules simulators import both from here.
 */

import { RulesValue } from '../simulator/wrappers/base.js';
import { Bytes } from '../simulator/wrappers/bytes.js';
import { FirestoreSet } from '../simulator/firestore-set.js';
import { isValidRulesDate } from '../test/case-refusals.js';

/**
 * A signed-in identity for a rules request or a sandbox operation. `null` is anonymous.
 *
 * `token` is the Firebase Auth token claims map (custom claims plus
 * standard ones). It surfaces the same way it does in production rules
 * via `request.auth.token.*`. Omit it for plain UID-only auth.
 *
 * Renamed from `AuthContext` (pre-multi-context) so the data type
 * doesn't visually collide with `SandboxContext` (the identity-bearing
 * handle). They sit at different layers, payload and handle, and the
 * names should reflect that.
 */
export type AuthState =
  | { uid: string; token?: Record<string, unknown>; tenant?: string }
  | null;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return true;
  // Inline `{ __proto__: { ... } }` literals set a plain-object prototype that
  // lacks an own `constructor`; copy own enumerable keys onto `{}` to strip it.
  return !Object.prototype.hasOwnProperty.call(proto, 'constructor');
}

function cloneAuthClaim(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
  ) {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Auth token claims cannot contain ${typeof value} values.`);
  }
  if (value instanceof Bytes) {
    return new Bytes(new Uint8Array(value.data));
  }
  if (value instanceof RulesValue) {
    return value;
  }
  if (value instanceof FirestoreSet) {
    return new FirestoreSet(value.toArray().map((item) => cloneAuthClaim(item, ancestors)));
  }
  if (value instanceof Date) {
    if (!isValidRulesDate(value)) {
      throw new TypeError('Auth token claims cannot contain an invalid or out-of-range Date.');
    }
    return new Date(value.getTime());
  }
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags);
  }
  const obj = value as object;
  if (ancestors.has(obj)) {
    throw new TypeError('Auth token claims cannot contain circular references.');
  }
  if (Array.isArray(value)) {
    ancestors.add(obj);
    try {
      return value.map((item) => cloneAuthClaim(item, ancestors));
    } finally {
      ancestors.delete(obj);
    }
  }
  if (!isPlainRecord(value)) {
    throw new TypeError('Auth token claims must be plain objects, arrays, primitives, or Rules value wrappers.');
  }
  ancestors.add(obj);
  try {
    const proto = Object.getPrototypeOf(value);
    const copy: Record<string, unknown> = proto === null ? Object.create(null) : {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key, {
        value: cloneAuthClaim(item, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(obj);
  }
}

function cloneAuthToken(token: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainRecord(token)) {
    throw new TypeError('Auth token must be a plain object.');
  }
  return cloneAuthClaim(token) as Record<string, unknown>;
}

/**
 * Normalize an AuthState before rules read it.
 * Automatically projects top-level `tenant` into `token.firebase.tenant`
 * while preserving custom claims and explicit nested token overrides.
 * Never mutates original input.
 */
export function normalizeAuthState(auth: AuthState): AuthState {
  if (auth === null) return null;

  if (auth.tenant === undefined) {
    if (auth.token === undefined) {
      return { uid: auth.uid };
    }
    return {
      uid: auth.uid,
      token: cloneAuthToken(auth.token),
    };
  }

  const token = auth.token !== undefined ? cloneAuthToken(auth.token) : {};
  const existingFirebase = token.firebase;

  let normalizedFirebase: Record<string, unknown>;
  if (isPlainRecord(existingFirebase)) {
    normalizedFirebase = {};
    for (const [key, item] of Object.entries(existingFirebase)) {
      Object.defineProperty(normalizedFirebase, key, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (existingFirebase.tenant === undefined) {
      normalizedFirebase.tenant = auth.tenant;
    }
  } else {
    normalizedFirebase = { tenant: auth.tenant };
  }

  token.firebase = normalizedFirebase;

  return {
    uid: auth.uid,
    tenant: auth.tenant,
    token,
  };
}
