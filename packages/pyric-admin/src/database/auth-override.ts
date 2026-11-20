/**
 * `databaseAuthVariableOverride` for `pyric-admin/database`.
 *
 * firebase-admin's app option downscopes the app's Realtime Database access:
 *
 * - left out: full admin access, no rules (the default);
 * - `null`: rules run as an unauthenticated request;
 * - an object: rules run with `auth` set to that object.
 *
 * The sandbox's rules see `auth` as `{ uid, token }` (pyric's auth state), so
 * an override object needs a non-empty `uid`, and its custom fields go under
 * `token`, where production reads them the same way (`auth.token.<field>`):
 * production's `auth` is the override object itself. Top-level fields other
 * than `uid` and `token` cannot be represented yet and are refused rather than
 * silently dropped (https://github.com/davideast/pyric/issues/3001).
 */

import type { AuthState } from 'pyric/sandbox';
import { FirebaseDatabaseError } from './error.js';

/** Which identity the app's database operations carry: the worker host's `actAs` lens shape. */
export type DatabaseAuthLens =
  | { readonly mode: 'admin' }
  | { readonly mode: 'anon' }
  | { readonly mode: 'as'; readonly uid: string; readonly token?: Record<string, unknown> };

const ADMIN_DATABASE_LENS: DatabaseAuthLens = { mode: 'admin' };

const OVERRIDE_DOCS = 'https://github.com/davideast/pyric/issues/3001';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function unsupportedOverride(detail: string): FirebaseDatabaseError {
  return new FirebaseDatabaseError({
    code: 'invalid-argument',
    message: `pyric: databaseAuthVariableOverride ${detail} (${OVERRIDE_DOCS}).`,
  });
}

/**
 * The lens for an app's `databaseAuthVariableOverride` option. Throws as the
 * database SDK does for a non-object override, and with a pyric message for an
 * object the sandbox's rules cannot represent.
 */
export function databaseAuthLensOf(override: unknown): DatabaseAuthLens {
  if (override === undefined) return ADMIN_DATABASE_LENS;
  if (override === null) return { mode: 'anon' };
  if (typeof override !== 'object') {
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
  const extra = Object.keys(fields).filter((key) => key !== 'uid' && key !== 'token');
  if (extra.length > 0) {
    throw unsupportedOverride(
      `field${extra.length === 1 ? '' : 's'} ${extra.map((key) => `\`${key}\``).join(', ')} can't be seen by the sandbox's rules, which read only \`auth.uid\` and \`auth.token\`; put custom fields under \`token\``,
    );
  }
  if (token === undefined) return { mode: 'as', uid };
  if (!isPlainObject(token)) {
    throw unsupportedOverride('`token` must be a plain object of claims');
  }
  return { mode: 'as', uid, token: structuredClone(token) };
}

/** The auth state the sandbox's rules evaluate for a non-admin lens. */
export function authStateOfLens(lens: Exclude<DatabaseAuthLens, { mode: 'admin' }>): AuthState {
  if (lens.mode === 'anon') return null;
  if (lens.token === undefined) return { uid: lens.uid };
  return { uid: lens.uid, token: structuredClone(lens.token) };
}
