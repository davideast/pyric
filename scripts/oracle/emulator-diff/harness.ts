#!/usr/bin/env bun
/**
 * Emulator-diff harness (T0-5) — the no-secret prod oracle for disputed
 * Firestore-rules semantics.
 *
 * For every case in ./corpus.ts it computes a verdict three ways:
 *
 *   1. PYRIC   — packages/pyric's local SimulateFirestoreRulesHandler.
 *   2. EMULATOR — the Firebase emulator's rules engine (same evaluator as
 *      production), when reachable. The emulator needs NO secret and is
 *      deterministic, so this is the oracle the behavior tracks confirm
 *      disputed semantics against (plan section 2, STOP section 5.4).
 *   3. EXPECTED — the documented prod verdict from the corpus
 *      (`expectedProd`), cited to the ledger / upstream clone.
 *
 * It then diffs:
 *   - PYRIC vs ORACLE, where ORACLE = EMULATOR if reachable, else EXPECTED.
 *   - EMULATOR vs EXPECTED (when the emulator is up) — flags any case whose
 *     documented prod value disagrees with the live emulator, so the corpus
 *     itself stays honest.
 *
 * The harness EXITS NON-ZERO when pyric disagrees with the oracle — i.e.
 * the RULES-B* bugs are still present. That is the intended state today
 * (run it pre-fix to see the failing set); a track flips a row green by
 * fixing the evaluator, at which point its case disappears from the diff.
 * Pass `--expect-known-bugs` to invert: pass while the known divergences
 * are still present, fail once they unexpectedly vanish or change shape
 * (useful as a regression guard before the fixes land).
 *
 * Reaching the emulator
 * ---------------------
 * No Firebase CLI is bundled here. Point the harness at a running rules
 * test endpoint (the local emulator, or the live Rules Test API) via:
 *   --oracle-url=<url>      POST <url> a {source,testSuite} payload, get
 *                           back Google's testResults[] shape.
 *   --oracle-token=<tok>    Bearer token (live API only; emulator needs none).
 * or env FIRESTORE_RULES_TEST_URL / FIRESTORE_RULES_TEST_TOKEN.
 *
 * With the Firebase CLI installed the canonical local recipe is:
 *   firebase emulators:exec --only firestore \
 *     'bun run scripts/oracle/emulator-diff/harness.ts --oracle-url=http://127.0.0.1:8080/...'
 * (the emulator exposes the same firebaserules :test contract locally).
 *
 * Usage:
 *   bun run scripts/oracle/emulator-diff/harness.ts            # sim vs documented prod
 *   bun run scripts/oracle/emulator-diff/harness.ts --oracle-url=...   # sim vs emulator
 *   bun run scripts/oracle/emulator-diff/harness.ts --json
 *   bun run scripts/oracle/emulator-diff/harness.ts --expect-known-bugs
 */
import { SimulateFirestoreRulesHandler } from '../../../packages/pyric/src/rules/index.ts';
import { buildApiTestCase } from '../../../packages/pyric/src/rules/test/spec.ts';
import { CORPUS, type CorpusCase } from './corpus.ts';

type Verdict = 'ALLOW' | 'DENY' | 'UNSUPPORTED' | 'ERROR' | 'PARSE_FAILED';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.some((a) => a === `--${name}`);
const opt = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const ORACLE_URL = opt('oracle-url') ?? process.env.FIRESTORE_RULES_TEST_URL;
const ORACLE_TOKEN = opt('oracle-token') ?? process.env.FIRESTORE_RULES_TEST_TOKEN;
const WANT_JSON = flag('json');
const EXPECT_KNOWN_BUGS = flag('expect-known-bugs');

// ── pyric local simulator ────────────────────────────────────────────
const sim = new SimulateFirestoreRulesHandler();

function pyricVerdict(c: CorpusCase): Verdict {
  const res = sim.simulate(c.rules, [c.testCase]);
  if (!res.success) return 'PARSE_FAILED';
  const r = res.data.results[0];
  return r?.decision ?? 'ERROR';
}

// ── emulator / live Rules Test API ───────────────────────────────────
interface OracleResult { verdict: Verdict; raw?: unknown }

