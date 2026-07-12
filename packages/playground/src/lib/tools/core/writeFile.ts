/**
 * `write_file` — create or overwrite a file in the OPFS VFS.
 * Replaces `writeApp` / `writeCode` / `writeRules` with a single
 * path-keyed write surface.
 *
 * Side effects:
 *   - intermediate directories are created automatically.
 *   - calls `notifyVfsWrite` so the legacy workspace store mirrors
 *     `/workspace/firestore.rules` and `/workspace/src/App.tsx` until
 *     Phase C swaps the compile/deploy reads to the VFS directly.
 */
import type { ToolHandler, ToolResult } from '@inbrowser/agent';
import { resolveModulesBrowser } from 'pyric/rules/internal';

import { notifyVfsWrite } from '~/lib/files/bootstrap';
import { RULES_PATH, WORKSPACE_ROOT, useFilesStore } from '~/lib/store/files';
import { diffLines, type DiffStats } from '~/lib/utils/diff';
import { getVFS } from '~/lib/vfs';
import { runWorkspaceTests, type CaseFailure } from '~/lib/workspace-tests/runner';
import { TESTS_DIR } from './runWorkspaceTests';
import {
  isAppSourcePath,
  summarizeValidation,
  validateAppWrite,
  validateRulesWrite,
  type WriteValidation,
} from './write-gates';

/** Detect a `2+modules` ruleset (uses stdlib `import { … } from '…'` lines
 *  the in-browser evaluator can't run until they're inlined). */
const IS_MODULAR_RULES = /^\s*rules_version\s*=\s*['"]2\+modules['"]/m;

export interface WriteFileArgs {
  path: string;
  content: string;
}

/** One failing case from the ambient suite run — the compact subset of the
 *  runner's `CaseFailure` that an agent needs to repair (W1.4). */
export interface WriteTestsFailure {
  method: string;
  path: string;
  expect: string;
  /** `ERROR` = a non-rules failure (broken test/seed), not a denial. */
  got: string;
  source: CaseFailure['source'];
  name?: string;
  detail?: string;
}

/**
 * Ambient workspace-test evidence (W1.4): writes that affect the suite
 * (rules + `/workspace/tests/*.test.json`) auto-run it and report here.
 * Same contract as the C1 gates — REPORT, never block. Exactly one of
 * `{total,…}` / `skipped` / `error` shapes is present.
 */
export interface WriteTestsBlock {
  total?: number;
  passed?: number;
  failed?: number;
  /** Capped at {@link TESTS_FAILURE_CAP}; `failed` carries the true count. */
  failures?: WriteTestsFailure[];
  /** File-level problems (unparseable test file, rules deploy error) —
   *  e.g. the test file just written fails to parse. */
  errors?: string[];
  /** The suite didn't run, with the reason ('no test files', 'no ruleset',
   *  'rules parse error'). Only reported when it's signal — silent on rules
   *  writes before any tests exist. */
  skipped?: string;
  /** The gate itself crashed — write landed without test evidence. */
  error?: string;
}

export interface WriteFileData {
  path: string;
  bytes: number;
  replaced: boolean;
  diff: DiffStats;
  /** Host-side validation evidence (C1 gates + W1.4 ambient tests).
   *  Present on rules + `.tsx`/`.ts` + test-file writes; empty arrays =
   *  verified clean. The gates REPORT — the write has already landed
   *  regardless of what's in here. */
  validation?: WriteValidation & { tests?: WriteTestsBlock };
}

export function assertWithinWorkspace(path: string): void {
  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new Error(`Path must live under ${WORKSPACE_ROOT}/`);
  }
}

