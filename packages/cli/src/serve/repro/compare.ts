/**
 * Compare a replayed frame with the recorded one.
 *
 * Two runs of the same operations differ in values nobody chose: generated ids
 * (anonymous uids, push keys, document ids, download tokens) and times. The
 * comparison treats them as follows.
 *
 * - Generated ids are bound: the first time a recorded id and a replayed id sit
 *   at the same place, the replay records that the replayed id stands for the
 *   recorded one, rewrites later frames it sends with the replayed id, and maps
 *   replayed values back before comparing. A recorded id bound to two replayed
 *   ids is a divergence.
 * - Times compare equal to times: epoch milliseconds, `{ seconds, nanoseconds }`
 *   timestamps, ISO and HTTP dates, and the `iat`, `exp` and `auth_time` claims.
 *
 * Everything else must be equal.
 */

const ID_CHARS = /^[A-Za-z0-9_-]+$/;
const TOKEN_SPLIT = /([^A-Za-z0-9_-]+)/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const TIME_CLAIMS = new Set(['iat', 'exp', 'auth_time']);
export const TIME = '<time>';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for a string shaped like a generated id: long, id characters, not a plain word. */
export function isGeneratedId(value: string): boolean {
  const isLong = value.length >= 16;
  const hasDigit = /\d/.test(value);
  const hasMixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);
  return isLong && ID_CHARS.test(value) && (hasDigit || hasMixedCase);
}

function isEpochMillis(value: number): boolean {
  return Number.isInteger(value) && value >= 1e12 && value < 1e14;
}

/** Times become {@link TIME}; JSON text inside a string is compared as the value it encodes. */
export function normalize(value: unknown): unknown {
  if (typeof value === 'number') return isEpochMillis(value) ? TIME : value;
  if (typeof value === 'string') {
    const isTime = ISO_DATE.test(value) || HTTP_DATE.test(value) || (/^\d{13}$/.test(value));
    if (isTime) return TIME;
    const mayBeJson = value.startsWith('{') || value.startsWith('[');
    if (mayBeJson) {
      try {
        return { json: normalize(JSON.parse(value)) };
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  const isTimestamp = 'seconds' in value && 'nanoseconds' in value && keys.every((key) => key === 'seconds' || key === 'nanoseconds' || key.startsWith('_') || key === 'type');
  if (isTimestamp) return TIME;
  const copy: Record<string, unknown> = {};
  for (const key of keys.sort()) {
    const child = value[key];
    copy[key] = TIME_CLAIMS.has(key) && typeof child === 'number' ? TIME : normalize(child);
  }
  return copy;
}

/** Recorded ids and the replayed ids that stand for them, one plane at a time. */
export class IdBindings {
  private readonly forward = new Map<string, string>();
  private readonly backward = new Map<string, string>();

  /** Bind a recorded id to a replayed one. False when either side is already bound elsewhere. */
  bind(recorded: string, replayed: string): boolean {
    const known = this.forward.get(recorded);
    if (known !== undefined) return known === replayed;
    const claimed = this.backward.get(replayed);
    if (claimed !== undefined) return claimed === recorded;
    this.forward.set(recorded, replayed);
    this.backward.set(replayed, recorded);
    return true;
  }

  /** A recorded frame as the replay sends it: recorded ids become replayed ids. */
  toReplay(value: unknown): unknown {
    return rewrite(value, this.forward);
  }

  /** A replayed frame in the recording's ids. */
  toRecorded(value: unknown): unknown {
    return rewrite(value, this.backward);
  }
}

function rewriteString(value: string, map: Map<string, string>): string {
  if (map.size === 0) return value;
  const whole = map.get(value);
  if (whole !== undefined) return whole;
  return value.split(TOKEN_SPLIT).map((part) => map.get(part) ?? part).join('');
}

function rewrite(value: unknown, map: Map<string, string>): unknown {
  if (map.size === 0) return value;
  if (typeof value === 'string') return rewriteString(value, map);
  if (Array.isArray(value)) return value.map((child) => rewrite(child, map));
  if (!isPlainObject(value)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) copy[rewriteString(key, map)] = rewrite(child, map);
  return copy;
}

/**
 * Learn bindings from a recorded and a replayed value with the same shape:
 * strings at the same place, string tokens at the same place, and object keys
 * present on one side only, paired when exactly one is unmatched on each side.
 */
export function learnBindings(recorded: unknown, replayed: unknown, bindings: IdBindings): void {
  if (typeof recorded === 'string' && typeof replayed === 'string') {
    if (recorded === replayed) return;
    const left = recorded.split(TOKEN_SPLIT);
    const right = replayed.split(TOKEN_SPLIT);
    if (left.length !== right.length) return;
    for (let index = 0; index < left.length; index++) {
      const differs = left[index] !== right[index];
      const bothIds = differs && isGeneratedId(left[index]) && isGeneratedId(right[index]) && left[index].length === right[index].length;
      if (bothIds) bindings.bind(left[index], right[index]);
    }
    return;
  }
  if (Array.isArray(recorded) && Array.isArray(replayed)) {
    const count = Math.min(recorded.length, replayed.length);
    for (let index = 0; index < count; index++) learnBindings(recorded[index], replayed[index], bindings);
    return;
  }
  if (!isPlainObject(recorded) || !isPlainObject(replayed)) return;
  const onlyRecorded = Object.keys(recorded).filter((key) => !(key in replayed));
  const onlyReplayed = Object.keys(replayed).filter((key) => !(key in recorded));
  const pairsOneKey = onlyRecorded.length === 1 && onlyReplayed.length === 1
    && isGeneratedId(onlyRecorded[0]) && isGeneratedId(onlyReplayed[0]);
  if (pairsOneKey) {
    bindings.bind(onlyRecorded[0], onlyReplayed[0]);
    learnBindings(recorded[onlyRecorded[0]], replayed[onlyReplayed[0]], bindings);
  }
  for (const key of Object.keys(recorded)) {
    if (key in replayed) learnBindings(recorded[key], replayed[key], bindings);
  }
}

/** Stable JSON for comparing normalized values. */
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? 'undefined';
}

/**
 * Compare a replayed value with the recorded one, learning id bindings first.
 * Returns the replayed value in the recording's ids, normalized, and whether it matches.
 */
export function matchRecorded(recorded: unknown, replayed: unknown, bindings: IdBindings): { matches: boolean; observed: unknown } {
  learnBindings(recorded, replayed, bindings);
  const observed = normalize(bindings.toRecorded(replayed));
  const expected = normalize(recorded);
  return { matches: JSON.stringify(observed) === JSON.stringify(expected), observed };
}