async function oracleVerdict(c: CorpusCase): Promise<OracleResult | null> {
  if (!ORACLE_URL) return null; // emulator not wired — caller falls back to expectedProd
  const apiCase = buildApiTestCase(c.testCase);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ORACLE_TOKEN) headers.Authorization = `Bearer ${ORACLE_TOKEN}`;
  const res = await fetch(ORACLE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source: { files: [{ name: 'firestore.rules', content: c.rules }] },
      testSuite: { testCases: [apiCase] },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`oracle ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { testResults?: Array<{ state: 'SUCCESS' | 'FAILURE' }> };
  const state = data.testResults?.[0]?.state;
  // The :test contract returns SUCCESS when the engine's verdict matched
  // the case's `expectation`. We sent expectation = expectedProd, so
  // SUCCESS ⇒ emulator agreed with expectedProd, FAILURE ⇒ it returned the
  // opposite. Recover the absolute verdict.
  const opposite = (v: 'ALLOW' | 'DENY'): Verdict => (v === 'ALLOW' ? 'DENY' : 'ALLOW');
  const verdict: Verdict = state === 'SUCCESS' ? c.testCase.expectation : opposite(c.testCase.expectation);
  return { verdict, raw: data.testResults?.[0] };
}

// ── run ──────────────────────────────────────────────────────────────
interface Row {
  id: string;
  finding: string;
  describe: string;
  pyric: Verdict;
  emulator: Verdict | null;
  expectedProd: Verdict;
  oracle: Verdict; // emulator if present else expectedProd
  oracleSource: 'emulator' | 'documented';
  pyricMatchesOracle: boolean;
  emulatorMatchesExpected: boolean | null;
}

async function run(): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of CORPUS) {
    const pyric = pyricVerdict(c);
    let emulator: Verdict | null = null;
    try {
      const o = await oracleVerdict(c);
      emulator = o?.verdict ?? null;
    } catch (e) {
      console.error(`! oracle call failed for ${c.id}: ${(e as Error).message}`);
      emulator = null;
    }
    const oracle: Verdict = emulator ?? c.expectedProd;
    rows.push({
      id: c.id,
      finding: c.finding,
      describe: c.describe,
      pyric,
      emulator,
      expectedProd: c.expectedProd,
      oracle,
      oracleSource: emulator ? 'emulator' : 'documented',
      pyricMatchesOracle: pyric === oracle,
      emulatorMatchesExpected: emulator ? emulator === c.expectedProd : null,
    });
  }
  return rows;
}

const rows = await run();
const diverged = rows.filter((r) => !r.pyricMatchesOracle);
const corpusDrift = rows.filter((r) => r.emulatorMatchesExpected === false);
const usingEmulator = rows.some((r) => r.oracleSource === 'emulator');

if (WANT_JSON) {
  console.log(JSON.stringify({ usingEmulator, rows, diverged: diverged.map((r) => r.id), corpusDrift: corpusDrift.map((r) => r.id) }, null, 2));
} else {
  console.log('# Emulator-diff harness — disputed Firestore-rules semantics\n');
  console.log(`Oracle source: ${usingEmulator ? 'Firebase emulator (live)' : 'documented expectedProd (emulator not wired — pass --oracle-url=<emulator endpoint> for live confirmation)'}`);
  console.log(`Cases: ${rows.length}   pyric≠oracle: ${diverged.length}` + (usingEmulator ? `   emulator≠documented: ${corpusDrift.length}` : '') + '\n');
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad('finding', 10)} ${pad('pyric', 7)} ${pad('oracle', 7)} ${pad('src', 11)} case`);
  console.log('─'.repeat(72));
  for (const r of rows) {
    const mark = r.pyricMatchesOracle ? ' ' : '✗';
    console.log(`${mark}${pad(r.finding, 9)} ${pad(r.pyric, 7)} ${pad(r.oracle, 7)} ${pad(r.oracleSource, 11)} ${r.id}`);
  }
  console.log();
  if (diverged.length > 0) {
    console.log('## Divergences (pyric ≠ oracle)\n');
    for (const r of diverged) {
      console.log(`- **${r.finding}** ${r.id}: pyric=${r.pyric}, prod=${r.oracle} (${r.oracleSource})`);
      console.log(`  ${r.describe}`);
    }
    console.log();
  }
  if (corpusDrift.length > 0) {
    console.log('## ⚠ Corpus drift (emulator ≠ documented expectedProd) — fix corpus.ts\n');
    for (const r of corpusDrift) {
      console.log(`- ${r.id}: emulator=${r.emulator}, corpus expectedProd=${r.expectedProd}`);
    }
    console.log();
  }
}

// Exit policy.
// - corpus drift (emulator contradicts our documented value) is ALWAYS a
//   failure: the oracle disagreeing with the corpus invalidates the harness.
// - otherwise, default mode fails when pyric diverges from the oracle (the
//   bugs are present); --expect-known-bugs inverts that so the harness can
//   serve as a pre-fix regression guard.
if (corpusDrift.length > 0) process.exit(2);
if (EXPECT_KNOWN_BUGS) {
  // Pass while the seeded divergences are still present. Fail if a case
  // that is SUPPOSED to diverge (expectDivergence !== false) has converged —
  // that means a fix landed and the corpus/expectation needs updating.
  // Cases marked expectDivergence:false (regression anchors that already
  // match prod) are excluded from the alarm.
  const byId = new Map(CORPUS.map((c) => [c.id, c]));
  const converged = rows.filter(
    (r) => r.pyricMatchesOracle && byId.get(r.id)?.expectDivergence !== false,
  );
  if (converged.length > 0) {
    console.error(`\n${converged.length} case(s) now AGREE with the oracle — a fix landed; update the corpus/expectation:`);
    for (const r of converged) console.error(`  - ${r.finding} ${r.id}`);
    process.exit(1);
  }
  process.exit(0);
}
process.exit(diverged.length > 0 ? 1 : 0);
