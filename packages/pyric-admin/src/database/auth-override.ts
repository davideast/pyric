/**
 * `databaseAuthVariableOverride` for `pyric-admin/database`.
 *
 * firebase-admin's app option downscopes the app's Realtime Database access:
 *
 * - left out: full admin access, no rules (the default);
 * - `null`: rules run as an unauthenticated request;
 * - an object: rules run with `auth` set to that object.
 *
 * An override object needs a non-empty `uid`. Its top-level fields read as
 * `auth.<field>` and its `token` holds only the claims the override supplied.
 */

import type { AuthState } from 'pyric/sandbox';
import { FirebaseDatabaseError } from './error.js';

/** Which identity the app's database operations carry: the worker host's `actAs` lens shape. */
export type DatabaseAuthLens =
  | { readonly mode: 'admin' }
  | { readonly mode: 'anon' }
  | { readonly mode: 'as'; readonly uid: string; readonly token?: Record<string, unknown> }
  | ({
      readonly mode: 'as';
      readonly uid: string;
      readonly token?: Record<string, unknown>;
    } & Readonly<Record<string, unknown>>);

const ADMIN_DATABASE_LENS: DatabaseAuthLens = { mode: 'admin' };

const FORBIDDEN_OVERRIDE_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'mode']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unsupportedOverride(detail: string): FirebaseDatabaseError {
  return new FirebaseDatabaseError({
    code: 'invalid-argument',
    message: `pyric: databaseAuthVariableOverride ${detail}.`,
  });
}

/**
 * The lens for an app's `databaseAuthVariableOverride` option. Throws as the
 * database SDK does for a non-object override, and with a pyric message for an
 * object without a non-empty string `uid` or with a non-object `token`.
 */
export function databaseAuthLensOf(override: unknown): DatabaseAuthLens {
  if (override === undefined) return ADMIN_DATABASE_LENS;
  if (override === null) return { mode: 'anon' };
  if (typeof override !== 'object' || Array.isArray(override)) {
    throw new Error('Only objects are supported for option databaseAuthVariableOverride');
  }
  try {
    JSON.stringify(override);
  } catch (error) {
    throw new Error(`Invalid authOverride provided: ${String(error)}`);
  }
  const fields = override as Record<string, unknown>;
  const { uid, token } = fields;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw unsupportedOverride('needs a non-empty string `uid` in the sandbox, whose rules always read `auth.uid`');
  }
  if (token !== undefined && !isPlainObject(token)) {
    throw unsupportedOverride('`token` must be a plain object of claims');
  }
  const lens: Record<string, unknown> = { mode: 'as', uid };
  if (token !== undefined) {
    lens.token = structuredClone(token);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'uid' || key === 'token' || FORBIDDEN_OVERRIDE_KEYS.has(key)) {
      continue;
    }
    if (value === undefined) continue;
    Object.defineProperty(lens, key, {
      value: structuredClone(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return lens as DatabaseAuthLens;
}

/** The auth state the sandbox's rules evaluate for a non-admin lens. */
export function authStateOfLens(lens: Exclude<DatabaseAuthLens, { mode: 'admin' }>): AuthState {
  if (lens.mode === 'anon') return null;
  const state: NonNullable<AuthState> = { uid: lens.uid };
  if (lens.token !== undefined) {
    state.token = structuredClone(lens.token);
  }
  for (const [key, value] of Object.entries(lens)) {
    if (key === 'uid' || key === 'token' || FORBIDDEN_OVERRIDE_KEYS.has(key)) {
      continue;
    }
    if (value === undefined) continue;
    Object.defineProperty(state, key, {
      value: structuredClone(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return state;
}
