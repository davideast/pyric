/**
 * `run_workspace_tests` — W1.2: the workspace dev loop as ONE tool call
 * (workstation-architecture.md). Loads every `/workspace/tests/*.test.json`,
 * runs it hermetically against the workspace ruleset via the W1 runner
 * (real data plane, per-file seeds, identity-with-claims), and returns one
 * compact report — replacing the per-case `simulate_firestore_write`
 * fan-out that re-shipped the ruleset on every call.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { commitCheckpoint } from '~/lib/checkpoints/service';
import { RULES_PATH, WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';
import {
  runWorkspaceTests,
  type TestRunReport,
} from '~/lib/workspace-tests/runner';

export const TESTS_DIR = `${WORKSPACE_ROOT}/tests`;

async function readUtf8(path: string): Promise<string | null> {
  try {
    const v = await getVFS().promises.readFile(path, 'utf8');
    return typeof v === 'string' ? v : new TextDecoder().decode(v);
  } catch {
    return null;
  }
}

async function listTestFiles(): Promise<string[]> {
  const vfs = getVFS();
  try {
    const entries = (await vfs.promises.readdir(TESTS_DIR)) as string[];
    return entries
      .filter((e) => e.endsWith('.test.json'))
      .sort()
      .map((e) => `${TESTS_DIR}/${e}`);
  } catch {
    return []; // no tests dir yet
  }
}

export interface RunWorkspaceTestsData extends TestRunReport {
  rulesSource: 'workspace';
  /** W3.1 — auto-checkpoint evidence. Present when the suite was green and
   *  the host committed a checkpoint (`{sha}`) or tried and failed
   *  (`{error}`). Absent on red suites or when nothing changed. */
  checkpoint?: { sha: string } | { error: string };
}

export const runWorkspaceTestsHandler: ToolHandler<
  Record<string, never>,
  RunWorkspaceTestsData | { reason: string }
> = {
  name: 'run_workspace_tests',
  parallelSafe: true, // hermetic: each run builds its own sandboxes
  description:
    'Run every workspace test file (`/workspace/tests/*.test.json`) against the CURRENT `/workspace/firestore.rules` and return one compact pass/fail report. Each file is hermetic: a fresh sandbox, the ruleset deployed once, then `cases` executed through the real data plane under each case\'s identity (custom claims under `as.token` read as `request.auth.token.<name>`). Cases are INDEPENDENT — the data plane resets to `seed` (applied admin-bypass) before every case, so a case\'s writes never affect another case; any doc a case reads/updates/deletes must be in `seed`. Test file shape: `{ "seed": [{path, data}], "cases": [{ "as": {uid, token?}|null, "do": {method: get|list|create|update|delete, path, data?}, "expect": "ALLOW"|"DENY", "name"? }] }` — `list` takes a collection path and runs as a real query. Use this INSTEAD of per-case simulate calls: author the suite once with write_file, run it after every rules edit. A `got: "ERROR"` failure means the test or seed is wrong (e.g. update on a missing doc), not the rules.',
  parameters: { type: 'object', properties: {} },
  async execute() {
    const rules = await readUtf8(RULES_PATH);
    if (!rules || rules.trim().length === 0) {
      return {
        ok: false,
        summary: 'run_workspace_tests: no /workspace/firestore.rules to test against',
        data: { reason: 'no ruleset' },
      };
    }
    const paths = await listTestFiles();
    if (paths.length === 0) {
      return {
        ok: false,
        summary:
          'run_workspace_tests: no test files — author /workspace/tests/<name>.test.json first (shape in this tool\'s description)',
        data: { reason: 'no test files' },
      };
    }
    const files: Array<{ name: string; content: string }> = [];
    for (const p of paths) {
      const content = await readUtf8(p);
      if (content !== null) files.push({ name: p.slice(TESTS_DIR.length + 1), content });
    }
    const report = await runWorkspaceTests(files, rules);
    // W3.1 auto-commit on green: a fully-passing suite is a verified
    // workspace state — checkpoint it. Best-effort: git trouble rides
    // back as evidence (`checkpoint.error`), never fails the test run.
    let checkpoint: { sha: string } | { error: string } | undefined;
    if (report.ok && report.total > 0) {
      try {
        const sha = await commitCheckpoint(`tests green: ${report.passed}/${report.total}`);
        if (sha) checkpoint = { sha };
      } catch (e) {
        checkpoint = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const failNote =
      report.failed > 0
        ? ` · failures in ${report.files
            .filter((f) => f.failures.length > 0 || f.error)
            .map((f) => f.file)
            .join(', ')}`
        : '';
    return {
      ok: true,
      summary: `run_workspace_tests · ${report.passed}/${report.total} passed across ${report.files.length} file(s)${failNote}`,
      data: { ...report, rulesSource: 'workspace', ...(checkpoint ? { checkpoint } : {}) },
    };
  },
};
