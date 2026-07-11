/**
 * Workspace test runner — W1 of the workstation architecture
 * (plans/agent-capability-epic/workstation-architecture.md).
 *
 * Executes declarative rule/app tests from `/workspace/tests/*.test.json`
 * against a HERMETIC sandbox: each test file gets a fresh
 * `initializeSandbox()`, the candidate ruleset is deployed ONCE, declared
 * seeds are applied via admin bypass, and every case runs through the
 * REAL pyric data plane (`getDoc`/`getDocs`/`setDoc`/…) under the case's
 * identity. This is the structural fix for the DV sweep's failure modes
 * (conductor log 2026-06-10):
 *
 *   - `list` runs as an actual query through the post-#536 enforcement
 *     path — no simulator collection-path matching defect;
 *   - owner-read/update cases run against SEEDED docs (`seed:` block) —
 *     no `resource.data = {}` false DENYs;
 *   - the ruleset is deployed once per file — zero re-shipped bytes;
 *   - one runner invocation replaces the per-case tool-call fan-out.
 *
 * Execution contract (documented, deliberate):
 *   - Files are independent (fresh sandbox + seeds per file).
 *   - Cases are ISOLATED: before EVERY case the data plane is reset to
 *     the file's `seed` (admin bypass; rules stay deployed once per
 *     file). A case's writes are invisible to later cases, so outcomes
 *     never depend on case order — the shared-state contract this
 *     replaces let one case's ALLOWed write silently change what later
 *     cases evaluated against (conductor session 2026-06-09: an admin
 *     status update broke a later owner-delete case). Cases that need a
 *     doc to exist declare it in `seed`.
 *   - Cases still run sequentially: identity is sandbox-global
 *     (`authOps.setUser`), so concurrent dispatch would race identities —
 *     the same trap that bit the DV sweep's display layer.
 *
 * Browser- and node-safe: pyric only, no fs (callers load file contents).
 */
import { initializeSandbox } from 'pyric/sandbox';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  sandbox as fsOps,
  setDoc,
  updateDoc,
} from 'pyric/firestore';
import { getAuth, sandbox as authOps, type User } from 'pyric/auth';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { FIRESTORE_METHODS, type FirestoreMethod, type TestIdentity } from 'pyric/rules/internal';

export type CaseExpect = 'ALLOW' | 'DENY';

export interface WorkspaceTestCase {
  /** Identity for the case. `null` = unauthenticated. Custom claims go
   *  under `token` and read as `request.auth.token.<name>` in rules. */
  as: TestIdentity | null;
  do: {
    method: FirestoreMethod;
    /** Document path (collection path for `list`). */
    path: string;
    /** Incoming data for create/update. */
    data?: Record<string, unknown>;
  };
  expect: CaseExpect;
  /** Provenance: 'floor' = host-authored invariant (a failure means the
   *  rules are genuinely wrong); 'authored' = model/user-written;
   *  'derived' = host-derived from the app-spec access matrix (a failure
   *  means the rules disagree with the spec — either may be wrong).
   *  Feeds the router's floor-evidence escalation policy. */
  source?: 'floor' | 'authored' | 'derived';
  /** Optional human label surfaced in failure reports. */
  name?: string;
}

export interface WorkspaceTestFile {
  /** Admin-bypass fixture docs. The data plane is reset to exactly this
   *  set before EVERY case — cases are isolated from each other's writes. */
  seed?: Array<{ path: string; data: Record<string, unknown> }>;
  cases: WorkspaceTestCase[];
}

export interface CaseFailure {
  name?: string;
  method: FirestoreMethod;
  path: string;
  as: WorkspaceTestCase['as'];
  expect: CaseExpect;
  /** What actually happened. `ERROR` = a non-rules failure (e.g. update
   *  on a missing doc) — fix the test or seed, not the rules. */
  got: CaseExpect | 'ERROR';
  source: 'floor' | 'authored' | 'derived';
  detail?: string;
}

export interface FileReport {
  file: string;
  total: number;
  passed: number;
  failures: CaseFailure[];
  /** Non-case-level failure: unparseable file, rules deploy error, … */
  error?: string;
}

export interface TestRunReport {
  files: FileReport[];
  total: number;
  passed: number;
  failed: number;
  ok: boolean;
}

/** Parse + structurally validate one test file. Throws with an
 *  agent-actionable message on malformed input. */
