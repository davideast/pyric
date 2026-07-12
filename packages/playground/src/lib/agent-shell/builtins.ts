/**
 * Playground capabilities mounted as shell builtins (W2.1, Move W2 of
 * workstation-architecture.md). Each builtin is a `just-bash` custom
 * `Command` registered on the agent shell's Bash instance:
 *
 *   run-tests [pattern]   the W1 workspace test runner (the shell layer
 *                         also routes a leading `test` token here —
 *                         just-bash's interpreter owns `test`/`[`, so a
 *                         registry command named `test` never fires;
 *                         see session.ts). A green FULL-suite run
 *                         auto-commits a workspace checkpoint (W3.1
 *                         parity with the run_workspace_tests tool).
 *   lint-rules [path]     the same `lintFirestoreRules` linter the
 *                         write_file gate and firestore_lint_rules use
 *   man <topic>           paged docs on demand (man-pages.ts)
 *
 * Builtins read workspace files through `ctx.fs` — the SAME mounted
 * filesystem the rest of the shell sees (OPFS in the browser, the
 * in-memory VFS adapter headless), so `test` and `lint-rules` always
 * operate on what `cat` would show.
 */
import type { Command, ExecResult } from 'just-bash';
import { lintFirestoreRules } from 'pyric/rules/internal';

import { commitCheckpoint } from '~/lib/checkpoints/service';
import { RULES_PATH } from '~/lib/store/files';
import { TESTS_DIR } from '~/lib/tools/core/runWorkspaceTests';
import {
  runWorkspaceTests,
  type TestRunReport,
} from '~/lib/workspace-tests/runner';

import { MAN_PAGES, MAN_SUMMARIES, MAN_TOPICS } from './man-pages';
import { resolveActiveSkills } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

function fail(name: string, message: string, exitCode = 1): ExecResult {
  return { stdout: '', stderr: `${name}: ${message}\n`, exitCode };
}

// ─── run-tests ────────────────────────────────────────────────────────

function describeIdentity(as: { uid: string } | null): string {
  return as ? `as ${as.uid}` : 'unauthenticated';
}

/** Compact, line-oriented text rendering of the W1 runner report. */
export function formatTestReport(report: TestRunReport): string {
  const lines: string[] = [];
  for (const f of report.files) {
    const mark = f.error || f.failures.length > 0 ? '✗' : '✓';
    lines.push(`${mark} ${f.file} ${f.passed}/${f.total}`);
    if (f.error) lines.push(`  ! ${f.error}`);
    for (const fl of f.failures) {
      const label = fl.name ? `${fl.name} — ` : '';
      const detail = fl.detail ? ` (${fl.detail})` : '';
      lines.push(
        `  ✗ ${label}${fl.method} ${fl.path} ${describeIdentity(fl.as)} — expected ${fl.expect}, got ${fl.got}${detail}`,
      );
    }
  }
  lines.push(
    `${report.passed}/${report.total} passed across ${report.files.length} file(s) · ${report.ok ? 'PASS' : 'FAIL'}`,
  );
  return `${lines.join('\n')}\n`;
}

export const runTestsCommand: Command = {
  name: 'run-tests',
  // Host-extension command: the pyric sandbox uses `Proxy` (blocked for
  // untrusted commands by just-bash's DefenseInDepthBox).
  trusted: true,
  async execute(args, ctx) {
    const pattern = args[0];
    let rules: string;
    try {
      rules = await ctx.fs.readFile(RULES_PATH);
    } catch {
      return fail('test', `no ${RULES_PATH} — write rules first (man rules)`);
    }
    if (rules.trim().length === 0) {
      return fail('test', `${RULES_PATH} is empty — write rules first (man rules)`);
    }

    let entries: string[] = [];
    try {
      entries = await ctx.fs.readdir(TESTS_DIR);
    } catch {
      // no tests dir yet — handled below
    }
    const allNames = entries.filter((e) => e.endsWith('.test.json')).sort();
    const names = pattern ? allNames.filter((n) => n.includes(pattern)) : allNames;
    if (names.length === 0) {
      return fail(
        'test',
        pattern
          ? `no test files matching "${pattern}" in ${TESTS_DIR}/`
          : `no test files — author ${TESTS_DIR}/<name>.test.json first (man test)`,
      );
    }

    const files: Array<{ name: string; content: string }> = [];
    for (const n of names) {
      files.push({ name: n, content: await ctx.fs.readFile(`${TESTS_DIR}/${n}`) });
    }
    const report = await runWorkspaceTests(files, rules);

    // W1.4 — checkpoint-on-green parity with the run_workspace_tests tool
    // (W3.1's hook). Only a green run of the FULL suite is a verified
    // workspace state — a pattern-filtered subset doesn't qualify.
    // Best-effort exactly like the tool: git trouble never fails the
    // command; a no-op (clean tree) appends nothing.
    let checkpointNote = '';
    if (report.ok && report.total > 0 && names.length === allNames.length) {
      try {
        const sha = await commitCheckpoint(
          `tests green: ${report.passed}/${report.total} (run-tests)`,
        );
        if (sha) checkpointNote = `checkpoint ${sha.slice(0, 7)}\n`;
      } catch {
        // best-effort — never fail the command on checkpoint trouble
      }
    }
    return {
      stdout: formatTestReport(report) + checkpointNote,
      stderr: '',
      exitCode: report.ok ? 0 : 1,
    };
  },
};

