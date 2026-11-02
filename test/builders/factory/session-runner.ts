/**
 * The factory's session runner, the module the supervisor loads (#1790):
 * `runSession(role, options)` runs one Codex session for a seat, in a
 * sandbox of its own, and says how it ended.
 *
 * Each session gets its own bwrap sandbox (`../namespace.ts`) whose one
 * read-write bind is the run directory, where the app and the shared files
 * are, with the Codex install, the role's skill and the brief directory
 * (`PYRIC_FACTORY_BRIEF_DIR`) bound read-only and the npm cache under an
 * overlay. Codex gets `$BRIEF_DIR`, `$RUN_DIR` and `$APP_DIR`, which the
 * role skills name. Codex runs there with a HOME and CODEX_HOME
 * of the seat's own that hold no login (`homes/<seat>/`); the forwarder,
 * outside, alone reads the login (`codex-session.ts`). The session's events
 * go to `logs/<seat>-<stamp>.jsonl`, its sandbox's network record to
 * `logs/<seat>-<stamp>.network.jsonl`, and the forwarder's record to
 * `<run dir>.codex-channel/<seat>.jsonl`, beside the run directory, where
 * nothing in the sandbox can write.
 */
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { npmCacheDir } from '../app-install.ts';
import type { Upstream } from '../model-forwarder.ts';
import { startEgressNamespace } from '../namespace.ts';
import { recorderEnvironment, runStamp } from '../scratch.ts';
import { codexHomeOf, FACTORY_MODEL, MAX_REASONING_EFFORT, type CodexSession } from './codex-command.ts';
import { readCodexLogin, type LoginRead } from './codex-login.ts';
import { roleSkill, rolePrompt } from './codex-roles.ts';
import { runCodexSession } from './codex-session.ts';
import type { Role, SessionOptions, SessionResult } from './session.ts';

/** The longest Unix socket path the kernel takes (`sun_path` is 108 bytes, with its terminator). */
const MAX_SOCKET_PATH_BYTES = 107;

export interface SessionPaths {
  home: string;
  log: string;
  networkLog: string;
  phaseFile: string;
  socket: string;
  channelRecord: string;
}

export function sessionPaths(runDir: string, seat: string, stamp: string): SessionPaths {
  const log = join(runDir, 'logs', `${seat}-${stamp}.jsonl`);
  return {
    home: join(runDir, 'homes', seat),
    log,
    networkLog: join(runDir, 'logs', `${seat}-${stamp}.network.jsonl`),
    phaseFile: join(runDir, 'logs', `${seat}-${stamp}.phase.json`),
    // One per session: Node removes it when the forwarder closes, but a killed harness leaves it behind.
    socket: join(runDir, `${seat}-${stamp}.sock`),
    channelRecord: join(`${runDir}.codex-channel`, `${seat}.jsonl`),
  };
}

/** The `codex` launcher on PATH, as a real path, and its package directory, which the sandbox binds. */
export function codexInstall(env: NodeJS.ProcessEnv = process.env): { codex: string; packageDir: string } {
  const dirs = (env.PATH ?? '').split(':').filter((dir) => dir !== '');
  const found = dirs.map((dir) => join(dir, 'codex')).find((path) => existsSync(path));
  if (found === undefined) throw new Error('no codex on PATH: install @openai/codex');
  const codex = realpathSync(found);
  return { codex, packageDir: dirname(dirname(codex)) };
}

/** Where the run's brief is (`BRIEF.md`, `specs/`, `DESIGN.md`): a directory outside the run directory, bound read-only. */
export const BRIEF_DIR_ENV = 'PYRIC_FACTORY_BRIEF_DIR';

/** What a session runs with besides the supervisor's options. `runSession` reads it from the harness; tests pass fakes. */
export interface RunnerConfig {
  briefDir: string;
  codex: { codex: string; packageDir: string };
  skillFile: string;
  login: () => LoginRead;
  /** Test seam: where the forwarder sends requests. */
  upstream?: Upstream;
}

