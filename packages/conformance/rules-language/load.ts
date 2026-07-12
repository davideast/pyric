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
  EXCLUSION_CLASSES,
  type ConstructExclusion,
  type ConstructKind,
  type ExclusionClass,
  type LanguageConstruct,
  type LanguageSnapshot,
  type RulesEngine,
} from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export const RULES_ENGINES: readonly RulesEngine[] = ['firestore', 'storage', 'rtdb'] as const;

const KIND_SET = new Set<string>(CONSTRUCT_KINDS);
const STATUS_SET = new Set(['unprobed', 'accepted', 'rejected', 'unprobeable']);
const EXCLUSION_CLASS_SET = new Set<string>(EXCLUSION_CLASSES);

/**
 * The exclusion predicates. An exclusion takes a construct OUT of the published
 * coverage denominator, so it must earn that by satisfying its reason class's
 * predicate against the construct's own record — see ConstructExclusion in
 * types.ts for what each class means and why its predicate is the shape it is.
 * An exclusion whose predicate does not hold is a hard failure: the construct
 * stays in the denominator as the gap it is.
 */
function exclusionProblems(at: string, c: Partial<LanguageConstruct>): string[] {
  const excluded = c.excluded;
  if (excluded === undefined) return [];
  const problems: string[] = [];
  if (typeof excluded !== 'object' || excluded === null) {
    return [`${at} (${c.id}): excluded must be an object { class, reason } — free-text exclusions are not accepted`];
  }
  if (typeof excluded.class !== 'string' || !EXCLUSION_CLASS_SET.has(excluded.class)) {
    problems.push(
      `${at} (${c.id}): illegal exclusion class "${excluded.class}" (expected one of ${EXCLUSION_CLASSES.join(', ')})`,
    );
    return problems;
  }
  if (typeof excluded.reason !== 'string' || excluded.reason.trim().length === 0) {
    problems.push(`${at} (${c.id}): exclusion class "${excluded.class}" requires a non-empty reason`);
  }

  switch (excluded.class) {
    case 'no-ast-node':
      // A token can always be found in an AST. Only a semantic — ambient engine
      // behavior with no expression-level form — has no node to credit.
      if (c.kind !== 'semantic') {
        problems.push(
          `${at} (${c.id}): exclusion class "no-ast-node" is valid only for kind "semantic", but this construct is kind "${c.kind}" — a ${c.kind} IS an expression-level token the analyzer can find, so it stays in the denominator`,
        );
      }
      break;
    case 'not-authorization':
      // Anything usable inside a rule expression feeds the value that IS the
      // ALLOW/DENY verdict. Only a declaration form can be a directive the
      // engine reads for some other purpose.
      if (c.kind !== 'rule-kind') {
        problems.push(
          `${at} (${c.id}): exclusion class "not-authorization" is valid only for kind "rule-kind" (a declaration-level directive), but this construct is kind "${c.kind}" — a ${c.kind} appears inside a rule expression whose value is the authorization verdict`,
        );
      }
      break;
    case 'production-rejects':
      // Production must actually have rejected it, in its own words.
      if (c.status !== 'rejected') {
        problems.push(
          `${at} (${c.id}): exclusion class "production-rejects" requires snapshot status "rejected", but this construct's status is "${c.status}" — production did not refuse it, so it is an ordinary coverage gap`,
        );
      }
      if (typeof c.probeNote !== 'string' || c.probeNote.trim().length === 0) {
        problems.push(
          `${at} (${c.id}): exclusion class "production-rejects" requires a probeNote carrying production's verbatim rejection message`,
        );
      }
      break;
  }
  return problems;
}

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
    problems.push(...exclusionProblems(at, c));
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

export type { ConstructExclusion, ConstructKind, ExclusionClass, LanguageConstruct, LanguageSnapshot, RulesEngine };
