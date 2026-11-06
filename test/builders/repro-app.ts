/**
 * A fresh copy of a builder's app for one try of a reproduction: the kept
 * `app.tgz` extracted into the try's scratch directory, its Pyric
 * dependencies pinned to the tarballs, the fake Firebase config written
 * again, and the repro script copied in beside `package.json`.
 *
 * The archive is the builder's work, and these writes happen outside the
 * sandbox, so nothing is written through a link: only the archive's `app/`
 * is extracted, `app` must be a directory, and each file the harness
 * writes in it must be absent or a regular file.
 *
 * The app's own `.npmrc` is set aside as `.npmrc.from-builder` before the
 * install, so only the harness's flags configure npm: a builder's
 * `registry=` or a helper program it names never applies.
 */
import { copyFileSync, lstatSync, renameSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pinPyricPackages, runCommand, type Tarballs } from '../apps/install.ts';
import { demoProjectId, writeFakeFirebaseConfig, type RunDirs } from './scratch.ts';

/** What the script is called in the app, with its own extension. */
export const reproScriptName = (script: string) => `pyric-repro${extname(script)}`;

/** The files of the app the harness writes, outside the sandbox. */
const WRITTEN = ['package.json', 'firebase-config.js', '.firebaserc'];

/** npm's project config, which the builder may have written. */
export const APP_NPMRC = '.npmrc';
export const SET_ASIDE_NPMRC = '.npmrc.from-builder';

/** Renames the app's `.npmrc`, a link included, out of npm's reach. Resolves whether there was one. */
export function setAsideNpmrc(app: string): boolean {
  const npmrc = join(app, APP_NPMRC);
  const exists = lstatSync(npmrc, { throwIfNoEntry: false }) !== undefined;
  if (exists) renameSync(npmrc, join(app, SET_ASIDE_NPMRC));
  return exists;
}

/** Why writing `path` could land somewhere else; undefined when it can't. */
export function linkProblem(path: string, kind: 'file' | 'directory'): string | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return kind === 'directory' ? `${path} does not exist` : undefined;
  const isExpected = kind === 'directory' ? stat.isDirectory() : stat.isFile();
  return isExpected && !stat.isSymbolicLink() ? undefined : `${path} is not a plain ${kind}`;
}

function assertWritable(app: string, files: readonly string[]): void {
  const problems = [linkProblem(app, 'directory'), ...files.map((file) => linkProblem(join(app, file), 'file'))].filter((problem) => problem !== undefined);
  if (problems.length > 0) throw new Error(`refusing to write into the builder's app:\n- ${problems.join('\n- ')}`);
}

export interface ReproAppInput {
  dirs: RunDirs;
  appArchive: string;
  tarballs: Tarballs;
  run: string;
  script: string;
}

/** Lays out the try's app. Resolves the script's name inside it. */
export async function layOutReproApp(input: ReproAppInput): Promise<string> {
  const { dirs } = input;
  const tar = await runCommand('tar', ['-xzf', input.appArchive, '--no-same-owner', '--no-same-permissions', '-C', dirs.root, 'app'], { cwd: dirs.root });
  if (tar.code !== 0) throw new Error(`extracting ${input.appArchive} failed (exit ${tar.code}):\n${tar.output}`);
  const scriptName = reproScriptName(input.script);
  assertWritable(dirs.app, [...WRITTEN, scriptName, SET_ASIDE_NPMRC]);
  setAsideNpmrc(dirs.app);
  pinPyricPackages(dirs.app, input.tarballs);
  writeFakeFirebaseConfig(dirs.app, demoProjectId(input.run));
  copyFileSync(input.script, join(dirs.app, scriptName));
  return scriptName;
}
