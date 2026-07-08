/**
 * `createDraftThenValidateStrategy` — W1.3: the WORKSPACE draft strategy
 * (plans/agent-capability-epic/workstation-architecture.md section Move W1, section 3).
 *
 * The previous incarnation drafted a RULES-ONLY artifact and validated it
 * with a per-case `simulate_firestore_write` sweep. Two user-found failure
 * modes were structural (conductor log 2026-06-10): the draft never
 * produced app UI (UI was not a scored artifact), and the sweep generated
 * systematically unfixable failures (unseeded docs, simulator list-path
 * defect, ruleset re-shipped per call). This rewrite makes the draft a
 * workspace draft validated by build + test:
 *
 *   1. DRAFT (tool-free) — one `llm.chat()` with an EMPTY tool list and a
 *      COMPOSED draft prompt (scope/constraints/pitfalls — NOT the full
 *      tool-orchestration prefix, which described tools the draft is
 *      forbidden to call). The model emits FOUR fenced artifacts:
 *      ```json app-spec (the access matrix, plans/app-spec.md),
 *      ```firestore rules, ```tsx App.tsx, and ```json workspace tests
 *      (the W1 runner's `WorkspaceTestFile` shape).
 *   2. VALIDATE (host-driven, ONE pass per attempt) —
 *      · rules + tests via `runWorkspaceTests`: HOST-DERIVED spec-matrix
 *        tests (`deriveTests`, source 'derived' — incl. the
 *        deny-by-default cases models never write) PLUS model-authored
 *        tests (now positioned as field-validation extras + `custom`
 *        cases) PLUS a synthetic host floor file (`source: 'floor'`
 *        cases). Deploy-once and admin seeding come free from the runner
 *        — no per-case simulate calls, no rules re-shipping, no callId
 *        collisions. Spec degradation pin: a missing/unparseable spec
 *        fence gets ONE repair, then validation falls back to the exact
 *        three-fence behavior — the spec can never make DV worse.
 *      · App.tsx compile via the injected `compileCheck` callback (harness:
 *        Bun.Transpiler; browser: esbuild service). When absent, compile is
 *        recorded `'unchecked'` — never faked.
 *      · a MISSING artifact is a validation failure of that artifact, not
 *        a crash (and not a silent skip — "no App.tsx" must score red).
 *   3. REPAIR (bounded) — compact per-artifact feedback: status + failing
 *      cases (method/path/expected/got/source) + compile error. Passing
 *      artifacts are NOT re-shipped; the model re-emits only what must
 *      change and the strategy carries unchanged artifacts forward.
 *   4. WRITE-BACK — after validation settles, the host dispatches real
 *      `write_file` calls for ALL artifacts (rules, App.tsx, tests file),
 *      so auto-deploy, the preview, and the C1 write gate see them.
 *
 * Escalation compatibility: `validation_result` carries `failures` rows
 * with a `source` field ('floor' = host-authored evidence) and
 * `validation_exhausted` is unchanged — the strategy-router's
 * `shouldEscalateOnExhaustion` keys on floor evidence. Host-verified
 * failures (missing artifact, compile error, rules deploy error, floor
 * case) are tagged `'floor'`; model-authored test failures are
 * `'authored'` (a bad case is as likely as a bad ruleset).
 *
 * Custom milestones (ride the `strategy_event` channel): `draft_started`,
 * `validation_result`, `repair_started`, `validation_exhausted`.
 *
 * Browser- and node-safe: pyric-backed runner only, no fs/node imports.
 */
import type {
  AgentStrategy,
  ModelMessage,
  StrategyEvent,
  StrategyRunInput,
  ToolDeclarationView,
  ToolHandler,
  ToolResult,
  ToolSpec,
} from '@inbrowser/agent';
import {
  BACKEND_UI_GUIDANCE,
  FIRESTORE_SEEDING_POLICY,
  WORKSPACE_FILE_REFERENCES,
} from '~/lib/agent/system-prompt';
import {
  parseWorkspaceTestFile,
  runWorkspaceTests,
  type CaseFailure,
  type WorkspaceTestCase,
  type WorkspaceTestFile,
} from '~/lib/workspace-tests/runner';
import { validateAppSpec, quoteRule, type AppSpecV1 } from '~/lib/agent/spec/schema';
import { customConditions, deriveTests, findRuleForCase, summarizeMatrix } from '~/lib/agent/spec/derive';
import {
  compileRules,
  describeHole,
  unfilledHoles,
  type CustomHole,
} from '~/lib/agent/spec/compile-rules';

// ─────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────

export interface CompileCheckResult {
  ok: boolean;
  error?: string;
}

/** Host-injected compile probe over candidate workspace files. The
 *  strategy runs in BOTH hosts: the harness wires a Bun.Transpiler check
 *  (scripts/run-app-build.ts); the browser session host should wire the
 *  esbuild service. When absent, compile is recorded `'unchecked'`. */
export type CompileCheck = (
  files: Record<string, string>,
) => Promise<CompileCheckResult>;

/** SF-S1 de-cage: the BOUNDED, read-mostly tool set the draft cadence may
 *  reach for when genuinely stuck. Deliberately narrow — discovery +
 *  simulation + file reads + the host data affordance. NO `write_file`
 *  (the strategy owns write-back), NO mutation tools, NO project tools.
 *  The model calls these instead of hacking setup into App.tsx. The list
 *  is intersected with the host's actual `toolList` at run time, so a host
 *  that doesn't register one of these simply doesn't expose it. */
export const BOUNDED_DRAFT_TOOLS: readonly string[] = [
  'sandbox_discover_paths',
  'simulate_firestore_write',
  'search_file',
  'read_file',
  'list_files',
  'seed_firestore_data_as_admin',
] as const;

/** Default per-draft tool-call budget. Small by design: the escape hatch
 *  must not degrade the compose-first cadence into a react loop. Measured
 *  bound — a draft that needs >5 tool calls to unblock is thrashing, and
 *  the strategy stops offering tools (composes the rest tool-free) rather
 *  than loop unbounded. */
export const DEFAULT_DRAFT_TOOL_BUDGET = 5;

export interface DraftValidateConfig {
  /** Max repair loops after a failed validation. Default 2. 0 = validate
   *  once and surface the verdict, but never retry. */
  maxRepairs?: number;
  /** SF-S1: per-DRAFT tool-call budget (the de-cage escape hatch). Default
   *  `DEFAULT_DRAFT_TOOL_BUDGET` (5). 0 disables the hatch entirely — the
   *  draft runs exactly like the pre-de-cage tool-free compose pass (the
   *  degradation floor). Counts EVERY dispatched draft tool call across the
   *  whole turn (shared across repair attempts), never per-attempt. */
  draftToolBudget?: number;
  /** Compile probe for the App.tsx artifact.
   *  TODO(session-host): wire `getEsbuild()` from
   *  `src/lib/preview/esbuild-service.ts` as the browser compileCheck —
   *  until then browser runs record compile as 'unchecked'. */
  compileCheck?: CompileCheck;
  /** Host floor — synthetic invariant cases merged into validation as
   *  their own test file (cases MUST carry `source: 'floor'`; cases that
   *  need pre-existing docs MUST declare `seed`). Default:
   *  unauthenticated-create-must-DENY per distinct doc path the model's
   *  cases touch. Override when a ruleset intentionally allows public
   *  writes. Receives the model's parsed test file (null when absent). */
  floor?: (modelTests: WorkspaceTestFile | null) => WorkspaceTestFile | null;
  /** Dispatch `write_file` for every artifact after validation settles.
   *  Default true. */
  writeBack?: boolean;
  /** Artifact landing paths (kept as config so this module stays free of
   *  store imports). */
  rulesPath?: string; // default /workspace/firestore.rules
  appPath?: string; // default /workspace/src/App.tsx
  testsPath?: string; // default /workspace/tests/draft.test.json
  specPath?: string; // default /workspace/app.spec.json
}

// ─────────────────────────────────────────────────────────────────────
// Failure & validation shapes
// ─────────────────────────────────────────────────────────────────────

