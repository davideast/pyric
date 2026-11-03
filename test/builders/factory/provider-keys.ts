/**
 * The provider key file `factory --provider-keys <file>` names. It holds one
 * `GEMINI_API_KEY=...` line, mode 0600, outside the run's directories and
 * the repo. The key is read from it once per forwarded call, inside the
 * supervisor; it never goes in an env var, argv, a unit file or a run file.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workDirOf } from './app-paths.ts';
import { hostDirOf, isInside } from './host-files.ts';
import type { ProviderKeyRead } from './provider-forwarder.ts';

/** The one line the file must hold, with the key after `=`. */
export const KEY_LINE_NAME = 'GEMINI_API_KEY';

/** The repo this harness runs from: a key file inside it could be committed. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const KEY_SHAPE = /^[A-Za-z0-9._-]+$/;
const QUOTED = /^(['"])(.*)\1$/;

/** The key from the file's `GEMINI_API_KEY=` line. A problem never quotes the file's text. */
export function readProviderKey(path: string): ProviderKeyRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, problem: `the provider key file can't be read (${(error as NodeJS.ErrnoException).code ?? 'unknown'})` };
  }
  const prefix = `${KEY_LINE_NAME}=`;
  const line = text.split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => candidate.startsWith(prefix));
  const key = line?.slice(prefix.length).trim().replace(QUOTED, '$2') ?? '';
  if (!KEY_SHAPE.test(key)) return { ok: false, problem: `the provider key file has no ${KEY_LINE_NAME}= line with a key` };
  return { ok: true, key };
}

function realOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Why the run can't use `path` as its key file, or undefined when it can. */
export function providerKeyFileProblem(path: string, runDir: string, appDir: string, repoRoot: string = REPO_ROOT): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return `the provider key file ${path} does not exist`;
  if (!stat.isFile()) return `the provider key file ${path} is not a regular file`;
  const isPrivate = (stat.mode & 0o077) === 0;
  if (!isPrivate) return `the provider key file ${path} must have mode 0600, not ${(stat.mode & 0o777).toString(8).padStart(4, '0')}`;
  const real = realOf(path);
  const fenced = [runDir, hostDirOf(runDir), workDirOf(runDir), appDir, repoRoot];
  const inside = fenced.find((dir) => isInside(real, realOf(dir)) || isInside(path, dir));
  if (inside !== undefined) return `the provider key file ${path} is inside ${inside}; keep it outside the run, the app and the repo`;
  const read = readProviderKey(path);
  return read.ok ? undefined : read.problem;
}
