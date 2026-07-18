/**
 * Walk a pre-resolution write payload and extract every sentinel hit
 * keyed by its field path.
 *
 * Used by `LocalEnvironment.emitWrite` to populate
 * `WriteSandboxEvent.sentinels` so the replay engine can re-issue the
 * same sentinels at replay time (without consulting resolved values
 * which would have drifted).
 *
 * Detection: every Firestore sentinel converter in
 * `converters/{fieldvalue,timestamp}.ts` marks its payload with a
 * `__type: '<name>'` discriminator. The walk matches that.
 *
 * Field-path syntax (locked in the decision doc, R1):
 *   - object keys join with '.'
 *   - in-array positions append '[<index>]'
 *   - e.g., `tags[0]`, `profile.lastSeen`, `history[0].at`
 *
 * Short-circuit: when a sentinel is detected the walk does NOT recurse
 * into its internals (e.g. `arrayUnion.values` may contain plain values
 * that aren't replay-relevant). This is also what makes the walk cheap
 * — probe R2 measured p99 ≤ 0.009ms across 0/1/16 sentinels per doc.
 */

export interface SentinelHit {
  /** Dotted path with bracket-array-indices. */
  field: string;
  kind: 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
}

export function walkForSentinels(value: unknown, prefix = ''): SentinelHit[] {
  const hits: SentinelHit[] = [];
  visit(value, prefix);
  return hits;

  function visit(v: unknown, p: string): void {
    if (v === null || v === undefined || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      v.forEach((el, i) => visit(el, `${p}[${i}]`));
      return;
    }
    const obj = v as Record<string, unknown>;
    const kind = detect(obj);
    if (kind) {
      hits.push({ field: p, kind });
      return;
    }
    for (const [k, child] of Object.entries(obj)) {
      const next = p ? `${p}.${k}` : k;
      visit(child, next);
    }
  }
}

function detect(obj: Record<string, unknown>): SentinelHit['kind'] | null {
  const t = obj.__type;
  if (t === 'serverTimestamp') return 'serverTimestamp';
  if (t === 'increment') return 'increment';
  if (t === 'arrayUnion') return 'arrayUnion';
  if (t === 'arrayRemove') return 'arrayRemove';
  if (t === 'deleteField') return 'delete';
  return null;
}