export type DraftArtifactId = 'spec' | 'rules' | 'app' | 'tests';

/** One validation failure row. Every row carries `source` — the router's
 *  floor-evidence escalation contract. Case rows additionally carry the
 *  case coordinates (method/path/as/expect). */
export interface DraftFailure {
  artifact: DraftArtifactId;
  kind:
    | 'missing_artifact'
    | 'invalid_tests'
    | 'invalid_spec'
    | 'compile_error'
    | 'deploy_error'
    | 'case'
    // SF-S3: a `custom` hole the host compiled with no model-supplied
    // `rulesExpr` — the model must fill the named expression.
    | 'unfilled_hole';
  expect: string;
  got: string;
  source: 'floor' | 'authored' | 'derived';
  name?: string;
  method?: CaseFailure['method'];
  path?: string;
  as?: WorkspaceTestCase['as'];
  detail?: string;
  /** For `source: 'derived'` case rows: the access-matrix entry that
   *  generated the case, quoted verbatim (teaching-grade evidence). */
  rule?: string;
}

/** Spec observables carried on every validation result — enough to
 *  compute the gate's custom-condition rate and derived-vs-model catch
 *  attribution later (failures additionally carry `source`). */
export interface SpecSummary {
  title: string;
  assumptions: string[];
  matrix: import('~/lib/agent/spec/derive').MatrixRow[];
  /** `custom` conditions in the matrix — the unverified residue. */
  customConditions: number;
  /** Derived / model-authored case counts that ran this attempt. */
  derivedCases: number;
  modelCases: number;
}

export interface DraftValidation {
  attempt: number;
  /** Checks performed: runner cases + one per artifact-level failure. */
  total: number;
  /** Runner cases that passed. `passed === total` ⇔ green attempt. */
  passed: number;
  artifacts: {
    /** 'fallback' = the spec fence stayed missing/unparseable past the
     *  one-repair budget and validation degraded to the three-fence
     *  behavior — recorded, never failed. */
    spec: 'ok' | 'invalid' | 'missing' | 'fallback';
    rules: 'ok' | 'failed' | 'missing' | 'unchecked';
    app: 'ok' | 'compile_failed' | 'missing' | 'unchecked';
    tests: 'ok' | 'invalid' | 'missing';
  };
  failures: DraftFailure[];
  /** Present whenever a valid spec drove this attempt. */
  spec?: SpecSummary;
  /** SF-S3 checkpoint-#2 observability — where the validated ruleset came
   *  from this attempt:
   *   - 'compiled' = host-compiled from the spec's access matrix (the
   *     enumerable case; the model's rules fence was NOT used);
   *   - 'authored' = the model's rules fence (no valid spec, or fallback);
   *   - 'fallback' = a spec existed but compilation failed → model fence
   *     (degradation: never worse than the pre-SF behavior). */
  rulesSource: 'compiled' | 'authored' | 'fallback';
  /** Total / unfilled `custom` holes the compiler produced (0 unless a spec
   *  drove a compile this attempt). `holesUnfilled > 0` blocks a green
   *  attempt until the model fills them. */
  holes: number;
  holesUnfilled: number;
  /** The ruleset that was actually validated this attempt — the
   *  host-compiled output when `rulesSource === 'compiled'`, else the
   *  model's fence. The strategy writes THIS back (not necessarily the
   *  model's fence). Not emitted in the validation event (the rules already
   *  land via write-back); kept here so write-back uses the same bytes. */
  effectiveRules?: string;
}

// ─────────────────────────────────────────────────────────────────────
// Fence parsing (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────

const RULES_FENCE = /```(?:firestore(?:-rules)?|rules)?\s*\n([\s\S]*?)```/gi;

/** Pull the Firestore ruleset out of a draft. Prefers a fence that looks
 *  like rules (`rules_version` / `service cloud.firestore`); falls back to
 *  any fence containing an `allow` clause. Returns null when none found.
 *  (Kept with this exact contract — the strategy-router imports it to
 *  extract escalation evidence.) */
export function parseRules(draft: string): string | null {
  const fences: string[] = [];
  for (const m of draft.matchAll(RULES_FENCE)) {
    if (m[1]) fences.push(m[1].trim());
  }
  const preferred = fences.find(looksLikeRules);
  if (preferred) return preferred;
  const withAllow = fences.find((s) => /\ballow\b/.test(s));
  return withAllow ?? null;
}

function looksLikeRules(s: string): boolean {
  return /rules_version|service\s+cloud\.firestore/.test(s);
}

function looksLikeApp(s: string): boolean {
  return /export\s+default\s/.test(s) || /from\s+['"]react['"]/.test(s);
}

export interface ParsedTestsArtifact {
  raw: string;
  /** Canonical parsed file (case `source` forced to 'authored' so a draft
   *  cannot spoof floor provenance). Null when the fence didn't parse. */
  file: WorkspaceTestFile | null;
  error?: string;
}

export interface ParsedSpecArtifact {
  raw: string;
  /** Validated spec (structural + referential). Null when the fence
   *  didn't parse or failed validation — `errors` says why. */
  spec: AppSpecV1 | null;
  errors?: string[];
}

export interface ParsedDraft {
  spec: ParsedSpecArtifact | null;
  rules: string | null;
  app: string | null;
  appFiles: Record<string, string>;
  tests: ParsedTestsArtifact | null;
}

const ANY_FENCE = /```([^\s`]*)([^\n]*)\n([\s\S]*?)```/g;
const RULES_LABELS = new Set(['firestore', 'firestore-rules', 'rules']);
const APP_LABELS = new Set(['tsx', 'jsx', 'ts', 'typescript', 'js', 'javascript', 'react']);
const DEFAULT_APP_PATH = '/workspace/src/App.tsx';
const APP_FILE_PATH_RE = /(?:\/workspace\/)?src\/[A-Za-z0-9_./-]+\.(?:tsx|ts|jsx|js)\b/i;

/** Structural smell test for an app-spec JSON body (cheap classifier for
 *  fences that lack the `app-spec` info string). */
function looksLikeSpec(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  return Array.isArray(o.collections) && Array.isArray(o.access);
}

/** Validate a ```json app-spec fence body. Never throws. */
export function canonicalizeSpec(raw: string): ParsedSpecArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { raw, spec: null, errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const v = validateAppSpec(parsed);
  if (!v.ok) return { raw, spec: null, errors: v.errors };
  return { raw, spec: v.spec };
}

/** Try to canonicalize a ```json fence body as a WorkspaceTestFile.
 *  Tolerates a bare array of cases (wrapped as `{ cases }`). Forces
 *  `source: 'authored'` on every case. */
