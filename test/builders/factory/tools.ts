/**
 * The binaries the hourly check runs, kept in `<run>.host/tools/` with their
 * hashes recorded in `app.json` and checked before each use:
 *
 * - ast-grep, from the harness's own install (`@ast-grep/cli`, pinned in the
 *   repo's package.json), never the one in a checkout a session can change;
 * - ffmpeg for Studio's tests, which `ffmpeg-static`'s install script would
 *   download and `--ignore-scripts` skips. Setup copies the source
 *   checkout's, and tests find it through `FFMPEG_BIN`.
 *
 * Both run only inside a sandbox, bound read-only from there.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export type ToolHashes = Record<string, string>;

export const AST_GREP = 'ast-grep';
export const FFMPEG = 'ffmpeg';

const PLATFORM_PACKAGES: Record<string, string> = {
  'linux-x64': '@ast-grep/cli-linux-x64-gnu',
  'linux-arm64': '@ast-grep/cli-linux-arm64-gnu',
};

export class ToolMissing extends Error {}
export class ToolChanged extends Error {}

/** The ast-grep binary of the harness's own `@ast-grep/cli`. */
export function harnessAstGrep(): string {
  const name = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (name === undefined) throw new ToolMissing(`no ast-grep package for ${process.platform}-${process.arch}`);
  const fromCli = createRequire(createRequire(import.meta.url).resolve('@ast-grep/cli/package.json'));
  const binary = join(dirname(fromCli.resolve(`${name}/package.json`)), AST_GREP);
  if (!existsSync(binary)) throw new ToolMissing(`${binary} is missing; run bun install at the repo root`);
  return binary;
}

export function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Copies a regular file into `tools/` as `name` and returns its hash. */
export function placeTool(tools: string, name: string, source: string): string {
  const isRegularFile = lstatSync(source).isFile();
  if (!isRegularFile) throw new ToolMissing(`${source} is not a regular file`);
  const target = join(tools, name);
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  return sha256Of(target);
}

/** The path of `name` in `tools/`, once its hash matches the recorded one. */
export function verifiedTool(tools: string, hashes: ToolHashes, name: string): string {
  const expected = hashes[name];
  if (expected === undefined) throw new ToolMissing(`setup recorded no ${name}`);
  const path = join(tools, name);
  const isRegularFile = lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
  if (!isRegularFile) throw new ToolMissing(`${path} is missing or not a regular file`);
  const actual = sha256Of(path);
  if (actual !== expected) throw new ToolChanged(`${path} changed since setup (sha256 ${actual}, recorded ${expected})`);
  return path;
}

/** The source checkout's ffmpeg, when its install downloaded one. */
export function sourceFfmpeg(source: string): string | undefined {
  const binary = join(source, 'node_modules', 'ffmpeg-static', FFMPEG);
  return existsSync(binary) ? binary : undefined;
}
