/**
 * Agent-facing shell session (W2.1) — a persistent-cwd, workspace-jailed
 * wrapper over the existing `just-bash` terminal infrastructure
 * (`~/lib/terminal/bash-session`), with playground capabilities mounted
 * as builtin commands (`./builtins`).
 *
 * Mechanics (probed against just-bash 3.0.1, recorded in the W2.1 step doc):
 *   - `Bash.exec` is stateless between calls (env + cwd reset), so the
 *     session keeps its own cwd and passes it via `ExecOptions.cwd` —
 *     the option-based equivalent of TerminalPanel's `cd <cwd> && `
 *     prefix, minus the quoting edge cases.
 *   - The post-script cwd is read from `result.env.PWD` (BashExecResult
 *     always carries the final env), which follows `cd` through `&&`,
 *     `;`, and subcommands — no command-line parsing heuristics.
 *   - JAIL: the filesystem is a MountableFs whose ONLY mount is the
 *     OPFS workspace at /workspace (base = empty InMemoryFs), so the
 *     host fs is unreachable by construction. On top of that the
 *     session clamps its persisted cwd back to /workspace whenever a
 *     command ends outside the mount (`cd /` works within one line but
 *     never relocates the session out of the workspace).
 *   - `test`/`[` are interpreter-owned in just-bash — a registry
 *     command named `test` never fires. The session therefore rewrites
 *     a LEADING `test` token to the registered `run-tests` builtin.
 *     Start-of-line only: that position can't be inside quotes, and
 *     `[ ... ]` stays available for genuine shell conditionals
 *     (documented in `man shell`).
 */
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { createBashSession, type BashSession } from '~/lib/terminal/bash-session';

import { AGENT_SHELL_BUILTINS } from './builtins';

export interface AgentShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The session cwd AFTER the command (post jail-clamp). */
  cwd: string;
}

export interface AgentShellExecOptions {
  /** Cooperative cancellation, forwarded to just-bash. */
  signal?: AbortSignal;
}

export interface AgentShell {
  exec(command: string, options?: AgentShellExecOptions): Promise<AgentShellResult>;
  /** Current persisted cwd (always inside the workspace). */
  cwd(): string;
}

/** Rewrite a leading `test` token to the registered `run-tests` builtin.
 *  Leading-position only — see module docs. Exported for tests. */
export function rewriteLeadingTest(command: string): string {
  return command.replace(/^(\s*)test(?=\s|$|;|&|\|)/, '$1run-tests');
}

function withinWorkspace(path: string): boolean {
  return path === WORKSPACE_ROOT || path.startsWith(`${WORKSPACE_ROOT}/`);
}

export function createAgentShell(): AgentShell {
  const session: BashSession = createBashSession();
  for (const cmd of AGENT_SHELL_BUILTINS) session.bash.registerCommand(cmd);
  let cwd = WORKSPACE_ROOT;

  return {
    cwd: () => cwd,
    async exec(command, options) {
      const line = rewriteLeadingTest(command);
      const result = await session.bash.exec(line, {
        cwd,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      const nextCwd = result.env?.PWD ?? cwd;
      cwd = withinWorkspace(nextCwd) ? nextCwd : WORKSPACE_ROOT;
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        cwd,
      };
    },
  };
}

// ─── Module singleton (the `bash` tool's session) ─────────────────────
//
// One shell per app lifecycle, mirroring the VFS singleton it mounts.
// NOT parallel-safe by design: the shared cwd is the point.

let singleton: AgentShell | null = null;

export function getAgentShell(): AgentShell {
  if (!singleton) singleton = createAgentShell();
  return singleton;
}

/** Drop the cached shell so the next `getAgentShell()` builds a fresh
 *  one. Headless tests call this after `resetVFS()` — the shell binds
 *  the VFS adapter at creation time. */
export function resetAgentShell(): void {
  singleton = null;
}