export function canonicalizeTests(raw: string): ParsedTestsArtifact {
  let json = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) json = JSON.stringify({ cases: parsed });
  } catch {
    /* parseWorkspaceTestFile reports the JSON error below */
  }
  try {
    const file = parseWorkspaceTestFile(json);
    return {
      raw,
      file: {
        ...(file.seed ? { seed: file.seed } : {}),
        cases: file.cases.map((c) => ({ ...c, source: 'authored' as const })),
      },
    };
  } catch (e) {
    return { raw, file: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Parse the four workspace artifacts out of a draft. Tolerant: fences in
 *  any order, labeled or content-classified; first match wins per slot;
 *  missing artifacts come back null (the VALIDATOR turns absence into a
 *  failure — parsing never throws). The spec rides a ```json fence with
 *  an `app-spec` info string; json fences without one are classified by
 *  shape (cases → tests, collections+access → spec). */
export function parseDraftArtifacts(draft: string): ParsedDraft {
  const out: ParsedDraft = { spec: null, rules: null, app: null, appFiles: {}, tests: null };
  const takeSpec = (body: string): void => {
    const candidate = canonicalizeSpec(body);
    // First spec fence is the candidate; a later VALID spec replaces an
    // earlier broken one (same tolerance as tests).
    if (!out.spec || (out.spec.spec === null && candidate.spec !== null)) {
      out.spec = candidate;
    }
  };
  const takeApp = (label: string, info: string, body: string): void => {
    const path = normalizeAppFencePath(label, info) ?? DEFAULT_APP_PATH;
    if (path === DEFAULT_APP_PATH) {
      if (!out.app) out.app = body;
      return;
    }
    out.appFiles[path] = body;
  };
  for (const m of draft.matchAll(ANY_FENCE)) {
    const rawLabel = m[1] ?? '';
    const rawInfo = m[2] ?? '';
    const label = rawLabel.toLowerCase();
    const info = rawInfo.toLowerCase();
    const body = (m[3] ?? '').trim();
    if (body.length === 0) continue;

    if (RULES_LABELS.has(label)) {
      if (!out.rules) out.rules = body;
      continue;
    }
    if (APP_LABELS.has(label)) {
      // Mislabeled rules fence (```ts with rules_version inside) → rules.
      if (looksLikeRules(body)) {
        if (!out.rules) out.rules = body;
      } else {
        takeApp(rawLabel, rawInfo, body);
      }
      continue;
    }
    if (label === 'json') {
      if (info.includes('app-spec') || info.includes('app.spec')) {
        takeSpec(body);
        continue;
      }
      // No info string — classify by shape. A parseable spec-shaped
      // object routes to the spec slot; everything else stays a tests
      // candidate (the historical behavior).
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        /* tests canonicalizer reports the error */
      }
      if (looksLikeSpec(parsedBody)) {
        takeSpec(body);
        continue;
      }
      const candidate = canonicalizeTests(body);
      // First json fence is the candidate; a later VALID tests fence
      // replaces an earlier unparseable one.
      if (!out.tests || (out.tests.file === null && candidate.file !== null)) {
        out.tests = candidate;
      }
      continue;
    }
    // Unlabeled / unknown label → classify by content.
    if (looksLikeRules(body)) {
      if (!out.rules) out.rules = body;
    } else if (looksLikeApp(body)) {
      takeApp(rawLabel, rawInfo, body);
    } else {
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse(body);
      } catch {
        /* not JSON — ignored below */
      }
      if (looksLikeSpec(parsedBody)) {
        takeSpec(body);
      } else {
        const candidate = canonicalizeTests(body);
        if (candidate.file !== null && !out.tests) out.tests = candidate;
      }
    }
  }
  return out;
}

