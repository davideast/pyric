#!/usr/bin/env bun
/**
 * Rules-language PRODUCTION ACCEPTANCE probe (issue #185, step 5, firestore +
 * storage arms only).
 *
 * The capability probe (rules-language-capability.ts, step 3) asks "does
 * pyric's OWN evaluator implement this construct?" against the local
 * simulator. This script asks a different, stronger question for every
 * firestore/storage construct: "does PRODUCTION agree the construct is real
 * rules-language surface?" — by submitting a minimal ruleset exercising the
 * construct through the SAME `TestFirestoreRulesHandler` / `TestStorageRulesHandler`
 * the scenario runners (run-rules.ts / run-rules-storage.ts) use against the
 * live Firebase Rules Test API. That API is side-effect-free: it
 * validates/evaluates a ruleset server-side and returns a verdict; it never
 * deploys anything.
 *
 * REUSE: the micro-scenario GENERATOR is the capability probe's own
 * `fsProbeFor` / `stProbeFor` (exported from rules-language-capability.ts for
 * exactly this reuse) resolved to a wire request via `resolveFsProbe` /
 * `resolveStProbe`. One generator, two backends — the local simulator and
 * production see the identical ruleset + case for a given construct.
 *
 * TWO PROBE MODES per (probeable) construct:
 *   - ACCEPTANCE  — does production parse/accept a ruleset using the
 *                   construct? A REJECTED ruleset (the API returns issues /
 *                   RULES_ERROR / INVALID_REQUEST) marks the construct
 *                   `rejected`, carrying the server's own message in
 *                   `probeNote`. This is the headline finding: the snapshot
 *                   claimed the construct was real language surface, and
 *                   production disagrees.
 *   - EVALUATION  — for constructs whose micro-scenario is a tautology
 *                   designed to hold (i.e., ALLOW is expected — the sole
 *                   documented exception is `storage.semantic.deny-by-default`,
 *                   which is designed to DENY), does production's actual
 *                   verdict match? Recorded in the acceptance report and the
 *                   summary printed to the console; does NOT change the
 *                   snapshot `status` field (that field answers the
 *                   acceptance question only).
 *
 * Constructs the capability probe already marked `unprobeable` (no
 * micro-scenario generator exists — module resolution, resource-limit
 * semantics, multi-node relationships, fields the standalone evaluator
 * doesn't model) get `status: 'unprobeable'` here too, with NO network call:
 * the same generator that abstains for the local simulator abstains here.
 *
 * CREDENTIAL CONTRACT (identical to run-rules.ts / run-rules-storage.ts):
 *   PARITY_SA_BASE64 — base64-encoded service-account JSON holding only
 *   `firebaserules.rulesets.test`. Read via `parityScope()`
 *   (packages/pyric/test/rules/parity/harness.ts); never logged, echoed, or
 *   written anywhere by this script.
 *
 * RUNNABLE-BUT-INERT WITHOUT CREDENTIALS:
 *   With PARITY_SA_BASE64 absent, this script makes NO network calls. It
 *   prints exactly what it WOULD probe (per engine: how many constructs need
 *   a network acceptance call vs. how many are unprobeable) then exits 0.
 *
 * RATE LIMITING: requests are issued in small batches with a brief pause
 * between batches — this is a probe of ~190 constructs run occasionally, not
 * a load test.
 *
 * Usage:
 *   # inert preview (no secret):
 *   bun run packages/conformance/src/rules-language-acceptance.ts
 *   # real probe (credentialed, reads env from the primary checkout):
 *   bun --env-file=/path/to/.env run packages/conformance/src/rules-language-acceptance.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageFunctionMock, TestCase } from '../../../packages/pyric/src/rules/test/spec.ts';
import type { EvaluationInput } from '../../../packages/pyric/src/storage/rules.ts';
import {
  resolveFirestoreConstructProbe,
  stProbeFor,
  resolveStProbe,
} from './rules-language-capability.ts';
import { FIRESTORE_ACCEPTANCE_EVIDENCE_NOTE } from './firestore-rules-acceptance-evidence.ts';
import { firestoreRulesTestInputDigest } from './firestore-rules-input-digest.ts';
import {
  loadSnapshot,
  type LanguageConstruct,
  type LanguageSnapshot,
  type RulesEngine,
} from '../rules-language/load.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LANG_DIR = join(HERE, '..', 'rules-language');

/** Only these two engines are in scope for the production Rules Test API
 *  probe — there is no Test API for RTDB rules, and RTDB uses a different
 *  credential entirely (issue #185 step 5, explicit exclusion). */
