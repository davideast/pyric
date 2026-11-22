/**
 * Persistence mode resolution for `initializeAuth(app, deps)` and
 * `setPersistence(auth, persistence)`.
 *
 * Mirrors `@firebase/auth` `1.13.6` (`_initializeAuthInstance` and
 * `PersistenceUserManager.create`):
 * - `initializeAuth` accepts a single `Persistence` or a `Persistence[]`
 *   hierarchy; an omitted or empty hierarchy falls back to in-memory (`NONE`).
 * - `'COOKIE'` maps to `'LOCAL'` (long-lived session storage), matching
 *   `setPersistence` and the served `SessionStore`.
 */
import { makeAuthError } from '../auth-errors.js';
import type { Persistence } from '../types.js';

export type AuthPersistenceMode = 'LOCAL' | 'SESSION' | 'NONE';

export interface ResolvedPersistenceConfig {
  readonly mode: AuthPersistenceMode;
  readonly restoreModes: ReadonlySet<'LOCAL' | 'SESSION'>;
}

/** Map a `Persistence` marker to its sandbox storage mode or throw `auth/argument-error`. */
export function resolvePersistenceMode(
  persistence: unknown,
  apiName: string,
): AuthPersistenceMode {
  if (typeof persistence !== 'object' || persistence === null) {
    throw makeAuthError(
      'auth/argument-error',
      `${apiName}: unrecognized persistence type ${String(persistence)}`,
    );
  }
  const rawType = (persistence as Partial<Persistence>).type;
  switch (rawType) {
    case 'LOCAL':
    case 'COOKIE':
      return 'LOCAL';
    case 'SESSION':
      return 'SESSION';
    case 'NONE':
      return 'NONE';
    default:
      throw makeAuthError(
        'auth/argument-error',
        `${apiName}: unrecognized persistence type ${String(rawType)}`,
      );
  }
}

/** Resolve the initial persistence mode and restorable slots from `initializeAuth` deps. */
export function resolveInitializeAuthPersistence(deps: unknown): ResolvedPersistenceConfig {
  if (typeof deps !== 'object' || deps === null || !('persistence' in deps)) {
    return { mode: 'NONE', restoreModes: new Set() };
  }
  const rawPersistence = (deps as { persistence?: unknown }).persistence;
  if (rawPersistence === undefined) {
    return { mode: 'NONE', restoreModes: new Set() };
  }
  const hierarchy = Array.isArray(rawPersistence) ? rawPersistence : [rawPersistence];
  if (hierarchy.length === 0) {
    return { mode: 'NONE', restoreModes: new Set() };
  }
  const modes: AuthPersistenceMode[] = [];
  const restoreModes = new Set<'LOCAL' | 'SESSION'>();
  for (const entry of hierarchy) {
    const mode = resolvePersistenceMode(entry, 'initializeAuth');
    modes.push(mode);
    if (mode === 'LOCAL' || mode === 'SESSION') {
      restoreModes.add(mode);
    }
  }
  const primaryMode = modes[0];
  if (primaryMode === undefined) {
    return { mode: 'NONE', restoreModes };
  }
  return { mode: primaryMode, restoreModes };
}