// ─── lint-rules ───────────────────────────────────────────────────────

export const lintRulesCommand: Command = {
  name: 'lint-rules',
  // Host-extension command — runs the pyric linter (ohm-js) outside the
  // defense-in-depth global patches.
  trusted: true,
  async execute(args, ctx) {
    const target = args[0]
      ? ctx.fs.resolvePath(ctx.cwd, args[0])
      : RULES_PATH;
    let source: string;
    try {
      source = await ctx.fs.readFile(target);
    } catch {
      return fail('lint-rules', `${target}: no such file`);
    }
    const result = lintFirestoreRules(source);
    if (result.parseError) {
      const pe = result.parseError;
      return fail(
        'lint-rules',
        `${target}: parse error at ${pe.line}:${pe.column} — expected ${pe.expected}`,
      );
    }
    if (result.warnings.length === 0) {
      return ok(`lint-rules: ${target}: clean\n`);
    }
    const lines = result.warnings.map((w) => {
      const loc = w.location;
      const where = loc?.functionName
        ? `in ${loc.functionName}: `
        : loc?.matchPath
          ? `at ${loc.matchPath}: `
          : '';
      const fix = w.fix ? ` — fix: ${w.fix}` : '';
      return `${w.severity}: ${where}[${w.rule}] ${w.message}${fix}`;
    });
    const errors = result.warnings.filter((w) => w.severity === 'error').length;
    return {
      stdout: `${lines.join('\n')}\n`,
      stderr: '',
      exitCode: errors > 0 ? 1 : 0,
    };
  },
};

// ─── man ──────────────────────────────────────────────────────────────

/** Man topics contributed by the session's ACTIVE skills (pull-based
 *  skill bodies — see lib/skills/registry.ts). Inactive skills' pages
 *  are hidden: the brief in the system prompt is the only
 *  advertisement, so the agent doesn't wander into knowledge the user
 *  didn't activate. */
function skillManEntries(): Array<{ topic: string; summary: string; page: string }> {
  return resolveActiveSkills(useSkillsStore.getState().activeSkillIds).map((s) => ({
    topic: s.manTopic,
    summary: s.manSummary,
    page: s.manBody,
  }));
}

function allManTopics(): string[] {
  return [...MAN_TOPICS, ...skillManEntries().map((e) => e.topic)];
}

/** `man -k [keyword]` — the apropos index: every topic with its one-line
 *  summary, optionally filtered by a case-insensitive keyword match over
 *  topic name + summary. Always exits 0; an unmatched keyword just says so. */
function manIndex(keyword?: string): ExecResult {
  const entries: Array<{ topic: string; summary: string }> = [
    ...MAN_TOPICS.map((t) => ({ topic: t as string, summary: MAN_SUMMARIES[t] })),
    ...skillManEntries(),
  ];
  const rows = entries
    .filter((e) => {
      if (!keyword) return true;
      const k = keyword.toLowerCase();
      return e.topic.includes(k) || e.summary.toLowerCase().includes(k);
    })
    .map((e) => `${e.topic.padEnd(12)} ${e.summary}`);
  if (rows.length === 0) {
    return ok(`man: nothing matches "${keyword}" — topics: ${allManTopics().join(', ')}\n`);
  }
  return ok(`${rows.join('\n')}\n`);
}

export const manCommand: Command = {
  name: 'man',
  async execute(args) {
    if (args[0] === '-k') {
      return manIndex(args[1]);
    }
    const topic = args[0];
    if (!topic) {
      return ok(`man: available topics: ${allManTopics().join(', ')} — man <topic>\n`);
    }
    // `man run-tests` should land on the test page.
    const key = topic === 'run-tests' ? 'test' : topic;
    const skillPage = skillManEntries().find((e) => e.topic === key);
    const page = skillPage?.page ?? (MAN_PAGES as Record<string, string>)[key];
    if (!page) {
      return fail('man', `no page for "${topic}" — topics: ${allManTopics().join(', ')}`);
    }
    return ok(`${page}\n`);
  },
};

export const AGENT_SHELL_BUILTINS: readonly Command[] = [
  runTestsCommand,
  lintRulesCommand,
  manCommand,
];