export async function readPriorContent(path: string): Promise<string> {
  try {
    const value = await getVFS().promises.readFile(path, 'utf8');
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

// ─── W1.4 — ambient workspace tests on suite-affecting writes ─────────

/** A workspace test file: directly under /workspace/tests/, *.test.json. */
const TEST_FILE_RE = /^\/workspace\/tests\/[^/]+\.test\.json$/;

export function isWorkspaceTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

/** Cap on reported failure rows — `failed` carries the true count. */
const TESTS_FAILURE_CAP = 10;

async function readUtf8OrNull(path: string): Promise<string | null> {
  try {
    const v = await getVFS().promises.readFile(path, 'utf8');
    return typeof v === 'string' ? v : new TextDecoder().decode(v);
  } catch {
    return null;
  }
}

/**
 * Run the workspace suite after a write that affects it (the rules file or
 * a test file) — the same loading semantics as the `run_workspace_tests`
 * tool, ONE runner invocation, rules deployed once per file by the runner.
 *
 * Skip/report semantics (deliberate):
 *   - No test files: silent on rules writes (no noise pre-suite); a
 *     test-file TARGET reports `skipped` — an authored test that can't be
 *     found/run is signal.
 *   - Rules that failed to parse (lint already reported it): skipped —
 *     every file would just repeat "rules deploy failed".
 *   - Green suites do NOT auto-checkpoint here: checkpoint semantics stay
 *     "a deliberate green test run" (the run_workspace_tests tool / the
 *     `run-tests` builtin), not "a write that happened to leave tests green".
 *   - Never throws; a crash degrades to `{error}` — write-without-tests.
 */
async function runAmbientTests(
  target: 'rules' | 'test',
  rules: string | null,
): Promise<WriteTestsBlock | undefined> {
  try {
    if (!rules || rules.trim().length === 0) {
      return target === 'test' ? { skipped: 'no ruleset' } : undefined;
    }
    let entries: string[] = [];
    try {
      entries = (await getVFS().promises.readdir(TESTS_DIR)) as string[];
    } catch {
      // no tests dir yet — handled by the empty-list branch below
    }
    const names = entries.filter((e) => e.endsWith('.test.json')).sort();
    if (names.length === 0) {
      return target === 'test' ? { skipped: 'no test files' } : undefined;
    }
    const files: Array<{ name: string; content: string }> = [];
    for (const n of names) {
      const content = await readUtf8OrNull(`${TESTS_DIR}/${n}`);
      if (content !== null) files.push({ name: n, content });
    }
    const report = await runWorkspaceTests(files, rules);
    const errors = report.files
      .filter((f) => f.error)
      .map((f) => `${f.file}: ${f.error}`);
    const failures: WriteTestsFailure[] = [];
    for (const f of report.files) {
      for (const fl of f.failures) {
        if (failures.length >= TESTS_FAILURE_CAP) break;
        failures.push({
          method: fl.method,
          path: fl.path,
          expect: fl.expect,
          got: fl.got,
          source: fl.source,
          ...(fl.name ? { name: fl.name } : {}),
          ...(fl.detail ? { detail: fl.detail } : {}),
        });
      }
    }
    return {
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      failures,
      ...(errors.length > 0 ? { errors: errors.slice(0, TESTS_FAILURE_CAP) } : {}),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** One-line summary fragment for the `tests` block. */
function summarizeTests(t: WriteTestsBlock): string {
  if (t.skipped) return `tests skipped (${t.skipped})`;
  if (t.error) return `tests gate error`;
  const errNote = t.errors?.length
    ? `, ${t.errors.length} file error${t.errors.length === 1 ? '' : 's'}`
    : '';
  return `tests ${t.passed}/${t.total}${errNote}`;
}

export interface CommitWorkspaceFileOpts {
  /** Tool name used in the one-line summary. */
  toolName?: string;
}

/**
 * Shared file-commit pipeline for mutating file tools. This is the single
 * path that mirrors workspace writes, resolves modular rules for deploy,
 * runs rules/app validation, and triggers ambient workspace tests.
 */
export async function commitWorkspaceFile(
  path: string,
  content: string,
  opts: CommitWorkspaceFileOpts = {},
): Promise<ToolResult<WriteFileData>> {
  const toolName = opts.toolName ?? 'write_file';
  assertWithinWorkspace(path);
  const adapter = getVFS();
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent && parent !== WORKSPACE_ROOT) {
    await adapter.promises.mkdir(parent, { recursive: true });
  }
  const prior = await readPriorContent(path);
  await adapter.promises.writeFile(path, content);

  // `2+modules` rulesets carry stdlib imports the in-browser evaluator (and
  // the deploy/oracle) can't run until they're inlined. Resolve them here so
  // the agent can author modular rules naturally without a separate
  // resolve_modules call — the VFS file keeps the authored modular source,
  // while the deployed/evaluated ruleset (mirrored to the workspace store)
  // is the inlined form. Resolution failure is surfaced so the agent can fix
  // a bad import instead of silently shipping un-evaluatable rules.
  let deployContent = content;
  let moduleNote = '';
  if (path === RULES_PATH && IS_MODULAR_RULES.test(content)) {
    const res = resolveModulesBrowser(content);
    if (res.success) {
      deployContent = res.data.resolved;
      moduleNote = ` · inlined ${res.data.modules.length} stdlib module(s)`;
    } else {
      // The VFS file keeps the broken source (so the agent can re-read and
      // fix it), but DON'T mirror it to the workspace store — that store
      // feeds auto-deploy + the oracle, and replacing the last-good ruleset
      // with un-evaluatable source would deny every request while the agent
      // repairs the import. Bump the tree only, so the file panel refreshes.
      useFilesStore.getState().bumpTree();
      return {
        ok: false,
        summary: `${toolName} · ${path} · module resolution failed: ${res.error.message}`,
        data: { path, bytes: content.length, replaced: prior.length > 0, diff: diffLines(prior, content) },
      };
    }
  }
  notifyVfsWrite(path, deployContent);

  // ── Host-side validation gates (C1) — run AFTER the write/deploy.
  // Report, never block: the write above has already landed; whatever
  // the gates find rides back as repair evidence. A gate that can't
  // run degrades to write-without-validation (`gateError`).
  let validation: WriteValidation | undefined;
  if (path === RULES_PATH) {
    validation = validateRulesWrite(deployContent);
  } else if (isAppSourcePath(path)) {
    validation = await validateAppWrite(path, content);
  }

  // ── Ambient workspace tests (W1.4) — a write that affects the suite
  // (the rules file or a test file) runs it, same report-don't-block
  // contract. Un-parseable rules skip the run (the lint entry above IS
  // the evidence; every test file would only repeat the deploy failure).
  let tests: WriteTestsBlock | undefined;
  const isTestFile = isWorkspaceTestPath(path);
  if (path === RULES_PATH || isTestFile) {
    const rulesParseError =
      validation?.lint?.[0]?.startsWith('error: parse error') ?? false;
    if (rulesParseError) {
      tests = { skipped: 'rules parse error' };
    } else {
      // Rules write: test against the just-deployed (resolved) source.
      // Test-file write: load the workspace rules like the tool does.
      const rules = path === RULES_PATH ? deployContent : await readUtf8OrNull(RULES_PATH);
      tests = await runAmbientTests(isTestFile ? 'test' : 'rules', rules);
    }
  }

  const diff = diffLines(prior, content);
  const notes: string[] = [];
  if (validation) notes.push(summarizeValidation(validation));
  if (tests) notes.push(summarizeTests(tests));
  const validationNote = notes.length > 0 ? ` · ${notes.join(' · ')}` : '';
  const fullValidation =
    validation || tests
      ? { ...(validation ?? {}), ...(tests ? { tests } : {}) }
      : undefined;
  const summary = prior.length > 0
    ? `${toolName} · ${path} · +${diff.added} / −${diff.removed} lines${moduleNote}${validationNote}`
    : `${toolName} · ${path} · ${content.split('\n').length} lines${moduleNote}${validationNote}`;
  return {
    ok: true,
    summary,
    data: {
      path,
      bytes: content.length,
      replaced: prior.length > 0,
      diff,
      ...(fullValidation ? { validation: fullValidation } : {}),
    },
  };
}

export const writeFileHandler: ToolHandler<WriteFileArgs, WriteFileData> = {
  name: 'write_file',
  description:
    "Create or overwrite a file in the OPFS VFS under /workspace/. REPLACES THE ENTIRE FILE — no merge. Use for App TSX, Firestore rules, RTDB rules, helper modules, any user-facing source. Special paths: `/workspace/src/App.tsx` is the preview entry, `/workspace/firestore.rules` is the Firestore rules file that auto-deploys, and `/workspace/database.rules.json` is the Realtime Database rules file that auto-deploys in shared sandbox mode. Intermediate directories are created automatically. The host AUTO-VALIDATES each save and returns a `validation` block in the result — Firestore rules files: lint + a replay of this session's captured traffic ({lint, regressions, stillDenied, unblocked}); .tsx/.ts files: a compile check ({compile}). Writes to the Firestore rules file or a /workspace/tests/*.test.json file ALSO auto-run the workspace test suite when one exists — `validation.tests` carries {total, passed, failed, failures} (no need to call run_workspace_tests after such a write). Empty arrays = verified clean (no need to lint or re-simulate what was already verified). The write always lands; if validation reports issues, fix them in a follow-up write_file.",
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to write. Must start with /workspace/.',
      },
      content: {
        type: 'string',
        description: 'Full file contents (UTF-8).',
      },
    },
    required: ['path', 'content'],
  },
  async execute({ path, content }) {
    return commitWorkspaceFile(path, content, { toolName: 'write_file' });
  },
};
