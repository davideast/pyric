/**
 * Pre-runtime Firestore `list` query soundness pass (`staticQueryProofPass`):
 * feeds {@link SdkUsageIndex} client queries and bare collection reads into
 * {@link proveListQuery} and residual simulation, emitting deterministic
 * {@link AssuranceDiagnostic} items with copy-paste `.where(...)` remediation.
 */
import { SimulateFirestoreRulesHandler } from '../../rules/simulator/handler.js';
import {
  sortAssuranceDiagnostics,
  type AssuranceDiagnostic,
} from '../../sandbox/internal/assurance-diagnostic.js';
import type {
  SdkQueryConstraint,
  SdkRef,
  SdkUsageIndex,
} from '../code/usage-index.js';
import { parseFirestoreRulesAstWithMultiMatch } from '../rules/rules-ast-utils.js';
import {
  concretizeQueryTarget,
  expandQueryArmsWithTruncation,
} from './static-query-proof-args.js';
import {
  evaluateCandidateArm,
  type ArmFailure,
  type ResolvedDatabaseRules,
} from './static-query-proof-eval.js';
import {
  normalizeDatabaseRootAst,
  rulesetHasRootForDatabase,
} from './static-query-proof-rules.js';

const DIAGNOSTIC_CODE = 'firestore-unprovable-list-query';

export interface StaticQueryProofRulesConfig {
  readonly rules?: Readonly<Record<string, string>> | string;
  readonly defaultDatabaseId?: string;
  readonly rulesFile?: Readonly<Record<string, string>> | string;
  readonly modules?: Readonly<Record<string, string>>;
  readonly sharedDefaultRules?: boolean;
}

export type StaticQueryProofPassOptions = string | StaticQueryProofRulesConfig;

interface QueryCandidate {
  readonly id: string;
  readonly baseRef: SdkRef;
  readonly arms: readonly (readonly SdkQueryConstraint[])[];
  readonly truncated: boolean;
  readonly source: string;
  readonly through?: string;
}

function lookupOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return record[key];
}

function resolveRulesFile(
  rulesFile: Readonly<Record<string, string>> | string | undefined,
  resourceId: string,
  defaultDatabaseId: string,
): string {
  if (typeof rulesFile === 'string') return rulesFile;
  if (rulesFile !== undefined) {
    const direct = lookupOwn(rulesFile, resourceId);
    if (direct !== undefined) return direct;
    if (resourceId === '(default)') {
      const fallback = lookupOwn(rulesFile, defaultDatabaseId);
      if (fallback !== undefined) return fallback;
    }
  }
  return 'firestore.rules';
}

function resolveDefaultDatabaseId(options: StaticQueryProofPassOptions): string {
  if (typeof options === 'string') return '(default)';
  if (options.defaultDatabaseId !== undefined) return options.defaultDatabaseId;
  return '(default)';
}

function createRulesResolver(
  options: StaticQueryProofPassOptions,
): (resourceId: string) => ResolvedDatabaseRules | null {
  const cache = new Map<string, ResolvedDatabaseRules | null>();
  const defaultDbId = resolveDefaultDatabaseId(options);

  return (resourceId: string): ResolvedDatabaseRules | null => {
    if (cache.has(resourceId)) {
      return cache.get(resourceId) ?? null;
    }
    let source: string | undefined;
    let file = 'firestore.rules';
    let usedSharedFallback = false;
    if (typeof options === 'string') {
      source = options;
      if (resourceId !== defaultDbId) usedSharedFallback = true;
    } else if (typeof options.rules === 'string') {
      if (resourceId === defaultDbId || (resourceId === '(default)' && options.defaultDatabaseId === undefined)) {
        source = options.rules;
        file = resolveRulesFile(options.rulesFile, resourceId, defaultDbId);
      } else if (options.defaultDatabaseId === undefined) {
        source = options.rules;
        file = resolveRulesFile(options.rulesFile, '(default)', defaultDbId);
        usedSharedFallback = true;
      }
    } else if (options.rules !== undefined) {
      source = lookupOwn(options.rules, resourceId);
      if (source === undefined && resourceId === '(default)') {
        source = lookupOwn(options.rules, defaultDbId);
      }
      if (source !== undefined) {
        file = resolveRulesFile(options.rulesFile, resourceId, defaultDbId);
      } else if (options.sharedDefaultRules === true) {
        source = lookupOwn(options.rules, defaultDbId);
        if (source === undefined && defaultDbId !== '(default)') {
          source = lookupOwn(options.rules, '(default)');
        }
        file = resolveRulesFile(options.rulesFile, '(default)', defaultDbId);
        usedSharedFallback = true;
      }
    }

    if (source === undefined) {
      cache.set(resourceId, null);
      return null;
    }
    const lowerOpts: {
      targetService: 'cloud.firestore';
      sourceFile: string;
      modules?: Readonly<Record<string, string>>;
    } = {
      targetService: 'cloud.firestore',
      sourceFile: file,
    };
    if (typeof options !== 'string' && options.modules !== undefined) {
      lowerOpts.modules = options.modules;
    }
    const parsed = parseFirestoreRulesAstWithMultiMatch(source, lowerOpts);
    if (!parsed || (usedSharedFallback && !rulesetHasRootForDatabase(parsed.ast, resourceId))) {
      cache.set(resourceId, null);
      return null;
    }
    const resolved: ResolvedDatabaseRules = {
      source: parsed.source,
      file,
      ast: normalizeDatabaseRootAst(parsed.ast, resourceId),
    };
    cache.set(resourceId, resolved);
    return resolved;
  };
}

