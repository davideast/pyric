/**
 * Committed expected-failures for the entry-path CLIFF gate
 * (`../src/entry-path-gate.ts`).
 *
 * One record per known-red corpus program. Every entry MUST cite an
 * ALREADY-EXISTING gap (see `GapCitation` in `types.ts`) — `compat:validate`
 * (`../src/entry-path-validate.ts`) re-derives the citation from the live
 * surface census, the surface contracts, or the registry ledger and fails the build
 * if the cited gap does not currently, actually exist. That is what makes
 * this safe to be the one ratified exception to the ratchet philosophy: an
 * expected-failure record cannot be added speculatively or left stale — it
 * is either backed by a real, independently-tracked gap right now, or the
 * gate goes strict (RED, no tolerance) for that program.
 *
 * When the cited gap closes (the climb/branch named in `fixedBy` lands),
 * DELETE the record here — do not leave it committed once the program is
 * actually green; a stale expected-failure that no longer names a real gap
 * is exactly the fatal case `entry-path-validate.ts` checks for.
 *
 * As of this writing every entry-path program is GREEN (see
 * `compat:entry-path` output) — this array is empty, which
 * `README`/the mission both name as the end state, not a placeholder to be
 * filled in.
 */
import type { ExpectedFailureRecord } from './types.ts';

export const expectedFailures: ExpectedFailureRecord[] = [];
