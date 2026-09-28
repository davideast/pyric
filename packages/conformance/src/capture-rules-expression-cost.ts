#!/usr/bin/env bun
/**
 * Capture production Security Rules evaluation cost for the expression-cost
 * suites and write the fixture the linter's EXPRESSION_BUDGET test reads.
 *
 * For every case this records:
 *  - production.decision, notes and the granting rule, from the Rules Test API
 *    with `expressionReportLevel: 'VISITED'` and no padding;
 *  - production.reported: the evaluations the API's `expressionReports` list
 *    (their `values` counts, excluding the `||invalid_argument||` placeholder
 *    reported for operands a short-circuit skipped). The API omits literals
 *    from these reports and repeats earlier rules' counts for each later rule,
 *    so this number is recorded for comparison, not used as the cost;
 *  - production.cost: bounds on the count production's 1000-expression limit
 *    uses, measured by padding (see `rules-expression-cost-pad.ts`). A case
 *    that reaches the limit without padding has `{ low: 1000, high: null }`;
 *  - simulator: the decision, granting rule and `evaluatedExpressions`, the
 *    count Pyric's simulator enforces the same limit with.
 *
 * Output: packages/pyric/test/rules/linter/fixtures/expression-cost/
 *   captures.json and one `<suite>.rules` per suite.
 *
 * Credentials: the same contract as the Firestore rules oracle
 * (`run-rules.ts`): PARITY_SA_BASE64, PARITY_SA_PATH, or a firebase-tools
 * login with PARITY_PROJECT_ID. The caller needs `firebaserules.rulesets.test`.
 * The Rules Test API evaluates the submitted ruleset without deploying it.
 *
 * Usage:
 *   bun run packages/conformance/src/capture-rules-expression-cost.ts
 *     [--suite ladder,chess,arcade]   recapture only these suites, reusing the
 *                                     stored padding anchors
 *     [--reports]                     refresh the unpadded production fields and
 *                                     the simulator fields, keeping stored thresholds
 *   PYRIC_ARCADE_RULES=/path/to/firestore.rules adds the arcade suite.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectScope } from '../../pyric/src/project-scope.ts';
import type { MatchBlock } from '../../pyric/src/rules/grammar/FirestoreAST.ts';
import { parseToAST } from '../../pyric/src/rules/grammar/FirestoreParser.ts';
import type { TestCase } from '../../pyric/src/rules/test/spec.ts';
import {
  EXPRESSION_LIMIT,
  PAD_MAX,
  PAD_SECOND_TOKEN,
  PAD_TOKEN,
  anchorRules,
  costBounds,
  fitPadCost,
  injectPadding,
  isLimitMessage,
  nextCandidates,
  observe,
  type PadAnchor,
  type Threshold,
} from './rules-expression-cost-pad.ts';
import {
  REPO_ROOT,
  expressionCostSuites,
  type ExpressionCostCase,
  type ExpressionCostSuite,
} from './rules-expression-cost-suites.ts';

const FIXTURE_DIR = join(REPO_ROOT, 'packages', 'pyric', 'test', 'rules', 'linter', 'fixtures', 'expression-cost');
const CAPTURES = join(FIXTURE_DIR, 'captures.json');
const POINTS_PER_ROUND = 5;
const MAX_ROUNDS = 8;
const MAX_REQUEST_BYTES = 600_000;
const ATTEMPTS = 4;
const PLACEHOLDER = '||invalid_argument||';

interface ReportNode {
  values?: { value?: unknown; count?: number }[];
  children?: ReportNode[];
}

/** Sum of evaluated-expression counts in an ExpressionReport tree. */
function reportedEvaluations(reports: readonly ReportNode[] | undefined): number {
  let total = 0;
  for (const node of reports ?? []) {
    for (const v of node.values ?? []) if (v.value !== PLACEHOLDER) total += v.count ?? 0;
    total += reportedEvaluations(node.children);
  }
  return total;
}

/** A rule named by its block's authored path and its position among the block's allows. */
interface RuleRef { matchPath: string; index: number }

