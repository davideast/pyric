/**
 * Divergences the runner has found that are not fixed yet. A mismatch one of
 * these describes is skipped, and comparison continues past it; any other
 * mismatch fails. Each entry's minimal sequence is saved as
 * `fixtures/<name>.json`, and the gate requires every entry to be reproduced.
 * The change that fixes a divergence deletes its entry, so its fixture must
 * then agree on every plane.
 */
import { stable, type Mismatch } from './compare.js';
import type { Step } from './sequence.js';

export interface KnownDivergence {
  name: string;
  /** `step` is the step a `steps[i]` mismatch is at. */
  matches(mismatch: Mismatch, step: Step | undefined): boolean;
}

const SERVED = ['worker', 'node'] as const;

function stepError(mismatch: Mismatch, plane: string): string | undefined {
  const value = mismatch.values[plane] as { error?: unknown } | undefined;
  return typeof value?.error === 'string' ? value.error : undefined;
}

/** Every served plane holds the same value. */
function servedAgree(mismatch: Mismatch): boolean {
  const [first, ...rest] = SERVED.filter((plane) => plane in mismatch.values).map((plane) => stable(mismatch.values[plane]));
  return first !== undefined && rest.every((value) => value === first);
}

/**
 * A listener's events without the ones an auth change replays: a value event
 * equal to the one before it, and a second child event for a key.
 */
function withoutReplays(events: unknown): string[] {
  if (!Array.isArray(events)) return [];
  const out: string[] = [];
  const keys = new Set<string>();
  for (const event of events as Array<Record<string, unknown>>) {
    const encoded = stable(event);
    if ('key' in event) {
      const key = String(event['key']);
      if (keys.has(key)) continue;
      keys.add(key);
    } else if (out[out.length - 1] === encoded) {
      continue;
    }
    out.push(encoded);
  }
  return out;
}

export const KNOWN_DIVERGENCES: KnownDivergence[] = [
  {
    // A served listener re-registered for a new Auth identity delivers its
    // current data again, on every sign-in and sign-out operation.
    name: 'auth-change-replays-listener-events',
    matches(mismatch) {
      if (!mismatch.where.startsWith('events.')) return false;
      const lists = Object.values(mismatch.values).map((events) => stable(withoutReplays(events)));
      return lists.every((list) => list === lists[0]);
    },
  },
  {
    // A served transaction reads its location under the read rules before it
    // runs the update function.
    name: 'served-transaction-read-denied',
    matches(mismatch, step) {
      if (step?.op !== 'transaction' || !servedAgree(mismatch)) return false;
      return stepError(mismatch, 'worker') === 'code=PERMISSION_DENIED; PERMISSION_DENIED: Permission denied';
    },
  },
];

export function knownDivergence(mismatch: Mismatch, step: Step | undefined): KnownDivergence | undefined {
  return KNOWN_DIVERGENCES.find((divergence) => divergence.matches(mismatch, step));
}
