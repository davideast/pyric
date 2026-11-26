/**
 * Scenario selection, inert preview formatting, query-constraint mapping, and
 * metadata linkage helpers for `run-rules-rtdb.ts`.
 */
import {
  ALL_RULES_RTDB_DEPLOY_SCENARIOS,
  ALL_RULES_RTDB_SCENARIOS,
  RULES_RTDB_OBSERVATION_PREFIX,
  rtdbObservationName,
  type RtdbCaseQuery,
  type RtdbDeployScenario,
  type RtdbScenario,
} from '../rules-corpus/rtdb/index.ts';
import { orderDeployScenarios } from './rtdb-rules-deploy-run.ts';

/** The operation and deploy scenarios one run captures. */
export interface RtdbSelection {
  scenarios: RtdbScenario[];
  deployScenarios: RtdbDeployScenario[];
}

export interface ObservationLinkage {
  matrixRow: string;
  rowIds: string[];
}

/** One SDK query constraint: the `firebase/database` function name and its arguments. */
type QueryConstraintSpec =
  | ['orderByChild', string]
  | ['orderByKey']
  | ['orderByValue']
  | ['orderByPriority']
  | ['equalTo' | 'startAt' | 'endAt', string | number | boolean | null]
  | ['limitToFirst' | 'limitToLast', number];

function totalCases(scenarios: readonly RtdbScenario[]): number {
  return scenarios.reduce((n, scenario) => n + scenario.cases.length, 0);
}

/** The ids one `--scenario` or `--exclude-scenario` value names, comma-separated. */
function scenarioIdsOf(flag: string, value: string | undefined): string[] {
  const isMissing = !value || value.startsWith('--');
  if (isMissing) {
    throw new Error(`${flag} requires an id`);
  }
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => id === '')) {
    throw new Error(`${flag} requires an id between each comma`);
  }
  return ids;
}

interface ParsedScenarioFlags {
  included: Set<string>;
  excluded: Set<string>;
}

/** Parses `--scenario` and `--exclude-scenario` flags in either `--flag val` or `--flag=val` form. */
function parseScenarioFlags(args: readonly string[]): ParsedScenarioFlags {
  const cleaned = args.filter((arg) => arg !== '--write' && arg !== '--capture');
  const included = new Set<string>();
  const excluded = new Set<string>();
  for (let index = 0; index < cleaned.length; index += 1) {
    const arg = cleaned[index];
    if (!arg) {
      continue;
    }
    if (arg === '--scenario') {
      for (const id of scenarioIdsOf('--scenario', cleaned[index + 1])) {
        included.add(id);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--scenario=')) {
      for (const id of scenarioIdsOf('--scenario', arg.slice('--scenario='.length))) {
        included.add(id);
      }
      continue;
    }
    if (arg === '--exclude-scenario') {
      for (const id of scenarioIdsOf('--exclude-scenario', cleaned[index + 1])) {
        excluded.add(id);
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--exclude-scenario=')) {
      const raw = arg.slice('--exclude-scenario='.length);
      for (const id of scenarioIdsOf('--exclude-scenario', raw)) {
        excluded.add(id);
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { included, excluded };
}

/**
 * The scenarios `--scenario` names (or the whole corpus when absent), minus any
 * scenarios explicitly excluded via `--exclude-scenario`, in corpus order. Both
 * flags take comma-separated lists and may be repeated so one run can recapture
 * a chosen set (for example, all observed scenarios except r61) under one rules
 * snapshot.
 */
export function selectRtdbScenarios(args: readonly string[]): RtdbSelection {
  const { included, excluded } = parseScenarioFlags(args);
  if (included.size === 0 && excluded.size === 0) {
    return {
      scenarios: ALL_RULES_RTDB_SCENARIOS,
      deployScenarios: ALL_RULES_RTDB_DEPLOY_SCENARIOS,
    };
  }
  const known = new Set(
    [...ALL_RULES_RTDB_SCENARIOS, ...ALL_RULES_RTDB_DEPLOY_SCENARIOS].map((s) => s.id),
  );
  const unknown = [...included, ...excluded].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`unknown RTDB scenario: ${unknown.join(', ')}`);
  }

  let scenarios = ALL_RULES_RTDB_SCENARIOS;
  let deployScenarios = ALL_RULES_RTDB_DEPLOY_SCENARIOS;
  if (included.size > 0) {
    scenarios = scenarios.filter((scenario) => included.has(scenario.id));
    deployScenarios = deployScenarios.filter((scenario) => included.has(scenario.id));
  }
  if (excluded.size > 0) {
    scenarios = scenarios.filter((scenario) => !excluded.has(scenario.id));
    deployScenarios = deployScenarios.filter((scenario) => !excluded.has(scenario.id));
  }
  if (scenarios.length === 0 && deployScenarios.length === 0) {
    throw new Error('no RTDB scenarios remain after applying --exclude-scenario');
  }
  return { scenarios, deployScenarios };
}

export function observationLinkageOf(value: unknown): ObservationLinkage {
  if (!value || typeof value !== 'object') {
    return { matrixRow: '', rowIds: [] };
  }
  const record = value as Record<string, unknown>;
  let matrixRow = '';
  if (typeof record.matrixRow === 'string') {
    matrixRow = record.matrixRow;
  }
  let rowIds: string[] = [];
  if (Array.isArray(record.rowIds)) {
    rowIds = record.rowIds.filter((id): id is string => typeof id === 'string');
  }
  return { matrixRow, rowIds };
}

export function assertMatchingOracleProjects(
  config: { projectId: string },
  serviceAccount: { project_id: string },
): void {
  if (config.projectId !== serviceAccount.project_id) {
    throw new Error(
      `oracle project mismatch: Web config is ${config.projectId}, service account is ${serviceAccount.project_id}`,
    );
  }
}

/** The constraints a case query applies: ordering first, then range, then limits. */
export function queryConstraintsOf(query: RtdbCaseQuery): QueryConstraintSpec[] {
  const out: QueryConstraintSpec[] = [];
  if (query.orderByChild !== undefined) out.push(['orderByChild', query.orderByChild]);
  if (query.orderByKey) out.push(['orderByKey']);
  if (query.orderByValue) out.push(['orderByValue']);
  if (query.orderByPriority) out.push(['orderByPriority']);
  if (query.equalTo !== undefined) out.push(['equalTo', query.equalTo]);
  if (query.startAt !== undefined) out.push(['startAt', query.startAt]);
  if (query.endAt !== undefined) out.push(['endAt', query.endAt]);
  if (query.limitToFirst !== undefined) out.push(['limitToFirst', query.limitToFirst]);
  if (query.limitToLast !== undefined) out.push(['limitToLast', query.limitToLast]);
  return out;
}

/** Recursively substitute the `<UID>` token, mirroring the agreement probe. */
export function substituteUid<T>(v: T, uid: string): T {
  if (typeof v === 'string') return v.replaceAll('<UID>', uid) as unknown as T;
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((item) => substituteUid(item, uid)) as unknown as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k.replaceAll('<UID>', uid)] = substituteUid(val, uid);
    }
    return out as unknown as T;
  }
  return v;
}

