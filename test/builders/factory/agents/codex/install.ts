/**
 * Codex as installed on the host: the `codex` launcher on PATH, resolved to
 * its real path, and the npm package it belongs to, which the sandbox binds
 * read-only. Only the npm layout is taken (`<package>/bin/codex.js`, with
 * the package's `package.json` naming `@openai/codex`): another layout, a
 * standalone binary in `~/.local/bin` say, would make the bind its parent
 * directory, which could hold anything.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentInstall } from '../../agent.ts';

export const CODEX_PACKAGE = '@openai/codex';

const packageSchema = z.object({ name: z.string() }).passthrough();

/** The package's name from its `package.json`, or undefined when there is none to read. */
function packageName(dir: string): string | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    const parsed = packageSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.name : undefined;
  } catch {
    return undefined;
  }
}

export function codexInstall(env: NodeJS.ProcessEnv = process.env): AgentInstall {
  const dirs = (env.PATH ?? '').split(':').filter((dir) => dir !== '');
  const found = dirs.map((dir) => join(dir, 'codex')).find((path) => existsSync(path));
  if (found === undefined) throw new Error(`no codex on PATH: install ${CODEX_PACKAGE}`);
  const command = realpathSync(found);
  const packageDir = dirname(dirname(command));
  const isCodexPackage = packageName(packageDir) === CODEX_PACKAGE;
  if (!isCodexPackage) throw new Error(`codex resolves to ${command}, which is not in an npm install of ${CODEX_PACKAGE}: the sandbox would bind ${packageDir}`);
  return { command, binds: [packageDir] };
}