const PROBED_ENGINES: readonly RulesEngine[] = ['firestore', 'storage'] as const;

function selectedEngines(args: readonly string[] = process.argv.slice(2)): readonly RulesEngine[] {
  const at = args.indexOf('--engine');
  if (at < 0) return PROBED_ENGINES;
  const engine = args[at + 1];
  if (engine !== 'firestore' && engine !== 'storage') {
    throw new Error('--engine requires firestore or storage');
  }
  return [engine];
}

/** The sole construct whose micro-scenario is designed to DENY rather than
 *  ALLOW (storage's default-deny semantic: no rule matches the probed path).
 *  Every other probeable construct's micro-scenario is a tautology designed
 *  to ALLOW when the construct behaves as expected. */
const EXPECTS_DENY = new Set(['storage.semantic.deny-by-default']);

// ── Batching / rate limiting ────────────────────────────────────────────

const BATCH_SIZE = 8;
const BATCH_PAUSE_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Per-construct probe result ──────────────────────────────────────────

type AcceptanceStatus = 'accepted' | 'rejected' | 'unprobeable';

interface ConstructProbeResult {
  id: string;
  kind: string;
  status: AcceptanceStatus;
  probeNote?: string;
  probeDigest?: { algorithm: 'sha256'; value: string };
  /** Set whenever production returned a per-case verdict, including
   *  evaluation-time rejections. Compile-time rejections have no verdict. */
  evaluationAgreement?: boolean;
  evaluationDetail?: string;
  expectedDecision?: 'ALLOW' | 'DENY';
  actualDecision?: 'ALLOW' | 'DENY';
}

interface EngineProbeReport {
  engine: RulesEngine;
  total: number;
  accepted: number;
  rejected: number;
  unprobeable: number;
  evaluationAgree: number;
  evaluationDisagree: number;
  constructs: ConstructProbeResult[];
}

interface AcceptanceReport {
  generatedNote: string;
  probedAt: string;
  engines: EngineProbeReport[];
}

/** Fail closed when the API omits or duplicates a probe result. */
export function requireExactProbeResults<T>(
  engine: RulesEngine,
  constructId: string,
  expectedCount: number,
  results: readonly T[],
): readonly T[] {
  if (results.length !== expectedCount) {
    throw new Error(
      `[${engine}] invalid result count probing "${constructId}": expected ${expectedCount}, got ${results.length}`,
    );
  }
  return results;
}

// ── Firestore adapter ────────────────────────────────────────────────────

/**
 * Fixed instant used for every probe's `request.time` / `requestTime`.
 *
 * DIAGNOSIS (issue #185 step 5): the production Rules Test API does NOT
 * default `request.time` the way the local simulator does — an expression
 * touching `request.time` with no `requestTime` on the test case fails with
 * "Property time is undefined on object." The capability probe's local
 * simulator silently defaults it, so this only surfaces against production.
 * Every probe below sets it explicitly so `request.time`-dependent
 * constructs (the binding itself, and every `timestamp.*` method called on
 * it) get a real ACCEPTANCE/EVALUATION signal instead of a harness artifact.
 */
function firestoreRequest(c: LanguageConstruct): { rules: string; cases: TestCase[] } | { unprobeable: string } {
  return resolveFirestoreConstructProbe(c);
}

