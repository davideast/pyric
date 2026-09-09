/**
 * Codex provider.
 *
 * Codex reads its configuration from `CODEX_HOME`, so the run writes a private
 * `config.toml` there holding one profile and the `[mcp_servers.pyric]` block,
 * and points `CODEX_HOME` at the run directory's `codex-home`. `--ignore-user-config`
 * keeps the user's own servers and settings out of the run; the profile is still
 * found because it lives in `CODEX_HOME`, not in the user config.
 *
 * Authentication is the one thing that does not come from the profile: Codex
 * resolves credentials from `auth.json` inside `CODEX_HOME`. The runner copies
 * or symlinks the user's real `~/.codex/auth.json` into the temporary home
 * before spawning, otherwise every run fails unauthenticated. The credential is
 * never written into the config this module produces.
 */
import { join } from 'node:path';
import type { EvalRun, Invocation } from '../types.js';
import { serverEntry } from './server-env.js';

export const CODEX_HOME_DIR = 'codex-home';
export const CODEX_CONFIG_FILE = join(CODEX_HOME_DIR, 'config.toml');
export const CODEX_PROFILE = 'pyric-eval';
/** Where Codex looks for the credential the runner links into `CODEX_HOME`. */
export const CODEX_AUTH_FILE = join(CODEX_HOME_DIR, 'auth.json');

/** TOML string literal. Codex config values are plain strings and paths. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** TOML array of strings on one line. */
function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

/** TOML inline table for the server env block, sorted so the file is stable. */
function tomlInlineTable(entries: Record<string, string>): string {
  const pairs = Object.keys(entries)
    .sort()
    .map((key) => `${key} = ${tomlString(entries[key] as string)}`);
  return `{ ${pairs.join(', ')} }`;
}

function renderConfig(run: EvalRun): string {
  const entry = serverEntry(run);
  const lines = [
    `[profiles.${CODEX_PROFILE}]`,
    `model = ${tomlString(run.row.model)}`,
  ];
  const effort = run.row.effort;
  if (effort !== undefined) {
    lines.push(`model_reasoning_effort = ${tomlString(effort)}`);
  }
  lines.push(
    '',
    '[mcp_servers.pyric]',
    `command = ${tomlString(entry.command)}`,
    `args = ${tomlStringArray(entry.args)}`,
    `env = ${tomlInlineTable(entry.env)}`,
    '',
  );
  return lines.join('\n');
}

export function buildInvocation(run: EvalRun): Invocation {
  const command = [
    'codex',
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '-m',
    run.row.model,
  ];
  const effort = run.row.effort;
  if (effort !== undefined) {
    command.push('-c', `model_reasoning_effort='"${effort}"'`);
  }
  command.push(
    '-c',
    `approval_policy='"never"'`,
    '-s',
    'workspace-write',
    '--profile',
    CODEX_PROFILE,
    run.task.prompt,
  );

  return {
    command,
    // `CODEX_HOME` takes a path, so the home lives in the run directory and the
    // workspace the agent is started in stays empty.
    env: { CODEX_HOME: join(run.dir, CODEX_HOME_DIR) },
    files: { [CODEX_CONFIG_FILE]: renderConfig(run) },
    workspaceFiles: {},
  };
}

export default buildInvocation;
