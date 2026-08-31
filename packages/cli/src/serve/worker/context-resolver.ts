/**
 * SharedWorker context resolver.
 *
 * Coordinates asynchronous initialization of a singleton resource across
 * concurrent inbound connection requests or burst messages.
 *
 * Invariants:
 * 1. Single In-Flight Attempt: When multiple callers request the context
 *    concurrently while initialization is in flight, all callers share the
 *    single in-flight promise rather than starting parallel initializations.
 * 2. Unpoisoned on Rejection: If initialization rejects, the memoized promise
 *    is cleared immediately, allowing subsequent requests to retry initialization
 *    rather than permanently caching the rejection.
 * 3. Synchronous Retrieval: Once successfully resolved, the resource is
 *    available synchronously for shutdown and cleanup handlers.
 */

export interface ContextResolver<T> {
  /**
   * Return the resolved resource or the in-flight initialization promise.
   * If a previous attempt rejected, starts a new attempt.
   */
  get(): Promise<T>;

  /**
   * Return the successfully resolved resource, or null if not yet resolved
   * or currently in-flight.
   */
  current(): T | null;
}

export function createContextResolver<T>(factory: () => Promise<T>): ContextResolver<T> {
  let value: T | null = null;
  let inFlight: Promise<T> | null = null;

  return {
    async get(): Promise<T> {
      if (value !== null) {
        return value;
      }
      if (inFlight === null) {
        inFlight = factory()
          .then((resolved) => {
            value = resolved;
            return resolved;
          })
          .catch((error: unknown) => {
            inFlight = null;
            value = null;
            throw error;
          });
      }
      return inFlight;
    },

    current(): T | null {
      return value;
    },
  };
}
