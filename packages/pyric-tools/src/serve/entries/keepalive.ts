/**
 * `keepalive` size gate for the persist flush (pre-mortem #1).
 *
 * The persistence controller's `beforeunload` flush fires while the page is
 * unloading; a plain `fetch` is aborted on unload, so the final delta is
 * lost (the original "crash-only loss window" claim was wrong). `fetch(...,
 * {keepalive: true})` survives unload — but the browser caps the TOTAL body
 * size of in-flight keepalive requests at ~64KB. Above that the request is
 * rejected, so we only set keepalive when the body comfortably fits, and
 * warn once when it doesn't (that page's final unsaved change can be lost on
 * tab close; reload-triggered flushes are unaffected because they complete
 * before navigation).
 */

/** Below this, keepalive is safe; above, skip it (and warn once). 60KB
 *  leaves headroom under the ~64KB spec cap for headers/other requests. */
export const KEEPALIVE_MAX_BYTES = 60_000;

let warnedLargeState = false;

export function keepaliveSafe(
  body: string,
  warn: (msg: string) => void = (m) => console.warn(m),
): boolean {
  const bytes = byteLength(body);
  if (bytes <= KEEPALIVE_MAX_BYTES) return true;
  if (!warnedLargeState) {
    warnedLargeState = true;
    warn(
      `[pyric serve] persisted state is ${Math.round(bytes / 1024)}KB — too large for an ` +
        'unload-time flush; the final unsaved change may be lost if you CLOSE the tab before ' +
        'the next auto-flush. Reloads and normal saves are unaffected.',
    );
  }
  return false;
}

/** Reset module state — tests only. */
export function __resetKeepaliveWarning(): void {
  warnedLargeState = false;
}

function byteLength(s: string): number {
  // TextEncoder is in every browser + bun; avoids assuming Buffer.
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
}
