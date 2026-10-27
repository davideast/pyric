/**
 * Under Node, the RTDB expression parser reads every `||` chain production deploys.
 *
 * Node's default stack holds far fewer recursive-descent frames than bun's.
 * Before `||` and `&&` chains matched flat, every semantics pass descended
 * once per term, and a fresh Node process (22 and 24 alike) overflowed at
 * 499 terms; the parser turned that into PARSE_ERROR ("The expression chains
 * more terms than the rules parser reads."), so `lint()` reported an error
 * and `simulate()` returned UNSUPPORTED for a ruleset production deploys
 * (finding LD-7, #1247). Whether 500 or 501 terms overflowed in a process
 * that had already run other cases depended on JIT warm-up and case order,
 * so each case here runs in its own fresh `node` child. The bun test runner
 * reads 2,000 terms either way, so the corpus replay in
 * `rules-conformance.test.ts` never saw it. Each child runs against the built
 * `dist`, as the CLI and the published package run them.
 *
 * Evidence: `rules-rtdb-r51-deploy-anchor-index-and-length-probes` (dry-run
 * deploy, 2026-10-26) records production ACCEPTING `.read` rules that chain
 * 500, 501 and 2,000 `auth.uid == 'u<n>'` terms. Each case must agree:
 * no lint error and an ALLOW for uid `u0`.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALL_RULES_RTDB_DEPLOY_SCENARIOS } from '../../../../conformance/rules-corpus/rtdb/index.ts';

const R51_ID = 'r51-deploy-anchor-index-and-length-probes';
const pyricRoot = resolve(import.meta.dir, '../../..');
const rulesDist = join(pyricRoot, 'dist/rules/index.js');
const observationPath = resolve(pyricRoot, `../conformance/observations/rtdb-rules/rules-rtdb-${R51_ID}.json`);

/** The r51 deploy cases that chain `||` terms. */
const CHAIN_CASES = (ALL_RULES_RTDB_DEPLOY_SCENARIOS.find((scenario) => scenario.id === R51_ID)?.deployCases ?? [])
  .filter((deployCase) => deployCase.construct === 'rtdb.operator.or');

interface NodeOutcome {
  lintErrors: string[];
  decision: string;
}

/** What production's ACCEPTED verdict means for Pyric's result in Node. */
const AGREES_WITH_ACCEPTED: NodeOutcome = { lintErrors: [], decision: 'ALLOW' };

const NODE_PROBES_TIMEOUT_MS = 60_000;
const NODE_SPAWN_TIMEOUT_MS = 18_000;

/** Lints and simulates one ruleset in a fresh node child; the read case signs in as uid `u0`. */
function runInNode(ruleset: string): NodeOutcome {
  const script = `
    const { rtdbRules } = await import(${JSON.stringify(pathToFileURL(rulesDist).href)});
    const built = rtdbRules({ rules: JSON.parse(process.argv[1]) });
    const lintErrors = built.lint().filter((issue) => issue.severity === 'error').map((issue) => issue.code);
    const [result] = built.simulate([
      { expectation: 'ALLOW', operation: 'read', path: '/a', auth: { uid: 'u0', token: {} } },
    ]).cases;
    process.stdout.write(JSON.stringify({ lintErrors, decision: result.decision }));
  `;
  const res = spawnSync('node', ['--input-type=module', '--eval', script, ruleset], {
    encoding: 'utf8',
    timeout: NODE_SPAWN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`node exited ${res.status} (signal ${res.signal}${res.error ? `, ${res.error.message}` : ''}): ${res.stderr}`);
  }
  try {
    return JSON.parse(res.stdout) as NodeOutcome;
  } catch (e) {
    throw new Error(`node wrote ${Buffer.byteLength(res.stdout)} bytes that are not JSON (${(e as Error).message}): ${res.stdout.slice(0, 200)}`);
  }
}

let outcomes: NodeOutcome[];
let recorded: Record<string, { verdict?: string }>;
beforeAll(() => {
  if (!existsSync(rulesDist)) throw new Error(`dist/rules/index.js missing, run \`bun run build\` first (${rulesDist})`);
  recorded = (JSON.parse(readFileSync(observationPath, 'utf8')) as { behavior: Record<string, { verdict?: string }> }).behavior;
  outcomes = CHAIN_CASES.map((deployCase) => runInNode(deployCase.rules));
}, NODE_PROBES_TIMEOUT_MS);

describe('RTDB rules under Node: || chains production deploys (r51)', () => {
  test('r51 holds the three chain cases', () => {
    expect(CHAIN_CASES.length).toBe(3);
  });

  for (const [index, deployCase] of CHAIN_CASES.entries()) {
    test(deployCase.description, () => {
      expect(recorded[deployCase.description]?.verdict, 'recorded production verdict').toBe('ACCEPTED');
      expect(outcomes[index], 'Node lint and simulate').toEqual(AGREES_WITH_ACCEPTED);
    });
  }

  // rules-diff canonicalizes both sides of a changed rule. A chain that lints
  // and simulates must canonicalize too, or two equivalent rules read as a change.
  test('canonical form reads an 18,000-term chain compared with ==', () => {
    const canonicalDist = join(pyricRoot, 'dist/rules/rtdb/grammar/canonical.js');
    const script = `
      const { canonicalRtdbExpression } = await import(${JSON.stringify(pathToFileURL(canonicalDist).href)});
      const operand = '(' + Array.from({ length: 18000 }, () => 'f').join(' || ') + ')';
      const a = canonicalRtdbExpression(operand + ' == true');
      process.stdout.write(String(a === canonicalRtdbExpression('true == ' + operand)));
    `;
    const res = spawnSync('node', ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: NODE_SPAWN_TIMEOUT_MS });
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('true');
  }, NODE_PROBES_TIMEOUT_MS);
});