function printDeployScenarios(deployScenarios: readonly RtdbDeployScenario[]): void {
  for (const scenario of deployScenarios) {
    let limit = '';
    if (scenario.largeRuleset) {
      limit = `, ${scenario.largeRuleset.timeoutMs / 1_000}s limit`;
    }
    console.log(
      `    - ${scenario.id.padEnd(28)} [${scenario.fm.padEnd(8)}] ` +
        `${String(scenario.deployCases.length).padStart(2)} rulesets${limit}, expects deploy verdict -> ${rtdbObservationName(scenario)}.json`,
    );
  }
}

export function printInertPlan(
  { scenarios, deployScenarios }: RtdbSelection,
  obsDir: string,
): void {
  console.log('[oracle:rules-rtdb] PYRIC_ORACLE_FIREBASE_CONFIG not set -- INERT preview, no network calls.\n');
  console.log('  Credential env vars expected:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG  (Web SDK config JSON with databaseURL + apiKey; gates capture)');
  console.log('    PYRIC_ORACLE_SA_PATH          (service-account JSON path for the rules-deploy admin token;');
  console.log('                                   unset, Application Default Credentials are used)');
  console.log('    PYRIC_ORACLE_PROJECT_ID       (the oracle project id, read when PYRIC_ORACLE_SA_PATH is unset)\n');
  console.log(`  Observation output directory: ${obsDir}`);
  console.log(`  Observation filename prefix:  ${RULES_RTDB_OBSERVATION_PREFIX}\n`);
  console.log('  Capture protocol: deploy -> execute ops on live RTDB -> restore rules + delete run data -> read-back verify both.');
  console.log('                    RTDB has no server-side rules test API, so production truth is observed by deploying real rules.');
  console.log('                    Clean run = rules canonical-JSON identical to the pre-run snapshot AND the run-scoped data');
  console.log('                    namespace absent from a shallow root read.\n');
  console.log(`  Would capture ${scenarios.length} scenario(s):`);
  for (const scenario of scenarios) {
    const pending = scenario.cases.filter((c) => c.pendingCapture).length;
    let pendingNote = '';
    if (pending > 0) {
      pendingNote = ` (${pending} pending-capture, excluded from replay)`;
    }
    console.log(
      `    - ${scenario.id.padEnd(28)} [${scenario.fm.padEnd(8)}] ` +
        `${String(scenario.cases.length).padStart(2)} cases${pendingNote} -> ${rtdbObservationName(scenario)}.json`,
    );
  }
  console.log(`\n  Total: ${scenarios.length} scenarios, ${totalCases(scenarios)} cases.`);
  const order = orderDeployScenarios(deployScenarios);
  console.log(`\n  Would dry-run ${deployScenarios.length} deploy scenario(s) (PUT /.settings/rules.json?dryRun=true, nothing deployed):`);
  printDeployScenarios(order.beforeOperations);
  if (order.afterOperations.length > 0) {
    console.log('\n  Then, after the operation scenarios, the large-ruleset deploy scenarios:');
    printDeployScenarios(order.afterOperations);
  }
  console.log('\n  To capture for real:');
  console.log('    PYRIC_ORACLE_FIREBASE_CONFIG="$(cat oracle-web-config.json)" \\');
  console.log('      PYRIC_ORACLE_PROJECT_ID=<oracle project id> \\');
  console.log('      bun run packages/conformance/src/run-rules-rtdb.ts --write \\');
  console.log('      [--scenario <id>[,<id>...]] [--exclude-scenario r61-deploy-regex-3000-groups]');
}