function collectQueryCandidates(usage: SdkUsageIndex): QueryCandidate[] {
  const candidates: QueryCandidate[] = [];
  const coveredRefConsumers = new Set<string>();

  for (const q of usage.queries) {
    if (q.admin || q.baseRef.admin) continue;
    if (q.baseRef.pattern.service !== 'firestore') continue;
    if (q.baseRef.refKind === 'doc') continue;
    for (const consumer of q.consumedBy) {
      coveredRefConsumers.add(`${q.baseRef.id}|${consumer}`);
    }
    const expanded = expandQueryArmsWithTruncation(q);
    const candidate: {
      id: string;
      baseRef: SdkRef;
      arms: readonly (readonly SdkQueryConstraint[])[];
      truncated: boolean;
      source: string;
      through?: string;
    } = {
      id: q.id,
      baseRef: q.baseRef,
      arms: expanded.arms,
      truncated: expanded.truncated,
      source: q.source,
    };
    if (q.through !== undefined) candidate.through = q.through;
    candidates.push(candidate);
  }

  for (const ref of usage.refs) {
    if (ref.admin) continue;
    if (ref.pattern.service !== 'firestore') continue;
    if (ref.refKind !== 'collection' && ref.refKind !== 'collectionGroup') continue;
    for (const consumer of ref.consumedBy) {
      if (!consumer.startsWith('query@')) continue;
      if (coveredRefConsumers.has(`${ref.id}|${consumer}`)) continue;
      const source = consumer.slice('query@'.length);
      const matchingOp = usage.operations.find(
        (op) => op.service === 'firestore' && op.op === 'query' && op.source === source,
      );
      if (matchingOp?.admin) continue;
      let through: string | undefined;
      if (matchingOp?.through !== undefined) {
        through = matchingOp.through;
      } else if (ref.through !== undefined) {
        through = ref.through;
      }
      const candidate: {
        id: string;
        baseRef: SdkRef;
        arms: readonly (readonly SdkQueryConstraint[])[];
        truncated: boolean;
        source: string;
        through?: string;
      } = {
        id: `unwrapped:${ref.id}@${source}`,
        baseRef: ref,
        arms: [[]],
        truncated: false,
        source,
      };
      if (through !== undefined) candidate.through = through;
      candidates.push(candidate);
    }
  }

  return candidates;
}

export function staticQueryProofPass(
  usage: SdkUsageIndex,
  options: StaticQueryProofPassOptions,
): AssuranceDiagnostic[] {
  const resolveRules = createRulesResolver(options);
  const simulator = new SimulateFirestoreRulesHandler();
  const candidates = collectQueryCandidates(usage);
  const diagnostics: AssuranceDiagnostic[] = [];
  const usedIds = new Set<string>();

  for (const candidate of candidates) {
    const resourceId = candidate.baseRef.pattern.resourceId;
    const dbRules = resolveRules(resourceId);
    if (!dbRules) continue;
    const target = concretizeQueryTarget(candidate.baseRef);
    if (!target) continue;

    let chosenFailure: ArmFailure | null = null;
    for (const arm of candidate.arms) {
      const failure = evaluateCandidateArm(simulator, dbRules, target, arm);
      if (!failure) continue;
      if (!chosenFailure) {
        chosenFailure = failure;
      } else if (chosenFailure.certainty === 'heuristic' && failure.certainty === 'static-proof') {
        chosenFailure = failure;
      }
    }
    if (!chosenFailure && candidate.truncated) {
      const unconstrainedFailure = evaluateCandidateArm(simulator, dbRules, target, []);
      if (unconstrainedFailure) {
        chosenFailure = {
          ...unconstrainedFailure,
          certainty: 'heuristic',
          reason:
            `query constraint expansion exceeded static DNF arm budget; unverified arm may fail (${unconstrainedFailure.reason})`,
        };
      }
    }
    if (!chosenFailure) continue;

    let scopeLabel = 'collection';
    if (target.isCollectionGroup) scopeLabel = 'collectionGroup';
    const baseId = `${DIAGNOSTIC_CODE}:${resourceId}:${scopeLabel}:${target.renderedPattern}:${candidate.source}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${baseId}#${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);

    const codeSite: { source: string; through?: string } = { source: candidate.source };
    if (candidate.through !== undefined) codeSite.through = candidate.through;

    let ruleSource = dbRules.file;
    if (chosenFailure.ruleLine !== undefined) {
      ruleSource = `${dbRules.file}:${chosenFailure.ruleLine}`;
    }
    const ruleSite: { source: string; expression?: string } = { source: ruleSource };
    if (chosenFailure.ruleExpression !== undefined) {
      ruleSite.expression = chosenFailure.ruleExpression;
    }

    let severity: 'high' | 'medium' = 'medium';
    if (chosenFailure.certainty === 'static-proof') severity = 'high';
    const message =
      `Firestore ${scopeLabel} query on '${target.renderedPattern}' cannot be proven safe against ` +
      `${ruleSource}: ${chosenFailure.reason}.`;

    diagnostics.push({
      id,
      code: DIAGNOSTIC_CODE,
      service: 'firestore',
      resourceId,
      severity,
      certainty: chosenFailure.certainty,
      message,
      resource: candidate.baseRef.pattern,
      codeSite,
      ruleSite,
      witness: [chosenFailure.witnessArm],
      remediation: chosenFailure.remediation,
    });
  }

  return sortAssuranceDiagnostics(diagnostics);
}