export function parseWorkspaceTestFile(json: string): WorkspaceTestFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const f = raw as Partial<WorkspaceTestFile>;
  if (!Array.isArray(f.cases) || f.cases.length === 0) {
    throw new Error('`cases` must be a non-empty array');
  }
  for (const [i, c] of f.cases.entries()) {
    if (!c || typeof c !== 'object') throw new Error(`cases[${i}] must be an object`);
    if (c.as !== null && (typeof c.as !== 'object' || typeof c.as?.uid !== 'string')) {
      throw new Error(`cases[${i}].as must be null or { uid, token? }`);
    }
    const m = c.do?.method;
    if (!m || !(FIRESTORE_METHODS as readonly string[]).includes(m)) {
      throw new Error(`cases[${i}].do.method must be ${FIRESTORE_METHODS.join('|')}`);
    }
    if (typeof c.do?.path !== 'string' || c.do.path.length === 0) {
      throw new Error(`cases[${i}].do.path must be a non-empty string`);
    }
    if (c.expect !== 'ALLOW' && c.expect !== 'DENY') {
      throw new Error(`cases[${i}].expect must be ALLOW or DENY`);
    }
  }
  if (f.seed !== undefined) {
    if (!Array.isArray(f.seed)) throw new Error('`seed` must be an array');
    for (const [i, s] of f.seed.entries()) {
      if (typeof s?.path !== 'string' || !s.path.includes('/')) {
        throw new Error(`seed[${i}].path must be a document path like "orders/o1"`);
      }
      if (!s.data || typeof s.data !== 'object') {
        throw new Error(`seed[${i}].data must be an object`);
      }
    }
  }
  return f as WorkspaceTestFile;
}

function isPermissionDenied(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code ?? '';
  return code.includes('permission-denied');
}

/**
 * Reset the data plane to the file's declared `seed` (admin bypass).
 * Every document currently in the sandbox is deleted, then every seed
 * doc is rewritten — so each case starts from exactly the declared
 * fixture state. Rules are NOT touched: deploy stays once-per-file.
 * Pure in-memory map operations; see runner tests for the cost pin.
 */
function resetToSeed(
  env: ReturnType<typeof getInternalEnv>,
  seed: WorkspaceTestFile['seed'],
): void {
  for (const path of Object.keys(env.snapshot())) {
    env.adminDeleteDocument(path);
  }
  for (const s of seed ?? []) {
    env.adminSetDocument(s.path, s.data);
  }
}

/** Run one parsed test file against a fresh hermetic sandbox. Rules are
 *  deployed once; the data plane resets to `seed` before every case. */
export async function runTestFile(
  name: string,
  file: WorkspaceTestFile,
  rules: string,
): Promise<FileReport> {
  const report: FileReport = { file: name, total: file.cases.length, passed: 0, failures: [] };
  const sbx = initializeSandbox();
  const db = getFirestore(sbx);
  const auth = getAuth(sbx);
  try {
    fsOps.setRules(db, rules);
  } catch (e) {
    report.error = `rules deploy failed: ${e instanceof Error ? e.message : String(e)}`;
    return report;
  }
  const env = getInternalEnv(sbx);

  // Pre-register every distinct case identity in the user DB. Claims
  // resolution is record-based: `setUser` reads `customClaims` off the
  // STORED user (sandbox-backend `setCurrentUser`), so an identity that
  // doesn't exist would evaluate rules with empty `request.auth.token`.
  const seen = new Set<string>();
  for (const c of file.cases) {
    if (!c.as || seen.has(c.as.uid)) continue;
    seen.add(c.as.uid);
    authOps.createUser(auth, { uid: c.as.uid, customClaims: c.as.token ?? {} });
  }

  // Sequential by construction — identity is sandbox-global. Each case
  // is ISOLATED: the data plane resets to the declared seed first, so a
  // case's writes never leak into the next case's evaluation.
  for (const c of file.cases) {
    resetToSeed(env, file.seed);
    authOps.setUser(auth, c.as ? ({ uid: c.as.uid } as User) : null);
    let got: CaseExpect | 'ERROR';
    let detail: string | undefined;
    try {
      const { method, path, data } = c.do;
      if (method === 'get') await getDoc(doc(db, path));
      else if (method === 'list') await getDocs(query(collection(db, path)));
      else if (method === 'create') await setDoc(doc(db, path), data ?? {});
      else if (method === 'update') await updateDoc(doc(db, path), data ?? {});
      else await deleteDoc(doc(db, path));
      got = 'ALLOW';
    } catch (e) {
      if (isPermissionDenied(e)) {
        got = 'DENY';
      } else {
        got = 'ERROR';
        detail = e instanceof Error ? e.message : String(e);
      }
    }
    if (got === c.expect) {
      report.passed += 1;
    } else {
      report.failures.push({
        ...(c.name ? { name: c.name } : {}),
        method: c.do.method,
        path: c.do.path,
        as: c.as,
        expect: c.expect,
        got,
        source: c.source ?? 'authored',
        ...(detail ? { detail } : {}),
      });
    }
  }
  return report;
}

/** Run a set of test files (already loaded from the VFS) against one
 *  candidate ruleset. Each file is hermetic. */
export async function runWorkspaceTests(
  files: Array<{ name: string; content: string }>,
  rules: string,
): Promise<TestRunReport> {
  const reports: FileReport[] = [];
  for (const { name, content } of files) {
    let parsed: WorkspaceTestFile;
    try {
      parsed = parseWorkspaceTestFile(content);
    } catch (e) {
      reports.push({
        file: name,
        total: 0,
        passed: 0,
        failures: [],
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    reports.push(await runTestFile(name, parsed, rules));
  }
  const total = reports.reduce((n, r) => n + r.total, 0);
  const passed = reports.reduce((n, r) => n + r.passed, 0);
  const failed = total - passed;
  const ok = failed === 0 && reports.every((r) => !r.error);
  return { files: reports, total, passed, failed, ok };
}
