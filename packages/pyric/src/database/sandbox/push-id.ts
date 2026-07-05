/**
 * RTDB push-ID generator — matches Firebase's published `nextPushId`
 * implementation exactly so a sandbox-minted key is shape-compatible
 * with a key produced by `firebase/database`'s real `push(ref)`.
 *
 * Locked by oracle observation
 * `scripts/oracle/observations/rtdb-push-autoid-format.json`:
 * length 20, leading `-`, lexicographically monotonic when generated
 * in quick succession.
 *
 * Format: 20 characters total.
 *   - First 8 chars encode the current ms-since-epoch in base-64 using
 *     the alphabet below (lex-sortable: ascending time = ascending key).
 *   - Last 12 chars are random, but if two calls land in the same
 *     millisecond the random tail is *incremented* (not regenerated)
 *     so two adjacent calls still sort. Firebase's reference impl does
 *     exactly this; we match it bit for bit.
 *
 * The alphabet is the published `PUSH_CHARS` constant: 64 characters,
 * with `-` as the smallest and `z` as the largest under lexicographic
 * (byte) ordering — that ordering is the whole point of the format.
 *
 * Reference: firebase-js-sdk `packages/database/src/core/util/NextPushId.ts`.
 */

const PUSH_CHARS =
  '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

let lastPushTime = 0;
const lastRandChars: number[] = new Array(12).fill(0);

/**
 * Generate a new RTDB push ID. Deterministic across the
 * "two pushes in the same ms" boundary: the random tail is the
 * single-step lex-successor of the previous tail, guaranteeing
 * `keyA < keyB` when `A` was minted before `B`.
 */
export function generatePushId(now: number = Date.now()): string {
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;

  // First 8 chars: ms-timestamp in base-64, lex-sortable
  const timeStampChars: string[] = new Array(8);
  let ts = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  if (ts !== 0) {
    // Defensive: clock past the 8-char window — won't happen until year ~2554.
    throw new Error('RTDB push-id: timestamp overflow.');
  }
  let id = timeStampChars.join('');

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) {
      lastRandChars[i] = Math.floor(Math.random() * 64);
    }
  } else {
    // Same-ms case: increment the previous tail by one lex step. Carry up
    // from the least-significant position. Matches the published impl;
    // ensures (rare) sub-ms repeats remain sortable.
    let i: number;
    for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) {
      lastRandChars[i] = 0;
    }
    if (i < 0) {
      // 12-digit base-64 odometer wrapped within a single ms — astronomically
      // unlikely. Fall back to a fresh random tail so the result is still
      // *some* valid key; consumers shouldn't observe this in practice.
      for (let j = 0; j < 12; j++) {
        lastRandChars[j] = Math.floor(Math.random() * 64);
      }
    } else {
      lastRandChars[i] = (lastRandChars[i] ?? 0) + 1;
    }
  }

  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(lastRandChars[i]!);
  }
  if (id.length !== 20) {
    throw new Error(`RTDB push-id: bad length ${id.length}.`);
  }
  return id;
}
