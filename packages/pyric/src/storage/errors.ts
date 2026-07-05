/**
 * `StorageError` — the sandbox's analog of `firebase/storage`'s
 * `StorageError`. Every sandbox operation that fails throws one of
 * these so `err.code === 'storage/...'` branching works identically
 * against the sandbox and a real bucket (ST-B1).
 *
 * Shape parity with upstream (`clones/firebase-js-sdk/packages/
 * storage/src/implementation/error.ts`):
 *   - `.code` is the prefixed form `storage/<code>` (e.g.
 *     `storage/object-not-found`).
 *   - the message embeds the prefixed code so the substring-matching
 *     probes (`toThrow(/object-not-found/)`) and `err.code` reads
 *     agree.
 *
 * Intentional divergence (documented in COMPAT row 105): upstream's
 * `StorageError extends FirebaseError` and reports `name:
 * 'FirebaseError'` with a `"Firebase Storage: … (storage/…)"`
 * message. The sandbox keeps a plain `Error` subclass — same as
 * `SandboxError` for Firestore — so the `.code` contract is faithful
 * while the message wording stays sandbox-flavored. The
 * `storage/<code>` prefix is what consumer code branches on.
 */

/**
 * The unprefixed storage error codes the sandbox can raise. Mirrors
 * the subset of `StorageErrorCode` the implemented operations use;
 * the deny-listed surface (download URLs, resumable, checksums) is
 * out of scope per the v1 scope.
 */
export type StorageErrorCode =
  | 'unknown'
  | 'object-not-found'
  | 'quota-exceeded'
  | 'unauthenticated'
  | 'unauthorized'
  | 'invalid-root-operation'
  | 'invalid-format'
  | 'invalid-argument';

/** Prefix an unprefixed code with `storage/` — matches upstream. */
export function prependCode(code: StorageErrorCode): `storage/${StorageErrorCode}` {
  return `storage/${code}`;
}

/**
 * Storage error carrying a prefixed `storage/<code>` on `.code`.
 * Drop-in for `err.code === 'storage/object-not-found'` branching.
 */
export class StorageError extends Error {
  /** Prefixed code, e.g. `storage/object-not-found`. */
  readonly code: `storage/${StorageErrorCode}`;

  constructor(code: StorageErrorCode, message: string) {
    const prefixed = prependCode(code);
    // The prefixed code is embedded so substring probes and `.code`
    // reads see the same value.
    super(`${prefixed}: ${message}`);
    this.name = 'StorageError';
    this.code = prefixed;
    // Mirror upstream's prototype pin so `instanceof StorageError`
    // survives the transpile-to-ES5-class-extends pattern.
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}

// ─── Factory helpers (mirror upstream's error.ts free functions) ────

export function objectNotFound(path: string): StorageError {
  return new StorageError('object-not-found', `no object at "${path}".`);
}

export function unauthorized(method: string, path: string, detail: string): StorageError {
  return new StorageError(
    'unauthorized',
    `${method} "${path}" denied by rules${detail}.`,
  );
}

export function quotaExceeded(path: string, size: number, max: number): StorageError {
  return new StorageError(
    'quota-exceeded',
    `object at "${path}" is ${size} bytes, exceeds maxDownloadSizeBytes ${max}.`,
  );
}

export function invalidRootOperation(op: string): StorageError {
  return new StorageError(
    'invalid-root-operation',
    `${op} cannot operate on the root reference.`,
  );
}

export function invalidFormat(format: string, message: string): StorageError {
  return new StorageError('invalid-format', `string does not match format "${format}": ${message}`);
}
