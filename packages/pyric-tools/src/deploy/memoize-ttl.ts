/**
 * `memoizeTtl` — host-side caching wrapper for resolver functions.
 *
 * Per F4, the SDK convention is "resolvers fire per-dispatch; hosts
 * memoize via `memoizeTtl` if cost matters." This is that memoizer.
 *
 * Default behavior (locked in v4.1):
 * - Parse `expires_in` from the resolved token's claims when the
 *   resolver returns an object whose shape carries it.
 * - Refresh proactively at **90% of TTL** — gives the next caller a
 *   fresh token before the in-flight window hits expiry.
 * - Accept an explicit `ttlMs` override when the resolver doesn't
 *   surface `expires_in` (rare; tests, mock tokens).
 *
 * Two shapes supported:
 *
 * 1. **Plain string resolver** — `() => Promise<string>`. Caller
 *    must supply `ttlMs` (the SDK can't infer TTL from an opaque
 *    string).
 * 2. **Structured token resolver** — `() => Promise<{ token: string;
 *    expiresIn?: number }>`. `expiresIn` is parsed as seconds; the
 *    memoizer refreshes at 90% of that. Callers can still pass
 *    `ttlMs` to override.
 */

interface MemoizedEntry {
  value: string;
  /** Epoch ms when this entry should be refreshed (not when it
   *  expires — the 90% point). */
  refreshAt: number;
}

export interface MemoizeTtlOptions {
  /** Explicit TTL in milliseconds. Required for plain-string
   *  resolvers; optional override for structured-token resolvers
   *  (defaults to 90% of `expiresIn`). */
  ttlMs?: number;
  /** Fraction of TTL to use as the refresh window. Default 0.9. */
  refreshAtFraction?: number;
  /**
   * Per-attempt timeout (ms) on the underlying resolver. Default
   * 30_000 (30 seconds). If the resolver hangs longer than this,
   * the in-flight wait rejects with a timeout error and the next
   * caller can retry afresh — prevents a wedged resolver from
   * deadlocking every subsequent call.
   */
  resolverTimeoutMs?: number;
}

/**
 * Wrap a plain string-returning resolver with TTL memoization.
 * Callers must supply `ttlMs` since opaque strings carry no
 * expiry information.
 */
export function memoizeTtl(
  resolver: () => Promise<string>,
  opts: MemoizeTtlOptions & { ttlMs: number },
): () => Promise<string>;

/**
 * Wrap a structured-token resolver with TTL memoization. The
 * memoizer parses `expiresIn` (seconds) from the resolver's return
 * value and refreshes at 90% of TTL by default.
 */
export function memoizeTtl(
  resolver: () => Promise<{ token: string; expiresIn?: number }>,
  opts?: MemoizeTtlOptions,
): () => Promise<string>;

export function memoizeTtl(
  resolver:
    | (() => Promise<string>)
    | (() => Promise<{ token: string; expiresIn?: number }>),
  opts: MemoizeTtlOptions = {},
): () => Promise<string> {
  let entry: MemoizedEntry | null = null;
  let inFlight: Promise<string> | null = null;
  const fraction = opts.refreshAtFraction ?? 0.9;
  const timeoutMs = opts.resolverTimeoutMs ?? 30_000;

  return async () => {
    const now = Date.now();
    if (entry && entry.refreshAt > now) return entry.value;
    // Coalesce concurrent refreshes — only one inflight at a time.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      // Race the resolver against a timeout so a hung resolver
      // can't wedge every subsequent caller. The timer is cleared
      // either way so we don't keep the process alive.
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timerHandle = setTimeout(() => {
          reject(
            new Error(
              `memoizeTtl: resolver did not complete within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      });
      let raw: string | { token: string; expiresIn?: number };
      try {
        raw = await Promise.race([resolver(), timeout]);
      } finally {
        if (timerHandle !== undefined) clearTimeout(timerHandle);
      }

      let token: string;
      let ttlMs: number;
      if (typeof raw === 'string') {
        token = raw;
        if (opts.ttlMs === undefined) {
          throw new Error(
            'memoizeTtl: plain-string resolver requires explicit ttlMs',
          );
        }
        ttlMs = opts.ttlMs;
      } else {
        token = raw.token;
        ttlMs =
          opts.ttlMs ??
          (raw.expiresIn !== undefined
            ? raw.expiresIn * 1000
            : (() => {
                throw new Error(
                  'memoizeTtl: structured-token resolver returned no expiresIn; pass an explicit ttlMs',
                );
              })());
      }
      entry = {
        value: token,
        refreshAt: Date.now() + Math.floor(ttlMs * fraction),
      };
      return token;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