export function runnerConfig(role: Role, env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const briefDir = env[BRIEF_DIR_ENV];
  const isUnset = briefDir === undefined || briefDir === '';
  if (isUnset) throw new Error(`no brief directory: set ${BRIEF_DIR_ENV} to the directory holding BRIEF.md, specs/ and DESIGN.md`);
  return { briefDir: resolve(briefDir), codex: codexInstall(env), skillFile: roleSkill(role), login: () => readCodexLogin() };
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * What keeps the session from running as laid out, each named, never a
 * value. The run directory is the sandbox's one read-write bind, so the app
 * must be inside it and the brief outside it, or the brief would be
 * writable.
 */
export function layoutProblems(options: Pick<SessionOptions, 'runDir' | 'appDir'>, config: RunnerConfig, paths: SessionPaths): string[] {
  const problems: string[] = [];
  const login = config.login();
  if (!login.ok) problems.push(login.problem);
  const briefIsDirectory = statSync(config.briefDir, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!briefIsDirectory) problems.push(`the brief directory ${config.briefDir} does not exist`);
  if (isInside(config.briefDir, options.runDir)) problems.push(`the brief directory ${config.briefDir} is inside the run directory, which sessions can write`);
  if (!isInside(options.appDir, options.runDir)) problems.push(`the app directory ${options.appDir} is outside the run directory, so sessions could not write it`);
  if (Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH_BYTES) problems.push(`the run directory's path is too long for the forwarder's socket ${paths.socket}`);
  return problems;
}

function makeDirs(paths: SessionPaths): void {
  for (const dir of [codexHomeOf(paths), dirname(paths.log), dirname(paths.channelRecord)]) mkdirSync(dir, { recursive: true });
}

/** Codex's environment besides HOME, CODEX_HOME and the three directories. No secret. */
function baseEnvironment(networkLog: string): Record<string, string> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? '', ...recorderEnvironment(networkLog) };
  for (const name of ['LANG', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

/** `runSession` with its configuration given: the tests run a scripted Codex this way, in a real sandbox. */
export async function runConfiguredSession(role: Role, options: SessionOptions, config: RunnerConfig): Promise<SessionResult> {
  const paths = sessionPaths(options.runDir, options.seat, runStamp());
  const problems = layoutProblems(options, config, paths);
  if (problems.length > 0) throw new Error(`the ${options.seat} session can't start:\n- ${problems.join('\n- ')}`);
  makeDirs(paths);
  const dirs = { briefDir: config.briefDir, runDir: options.runDir, appDir: options.appDir };
  const session: CodexSession = {
    codex: config.codex.codex,
    cwd: options.appDir,
    runDir: options.runDir,
    briefDir: config.briefDir,
    home: paths.home,
    model: FACTORY_MODEL,
    reasoningEffort: MAX_REASONING_EFFORT,
    prompt: rolePrompt(role, options, dirs),
    skillFile: config.skillFile,
  };
  const cache = npmCacheDir();
  const namespace = await startEgressNamespace({
    networkLog: paths.networkLog,
    runRoot: options.runDir,
    readOnly: [config.codex.packageDir, config.skillFile, config.briefDir],
    overlaid: existsSync(cache) ? [cache] : [],
  });
  try {
    return await runCodexSession({
      session,
      runRoot: options.runDir,
      phaseFile: paths.phaseFile,
      socketPath: paths.socket,
      channelRecord: paths.channelRecord,
      logPath: paths.log,
      deadlineMs: options.remainingMs,
      enter: namespace.enter,
      base: baseEnvironment(paths.networkLog),
      signal: options.signal,
      login: config.login,
      upstream: config.upstream,
    });
  } finally {
    await namespace.stop();
  }
}

export function runSession(role: Role, options: SessionOptions): Promise<SessionResult> {
  return runConfiguredSession(role, options, runnerConfig(role));
}
