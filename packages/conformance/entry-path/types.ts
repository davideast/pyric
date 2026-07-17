/**
 * Typed entry-path data.
 *
 * `packages/conformance/entry-path/<service>.ts` is the corpus: one canonical
 * initialization program per service, adapted from Firebase's official web
 * quickstart shape with Firebase-shaped initialization unchanged. Each program is a plain
 * runnable module exporting an async `run()` — see `load.ts` for how the
 * directory becomes the index, `../src/entry-path-gate.ts` for the CLIFF gate
 * that runs every program in-process, and `../src/entry-path-symbols.ts` for
 * the static import-set extraction that derives the critical set from these
 * programs on demand.
 */
import type { CensusSurface } from '../surfaces/types.ts';

/** The shape every `entry-path/<service>.ts` module must export. */
export interface EntryPathProgramModule {
  run(): Promise<void>;
}

/**
 * Why an expected-failure record's program is allowed to be RED today. Each
 * kind names an ALREADY-EXISTING, independently-tracked gap — the citation
 * cannot invent a new one; `validate-registry.ts` re-derives the same fact
 * (from the live surface census, surface contracts, or the registry ledger) and
 * fails if the cited gap does not actually, currently exist.
 *
 * - `unmapped-symbol`   — the exact upstream symbol is a genuine UNMAPPED gap
 *                         in the current surface census for `surface` (not
 *                         re-exported by the mirror, with no disposition;
 *                         tolerated debt in `census-baseline.json`).
 * - `disposition-deferred` — the symbol has a machine-readable disposition for
 *                         `surface` with tier `'deferred'` (intended,
 *                         buildable, not yet built).
 * - `unverified-row`    — a registry row (`rowId`) whose `status` is
 *                         currently `'unverified'` (born-unverified under
 *                         Conformance Driven Development; see `climb.ts`).
 */
export type GapCitation =
  | { kind: 'unmapped-symbol'; surface: CensusSurface; symbol: string }
  | { kind: 'disposition-deferred'; surface: CensusSurface; symbol: string }
  | { kind: 'unverified-row'; rowId: string };

/**
 * One record per known-red entry-path program (`entry-path/expected-
 * failures.ts`, a single committed file — see its header for why this is one
 * file rather than the one-record-per-file convention `exceptions/` etc. use).
 */
export interface ExpectedFailureRecord {
  /** The program name (an `entry-path/<name>.ts` filename minus `.ts`). */
  program: string;
  /** Why this program is known-red today — human prose, checked non-blank. */
  reason: string;
  /** What closes the gap — the climb / branch / PR that fixes it, so the
   *  entry names its own deletion condition. */
  fixedBy: string;
  /** The existing gap this failure traces to. See {@link GapCitation}. */
  gap: GapCitation;
}
