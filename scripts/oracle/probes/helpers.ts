/**
 * Shared measurement helper for the admin-app-* probes.
 *
 * Not itself a probe (the runner's directory scan filters to files matching
 * the `admin-app-` observation prefix, which this filename does not), just
 * the one bit of boilerplate every error-shape probe repeats: run a call,
 * and if it throws, flatten the thrown value into the plain-data fields the
 * committed observations use (`threw`/`code`/`errorName`/`isError`/`message`).
 */

export interface CapturedThrow {
  threw: boolean;
  code?: string;
  errorName?: string;
  isError?: boolean;
  message?: string;
}

/**
 * Runs `fn`. If it throws, returns the flattened shape; if it returns
 * normally, returns `{ threw: false }` only — callers fold in whatever
 * success-path fields their own probe measures.
 */
export function captureThrow(fn: () => unknown): CapturedThrow {
  try {
    fn();
    return { threw: false };
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; constructor?: { name?: unknown } };
    return {
      threw: true,
      code: typeof err.code === 'string' ? err.code : undefined,
      errorName: typeof err.constructor?.name === 'string' ? err.constructor.name : undefined,
      isError: e instanceof Error,
      message: typeof err.message === 'string' ? err.message : undefined,
    };
  }
}