// ── Storage adapter: EvaluationInput → StorageTestCase ──────────────────

function storageMethodToTestMethod(
  method: EvaluationInput['request']['method'],
): 'get' | 'list' | 'create' | 'update' | 'delete' {
  if (method === 'read') return 'get';
  if (method === 'write') return 'create';
  return method;
}

/**
 * DIAGNOSIS (issue #185 step 5): calling `firestore.get()` / `firestore.exists()`
 * from a Storage rule fails against production with "Function not found error"
 * UNLESS the test case ALSO declares a matching `functionMocks` entry for that
 * exact call — the mock registration is what makes the Test API recognize the
 * cross-service identifier at all, not merely supply its canned result.
 * Verified live: the identical expression evaluates ALLOW once the matching
 * mock is attached. Without this, both constructs would read as `rejected`;
 * that would be a probe-harness gap (no mock registered), not a genuine
 * production verdict on whether the construct is real language surface.
 */
const ST_FUNCTION_MOCKS: Record<string, StorageFunctionMock[]> = {
  'storage.function.firestore.get': [{ function: 'get', path: 'u/x', result: { k: 'v' } }],
  'storage.function.firestore.exists': [{ function: 'exists', path: 'u/x', result: true }],
};

async function storageRequest(
  c: LanguageConstruct,
): Promise<{ rules: string; cases: import('../../../packages/pyric/src/rules/test/spec.ts').StorageTestCase[] } | { unprobeable: string }> {
  const resolved = resolveStProbe(stProbeFor(c));
  if ('unprobeable' in resolved) return resolved;
  const { rules, input } = resolved;
  const expectation = EXPECTS_DENY.has(c.id) ? 'DENY' : 'ALLOW';
  const functionMocks = ST_FUNCTION_MOCKS[c.id];
  return {
    rules,
    cases: [
      {
        description: 'probe',
        expectation,
        method: storageMethodToTestMethod(input.request.method),
        path: input.request.path,
        auth: input.request.auth ?? null,
        resource: input.request.resource,
        existingResource: input.resource,
        // Production requires an explicit request.time.
        requestTime: '2024-01-01T00:00:00Z',
        ...(functionMocks ? { functionMocks } : {}),
      },
    ],
  };
}

// ── Inert plan ───────────────────────────────────────────────────────────

function printInertPlan(): void {
  console.log('[rules-language:acceptance] PARITY_SA_BASE64 not set — INERT preview, no network calls.\n');
  console.log('  Credential env var expected: PARITY_SA_BASE64');
  console.log('    (base64-encoded service-account JSON with firebaserules.rulesets.test)\n');
  let grandTotal = 0;
  let grandNetwork = 0;
  for (const engine of selectedEngines()) {
    const snapshot = loadSnapshot(engine);
    let networkCount = 0;
    let unprobeableCount = 0;
    for (const c of snapshot.constructs) {
      const req = engine === 'firestore' ? firestoreRequest(c) : resolveStProbe(stProbeFor(c));
      if ('unprobeable' in req) unprobeableCount++;
      else networkCount++;
    }
    grandTotal += snapshot.constructs.length;
    grandNetwork += networkCount;
    console.log(
      `  ${engine.padEnd(9)} total ${String(snapshot.constructs.length).padStart(3)}  ` +
        `would-probe(network) ${String(networkCount).padStart(3)}  unprobeable ${unprobeableCount}`,
    );
  }
  console.log(`\n  Grand total: ${grandTotal} constructs, ${grandNetwork} would require a network acceptance call.`);
  console.log('\n  To probe for real:');
  console.log('    bun --env-file=/path/to/.env run packages/conformance/src/rules-language-acceptance.ts');
}

