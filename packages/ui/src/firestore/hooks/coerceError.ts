/**
 * Coerce an arbitrary thrown value into an `Error` with a useful
 * `.message`. The naive `new Error(String(err))` produces the literal
 * string `"[object Object]"` when `err` is a non-Error object shape
 * — which is exactly what Firestore's `onSnapshot` error callback
 * receives for `FirestoreError`-like values (`{ code, message, …}`).
 *
 * Strategy:
 *   - `Error` → returned unchanged.
 *   - `string` → `new Error(value)`.
 *   - `{ message }` → `new Error(message)` (preserves Firestore's
 *     stringified message), with `code` appended when present.
 *   - anything else → `new Error(JSON.stringify(value))` (no more
 *     "[object Object]").
 */
export function coerceError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  if (value && typeof value === 'object') {
    const obj = value as { message?: unknown; code?: unknown };
    const msg = typeof obj.message === 'string' ? obj.message : null;
    const code = typeof obj.code === 'string' ? obj.code : null;
    if (msg && code) return new Error(`[${code}] ${msg}`);
    if (msg) return new Error(msg);
    if (code) return new Error(code);
    try {
      return new Error(JSON.stringify(value));
    } catch {
      // Cyclic objects — bail to a type tag rather than crash.
      return new Error(Object.prototype.toString.call(value));
    }
  }
  return new Error(String(value));
}
