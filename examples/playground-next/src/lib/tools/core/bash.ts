/**
 * `bash` — W2.1: the terminal as the agent's near-universal tool
 * (Move W2, workstation-architecture.md). One persistent shell session
 * over the workspace, with playground capabilities mounted as builtins
 * (`test`, `lint-rules`, `man` — see `~/lib/agent-shell`).
 *
 * Deliberately NOT parallelSafe: the session keeps a shared cwd and
 * shell commands mutate the workspace — two concurrent `bash` calls
 * would race both.
 *
 * Output is capped (`MAX_STDOUT`/`MAX_STDERR`) — tool results ride back
 * in history on every subsequent model call, so an uncapped `cat` of a
 * large file would re-introduce the accumulation problem the efficiency
 * epic fixed (#515).
 */
import type { ToolHandler } from '@inbrowser/agent';

import { getAgentShell } from '~/lib/agent-shell';

const MAX_STDOUT = 16_000; // chars ≈ 4k tok
const MAX_STDERR = 4_000;

export interface BashToolArgs {
  command: string;
}

export interface BashToolData {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Session cwd after the command — persists into the next call. */
  cwd: string;
  /** Set when stdout/stderr were capped. Re-run with head/grep/wc to
   *  narrow instead of re-reading the whole output. */
  truncated?: true;
}

function capStream(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n… (truncated, ${text.length} chars total — narrow with head/grep/wc)`,
    truncated: true,
  };
}

/** First line of the command, shortened — the summary's subject. */
function preview(command: string): string {
  const first = command.trim().split('\n', 1)[0] ?? '';
  return first.length > 64 ? `${first.slice(0, 61)}…` : first;
}

export const bashHandler: ToolHandler<BashToolArgs, BashToolData> = {
  name: 'bash',
  // NOT parallelSafe — shared cwd + workspace mutations (see module docs).
  description:
    'Run a bash command in the persistent workspace shell. JAILED to /workspace (the project filesystem) — no network, no subprocesses, no host paths. cwd persists between calls. Standard commands (ls, cat, grep, sed, find, jq, …) plus playground builtins: `test [pattern]` runs the workspace test suite against the current rules, `lint-rules [path]` lints a rules file, `man <topic>` prints docs on demand (`man -k` lists topics: test, rules, shell, workflow, diagnostics). Non-zero exit codes are returned as evidence, not errors. For whole-file writes prefer write_file: rules and App.tsx saved there auto-deploy and auto-validate, which bash redirection bypasses.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'The command line to execute (bash syntax: pipes, &&, redirects, globs). Runs in the session cwd.',
      },
    },
    required: ['command'],
  },
  async execute({ command }) {
    if (typeof command !== 'string' || command.trim().length === 0) {
      return {
        ok: false,
        summary: 'bash: empty command',
        data: { stdout: '', stderr: 'bash: empty command\n', exitCode: 2, cwd: getAgentShell().cwd() },
      };
    }
    const result = await getAgentShell().exec(command);
    const out = capStream(result.stdout, MAX_STDOUT);
    const err = capStream(result.stderr, MAX_STDERR);
    const truncated = out.truncated || err.truncated;
    return {
      ok: true, // the SHELL ran; the exit code is the verdict the agent reads
      summary: `bash · ${preview(command)} · exit ${result.exitCode}${truncated ? ' · output truncated' : ''}`,
      data: {
        stdout: out.text,
        stderr: err.text,
        exitCode: result.exitCode,
        cwd: result.cwd,
        ...(truncated ? { truncated: true as const } : {}),
      },
    };
  },
};
