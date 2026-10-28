/**
 * Divergences the runner has found that are not fixed yet. A mismatch one of
 * these describes is skipped, and comparison continues past it; any other
 * mismatch fails. Each entry's minimal sequence is saved as
 * `fixtures/<name>.json`, and the gate requires every entry to be reproduced.
 * The change that fixes a divergence deletes its entry, so its fixture must
 * then agree on every plane.
 */
import type { Mismatch } from './compare.js';
import type { Step } from './sequence.js';

export interface KnownDivergence {
  name: string;
  /** `step` is the step a `steps[i]` mismatch is at. */
  matches(mismatch: Mismatch, step: Step | undefined): boolean;
}

export const KNOWN_DIVERGENCES: KnownDivergence[] = [];

export function knownDivergence(mismatch: Mismatch, step: Step | undefined): KnownDivergence | undefined {
  return KNOWN_DIVERGENCES.find((divergence) => divergence.matches(mismatch, step));
}