// ── Evaluation-time rejection detection ─────────────────────────────────
//
// A ruleset can be SYNTACTICALLY accepted (handler.execute returns
// success:true — the Rules Test API compiled it) while the specific
// construct under test still isn't real production language surface: an
// unrecognized identifier is valid function-call/member-access GRAMMAR, so
// it doesn't fail at ruleset-load time, but production's evaluator reports
// an unambiguous "this name doesn't exist" error at evaluation time. That is
// exactly the honesty question this probe exists to answer, so these are
// promoted to `rejected` (with the server's own message) rather than filed
// as a vague "evaluation disagreement". Diagnosed live against production
// (issue #185 step 5) for: debug(), bool(), math.isInfinite(), map
// .hasAll()/.hasAny(), getAfter()/existsAfter(), resource.id/__name__,
// request.resource.id, path()-equality, storage firestore.get/exists.
const EVALUATION_REJECTION_PATTERNS: RegExp[] = [
  /Function not found error: Name: \[[^\]]+\]\.?/,
  /Property [\w.]+ is undefined on object\.?/,
  /Unsupported operation error\.[^\n]*/,
];

/** Return the first server note that names an unresolved identifier / an
 *  unsupported operation, or `undefined` if no such note is present. */
function evaluationRejectionReason(notes: string[]): string | undefined {
  for (const note of notes) {
    for (const pattern of EVALUATION_REJECTION_PATTERNS) {
      if (pattern.test(note)) return note;
    }
  }
  return undefined;
}

// ── Credentialed run ─────────────────────────────────────────────────────

async function probeFirestoreConstruct(
  handler: import('../../../packages/pyric/src/rules/test/handler.ts').TestFirestoreRulesHandler,
  scope: import('../../../packages/pyric/src/project-scope.ts').ProjectScope,
  c: LanguageConstruct,
): Promise<ConstructProbeResult> {
  const req = firestoreRequest(c);
  if ('unprobeable' in req) {
    return { id: c.id, kind: c.kind, status: 'unprobeable', probeNote: req.unprobeable };
  }
  const probeDigest = firestoreRulesTestInputDigest(req.rules, req.cases);
  const res = await handler.execute(scope, req.rules, req.cases);
  if (!res.success) {
    if (res.error.code === 'RULES_ERROR' || res.error.code === 'INVALID_REQUEST') {
      return { id: c.id, kind: c.kind, status: 'rejected', probeNote: `${res.error.code}: ${res.error.message}`, probeDigest };
    }
    // Infra-level failure (PERMISSION_DENIED / FETCH_FAILED) — not a
    // ruleset rejection. Surfaced as a thrown probe error so the run
    // aborts rather than silently mislabeling a construct.
    throw new Error(`[firestore] infra error probing "${c.id}": ${res.error.code}: ${res.error.message}`);
  }
  const result = requireExactProbeResults('firestore', c.id, req.cases.length, res.data.results)[0]!;
  const decision = result.decision;
  if (decision === 'UNSUPPORTED') {
    throw new Error(`[firestore] production returned impossible UNSUPPORTED decision for "${c.id}"`);
  }
  const expected = req.cases[0]?.expectation;
  if (!expected || req.cases.length !== 1) {
    throw new Error(`[firestore] canonical probe for "${c.id}" must define exactly one expected decision`);
  }
  const agree = decision === expected;
  if (!agree) {
    const rejectionReason = evaluationRejectionReason(result?.notes ?? []);
    if (rejectionReason) {
      return {
        id: c.id, kind: c.kind, status: 'rejected', probeNote: rejectionReason, probeDigest,
        evaluationAgreement: agree,
        evaluationDetail: `expected ${expected}, got ${decision}`,
        expectedDecision: expected,
        actualDecision: decision,
      };
    }
  }
  return {
    id: c.id,
    kind: c.kind,
    status: 'accepted',
    probeDigest,
    evaluationAgreement: agree,
    evaluationDetail: `expected ${expected}, got ${decision}`,
    expectedDecision: expected,
    actualDecision: decision,
    ...(agree ? {} : { probeNote: `accepted; evaluation disagreement: expected ${expected} got ${decision}` }),
  };
}

