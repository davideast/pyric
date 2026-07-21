/**
 * Rules-language snapshot loader + validator (issue #185, step 1).
 *
 * Reads the three committed `<engine>.json` snapshots and validates them as
 * CI-enforced input, not best-effort: a malformed snapshot is a hard failure
 * (throw), the same contract the corpus loaders use. Validations:
 *
 *   - construct ids are unique WITHIN each engine,
 *   - every `kind` is one of the legal {@link CONSTRUCT_KINDS},
 *   - `engine` on each construct matches the file it lives in,
 *   - `method` constructs carry a `receiverType`; non-method constructs do not,
 *   - every construct carries a non-empty `reference` and a legal `status`.
 *
 * Snapshots are pinned reference data of the computed class: one file per
 * engine, regenerated wholesale. The loader is the single seam every consumer
 * (the analyzer report, the capability probe, the future coverage wiring) reads
 * them through.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSTRUCT_KINDS,
  type ConstructKind,
  type LanguageConstruct,
  type LanguageSnapshot,
  type RulesEngine,
} from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const RULES_ENGINES: readonly RulesEngine[] = ['firestore', 'storage', 'rtdb'] as const;

const KIND_SET = new Set<string>(CONSTRUCT_KINDS);
const STATUS_SET = new Set(['unprobed', 'accepted', 'rejected', 'unprobeable']);

/** Structural problems in one snapshot (empty = valid). */
function snapshotProblems(engine: RulesEngine, snap: unknown): string[] {
  const problems: string[] = [];
  if (typeof snap !== 'object' || snap === null) {
    return [`${engine}.json: not an object`];
  }
  const s = snap as Partial<LanguageSnapshot>;
  if (s.engine !== engine) {
    problems.push(`${engine}.json: top-level engine is "${s.engine}", expected "${engine}"`);
  }
  if (typeof s.version !== 'string' || s.version.length === 0) {
    problems.push(`${engine}.json: missing version`);
  }
  if (!Array.isArray(s.sources) || s.sources.length === 0) {
    problems.push(`${engine}.json: missing sources[]`);
  }
  if (!Array.isArray(s.constructs) || s.constructs.length === 0) {
    problems.push(`${engine}.json: missing constructs[]`);
    return problems;
  }

  const seen = new Set<string>();
  for (const [i, raw] of s.constructs.entries()) {
    const at = `${engine}.json construct[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      problems.push(`${at}: not an object`);
      continue;
    }
    const c = raw as Partial<LanguageConstruct>;
    if (typeof c.id !== 'string' || c.id.length === 0) {
      problems.push(`${at}: missing id`);
    } else {
      if (seen.has(c.id)) problems.push(`${at}: duplicate id "${c.id}" within engine ${engine}`);
      seen.add(c.id);
    }
    if (typeof c.kind !== 'string' || !KIND_SET.has(c.kind)) {
      problems.push(`${at} (${c.id}): illegal kind "${c.kind}"`);
    }
    if (c.engine !== engine) {
      problems.push(`${at} (${c.id}): engine "${c.engine}" != file engine "${engine}"`);
    }
    if (typeof c.reference !== 'string' || c.reference.length === 0) {
      problems.push(`${at} (${c.id}): missing reference citation`);
    }
    if (typeof c.status !== 'string' || !STATUS_SET.has(c.status)) {
      problems.push(`${at} (${c.id}): illegal status "${c.status}"`);
    }
    const isMethod = c.kind === 'method';
    const hasReceiver = typeof c.receiverType === 'string' && c.receiverType.length > 0;
    if (isMethod && !hasReceiver) {
      problems.push(`${at} (${c.id}): method construct missing receiverType`);
    }
    if (!isMethod && hasReceiver) {
      problems.push(`${at} (${c.id}): non-method construct carries receiverType "${c.receiverType}"`);
    }
    if (c.note !== undefined && (typeof c.note !== 'string' || c.note.length === 0)) {
      problems.push(`${at} (${c.id}): note present but empty`);
    }
    if (c.probeNote !== undefined && (typeof c.probeNote !== 'string' || c.probeNote.length === 0)) {
      problems.push(`${at} (${c.id}): probeNote present but empty`);
    }
    if (c.unattributable !== undefined && (typeof c.unattributable !== 'string' || c.unattributable.length === 0)) {
      problems.push(`${at} (${c.id}): unattributable present but empty`);
    }
    if (c.moduleCallable !== undefined && c.moduleCallable !== true) {
      problems.push(`${at} (${c.id}): moduleCallable must be true when present`);
    }
    if ((c.status === 'rejected' || c.status === 'unprobeable') &&
        (typeof c.probeNote !== 'string' || c.probeNote.length === 0)) {
      problems.push(`${at} (${c.id}): status "${c.status}" requires a non-empty probeNote`);
    }
  }
  return problems;
}

/** Load and validate one engine's snapshot. Throws on any problem. */
export function loadSnapshot(engine: RulesEngine): LanguageSnapshot {
  const file = join(HERE, `${engine}.json`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const problems = snapshotProblems(engine, parsed);
  if (problems.length > 0) {
    throw new Error(`Invalid rules-language snapshot ${engine}.json:\n  - ${problems.join('\n  - ')}`);
  }
  return parsed as LanguageSnapshot;
}

/** Load and validate all three snapshots, keyed by engine. */
export function loadAllSnapshots(): Record<RulesEngine, LanguageSnapshot> {
  const out = {} as Record<RulesEngine, LanguageSnapshot>;
  for (const engine of RULES_ENGINES) out[engine] = loadSnapshot(engine);
  return out;
}

/** Non-throwing validation: returns the problem list for one snapshot. Exposed
 *  for the test suite so it can assert the shipped snapshots are clean AND
 *  drive negative cases through the same code path. */
export function validateSnapshotValue(engine: RulesEngine, snap: unknown): string[] {
  return snapshotProblems(engine, snap);
}

export type { ConstructKind, LanguageConstruct, LanguageSnapshot, RulesEngine };
