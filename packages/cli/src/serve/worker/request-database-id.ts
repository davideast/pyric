/**
 * The named Firestore database a request frame addressed: an operation's
 * `databaseId`, or a listener registration's `databaseId` / `target.databaseId`.
 * Returns `undefined` for `(default)`, empty string, and every non-Firestore
 * frame. Engine-free so client, host, and bridge planes read it identically.
 */
export function requestDatabaseId(frame: unknown): string | undefined {
  if (frame === null || typeof frame !== 'object') return undefined;
  const carrier = frame as { databaseId?: unknown; target?: unknown };
  let raw: unknown = carrier.databaseId;
  if (raw === undefined && carrier.target !== null && typeof carrier.target === 'object') {
    raw = (carrier.target as { databaseId?: unknown }).databaseId;
  }
  if (typeof raw !== 'string' || raw.length === 0 || raw === '(default)') {
    return undefined;
  }
  return raw;
}
