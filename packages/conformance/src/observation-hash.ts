/**
 * The content hash over an observation's `behavior` blob.
 *
 * WHY THIS EXISTS
 *
 * An observation is the ONLY place production's own verdicts live. Every
 * conformance number downstream — a `conforms` row, a rules-language construct
 * counted as production-verified, an assurance capability marked `supported` —
 * rests on the claim that the `behavior` blob in the file is what production
 * actually said. Nothing checked that claim. A simulator that failed to match
 * production could be "fixed" by editing the observation's recorded verdicts to
 * match the simulator, and every gate in the chain would go green: the row still
 * cites the file, the file still parses, the replay still compares equal —
 * because both sides now say the same wrong thing.
 *
 * The hash closes that path. It is written by the capture runner, at capture
 * time, over the verdicts production returned; the validator (compat:validate,
 * run by compat:check) recomputes it from the file's own `behavior` and compares.
 * An observation whose verdicts were edited after capture no longer matches its
 * hash, and compat:check fails.
 *
 * WHAT IT DOES AND DOES NOT PROVE
 *
 * It proves that the `behavior` blob has not changed since the hash beside it
 * was written. It is a TAMPER-EVIDENCE seal, not a signature: an editor who
 * changes `behavior` AND recomputes the hash produces a consistent file. What it
 * removes is the silent edit — the one-line verdict flip in a JSON file that no
 * gate reads as a change. A recapture rewrites both together, which is exactly
 * what a recapture should do; a hand-edit of the verdicts alone is now a hard
 * failure with the file named.
 *
 * WHY ONLY `behavior`
 *
 * `behavior` is the measured fact. The rest of the envelope is provenance and
 * bookkeeping (`description`, `rowIds`, `observedAt`) — prose and links that are
 * legitimately edited as rows are re-wired, and that no number is computed from.
 * Hashing them would make ordinary re-wiring look like tampering, and a gate that
 * cries wolf gets suppressed.
 *
 * THE CANONICAL FORM
 *
 * The hash is over a canonical JSON encoding: object keys sorted, no
 * insignificant whitespace. Key ORDER in the file must not change the hash —
 * a reformat, a re-serialization, a key reordering by a different writer are all
 * the same fact and must hash the same. What must change the hash is a changed
 * VERDICT.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** The algorithm prefix carried in the `behaviorHash` field, so the format can
 *  be migrated without ambiguity about what an existing hash was computed with. */
const ALGORITHM = 'sha256';

/**
 * Canonical JSON: object keys sorted at every depth, no insignificant
 * whitespace. Array ORDER is significant (it is data); object key order is not
 * (it is serialization).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The content hash of one observation's `behavior` blob, e.g. `sha256:1a2b…`. */
export function behaviorHash(behavior: unknown): string {
  const digest = createHash(ALGORITHM).update(canonicalJson(behavior ?? {}), 'utf8').digest('hex');
  return `${ALGORITHM}:${digest}`;
}

/** An observation envelope, as far as hashing is concerned. */
export interface HashableObservation {
  behavior: Record<string, unknown>;
  [key: string]: unknown;
}

/** The envelope with its `behaviorHash` stamped from its own `behavior`. */
export function stampBehaviorHash<T extends HashableObservation>(envelope: T): T & { behaviorHash: string } {
  return { ...envelope, behaviorHash: behaviorHash(envelope.behavior) };
}

/**
 * The ONE way a capture runner writes an observation to disk. Every runner calls
 * this rather than serializing an envelope itself, so no capture path can omit
 * the seal. (A runner that bypassed it would still be caught — the validator
 * fails an observation with no hash — but this is the seam that keeps it from
 * happening in the first place.)
 */
export function writeObservationFile(path: string, envelope: HashableObservation): void {
  writeFileSync(path, JSON.stringify(stampBehaviorHash(envelope), null, 2) + '\n');
}

/**
 * The validator's question: does this observation's recorded hash match the
 * blob it sits beside? Returns the problem, or null when the seal holds.
 */
export function behaviorHashProblem(observation: {
  file: string;
  behavior: Record<string, unknown>;
  behaviorHash?: string;
}): string | null {
  if (!observation.behaviorHash) {
    return `${observation.file}: missing behaviorHash — every observation carries a content hash over its 'behavior' blob, written at capture time (see src/observation-hash.ts)`;
  }
  const recomputed = behaviorHash(observation.behavior);
  if (observation.behaviorHash !== recomputed) {
    return `${observation.file}: behaviorHash does not match its 'behavior' blob (recorded ${observation.behaviorHash}, recomputed ${recomputed}) — the recorded production verdicts were edited after capture; recapture the observation rather than editing it`;
  }
  return null;
}