async function probeStorageConstruct(
  handler: import('../../../packages/pyric/src/rules/test/handler.ts').TestStorageRulesHandler,
  scope: import('../../../packages/pyric/src/project-scope.ts').ProjectScope,
  c: LanguageConstruct,
): Promise<ConstructProbeResult> {
  const req = await storageRequest(c);
  if ('unprobeable' in req) {
    return { id: c.id, kind: c.kind, status: 'unprobeable', probeNote: req.unprobeable };
  }
  const res = await handler.execute(scope, req.rules, req.cases);
  if (!res.success) {
    if (res.error.code === 'RULES_ERROR' || res.error.code === 'INVALID_REQUEST') {
      return { id: c.id, kind: c.kind, status: 'rejected', probeNote: `${res.error.code}: ${res.error.message}` };
    }
    throw new Error(`[storage] infra error probing "${c.id}": ${res.error.code}: ${res.error.message}`);
  }
  const result = requireExactProbeResults('storage', c.id, req.cases.length, res.data.results)[0]!;
  const decision = result.decision;
  if (decision === 'UNSUPPORTED') {
    throw new Error(`[storage] production returned impossible UNSUPPORTED decision for "${c.id}"`);
  }
  const expected = req.cases[0]?.expectation;
  if (!expected || req.cases.length !== 1) {
    throw new Error(`[storage] canonical probe for "${c.id}" must define exactly one expected decision`);
  }
  const agree = decision === expected;
  if (!agree) {
    const rejectionReason = evaluationRejectionReason(result?.notes ?? []);
    if (rejectionReason) {
      return { id: c.id, kind: c.kind, status: 'rejected', probeNote: rejectionReason };
    }
  }
  return {
    id: c.id,
    kind: c.kind,
    status: 'accepted',
    evaluationAgreement: agree,
    evaluationDetail: `expected ${expected}, got ${decision}`,
    expectedDecision: expected,
    actualDecision: decision,
    ...(agree ? {} : { probeNote: `accepted; evaluation disagreement: expected ${expected} got ${decision}` }),
  };
}

/** Run `fn` over `items` in small batches with a pause between batches — a
 *  courteous rate limit against the live production API. */
async function runBatched<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
    if (i + BATCH_SIZE < items.length) await sleep(BATCH_PAUSE_MS);
  }
  return out;
}

/** Rewrite `<engine>.json` with the probed constructs' `status`/`probeNote`
 *  advanced. Every other field (including the doc-vs-parser `note`) is left
 *  untouched; constructs are never deleted. */