/** The allow rule whose `allow` keyword is on `line`, or null. */
function ruleAtLine(rules: string, line: number): RuleRef | null {
  const ast = parseToAST(rules);
  if (!ast) return null;
  const visit = (block: MatchBlock): RuleRef | null => {
    const index = block.allows.findIndex((a) => a.loc?.line === line);
    if (index >= 0) return { matchPath: block.path.raw, index };
    for (const child of block.children) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(ast.service.match);
}

type Handler = { execute: (scope: ProjectScope, source: string, cases: TestCase[], opts?: { expressionReportLevel?: 'VISITED' }) => Promise<any> };
type Simulate = (source: string, cases: TestCase[], opts: unknown) => any;

async function runCases(handler: Handler, scope: ProjectScope, rules: string, cases: TestCase[], opts?: { expressionReportLevel?: 'VISITED' }) {
  const chunks: TestCase[][] = [];
  let current: TestCase[] = [];
  let bytes = 0;
  for (const tc of cases) {
    const size = JSON.stringify(tc).length;
    if (current.length > 0 && bytes + size > MAX_REQUEST_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(tc);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  const results: any[] = [];
  for (const chunk of chunks) {
    let res: any;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      res = await handler.execute(scope, rules, chunk, opts);
      // The API answers 500 and 503 transiently; retry those with backoff.
      const transient = !res.success && / (500|503) /.test(res.error.message);
      if (!transient || attempt === ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
    if (!res.success) throw new Error(`Rules Test API failed: ${res.error.code} ${res.error.message}`);
    results.push(...res.data.results);
  }
  return results;
}

function withMocks(suite: ExpressionCostSuite, tc: TestCase): TestCase {
  if (!tc.functionMocks) return tc;
  return {
    ...tc,
    functionMocks: tc.functionMocks.map((m) => (suite.documents[m.path] ? { ...m, result: suite.documents[m.path]!.data } : m)),
  };
}

/** The stored form of a case: document mocks name the document instead of embedding it. */
function storedTestCase(suite: ExpressionCostSuite, tc: TestCase): TestCase {
  if (!tc.functionMocks) return tc;
  return {
    ...tc,
    functionMocks: tc.functionMocks.map((m) => (suite.documents[m.path] ? { ...m, result: { $document: m.path } } : m)),
  };
}

function withPad(tc: TestCase, n: number, extra: Record<string, unknown> = {}): TestCase {
  const auth = tc.auth ?? { uid: 'pyric-pad' };
  return {
    ...tc,
    description: `${tc.description} [pad ${n}]`,
    auth: { ...auth, token: { ...(auth.token ?? {}), [PAD_TOKEN]: n, ...extra } },
  };
}

/** Resolve thresholds for a set of probes that share one ruleset. */
async function thresholds(
  handler: Handler,
  scope: ProjectScope,
  rules: string,
  probes: { testCase: TestCase; predicted?: number; extraToken?: Record<string, unknown> }[],
): Promise<{ thresholds: Threshold[]; cases: number }> {
  const state: Threshold[] = probes.map(() => ({ below: -1, at: PAD_MAX + 1 }));
  let sent = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const batch: { probe: number; n: number }[] = [];
    probes.forEach((p, i) => {
      for (const n of nextCandidates(state[i]!, POINTS_PER_ROUND, round === 0 ? p.predicted : undefined)) batch.push({ probe: i, n });
    });
    if (batch.length === 0) break;
    const cases = batch.map(({ probe, n }) => withPad(probes[probe]!.testCase, n, probes[probe]!.extraToken));
    const results = await runCases(handler, scope, rules, cases);
    sent += cases.length;
    results.forEach((r, k) => {
      const { probe, n } = batch[k]!;
      state[probe] = observe(state[probe]!, n, isLimitMessage(r.notes));
    });
  }
  return { thresholds: state, cases: sent };
}

function simulatorRecord(suite: ExpressionCostSuite, tc: TestCase, simulate: Simulate) {
  const res = simulate(suite.rules, [tc], {
    getDoc: (path: string) => suite.documents[path.replace(/^\/+/, '')]?.data ?? null,
  });
  if (!res.success) throw new Error(`simulator failed: ${res.error.message}`);
  const result = res.data.results[0];
  const evaluated = result.evaluatedExpressions as number;
  const granted = result.trace.find((t: any) => t.verdict === 'ALLOW');
  const grantingRule: RuleRef | null = granted ? { matchPath: granted.matchPath, index: granted.ruleIndex } : null;
  return { decision: result.decision as string, grantingRule, evaluated };
}

function productionRecord(suite: ExpressionCostSuite, report: any, threshold: Threshold, pad: ReturnType<typeof fitPadCost>) {
  const visited = (report.api?.visitedExpressions ?? []) as { sourcePosition?: { line?: number }; value?: unknown }[];
  const line = visited.find((v) => v.value === true)?.sourcePosition?.line;
  const limitReached = isLimitMessage(report.notes);
  return {
    decision: report.decision as string,
    notes: report.notes as string[],
    grantingRule: line === undefined ? null : ruleAtLine(suite.rules, line),
    limitReached,
    reported: reportedEvaluations(report.api?.expressionReports),
    threshold,
    cost: limitReached ? { low: EXPRESSION_LIMIT, high: null } : costBounds(pad, threshold),
  };
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function suiteHeader(suite: ExpressionCostSuite) {
  return {
    id: suite.id,
    description: suite.description,
    rulesFile: `${suite.id}.rules`,
    rulesSha256: sha256(suite.rules),
    documents: Object.fromEntries(Object.entries(suite.documents).map(([path, d]) => [path, { file: d.file, sha256: sha256(readFileSync(join(REPO_ROOT, d.file), 'utf8')) }])),
  };
}

async function tools() {
  const { parityScope } = await import('../../pyric/test/rules/parity/harness.ts');
  const { TestFirestoreRulesHandler } = await import('../../pyric/src/rules/test/handler.ts');
  const { SimulateFirestoreRulesHandler } = await import('../../pyric/src/rules/simulator/handler.ts');
  const simulator = new SimulateFirestoreRulesHandler();
  return {
    scope: parityScope() as ProjectScope,
    handler: new TestFirestoreRulesHandler() as Handler,
    simulate: simulator.simulate.bind(simulator) as Simulate,
  };
}

function printRow(row: any) {
  const c = row.production.cost;
  console.log(`  ${row.id.padEnd(28)} ${row.production.decision.padEnd(5)} cost ${c ? `${c.low}..${c.high ?? '-'}` : 'unbounded'}  simulator ${row.simulator.evaluated}`);
}

async function measureAnchors(handler: Handler, scope: ProjectScope): Promise<{ anchors: PadAnchor[]; cases: number }> {
  const anchorBase: TestCase = {
    description: 'anchor', expectation: 'DENY', method: 'get', path: 'anchor-false/x', auth: { uid: 'pyric-pad' },
  };
  // Second-padding lengths vary the segment count of the pair, which keeps
  // the three model terms separately identifiable.
  const seconds = [null, 0, 39, 100, 119, 159] as const;
  const probes = seconds.map((second) => ({
    testCase: { ...anchorBase, description: `anchor second=${second}`, path: second === null ? 'anchor-false/x' : 'anchor-pad/x' },
    predicted: second === null ? 195 : 194 - second,
    extraToken: second === null ? {} : { [PAD_SECOND_TOKEN]: second },
  }));
  const measured = await thresholds(handler, scope, anchorRules(), probes);
  return { anchors: seconds.map((second, i) => ({ second, threshold: measured.thresholds[i]! })), cases: measured.cases };
}

async function capture(options: { selected: string[] | null; reportsOnly: boolean }): Promise<void> {
  const { scope, handler, simulate } = await tools();
  let totalCases = 0;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const previous = existsSync(CAPTURES) ? JSON.parse(readFileSync(CAPTURES, 'utf8')) : null;
  if (options.reportsOnly && !previous) throw new Error('--reports needs an existing captures.json');

  // 1. The padding model. A partial recapture reuses the stored anchors so
  // every suite in the fixture shares one model.
  let padAnchors: PadAnchor[];
  if ((options.selected || options.reportsOnly) && previous?.padding?.anchors) {
    padAnchors = previous.padding.anchors;
  } else {
    const measured = await measureAnchors(handler, scope);
    padAnchors = measured.anchors;
    totalCases += measured.cases;
  }
  const pad = fitPadCost(padAnchors);
  console.log(`[expression-cost] padding model ${JSON.stringify(pad)}`);

  // 2. The suites.
  const suites = expressionCostSuites({ arcadeRules: process.env.PYRIC_ARCADE_RULES })
    .filter((s) => !options.selected || options.selected.includes(s.id))
    .filter((s) => !options.reportsOnly || previous.suites.some((p: any) => p.id === s.id));
  const records: any[] = (previous?.suites ?? []).filter((p: any) => !suites.some((s) => s.id === p.id));

  for (const suite of suites) {
    const cases = suite.cases.map((c: ExpressionCostCase) => ({ ...c, testCase: withMocks(suite, c.testCase) }));
    const reports = await runCases(handler, scope, suite.rules, cases.map((c) => c.testCase), { expressionReportLevel: 'VISITED' });
    totalCases += cases.length;
    const sims = cases.map((c) => simulatorRecord(suite, c.testCase, simulate));
    let stored: Threshold[];
    if (options.reportsOnly) {
      const prior = previous.suites.find((p: any) => p.id === suite.id);
      if (prior.rulesSha256 !== sha256(suite.rules)) throw new Error(`${suite.id}: ruleset changed since its thresholds were measured`);
      stored = cases.map((c) => {
        const row = prior.cases.find((r: any) => r.id === c.id);
        if (!row) throw new Error(`${c.id}: no stored threshold`);
        return row.production.threshold;
      });
    } else {
      const padded = injectPadding(suite.rules, cases.map((c) => ({ anchor: c.padAnchor, method: c.testCase.method })));
      const predictedStep = (cost: number) => Math.round((EXPRESSION_LIMIT - cost - pad.base) / pad.perStep) - 1;
      const measured = await thresholds(handler, scope, padded, cases.map((c, i) => ({
        testCase: c.testCase,
        predicted: Math.max(0, Math.min(PAD_MAX, predictedStep(sims[i]!.evaluated))),
      })));
      totalCases += measured.cases;
      stored = measured.thresholds;
    }
    writeFileSync(join(FIXTURE_DIR, `${suite.id}.rules`), suite.rules);
    const rows = cases.map((c, i) => ({
      id: c.id,
      description: c.testCase.description,
      block: c.padAnchor.replace(/^match\s+/, '').replace(/\s*\{$/, ''),
      pathFixed: c.pathFixed,
      testCase: storedTestCase(suite, c.testCase),
      production: productionRecord(suite, reports[i], stored[i]!, pad),
      simulator: sims[i],
    }));
    rows.forEach(printRow);
    records.push({ ...suiteHeader(suite), cases: rows });
  }

  // The `reversi` suite is not generated here: its request and threshold
  // come from the arcade's own measurement and are kept from the stored
  // fixture like any suite this run does not select.
  const order = ['ladder', 'chess', 'arcade', 'reversi'];
  records.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const fixture = {
    schema: 'pyric.rules-expression-cost.v1',
    limit: EXPRESSION_LIMIT,
    capturedAt: new Date().toISOString(),
    projectId: scope.projectId,
    padding: { model: pad, anchors: padAnchors },
    suites: records,
  };
  writeFileSync(CAPTURES, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`[expression-cost] ${totalCases} Rules Test API test cases; wrote ${CAPTURES}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--suite');
  const selected = i >= 0 ? args[i + 1]!.split(',') : null;
  if (!process.env.PARITY_SA_BASE64 && process.env.PARITY_SA_PATH) {
    process.env.PARITY_SA_BASE64 = Buffer.from(readFileSync(process.env.PARITY_SA_PATH)).toString('base64');
  }
  await capture({ selected, reportsOnly: args.includes('--reports') });
}
