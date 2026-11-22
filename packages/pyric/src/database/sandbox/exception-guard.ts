import { logDatabaseWarning } from './query-index.js';

function extractErrorStack(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'stack' in error) {
    const stack = (error as { stack?: unknown }).stack;
    if (typeof stack === 'string') {
      return stack;
    }
  }
  return '';
}

function rethrowUserCallbackError(error: unknown): void {
  const stack = extractErrorStack(error);
  let message = 'Exception was thrown by user callback.';
  if (stack.length > 0) {
    message = `Exception was thrown by user callback. ${stack}`;
  }
  logDatabaseWarning(message);
  throw error;
}

/**
 * Match `@firebase/database`'s `exceptionGuard`: isolate a throwing listener
 * callback from sibling deliveries, then rethrow it asynchronously from
 * `setTimeout(..., 0)` after logging the Firebase warning with its stack.
 */
export function scheduleCallbackErrorRethrow(error: unknown): void {
  globalThis.setTimeout(function rtdbExceptionGuardRethrow(): void {
    rethrowUserCallbackError(error);
  }, 0);
}

/**
 * Execute a listener callback under Firebase's `exceptionGuard` semantics so
 * sibling listeners still run synchronously and the error surfaces uncaught.
 */
export function runWithExceptionGuard(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    scheduleCallbackErrorRethrow(error);
  }
}