function writeSnapshotStatuses(engine: RulesEngine, results: ConstructProbeResult[]): void {
  const file = join(LANG_DIR, `${engine}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as LanguageSnapshot;
  const byId = new Map(results.map((r) => [r.id, r]));
  for (const c of snapshot.constructs) {
    const r = byId.get(c.id);
    if (!r) continue;
    c.status = r.status;
    if (r.probeNote) c.probeNote = r.probeNote;
    else delete (c as { probeNote?: string }).probeNote;
    if (r.probeDigest) c.probeDigest = r.probeDigest;
    else delete (c as { probeDigest?: unknown }).probeDigest;
    if (r.evaluationAgreement !== undefined) c.probeEvaluationAgreement = r.evaluationAgreement;
    else delete (c as { probeEvaluationAgreement?: unknown }).probeEvaluationAgreement;
  }
  writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
}

function writeFirestoreAcceptanceEvidence(
  report: AcceptanceReport,
  projectId: string,
): void {
  const firestore = report.engines.find((engine) => engine.engine === 'firestore');
  if (!firestore) return;
  const evidence = {
    schema: 'pyric.conformance.firestore-rules-acceptance-evidence.v1',
    generatedNote: FIRESTORE_ACCEPTANCE_EVIDENCE_NOTE,
    capturedAt: report.probedAt,
    projectId,
    ...firestore,
  };
  writeFileSync(
    join(LANG_DIR, 'firestore-acceptance-evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
    'utf8',
  );
}

async function run(): Promise<void> {
  // Heavy imports deferred to the credentialed path, same pattern as
  // run-rules.ts / run-rules-storage.ts, so the inert preview stays
  // dependency-light.
  const { parityScope } = await import('../../../packages/pyric/test/rules/parity/harness.ts');
  const { TestFirestoreRulesHandler, TestStorageRulesHandler } = await import(
    '../../../packages/pyric/src/rules/test/handler.ts'
  );
  const scope = parityScope();
  const fsHandler = new TestFirestoreRulesHandler();
  const stHandler = new TestStorageRulesHandler();

  const report: AcceptanceReport = {
    generatedNote:
      'Issue #185 step 5: production Rules Test API acceptance probe (firestore + storage arms). ' +
      '`status` on each snapshot construct is accepted/rejected/unprobeable — see rules-language/types.ts ' +
      "ConstructStatus doc. rejected constructs are findings: production disagrees with the snapshot's claim " +
      'that the construct is real language surface. RTDB stays unprobed (no Test API for RTDB rules).',
    probedAt: new Date().toISOString(),
    engines: [],
  };

  for (const engine of selectedEngines()) {
    const snapshot = loadSnapshot(engine);
    console.log(`\n[rules-language:acceptance] probing ${engine} (${snapshot.constructs.length} constructs)…`);
    const results = await runBatched(snapshot.constructs, (c) =>
      engine === 'firestore' ? probeFirestoreConstruct(fsHandler, scope, c) : probeStorageConstruct(stHandler, scope, c),
    );
    writeSnapshotStatuses(engine, results);

    const accepted = results.filter((r) => r.status === 'accepted').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    const unprobeable = results.filter((r) => r.status === 'unprobeable').length;
    const evaluationAgree = results.filter((r) => r.evaluationAgreement === true).length;
    const evaluationDisagree = results.filter((r) => r.evaluationAgreement === false).length;

    report.engines.push({
      engine,
      total: results.length,
      accepted,
      rejected,
      unprobeable,
      evaluationAgree,
      evaluationDisagree,
      constructs: results,
    });

    console.log(
      `  ${engine}: accepted ${accepted}, rejected ${rejected}, unprobeable ${unprobeable} ` +
        `(of ${results.length}); evaluation agreement ${evaluationAgree}/${evaluationAgree + evaluationDisagree}`,
    );
    const rejections = results.filter((r) => r.status === 'rejected');
    if (rejections.length > 0) {
      console.log(`  REJECTED (production disagrees with the snapshot):`);
      for (const r of rejections) console.log(`    - ${r.id}: ${r.probeNote}`);
    }
    const disagreements = results.filter((r) => r.evaluationAgreement === false);
    if (disagreements.length > 0) {
      console.log(`  EVALUATION DISAGREEMENT (production verdict differs from expectation):`);
      for (const r of disagreements) console.log(`    - ${r.id}: ${r.evaluationDetail}`);
    }
  }

  writeFirestoreAcceptanceEvidence(report, scope.projectId);

  writeFileSync(join(LANG_DIR, 'acceptance-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('\n[rules-language:acceptance] probe complete.');
  console.log(`[rules-language:acceptance] wrote ${join(LANG_DIR, 'acceptance-report.json')}`);
  console.log(`[rules-language:acceptance] updated ${selectedEngines().map((engine) => `${engine}.json`).join(' / ')} status fields.`);
}

if (import.meta.main) {
  if (!process.env.PARITY_SA_BASE64) {
    printInertPlan();
    process.exit(0);
  }
  try {
    await run();
  } catch (e) {
    console.error(`[rules-language:acceptance] ABORTED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
