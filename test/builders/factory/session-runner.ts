/**
 * The factory's session runner, the module the supervisor loads (#1790):
 * `runSession(role, options)` runs one Codex session for a seat, in a
 * sandbox of its own, and says how it ended.
 *
 * Each session gets its own bwrap sandbox (`../namespace.ts`) whose one
 * read-write bind is the run directory, where the app and the shared files
 * are, with the Codex install and the role's skill bound read-only and the
 * npm cache under an overlay. Codex runs there with a HOME and CODEX_HOME
 * of the seat's own that hold no login (`homes/<seat>/`); the forwarder,
 * outside, alone reads the login (`codex-session.ts`). The session's events
 * go to `logs/<seat>-<stamp>.jsonl`, its sandbox's network record to
 * `logs/<seat>-<stamp>.network.jsonl`, and the forwarder's record to
 * `<run dir>.codex-channel/<seat>.jsonl`, beside the run directory, where
 * nothing in the sandbox can write.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { npmCacheDir } from '../app-install.ts';
import { startEgressNamespace } from '../namespace.ts';
import { recorderEnvironment, runStamp } from '../scratch.ts';
import { codexHomeOf, FACTORY_MODEL, MAX_REASONING_EFFORT, type CodexSession } from './codex-command.ts';
import { readCodexLogin } from './codex-login.ts';
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

function makeDirs(paths: SessionPaths): void {
  for (const dir of [codexHomeOf(paths), dirname(paths.log), dirname(paths.channelRecord)]) mkdirSync(dir, { recursive: true });
}

/** Refuses up front what would fail later inside: no usable login, a socket path too long to bind. */
function preflight(paths: SessionPaths): void {
  const login = readCodexLogin();
  if (!login.ok) throw new Error(login.problem);
  const isTooLong = Buffer.byteLength(paths.socket) > MAX_SOCKET_PATH_BYTES;
  if (isTooLong) throw new Error(`the run directory's path is too long for the forwarder's socket ${paths.socket}`);
}

/** Codex's environment besides HOME and CODEX_HOME. No secret. */
function baseEnvironment(networkLog: string): Record<string, string> {
  const base: Record<string, string> = { PATH: process.env.PATH ?? '', ...recorderEnvironment(networkLog) };
  for (const name of ['LANG', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

export async function runSession(role: Role, options: SessionOptions): Promise<SessionResult> {
  const paths = sessionPaths(options.runDir, options.seat, runStamp());
  preflight(paths);
  makeDirs(paths);
  const install = codexInstall();
  const skillFile = roleSkill(role);
  const session: CodexSession = {
    codex: install.codex,
    cwd: options.appDir,
    home: paths.home,
    model: FACTORY_MODEL,
    reasoningEffort: MAX_REASONING_EFFORT,
    prompt: rolePrompt(role, options),
    ...(skillFile === undefined ? {} : { skillFile }),
  };
  const cache = npmCacheDir();
  const namespace = await startEgressNamespace({
    networkLog: paths.networkLog,
    runRoot: options.runDir,
    readOnly: [install.packageDir, ...(skillFile === undefined ? [] : [skillFile])],
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
    });
  } finally {
    await namespace.stop();
  }
}