function normalizeAppFencePath(label: string, info: string): string | null {
  const haystack = `${label} ${info}`;
  const match = APP_FILE_PATH_RE.exec(haystack)?.[0];
  if (match) {
    const normalized = match.startsWith('/workspace/') ? match : `/workspace/${match.replace(/^\/+/, '')}`;
    if (!normalized.startsWith('/workspace/src/') || normalized.includes('/../')) return null;
    return normalized;
  }
  if (/\bApp\.tsx\b/i.test(haystack)) return DEFAULT_APP_PATH;
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Host floor (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────

/** Default floor: unauthenticated create must DENY on every distinct DOC
 *  path the model's cases touch (collection paths — e.g. `list` targets —
 *  get a synthetic trailing segment so the probe is a valid doc write).
 *  Needs no seeds; floors that read existing docs must declare `seed`. */
export function defaultFloor(model: WorkspaceTestFile | null): WorkspaceTestFile | null {
  if (!model) return null;
  const paths = new Set<string>();
  for (const c of model.cases) {
    const segs = c.do.path.split('/').filter((s) => s.length > 0);
    if (segs.length === 0) continue;
    paths.add(segs.length % 2 === 0 ? segs.join('/') : [...segs, 'floor-probe'].join('/'));
  }
  if (paths.size === 0) return null;
  return {
    cases: [...paths].map((path) => ({
      as: null,
      do: { method: 'create' as const, path, data: {} },
      expect: 'DENY' as const,
      source: 'floor' as const,
      name: `floor: unauthenticated create on ${path} must be denied`,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Draft prompt composition (exported for tests + token measurement)
// ─────────────────────────────────────────────────────────────────────

/** The composed draft guidance. Deliberately NOT the playground
 *  tool-orchestration prompt: the old draft wrapped the full ~9–10k-token
 *  prefix (tool routing, simulate/seed/debug blocks) and then forbade
 *  tools — several thousand contradictory tokens per draft call
 *  (conductor log 2026-06-10). This is the scope/constraints/pitfalls
 *  subset that a one-shot workspace draft actually needs. Source guidance
 *  it condenses: system-prompt.ts SCOPE + UI_STYLE + the #575 auth-UI
 *  rule + the BACKEND_UI_GUIDANCE no-in-app-backend block (imported below
 *  so DV and the react loop share ONE source of truth), and the
 *  diagnostics rules-pitfalls block.
 *
 *  SF-S1 de-cage: the draft is compose-FIRST but no longer tool-FREE. A
 *  bounded, read-mostly tool set (discover/simulate/read/list + the host
 *  seed tool) is an ESCAPE HATCH the model MAY use when genuinely stuck —
 *  NOT a per-step react loop. The cadence is unchanged: compose all four
 *  artifacts in one pass; only reach for a tool to unblock, then keep
 *  composing. A small per-draft tool-call budget caps the escape hatch so
 *  de-caging can't degrade into thrash. */
const DRAFT_GUIDANCE = `You are a Firebase agent. Compose the artifacts directly from the request and context below.

COMPOSE THE FULL DRAFT FIRST. Most tasks need NO tools. Tools are a LAST-RESORT escape hatch for ONE specific missing fact (an existing schema you must discover, a single rule to simulate, a file to search/read, or demo data to seed so the app has something to render), reached for only AFTER you have composed everything you can — never as a way to explore or to start. Do not narrate a tool plan; do not call a tool per step; do not list/read files just to look around. When demo data is needed, call \`seed_firestore_data_as_admin\` — NEVER bake seeding into App.tsx.

${BACKEND_UI_GUIDANCE}

${FIRESTORE_SEEDING_POLICY}

Emit the workspace artifacts as fenced blocks (any order):
1. The app spec (access matrix) in a \`\`\`json app-spec fence — the heart of the draft. The host COMPILES your Firestore security rules deterministically FROM this matrix, so you do NOT write rules: get the access matrix right and correct rules follow for free.
2. App files: REQUIRED \`\`\`tsx /workspace/src/App.tsx, plus optional path-labeled supporting files under /workspace/src/components/* or /workspace/src/lib/* when useful. App.tsx stays the preview entry and imports them.
3. Workspace tests in a \`\`\`json fence (the host runs them against the compiled rules)

ARTIFACT 1 — APP SPEC (\`\`\`json app-spec):
A compact machine-readable contract — and the SOURCE the host compiles your Firestore rules from. The host also DERIVES rules tests from it (allowed access, denied access, and deny-by-default for every op you don't grant) and runs them against the compiled rules, so the matrix must match your app EXACTLY. One JSON object:
{ "meta": { "title": "…", "assumptions": ["…"] },
  "identities": [ { "uid": "alice", "description": "a customer" }, { "uid": "cara", "claims": { "admin": true } } ],
  "collections": [ { "path": "orders/{orderId}", "ownerField": "userId", "fields": [
      { "name": "userId", "type": "string", "required": true },
      { "name": "status", "type": "string", "enum": ["placed","ready"], "transitions": { "placed": ["ready"] } } ] } ],
  "access": [ { "collection": "orders/{orderId}", "op": "create", "grant": [ …conditions ] } ] }
- identities: one per role the app demos (customers, admins, …); custom claims under "claims".
- collections: path templates; "ownerField" names the doc field holding the owner uid — OMIT it when the doc ID is the uid (users/{uid}). Field "type" is one of string|integer|double|boolean|timestamp|bytes|geopoint|reference|array|map; mark "required"/"immutable"; closed value sets get "enum" (+ "transitions" when updates must follow an order).
- access: at most ONE entry per collection × op ("op": get|list|create|update|delete). Any op you don't grant is DENIED BY DEFAULT and the host tests that — grant everything the app actually uses. "grant" is "deny" or an array of conditions ANDed together ([] = public):
  {"kind":"authenticated"} · {"kind":"owner"} · {"kind":"claim","name":"admin","equals":true}
  {"kind":"fieldEquals","field":"f","value":v} · {"kind":"fieldImmutable","field":"f"} (update must not change f)
  {"kind":"requiredFields","fields":["a","b"]} (create must include all) · {"kind":"enumTransition","field":"status"}
  {"kind":"crossDoc","collection":"menuItems","docIdFrom":"itemId","remoteField":"price","localField":"price"} (local field must equal the referenced doc's field)
  {"kind":"custom","rulesExpr":"<raw rules expr>","rationale":"…"} — LAST resort; the host cannot verify it, so cover it in your own tests.

RULES ARE HOST-COMPILED — do NOT write a \`\`\`firestore fence:
The host compiles correct rules from your access matrix (list/get split, request.resource.data on create, claims, crossDoc, enum transitions — all by construction). The one exception is a \`{"kind":"custom"}\` condition: supply its \`rulesExpr\` (a raw rules boolean expr) in the spec and cover it in your tests. Prefer an enumerable kind over \`custom\` whenever one fits.

ARTIFACT 2 — APP FILES:
Required entry fence: \`\`\`tsx /workspace/src/App.tsx. Optional supporting files may be emitted as \`\`\`tsx /workspace/src/components/Name.tsx or \`\`\`ts /workspace/src/lib/name.ts. App.tsx stays the preview entry, imports supporting files, and default-exports the mounted component. Repairs may re-emit only changed files.
Use CANONICAL imports:
  import { useState, useEffect } from "react";
  import { collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot } from "firebase/firestore";
  import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signInWithPopup, GoogleAuthProvider, signOut } from "firebase/auth"; (when auth is needed)
  import { db } from "./firebase";
App.tsx ends with \`export default function App() { … }\`.
Constraints:
- NEVER import \`sandbox\` or anything from \`@pyric/*\` (the deploy bundler refuses such bundles).
- No Firestore cache/persistence/network APIs (getDocFromCache, enableIndexedDbPersistence, disableNetwork, loadBundle, vector search, initializeFirestore).
- No phone / custom-token / email-link auth; no updateProfile/updateEmail/updatePassword, password-reset/verification emails, account linking, re-auth, MFA, deleteUser, or initializeAuth.
- Provider sign-in WORKS: signInWithPopup / signInWithRedirect with GoogleAuthProvider etc. open a built-in account picker; getRedirectResult is supported.
- Auth UI must be REAL auth UI: sign-in control(s), the signed-in user's name/email, and sign-out. NEVER render a developer identity-switcher — no "sign in as Alice/Bob/Admin" button rows, no uid dropdowns, no hardcoded test credentials. Test identities live in the HOST's account picker; users demo role boundaries by signing out and back in.
UI style: elegant, MOBILE-FIRST, pure CSS (no frameworks): \`display: grid\`, \`gap\` for spacing between siblings (not margins), \`auto-fit\`/\`minmax\` for responsive grids. A single <style> block in the TSX is fine.

ARTIFACT 3 — TESTS (\`\`\`json):
One JSON object: { "seed": [{ "path": "orders/o1", "data": { … } }], "cases": [ { "as": { "uid": "alice", "token": { "admin": true } } | null, "do": { "method": "get|list|create|update|delete", "path": "…", "data": { … } }, "expect": "ALLOW" | "DENY", "name": "…" } ] }
- The host already derives the full access-matrix suite from your spec — do NOT duplicate it. Your cases cover what the spec can't express: field-validation specifics and every "custom" condition you declared.
- \`as: null\` = unauthenticated; custom claims go under \`as.token\`.
- get/create/update/delete take a DOCUMENT path (collection/docId); \`list\` takes a COLLECTION path and runs as a real query.
- Any case that gets/updates/deletes an EXISTING doc needs that doc in \`seed\` (applied admin-bypass; an update on a missing doc reports ERROR, not DENY).
- Cases are INDEPENDENT — state resets to \`seed\` before every case, so a case's writes are invisible to later cases. Outcomes never depend on case order; never rely on one case's create/update/delete in another.

The host then compiles your App.tsx, COMPILES + deploys the rules from your spec ONCE, seeds, and runs every spec-derived case plus yours plus its own invariants. Failures come back to you; re-emit ONLY the artifacts that must change.`;

/** Workspace state for drafts is file references only. Full file bodies are
 *  intentionally omitted; modification drafts should call search_file or
 *  ranged read_file when they need current content. */
export function extractWorkspaceState(_hostSystemPrompt: string): string {
  return WORKSPACE_FILE_REFERENCES;
}

/** Compose the draft system prompt: the self-contained guidance plus the
 *  stable workspace file references. */
export function composeDraftSystemPrompt(hostSystemPrompt: string): string {
  const state = extractWorkspaceState(hostSystemPrompt);
  return state ? `${DRAFT_GUIDANCE}\n\n${state}` : DRAFT_GUIDANCE;
}

// ─────────────────────────────────────────────────────────────────────
// De-cage: bounded tool exposure (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────

/** Intersect the host's actual `toolList` with `BOUNDED_DRAFT_TOOLS` and
 *  lower each surviving handler to a flat tool-decl view (the trace's
 *  `ToolDeclarationView` shape) for the chat call — wrapped into the nested
 *  `ToolSpec` shape at the request boundary. Order follows
 *  `BOUNDED_DRAFT_TOOLS` (stable, deterministic prefix). A host that
 *  registers none of them yields `[]` — the draft then runs tool-free (the
 *  degradation floor), no special-casing needed. */
export function selectDraftToolDeclarations(toolList: ToolHandler[]): ToolDeclarationView[] {
  const byName = new Map(toolList.map((t) => [t.name, t]));
  const out: ToolDeclarationView[] = [];
  for (const name of BOUNDED_DRAFT_TOOLS) {
    const h = byName.get(name);
    if (h) out.push({ name: h.name, description: h.description, parameters: h.parameters });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Repair feedback (exported for unit tests)
// ─────────────────────────────────────────────────────────────────────

const ARTIFACT_FENCE: Record<DraftArtifactId, string> = {
  spec: '```json app-spec',
  rules: '```firestore',
  app: '```tsx',
  tests: '```json',
};

function describeFailure(f: DraftFailure): string {
  if (f.kind === 'case') {
    const who = f.as ? `as ${f.as.uid}` : 'unauthenticated';
    const label = f.name ? ` (${f.name})` : '';
    const ruleQuote = f.rule ? `\n    from your spec rule: ${f.rule}` : '';
    return `- [${f.source}] ${f.method} ${f.path} ${who}: expected ${f.expect}, got ${f.got}${label}${f.detail ? ` — ${f.detail}` : ''}${ruleQuote}`;
  }
  if (f.kind === 'unfilled_hole') {
    // The detail already quotes collection + op + rationale (describeHole).
    return `- [${f.source}] unfilled custom condition — ${f.detail ?? 'supply its rulesExpr in the app-spec'}`;
  }
  return `- [${f.source}] ${f.artifact}: ${f.kind.replace(/_/g, ' ')} — expected ${f.expect}, got ${f.got}${f.detail ? ` — ${f.detail}` : ''}`;
}

/** Compact repair feedback: per-artifact status, the failing evidence,
 *  and an explicit "do not re-emit what passed" contract. Passing
 *  artifacts' full text is NEVER re-shipped. Derived-case failures quote
 *  the access-rule entry that generated them. */
export function formatRepairFeedback(v: DraftValidation): string {
  const broken = new Set(v.failures.map((f) => f.artifact));
  // SF-S3: when the host COMPILED the rules from the spec, the model can't
  // fix them by re-emitting a rules fence — the fix lives in the SPEC's
  // access matrix (or the `custom` rulesExpr). The rules status line points
  // there instead of asking for a ```firestore block.
  const hostCompiled = v.rulesSource === 'compiled';
  const statusLine = (id: DraftArtifactId, label: string): string => {
    if (!broken.has(id)) return `- ${label}: PASSED — do NOT re-emit (kept from your previous draft)`;
    if (id === 'rules' && hostCompiled) {
      return `- ${label}: FAILED — the host COMPILES the rules from your app-spec, so do NOT write a rules fence. Fix the ${ARTIFACT_FENCE.spec} access matrix (the failing rule is quoted below) and re-emit it`;
    }
    return `- ${label}: FAILED — re-emit the corrected ${ARTIFACT_FENCE[id]} block`;
  };
  const lines: string[] = [
    `Validation failed (${v.passed}/${v.total} checks passed). Artifact status:`,
    // The spec line only appears while the spec is still in play —
    // after fallback the feedback is exactly the three-fence shape.
    ...(v.artifacts.spec === 'fallback' ? [] : [statusLine('spec', 'app spec')]),
    statusLine('rules', 'rules'),
    statusLine('app', 'App.tsx'),
    statusLine('tests', 'tests'),
    '',
    'Failures:',
    ...v.failures.map(describeFailure),
  ];
  if (v.holesUnfilled > 0) {
    lines.push(
      '',
      `${v.holesUnfilled} \`custom\` condition(s) in your app-spec have no rules expression. The host compiles everything else, but a \`custom\` condition needs you to supply its \`rulesExpr\` (a raw Firestore rules boolean expression). Fill the named "rulesExpr" in your ${ARTIFACT_FENCE.spec} fence — or replace the \`custom\` condition with an enumerable kind the host can compile.`,
    );
  }
  if (v.failures.some((f) => f.source === 'derived')) {
    lines.push(
      '',
      'A `[derived]` case was derived by the host from YOUR app-spec access matrix (the generating rule is quoted with it). Fix the rules so they honor the quoted rule — or, if the spec entry itself is wrong, re-emit a corrected ```json app-spec fence.',
    );
  }
  if (v.failures.some((f) => f.kind === 'case' && f.got === 'ERROR' && f.source !== 'derived')) {
    lines.push(
      '',
      'A `got: ERROR` case means the TEST or SEED is wrong (e.g. update/delete on a doc that was never seeded) — fix the tests artifact, not the rules.',
    );
  }
  lines.push('', 'Re-emit ONLY the artifacts that must change, each in its fenced block.');
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// Validation (host-driven, one pass per attempt)
// ─────────────────────────────────────────────────────────────────────

interface Artifacts {
  spec: ParsedSpecArtifact | null;
  rules: string | null;
  app: string | null;
  appFiles: Record<string, string>;
  tests: ParsedTestsArtifact | null;
}

const FLOOR_FILE_NAME = '__floor__.test.json';
const DERIVED_FILE_PREFIX = '__spec_derived_';

async function validateDraft(
  attempt: number,
  artifacts: Artifacts,
  config: {
    compileCheck?: CompileCheck;
    floor: NonNullable<DraftValidateConfig['floor']>;
    appPath: string;
    testsFileName: string;
    /** 'active' = the spec fence is still required (missing/invalid is a
     *  repairable failure); 'fallback' = the one-repair budget is spent —
     *  validate exactly like the three-fence strategy (degradation pin). */
    specMode: 'active' | 'fallback';
  },
): Promise<DraftValidation> {
  const failures: DraftFailure[] = [];
  const v: DraftValidation = {
    attempt,
    total: 0,
    passed: 0,
    artifacts: { spec: 'fallback', rules: 'unchecked', app: 'unchecked', tests: 'ok' },
    failures,
    rulesSource: 'authored',
    holes: 0,
    holesUnfilled: 0,
  };

  // ── Spec presence + validity (skipped entirely after fallback) ─────
  let spec: AppSpecV1 | null = null;
  if (config.specMode === 'active') {
    if (!artifacts.spec) {
      v.artifacts.spec = 'missing';
      failures.push({
        artifact: 'spec', kind: 'missing_artifact', expect: 'a ```json app-spec fence', got: 'MISSING', source: 'floor',
      });
    } else if (!artifacts.spec.spec) {
      v.artifacts.spec = 'invalid';
      failures.push({
        artifact: 'spec', kind: 'invalid_spec', expect: 'a valid app-spec (see the ARTIFACT 1 contract)', got: 'INVALID', source: 'authored',
        ...(artifacts.spec.errors?.length ? { detail: artifacts.spec.errors.join('; ') } : {}),
      });
    } else {
      v.artifacts.spec = 'ok';
      spec = artifacts.spec.spec;
    }
  }

  // ── SF-S3: HOST-COMPILE the rules from the spec's access matrix ─────
  // When a valid spec parsed, the host OWNS rule generation for the
  // enumerable majority — the model need not author rules at all. The
  // compiled ruleset replaces the model's fence as the validated/written
  // artifact. `custom` holes the model didn't fill (no `rulesExpr`) become
  // repair failures naming collection+op+rationale. Degradation pin: a
  // compile failure falls back to the model's fence — never worse than the
  // pre-SF behavior.
  let effectiveRules: string | null = artifacts.rules;
  const unfilled: CustomHole[] = [];
  if (spec) {
    try {
      const compiled = compileRules(spec);
      v.holes = compiled.holes.length;
      const stillOpen = unfilledHoles(compiled.holes);
      v.holesUnfilled = stillOpen.length;
      unfilled.push(...stillOpen);
      effectiveRules = compiled.rules;
      v.rulesSource = 'compiled';
      for (const h of stillOpen) {
        failures.push({
          artifact: 'rules',
          kind: 'unfilled_hole',
          expect: 'a rules expression for the custom condition',
          got: 'UNFILLED',
          source: 'derived',
          detail: describeHole(h),
        });
      }
    } catch (e) {
      // Degradation: compile failed → use the model's fence (current
      // behavior). Recorded, never fatal.
      v.rulesSource = 'fallback';
      effectiveRules = artifacts.rules;
      console.warn('[draft-validate] compileRules failed; falling back to model rules:', e);
    }
  }

  // ── Artifact presence + tests validity ─────────────────────────────
  // A missing model rules fence is a failure ONLY when the host has no
  // compiled rules to use in its place (compiled/fallback both provide an
  // effective ruleset when a spec drove this attempt).
  if (!effectiveRules) {
    v.artifacts.rules = 'missing';
    failures.push({
      artifact: 'rules', kind: 'missing_artifact', expect: 'a ```firestore rules fence', got: 'MISSING', source: 'floor',
    });
  }
  if (!artifacts.app) {
    v.artifacts.app = 'missing';
    failures.push({
      artifact: 'app', kind: 'missing_artifact', expect: 'a ```tsx App.tsx fence', got: 'MISSING', source: 'floor',
    });
  }
  if (!artifacts.tests) {
    v.artifacts.tests = 'missing';
    failures.push({
      artifact: 'tests', kind: 'missing_artifact', expect: 'a ```json workspace-tests fence', got: 'MISSING', source: 'floor',
    });
  } else if (!artifacts.tests.file) {
    v.artifacts.tests = 'invalid';
    failures.push({
      artifact: 'tests', kind: 'invalid_tests', expect: 'a valid { seed?, cases } test file', got: 'INVALID', source: 'authored',
      ...(artifacts.tests.error ? { detail: artifacts.tests.error } : {}),
    });
  }

  // ── App compile (injected; absent → 'unchecked', never faked) ──────
  if (artifacts.app) {
    if (config.compileCheck) {
      try {
        const appCompileFiles = { [config.appPath]: artifacts.app, ...artifacts.appFiles };
        const res = await config.compileCheck(appCompileFiles);
        if (res.ok) {
          v.artifacts.app = 'ok';
        } else {
          v.artifacts.app = 'compile_failed';
          failures.push({
            artifact: 'app', kind: 'compile_error', expect: 'App.tsx compiles', got: 'COMPILE_ERROR', source: 'floor',
            ...(res.error ? { detail: res.error } : {}),
          });
        }
      } catch (e) {
        // A crashing compile probe degrades to unchecked — host-gate
        // doctrine: infrastructure failure never blocks the artifact.
        v.artifacts.app = 'unchecked';
        console.warn('[draft-validate] compileCheck crashed; recording compile as unchecked:', e);
      }
    } else {
      v.artifacts.app = 'unchecked';
    }
  }

  // ── Rules + tests through the W1 runner (deploy-once, seeded) ──────
  // Derived (spec-matrix) tests + model tests + the host floor run as
  // one suite. Derived cases carry source 'derived' end to end.
  const modelFile = artifacts.tests?.file ?? null;
  const floorFile = config.floor(modelFile);
  const derivedFiles: WorkspaceTestFile[] = spec ? deriveTests(spec) : [];
  // The ruleset under test is the HOST-COMPILED one when a spec drove this
  // attempt (rulesSource 'compiled'/'fallback' both set effectiveRules);
  // otherwise the model's fence.
  if (effectiveRules && (modelFile || floorFile || derivedFiles.length > 0)) {
    const files: Array<{ name: string; content: string }> = [];
    derivedFiles.forEach((file, i) => {
      files.push({ name: `${DERIVED_FILE_PREFIX}${i}__.test.json`, content: JSON.stringify(file) });
    });
    if (modelFile) files.push({ name: config.testsFileName, content: JSON.stringify(modelFile) });
    if (floorFile && floorFile.cases.length > 0) {
      files.push({ name: FLOOR_FILE_NAME, content: JSON.stringify(floorFile) });
    }
    const report = await runWorkspaceTests(files, effectiveRules);
    v.total += report.total;
    v.passed += report.passed;
    let deployError: string | null = null;
    for (const fr of report.files) {
      if (fr.error && !deployError) deployError = fr.error;
      for (const cf of fr.failures) {
        // ERROR attribution: pyric's setRules is lenient — a broken
        // ruleset surfaces at op time as "Failed to parse rules source".
        // That ERROR is host evidence against the RULES (floor). Every
        // other ERROR (e.g. update on an unseeded doc) means the TEST or
        // SEED is wrong — route the repair at the tests artifact. EXCEPT
        // derived cases: the model can't edit host-derived tests, so
        // their failures always point at the rules (or, via the quoted
        // rule, at the spec entry to correct).
        const rulesParseError =
          cf.got === 'ERROR' && /rules/i.test(cf.detail ?? '') && /pars|compil/i.test(cf.detail ?? '');
        const derived = cf.source === 'derived';
        const generatingRule =
          derived && spec && cf.method ? findRuleForCase(spec, cf.method, cf.path) : null;
        failures.push({
          artifact: cf.got === 'ERROR' && !rulesParseError && !derived ? 'tests' : 'rules',
          kind: rulesParseError ? 'deploy_error' : 'case',
          expect: cf.expect,
          got: cf.got,
          source: rulesParseError ? 'floor' : cf.source,
          method: cf.method,
          path: cf.path,
          as: cf.as,
          ...(cf.name ? { name: cf.name } : {}),
          ...(cf.detail ? { detail: cf.detail } : {}),
          ...(generatingRule
            ? { rule: quoteRule(generatingRule) }
            : derived
              ? { rule: `(no grant for this op — deny-by-default)` }
              : {}),
        });
      }
    }
    if (deployError) {
      // File-level deploy failure (defensive: not observed with current
      // pyric, which deploys leniently and fails at op time instead).
      v.artifacts.rules = 'failed';
      failures.push({
        artifact: 'rules', kind: 'deploy_error', expect: 'rules deploy cleanly', got: 'DEPLOY_ERROR', source: 'floor', detail: deployError,
      });
    } else if (failures.some((f) => f.artifact === 'rules')) {
      v.artifacts.rules = 'failed';
    } else if (effectiveRules) {
      v.artifacts.rules = 'ok';
    }
  }

  // ── Spec observables (gate wiring: custom-condition rate + the
  // derived-vs-model attribution both compute from here + `failures`) ──
  if (spec) {
    v.spec = {
      title: spec.meta.title,
      assumptions: spec.meta.assumptions,
      matrix: summarizeMatrix(spec),
      customConditions: customConditions(spec).length,
      derivedCases: derivedFiles.reduce((n, f) => n + f.cases.length, 0),
      modelCases: modelFile?.cases.length ?? 0,
    };
  }

  // Carry the validated ruleset for write-back (compiled when host-owned).
  if (effectiveRules) v.effectiveRules = effectiveRules;

  // Artifact-level failures count as unpassed checks: total grows by one
  // per non-case failure so `passed === total` ⇔ a fully green attempt
  // (the stepper renders these numbers directly).
  v.total += failures.filter((f) => f.kind !== 'case').length;
  return v;
}

// ─────────────────────────────────────────────────────────────────────
// Strategy
// ─────────────────────────────────────────────────────────────────────

/** The message shape the strategy threads into `llm.chat`. It is the
 *  package's `ModelMessage` VERBATIM — not a `{role,text}` subset — so
 *  both transports emit OpenAI-strict tool sequences: an assistant turn
 *  that dispatched a tool carries `toolCalls:[{id,name,args}]`
 *  (→ `tool_calls[].id`), and the following result is
 *  `{role:'tool', toolCallId, name, resultJson}` (→ `tool_call_id` matching
 *  that id). Earlier this was `{role,text}`-only, so tool dispatches were
 *  threaded as PROSE and the transports emitted a `role:'tool'` message
 *  with `tool_call_id:''` and an assistant message with NO `tool_calls` —
 *  which OpenAI-strict providers (k2.7-code) reject with a provider-400. */
type NormalizedMsg = ModelMessage;

function buildBaseMessages(input: StrategyRunInput): NormalizedMsg[] {
  const out: NormalizedMsg[] = [
    { role: 'system', text: composeDraftSystemPrompt(input.systemPrompt) },
  ];
  for (const m of input.history) {
    if (m.role === 'system') continue;
    out.push({ role: m.role, text: m.text });
  }
  out.push({ role: 'user', text: input.prompt });
  return out;
}

/** One de-caged DRAFT pass for a single attempt. Compose-first cadence:
 *  the model emits text (the four fences); if it instead reaches for a
 *  bounded escape-hatch tool, the host dispatches it, appends the result,
 *  and re-prompts — but ONLY while `toolBudget.remaining > 0`. The budget
 *  is shared across the whole turn (passed in by reference) so repairs
 *  can't reset the cap. When the budget is exhausted (or zero, or no tools
 *  are exposed) the pass degrades to a plain tool-free compose — the
 *  pre-de-cage floor. Tool/dispatch errors never abort the draft: a failed
 *  call is fed back as an `ok:false` tool result and composition continues.
 *
 *  Returns the accumulated draft text/thinking, the last usage seen, and
 *  the StrategyEvents to forward (the helper does not yield directly so
 *  the caller keeps a flat event stream and the existing trace emits). */
interface DraftPassResult {
  draftText: string;
  draftThinking: string;
  turnUsage?: import('@inbrowser/agent').ModelUsage;
  lastUsage?: import('@inbrowser/agent').ModelUsage;
  lastDetails?: import('@inbrowser/agent').TurnDetails;
  /** Tool calls dispatched this pass (for the trace + a thrash readout). */
  toolCalls: Array<{ id: string; name: string }>;
  /** Forwarded verbatim to the caller's event stream, in order. */
  events: StrategyEvent[];
  /** Set when the model stream errored — caller aborts the turn. */
  error?: string;
  aborted?: boolean;
}

async function runDraftPass(
  input: StrategyRunInput,
  signal: AbortSignal,
  convo: NormalizedMsg[],
  toolDecls: ToolDeclarationView[],
  toolBudget: { remaining: number },
): Promise<DraftPassResult> {
  const res: DraftPassResult = { draftText: '', draftThinking: '', toolCalls: [], events: [] };
  // Tools are offered only while budget remains AND the host exposed any.
  // `toolUseEnabled:false` with an empty list = the exact pre-de-cage call.
  const MAX_HATCH_STEPS = 8; // hard stop independent of budget (defensive)
  for (let step = 0; step < MAX_HATCH_STEPS; step++) {
    const offerTools = toolDecls.length > 0 && toolBudget.remaining > 0;
    // `ModelRequest.tools` is the nested OAI `ToolSpec` shape; the bounded
    // decls are the flat `{name,description,parameters}` view, so wrap them
    // at the request boundary (the agent's own loop does the same).
    const toolSpecs: ToolSpec[] = (offerTools ? toolDecls : []).map((d) => ({
      type: 'function' as const,
      function: { name: d.name, description: d.description, parameters: d.parameters },
    }));
    const pendingCalls: Array<{ id: string; name: string; args: unknown }> = [];
    let sawText = false;
    for await (const ev of input.llm.chat(
      {
        messages: convo,
        tools: toolSpecs,
        toolUseEnabled: offerTools,
      },
      signal,
    )) {
      if (ev.kind === 'text') {
        res.draftText += ev.text;
        sawText = true;
        res.events.push({ kind: 'text', chunk: ev.text });
      } else if (ev.kind === 'thinking') {
        res.draftThinking += ev.text;
        res.events.push({ kind: 'thinking', chunk: ev.text });
      } else if (ev.kind === 'tool_call') {
        pendingCalls.push({ id: ev.id, name: ev.name, args: ev.args });
      } else if (ev.kind === 'usage') {
        // ModelEvent ends with a `usage` event (no `turn_complete` on the
        // stream, no `details`). Carry the ModelUsage through; synthesize
        // the turn details from the model id.
        res.turnUsage = ev.usage;
        res.lastUsage = ev.usage;
        res.lastDetails = { requestedModel: input.llm.id };
      } else if (ev.kind === 'error') {
        res.error = ev.message;
        return res;
      }
    }

    // No escape-hatch calls this round → the model composed its draft.
    if (pendingCalls.length === 0) return res;

    // The model reached for tools. Honor only as many as the budget
    // allows; ignore any that aren't in the bounded set (defensive — the
    // adapter shouldn't surface them, but never dispatch off-list).
    const allowed = new Set(toolDecls.map((d) => d.name));
    for (const call of pendingCalls) {
      if (toolBudget.remaining <= 0) break;
      if (!allowed.has(call.name)) {
        // Off-list call: feed back a refusal, don't spend budget. Still
        // OpenAI-strict — the assistant turn records the tool_call and the
        // refusal is a `role:'tool'` message keyed to its id.
        convo.push({
          role: 'assistant',
          text: '',
          toolCalls: [{ id: call.id, name: call.name, args: call.args }],
        });
        convo.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          resultJson: `tool ${call.name} is not available in the draft; compose without it`,
          text: '',
        });
        continue;
      }
      if (signal.aborted) {
        res.aborted = true;
        return res;
      }
      toolBudget.remaining -= 1;
      res.toolCalls.push({ id: call.id, name: call.name });
      res.events.push({ kind: 'tool_call', id: call.id, name: call.name, args: call.args });
      let result: ToolResult;
      try {
        result = await input.tools.execute({ id: call.id, name: call.name, args: call.args }, input.toolContext());
      } catch (e) {
        result = { ok: false, summary: `tool error: ${e instanceof Error ? e.message : String(e)}` };
      }
      res.events.push({ kind: 'tool_result', id: call.id, result });
      // OpenAI-strict tool sequence: the assistant turn that made the call
      // records `tool_calls[].id == call.id`; the result is a `role:'tool'`
      // message whose `tool_call_id` is that SAME id. Both transports
      // (toOai / toOaiMessages) lower these verbatim.
      convo.push({
        role: 'assistant',
        text: '',
        toolCalls: [{ id: call.id, name: call.name, args: call.args }],
      });
      convo.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        resultJson: `${result.ok ? 'ok' : 'error'}: ${result.summary}`,
        text: '',
      });
    }
    // Budget just ran dry while calls were pending → tell the model to
    // finish from here, then loop once more tool-free to collect the draft.
    if (toolBudget.remaining <= 0) {
      convo.push({ role: 'user', text: 'Tool budget exhausted — compose your final fenced artifacts now from what you have.' });
    }
    // If the model only emitted text alongside its tool calls (some
    // adapters interleave), that text is already captured; keep looping so
    // the post-tool composition lands a clean draft.
    void sawText;
  }
  return res;
}

export function createDraftThenValidateStrategy(
  config: DraftValidateConfig = {},
): AgentStrategy {
  const maxRepairs = config.maxRepairs ?? 2;
  const floor = config.floor ?? defaultFloor;
  const writeBack = config.writeBack ?? true;
  const rulesPath = config.rulesPath ?? '/workspace/firestore.rules';
  const appPath = config.appPath ?? '/workspace/src/App.tsx';
  const testsPath = config.testsPath ?? '/workspace/tests/draft.test.json';
  const specPath = config.specPath ?? '/workspace/app.spec.json';
  const testsFileName = testsPath.split('/').pop() ?? 'draft.test.json';
  // Degradation pin: a missing/unparseable spec gets exactly ONE repair
  // (zero when no repairs are configured) before validation falls back
  // to the three-fence behavior — the feature never makes DV worse.
  const specRepairBudget = Math.min(1, maxRepairs);
  // SF-S1 de-cage: the per-TURN tool-call budget for the escape hatch.
  // Clamped to ≥0; 0 = the pre-de-cage tool-free draft (degradation floor).
  const draftToolBudget = Math.max(0, config.draftToolBudget ?? DEFAULT_DRAFT_TOOL_BUDGET);

  return {
    id: 'draft-then-validate',
    async *run(input, signal): AsyncIterable<StrategyEvent> {
      const turnIdForReq = input.turnId ?? 'turn-anon';
      const convo = buildBaseMessages(input);
      // Resolve the bounded escape-hatch tool set ONCE from the host's
      // actual capability-filtered list. Empty (no tools, or budget 0) →
      // the draft runs tool-free, byte-for-byte the pre-de-cage compose.
      const toolDecls =
        draftToolBudget > 0 ? selectDraftToolDeclarations(input.toolList ?? []) : [];
      // Shared across ALL attempts this turn — repairs can't reset the cap.
      const toolBudget = { remaining: draftToolBudget };
      let lastUsage: import('@inbrowser/agent').ModelUsage | undefined;
      let lastDetails: import('@inbrowser/agent').TurnDetails | undefined;
      /** Latest parsed artifacts across attempts — repairs re-emit only
       *  what changed, so unchanged artifacts carry forward. These are
       *  also the write-back candidates after validation settles. */
      const artifacts: Artifacts = { spec: null, rules: null, app: null, appFiles: {}, tests: null };
      /** SF-S3: the ruleset actually validated last (host-compiled when a
       *  spec drove the attempt) — write-back lands THIS, not necessarily the
       *  model's fence. Null until a validation produced an effective ruleset. */
      let writeBackRules: string | null = null;

      for (let attempt = 0; attempt <= maxRepairs; attempt++) {
        if (signal.aborted) {
          yield { kind: 'error', message: 'aborted' };
          return;
        }

        // ── DRAFT (compose-first; bounded tool escape hatch) ─────────
        // LEASH (SF fix): the hatch is a RECOVERY mechanism, not a default
        // exploration loop. The INITIAL draft (attempt 0) is ALWAYS
        // tool-free — pure compose-first cadence — so weak models can't use
        // list_files/read_file as a first-reach default (de-caged DV
        // regressed deepseek-v4-flash: 26/27 runs hatched, 80× list_files +
        // 43× read_file, displacing clean composition). Tools are offered
        // ONLY on a repair attempt (after a validation failure), where a
        // missing fact is genuinely the blocker. Budget 0 / no host tools →
        // empty either way (the degradation floor).
        const attemptToolDecls = attempt > 0 ? toolDecls : [];
        yield { kind: 'custom', name: 'draft_started', data: { attempt, toolBudgetRemaining: toolBudget.remaining } };
        const requestId = `${turnIdForReq}#draft-${attempt}`;
        input.tracer?.emit({
          kind: 'llm_request',
          data: {
            requestId,
            turnId: turnIdForReq,
            iteration: attempt,
            ts: Date.now(),
            systemPrompt: convo[0]?.text ?? '',
            messages: convo.map((m) => ({ ...m })),
            tools: attemptToolDecls.map((d) => ({ name: d.name, description: d.description, parameters: d.parameters })),
            llm: { id: input.llm.id, supportsTools: input.llm.supportsTools },
          },
        });

        const pass = await runDraftPass(input, signal, convo, attemptToolDecls, toolBudget);
        // Forward the pass's events (text/thinking/tool_call/tool_result)
        // in order — the strategy keeps one flat event stream.
        for (const ev of pass.events) yield ev;
        if (pass.error) {
          yield { kind: 'error', message: pass.error };
          return;
        }
        if (pass.aborted || signal.aborted) {
          yield { kind: 'error', message: 'aborted' };
          return;
        }
        const draftText = pass.draftText;
        const draftThinking = pass.draftThinking;
        const turnUsage = pass.turnUsage;
        if (pass.lastUsage) lastUsage = pass.lastUsage;
        if (pass.lastDetails) lastDetails = pass.lastDetails;

        input.tracer?.emit({
          kind: 'llm_response',
          data: {
            requestId,
            ts: Date.now(),
            text: draftText,
            thinking: draftThinking,
            toolCalls: pass.toolCalls.map((c) => ({ id: c.id, name: c.name, args: null })),
            ...(turnUsage
              ? {
                  usage: {
                    promptTokens: turnUsage.promptTokens,
                    outputTokens: turnUsage.outputTokens,
                    ...(turnUsage.cachedTokens !== undefined
                      ? { cachedTokens: turnUsage.cachedTokens }
                      : {}),
                  },
                }
              : {}),
          },
        });

        // ── Parse + carry forward (repairs re-emit only what changed) ─
        const parsed = parseDraftArtifacts(draftText);
        if (parsed.spec) artifacts.spec = parsed.spec;
        if (parsed.rules) artifacts.rules = parsed.rules;
        if (parsed.app) artifacts.app = parsed.app;
        for (const [path, content] of Object.entries(parsed.appFiles)) {
          artifacts.appFiles[path] = content;
        }
        if (parsed.tests) artifacts.tests = parsed.tests;

        // ── VALIDATE (host-driven: build + test, one pass) ───────────
        // Spec mode: active while a usable spec exists or its one-repair
        // budget hasn't been spent; after that, fallback = the exact
        // three-fence behavior.
        const specMode: 'active' | 'fallback' =
          artifacts.spec?.spec || attempt < specRepairBudget ? 'active' : 'fallback';
        const validation = await validateDraft(attempt, artifacts, {
          ...(config.compileCheck ? { compileCheck: config.compileCheck } : {}),
          floor,
          appPath,
          testsFileName,
          specMode,
        });
        // Carry the validated ruleset (compiled or fence) for write-back.
        if (validation.effectiveRules) writeBackRules = validation.effectiveRules;

        input.tracer?.emit({
          kind: 'turn_dispatch_complete',
          data: { requestId, turnId: turnIdForReq, iteration: attempt, ts: Date.now(), toolCallCount: pass.toolCalls.length },
        });

        yield {
          kind: 'custom',
          name: 'validation_result',
          data: {
            attempt,
            total: validation.total,
            passed: validation.passed,
            artifacts: validation.artifacts,
            // SF-S3 checkpoint-#2 observability: where the validated ruleset
            // came from (host-compiled / model-authored / fallback) + the
            // hole counts. Lets the gate measure the host-compiled rate.
            rulesSource: validation.rulesSource,
            holes: validation.holes,
            holesUnfilled: validation.holesUnfilled,
            // Spec observables (custom-condition rate; derived-vs-model
            // attribution comes from `failures[].source` + these counts).
            ...(validation.spec ? { spec: validation.spec } : {}),
            failures: validation.failures.map((f) => ({
              artifact: f.artifact,
              kind: f.kind,
              expect: f.expect,
              got: f.got,
              source: f.source,
              ...(f.method ? { method: f.method } : {}),
              ...(f.path ? { path: f.path } : {}),
              ...(f.as !== undefined ? { as: f.as } : {}),
              ...(f.name ? { name: f.name } : {}),
              ...(f.detail ? { detail: f.detail } : {}),
              ...(f.rule ? { rule: f.rule } : {}),
            })),
          },
        };

        if (validation.failures.length === 0) break; // green — done

        if (attempt < maxRepairs) {
          yield {
            kind: 'custom',
            name: 'repair_started',
            data: { attempt: attempt + 1, failures: validation.failures.length },
          };
          convo.push({ role: 'assistant', text: draftText });
          convo.push({ role: 'user', text: formatRepairFeedback(validation) });
          continue;
        }

        // Out of repairs — surface and return the best draft anyway
        // (validation never hard-blocks the answer; the router may
        // escalate on floor evidence). A derived-case failure surviving
        // the repair budget is flagged as a POSSIBLE SPEC ERROR — the
        // spec is a model-authored witness, so a standing disagreement
        // may mean the witness itself is wrong (surfaced, not fatal).
        const derivedRemaining = validation.failures.filter((f) => f.source === 'derived');
        yield {
          kind: 'custom',
          name: 'validation_exhausted',
          data: {
            attempt,
            remaining: validation.failures.length,
            ...(derivedRemaining.length > 0
              ? {
                  possibleSpecErrors: derivedRemaining.map((f) => ({
                    ...(f.name ? { name: f.name } : {}),
                    ...(f.method ? { method: f.method } : {}),
                    ...(f.path ? { path: f.path } : {}),
                    ...(f.rule ? { rule: f.rule } : {}),
                  })),
                }
              : {}),
          },
        };
        break;
      }

      // ── WRITE-BACK (host-driven) — ALL artifacts land via the real
      // write_file tool, so auto-deploy, the preview, and the C1 write
      // gate see them. Never blocks the answer: a failed dispatch is
      // surfaced as an ok:false tool_result and the turn still completes.
      if (writeBack && !signal.aborted) {
        const writes: Array<{ tag: string; path: string; content: string }> = [];
        // SF-S3: write back the HOST-COMPILED ruleset when a spec drove the
        // last validation (writeBackRules), else the model's fence. The
        // model's rules fence is never written when the host owns rules.
        const finalRules = writeBackRules ?? artifacts.rules;
        if (finalRules) writes.push({ tag: 'rules', path: rulesPath, content: finalRules });
        if (artifacts.app) writes.push({ tag: 'app', path: appPath, content: artifacts.app });
        Object.entries(artifacts.appFiles)
          .filter(([path]) => path !== appPath)
          .sort(([a], [b]) => a.localeCompare(b))
          .forEach(([path, content], index) => {
            writes.push({ tag: `app-${index + 1}`, path, content });
          });
        if (artifacts.tests?.file) {
          writes.push({ tag: 'tests', path: testsPath, content: JSON.stringify(artifacts.tests.file, null, 2) });
        }
        // The spec lands as a plain workspace file (transparency, not
        // enforcement) — only when it validated; a fallback turn writes
        // exactly the three files it always did.
        if (artifacts.spec?.spec) {
          writes.push({ tag: 'spec', path: specPath, content: JSON.stringify(artifacts.spec.spec, null, 2) });
        }
        for (const w of writes) {
          const callId = `${turnIdForReq}#writeback-${w.tag}`;
          const args = { path: w.path, content: w.content };
          yield { kind: 'tool_call', id: callId, name: 'write_file', args };
          let result: ToolResult;
          try {
            result = await input.tools.execute(
              { id: callId, name: 'write_file', args },
              input.toolContext(),
            );
          } catch (e) {
            result = {
              ok: false,
              summary: `write-back failed: ${e instanceof Error ? e.message : String(e)}`,
            };
          }
          yield { kind: 'tool_result', id: callId, result };
        }
      }

      if (lastUsage && lastDetails) {
        yield { kind: 'turn_complete', usage: lastUsage, details: lastDetails };
      }
    },
  };
}
