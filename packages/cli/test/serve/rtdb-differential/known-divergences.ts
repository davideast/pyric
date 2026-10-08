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

/** An exported value without its priorities. */
function withoutPriorities(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPriorities);
  if (value !== null && typeof value === 'object') {
    if ('.value' in value) return (value as Record<string, unknown>)['.value'];
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== '.priority')
      .map(([key, child]) => [key, withoutPriorities(child)]));
  }
  return value;
}

function isSubsequence(shorter: unknown[], longer: unknown[]): boolean {
  let index = 0;
  for (const item of longer) {
    if (index < shorter.length && stable(item) === stable(shorter[index])) index++;
  }
  return index === shorter.length;
}

export const KNOWN_DIVERGENCES: KnownDivergence[] = [
  {
    // Cancelling a descendant of a queued onDisconnect set splits the set's
    // server value as if it were an object: the sandbox then writes the raw
    // `{".sv": ...}` sentinel and the served hosts write nothing.
    name: 'disconnect-cancel-splits-server-value',
    matches(mismatch) {
      return stable(mismatch.values['sandbox'] ?? null).includes('".sv"');
    },
  },
  {
    // The sandbox decides child_moved by sort comparison and by which path a
    // write's priority touched, not by whether the child's indexed value
    // changed.
    name: 'sandbox-child-moved-indexed-value',
    matches(mismatch) {
      if (!/^events\.L\d+ child_moved /.test(mismatch.where) || !servedAgree(mismatch)) return false;
      const sandbox = mismatch.values['sandbox'];
      const served = mismatch.values['worker'];
      if (!Array.isArray(sandbox) || !Array.isArray(served)) return false;
      return isSubsequence(sandbox, served) || isSubsequence(served, sandbox);
    },
  },
  {
    // The sandbox's child_removed snapshot loses the removed child's
    // priorities.
    name: 'sandbox-child-removed-priority',
    matches(mismatch) {
      if (!/^events\.L\d+ child_removed /.test(mismatch.where) || !servedAgree(mismatch)) return false;
      return stable(withoutPriorities(mismatch.values['sandbox'])) === stable(withoutPriorities(mismatch.values['worker']));
    },
  },
  {
    // A listener re-registered for a new Auth identity delivers its current
    // data again: the sandbox's on each identity change, the served hosts' on
    // every sign-in and sign-out operation.
    name: 'auth-change-replays-listener-events',
    matches(mismatch) {
      if (!mismatch.where.startsWith('events.')) return false;
      const lists = Object.values(mismatch.values).map((events) => stable(withoutReplays(events)));
      return lists.every((list) => list === lists[0]);
    },
  },
  {
    // An Error without a `code` reaches the page with `code: 'unknown'`.
    name: 'served-codeless-error',
    matches(mismatch) {
      const sandbox = stepError(mismatch, 'sandbox');
      if (sandbox === undefined || !sandbox.startsWith('code=none; ') || !servedAgree(mismatch)) return false;
      return stepError(mismatch, 'worker') === sandbox.replace('code=none; ', 'code=unknown; ');
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
