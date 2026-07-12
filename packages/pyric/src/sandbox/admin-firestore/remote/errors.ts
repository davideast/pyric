/**
 * Wire-error translation for the remote arm — mirrors the shape the
 * local arm's `../error-translation.ts` produces so callers see one
 * `SandboxError` regardless of which arm ran the operation.
 */

import {
  SandboxError,
  type DenialContext,
  type SandboxErrorCode,
} from 'pyric/sandbox';

/**
 * Wire errors arrive as `Error & { code, denialContext? }` (the channel
 * reconstructs them from the protocol's `SerializedError`). Re-shape them
 * into the SAME `SandboxError` the local arm throws, re-attaching the
 * structured `denialContext` when the worker carried one — so
 * `err instanceof SandboxError && err.code === 'permission-denied'` and
 * `err.denialContext` work identically on both arms.
 */
export function toRemoteSandboxError(err: unknown): unknown {
  if (err instanceof SandboxError) return err;
  if (err !== null && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; denialContext?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      const denialContext =
        e.denialContext !== null && typeof e.denialContext === 'object'
          ? (e.denialContext as DenialContext)
          : undefined;
      return new SandboxError(e.code as SandboxErrorCode, e.message, denialContext);
    }
  }
  return err;
}

export function invalidArgument(message: string): SandboxError {
  return new SandboxError('invalid-argument', message);
}
