/**
 * Under Node, the RTDB expression parser reads every `||` chain production deploys.
 *
 * Node's default stack holds far fewer recursive-descent frames than bun's.
 * The RTDB parser turns a stack overflow into PARSE_ERROR ("The expression
 * chains more terms than the rules parser reads."), so `lint()` reports an
 * error and `simulate()` returns UNSUPPORTED for a ruleset production deploys.
 * The bun test runner reads 2,000 terms, so the corpus replay in
 * `rules-conformance.test.ts` never sees it. This file runs the captured
 * rulesets in one real `node` child against the built `dist`, as the CLI and
 * the published package run them.
 *
 * Evidence: `rules-rtdb-r51-deploy-anchor-index-and-length-probes` (dry-run
 * deploy, 2026-10-26) records production ACCEPTING `.read` rules that chain
 * 500, 501 and 2,000 `auth.uid == 'u<n>'` terms.
 *
 * KNOWN_NODE_DIVERGENCES pins both sides of each case (finding LD-7, #1247).
 * The 2,000-term case is pinned exactly: no Node default stack reads it. Under
 * Node 24 the parser already fails at 499 terms, so the 500- and 501-term cases
 * sit near the stack boundary, and another Node version may read them; their
 * pins are `stackDependent` and accept either outcome. The fix removes each
 * pin, watches the 2,000-term case go red, then makes all three read as
 * production does: no lint error and an ALLOW for uid `u0`.
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

interface KnownNodeDivergence {
  finding: string;
  prodVerdict: 'ACCEPTED' | 'REJECTED';
  node: NodeOutcome;
  /** Near the default stack boundary: a Node whose stack reads the chain agrees with production. */
  stackDependent?: true;
}

const CHAINED_TERMS_PARSE_ERROR: NodeOutcome = { lintErrors: ['PARSE_ERROR'], decision: 'UNSUPPORTED' };

/** What production's ACCEPTED verdict means for Pyric's result in Node. */
const AGREES_WITH_ACCEPTED: NodeOutcome = { lintErrors: [], decision: 'ALLOW' };

/** Keyed by the r51 case description. */
const KNOWN_NODE_DIVERGENCES: Record<string, KnownNodeDivergence> = {
  'LD-7: a 2000-term || chain': { finding: 'LD-7', prodVerdict: 'ACCEPTED', node: CHAINED_TERMS_PARSE_ERROR },
  'LD-7: a 501-term || chain': {
    finding: 'LD-7', prodVerdict: 'ACCEPTED', node: CHAINED_TERMS_PARSE_ERROR, stackDependent: true,
  },
  'LD-7 control: a 500-term || chain': {
    finding: 'LD-7', prodVerdict: 'ACCEPTED', node: CHAINED_TERMS_PARSE_ERROR, stackDependent: true,
  },
};

const NODE_PROBES_TIMEOUT_MS = 30_000;
const NODE_SPAWN_TIMEOUT_MS = NODE_PROBES_TIMEOUT_MS - 2_000;

/** Lints and simulates each ruleset in one node child; the read case signs in as uid `u0`. */
function runInNode(rulesets: string[]): NodeOutcome[] {
  const script = `
    const { rtdbRules } = await import(${JSON.stringify(pathToFileURL(rulesDist).href)});
    const rulesets = JSON.parse(process.argv[1]);
    const outcomes = rulesets.map((source) => {
      const built = rtdbRules({ rules: JSON.parse(source) });
      const lintErrors = built.lint().filter((issue) => issue.severity === 'error').map((issue) => issue.code);
      const [result] = built.simulate([
        { expectation: 'ALLOW', operation: 'read', path: '/a', auth: { uid: 'u0', token: {} } },
      ]).cases;
      return { lintErrors, decision: result.decision };
    });
    process.stdout.write(JSON.stringify(outcomes));
  `;
  const res = spawnSync('node', ['--input-type=module', '--eval', script, JSON.stringify(rulesets)], {
    encoding: 'utf8',
    timeout: NODE_SPAWN_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`node exited ${res.status} (signal ${res.signal}${res.error ? `, ${res.error.message}` : ''}): ${res.stderr}`);
  }
  try {
    return JSON.parse(res.stdout) as NodeOutcome[];
  } catch (e) {
    throw new Error(`node wrote ${Buffer.byteLength(res.stdout)} bytes that are not JSON (${(e as Error).message}): ${res.stdout.slice(0, 200)}`);
  }
}

let outcomes: NodeOutcome[];
let recorded: Record<string, { verdict?: string }>;
beforeAll(() => {
  if (!existsSync(rulesDist)) throw new Error(`dist/rules/index.js missing, run \`bun run build\` first (${rulesDist})`);
  recorded = (JSON.parse(readFileSync(observationPath, 'utf8')) as { behavior: Record<string, { verdict?: string }> }).behavior;
  outcomes = runInNode(CHAIN_CASES.map((deployCase) => deployCase.rules));
}, NODE_PROBES_TIMEOUT_MS);

describe('RTDB rules under Node: || chains production deploys (r51)', () => {
  test('every pin names an r51 chain case', () => {
    const descriptions = new Set(CHAIN_CASES.map((deployCase) => deployCase.description));
    const unknownPins = Object.keys(KNOWN_NODE_DIVERGENCES).filter((key) => !descriptions.has(key));
    expect(unknownPins).toEqual([]);
    expect(CHAIN_CASES.length).toBe(3);
  });

  for (const [index, deployCase] of CHAIN_CASES.entries()) {
    test(deployCase.description, () => {
      const outcome = outcomes[index]!;
      const verdict = recorded[deployCase.description]?.verdict;
      const known = KNOWN_NODE_DIVERGENCES[deployCase.description];
      if (!known) {
        expect(verdict).toBe('ACCEPTED');
        expect(outcome).toEqual(AGREES_WITH_ACCEPTED);
        return;
      }
      expect(verdict, `${known.finding} (recorded production verdict)`).toBe(known.prodVerdict);
      const allowed = known.stackDependent ? [known.node, AGREES_WITH_ACCEPTED] : [known.node];
      expect(allowed, `${known.finding} (Node lint and simulate)`).toContainEqual(outcome);
    });
  }
});
