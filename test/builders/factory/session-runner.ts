/**
 * The factory's session runner, the module the supervisor loads:
 * `runSession(role, options)` runs one agent session for a seat, in a
 * sandbox of its own, with the agent adapter the run names
 * (`options.agent`, from `agents/registry.ts`), and says how it ended.
 *
 * Each session gets its own bwrap sandbox (`../namespace.ts`) whose one
 * read-write bind is the run directory, where the app and the shared files
 * are. Read-only, it binds the agent's install, the role's skill, the brief
 * directory (`options.briefDir`, outside the run directory), Playwright's
 * browsers and the session's sandbox directory in the run's host directory,
 * which holds the phase file and the forwarder's socket; the npm cache is
 * under an overlay. No bind may contain the host's HOME or reach the agent's
 * credential.
 *
 * The agent runs with a HOME of the seat's own that holds no credential
 * (`homes/<seat>/`), and gets `$BRIEF_DIR`, `$RUN_DIR` and `$APP_DIR`, and
 * where the browsers and Playwright's client are, since that HOME has neither
 * and the app has no Playwright of its own. The forwarder, outside, alone reads the credential (`agent-session.ts`). Its
 * output goes to `<run dir>.host/logs/<seat>-<stamp>.jsonl` and the
 * forwarder's record to `<run dir>.host/channel/<seat>.jsonl`, where nothing
 * in a sandbox can write; the sandbox's own network record is
 * `logs/<seat>-<stamp>.network.jsonl` in the run directory.
 *
 * Once the app is set up, a session also sees the run's packed packages
 * (`<run dir>.host/packages`, which Studio's manifest names) and the hourly
 * check's results, bound read-only over `<run dir>/checks`.
 *
 * The module also exports the factory's hourly check (`hourly-check.ts`),
 * which the supervisor runs each hour, and `runEnd`, which stops the served
 * copy when the run ends (`served.ts`).
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { npmCacheDir } from '../app-install.ts';
import { PLAYWRIGHT_CLIENT_ENV, playwrightBrowsersPath } from '../browser-server.ts';
import type { Upstream } from '../model-forwarder.ts';
import { startEgressNamespace } from '../namespace.ts';
import { runStamp } from '../scratch.ts';
import type { AgentAdapter, AgentInstall, AgentSession, CredentialRead } from './agent.ts';
import { runAgentSession, socketOf } from './agent-session.ts';
import { agentNamed } from './agents/registry.ts';
import { PLAYWRIGHT_CLIENT } from './captures.ts';
import { hostDirOf, isInside, makeHostDir } from './host-files.ts';
import { ONLINE_INIT_ENV, ONLINE_INIT_SCRIPT } from './online-init.ts';
import { roleSkill, rolePrompt } from './roles.ts';
import { appPaths } from './app-paths.ts';
import type { View } from '../harness-view.ts';
import { stopRunServing } from './served.ts';
import type { Role, SessionOptions, SessionResult } from './session.ts';

export { hourlyCheck } from './hourly-check.ts';

/** Stops the served copy and removes its private-network entries when the run ends. */
export function runEnd(runDir: string): Promise<void> {
  return stopRunServing(runDir);
}

/** What a session sees of the app's harness state: the packages read-only, and the checks read-only over `<run>/checks`. */
export function appViews(runDir: string): { readOnly: string[]; innerViews: View[] } {
  const paths = appPaths(runDir);
  const readOnly = existsSync(paths.packages) ? [paths.packages] : [];
  const innerViews = existsSync(paths.checks) ? [{ source: paths.checks, dest: paths.roleChecks }] : [];
  return { readOnly, innerViews };
}

/** The longest Unix socket path the kernel takes (`sun_path` is 108 bytes, with its terminator). */
const MAX_SOCKET_PATH_BYTES = 107;

export interface SessionPaths {
  home: string;
  /** In the run's host directory. */
  log: string;
  /** In the run directory: the sandbox's holder writes it. */
  networkLog: string;
  /** In the run's host directory, bound read-only into this session's sandbox alone. */
  sandboxDir: string;
  /** In the run's host directory. */
  channelRecord: string;
}

export function sessionPaths(runDir: string, seat: string, stamp: string): SessionPaths {
  const host = hostDirOf(runDir);
  return {
    home: join(runDir, 'homes', seat),
    log: join(host, 'logs', `${seat}-${stamp}.jsonl`),
    networkLog: join(runDir, 'logs', `${seat}-${stamp}.network.jsonl`),
    // Short: the socket's path must fit in 107 bytes.
    sandboxDir: join(host, 's', `${seat}-${stamp}`),
    channelRecord: join(host, 'channel', `${seat}.jsonl`),
  };
}

/** What a session runs with besides the supervisor's options. `runSession` builds it from the run's agent; tests pass fakes. */
export interface RunnerConfig {
  agent: AgentAdapter;
  install: AgentInstall;
  skillFile: string;
  credential: () => CredentialRead;
  /** Test seam: where the forwarder sends requests. */
  upstream?: Upstream;
  /** Test seam: the host's HOME, which no bind may contain. */
  home?: string;
  /** Test seam: where Playwright's browsers are; `playwrightBrowsersPath()` by default. */
  browsers?: string;
}

export function runnerConfig(role: Role, options: Pick<SessionOptions, 'agent'>, env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const agent = agentNamed(options.agent);
  return { agent, install: agent.install(env), skillFile: roleSkill(role), credential: () => agent.readCredential() };
}

/** Why a read-only bind is refused: it would show the sandbox the host's HOME or the agent's credential. */
export function bindProblems(binds: readonly string[], config: Pick<RunnerConfig, 'agent' | 'home'>): string[] {
  const home = config.home ?? homedir();
  return binds.flatMap((bind) => {
    const problems: string[] = [];
    if (isInside(home, bind)) problems.push(`the bind ${bind} contains the home directory ${home}`);
    const reachesCredential = config.agent.credentialDirs.some((dir) => isInside(dir, bind) || isInside(bind, dir));
    if (reachesCredential) problems.push(`the bind ${bind} reaches the agent's credential directory`);
    return problems;
  });
}

const browsersOf = (config: Pick<RunnerConfig, 'browsers'>) => config.browsers ?? playwrightBrowsersPath();

/** What the sandbox binds read-only for a session. */
const readOnlyBinds = (options: Pick<SessionOptions, 'briefDir'>, config: RunnerConfig) => [...config.install.binds, config.skillFile, options.briefDir, browsersOf(config)];

/**
 * What keeps the session from running as laid out, each named, never a
 * value. The run directory is the sandbox's one read-write bind, so the app
 * must be inside it and the brief outside it, or the brief would be
 * writable.
 */
export function layoutProblems(options: Pick<SessionOptions, 'runDir' | 'appDir' | 'briefDir'>, config: RunnerConfig, paths: SessionPaths): string[] {
  const problems: string[] = [];
  const credential = config.credential();
  if (!credential.ok) problems.push(credential.problem);
  const briefIsDirectory = statSync(options.briefDir, { throwIfNoEntry: false })?.isDirectory() === true;
  if (!briefIsDirectory) problems.push(`the brief directory ${options.briefDir} does not exist`);
  if (isInside(options.briefDir, options.runDir)) problems.push(`the brief directory ${options.briefDir} is inside the run directory, which sessions can write`);
  if (!isInside(options.appDir, options.runDir)) problems.push(`the app directory ${options.appDir} is outside the run directory, so sessions could not write it`);
  if (!existsSync(browsersOf(config))) problems.push(`Playwright's browsers are not at ${browsersOf(config)}, so the session could not start Chromium`);
  problems.push(...bindProblems(readOnlyBinds(options, config), config));
  const socket = socketOf(paths.sandboxDir);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) problems.push(`the run directory's path is too long for the forwarder's socket ${socket}`);
  return problems;
}

/** Makes the session's directories: the host directory's on the host, checked; the run directory's `logs/` without following a link. */
function makeDirs(runDir: string, paths: SessionPaths): void {
  const host = makeHostDir(hostDirOf(runDir), hostDirOf(runDir), runDir);
  for (const dir of [join(host, 'logs'), join(host, 's'), paths.sandboxDir, join(host, 'channel')]) makeHostDir(dir, host, runDir);
  // mkdir never follows a link at its last part; the holder writes into it from inside the sandbox.
  try {
    mkdirSync(join(runDir, 'logs'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * The environment besides HOME and the three directories. No secret. No
 * `NODE_OPTIONS`, so not the Node recorder: a session starts the app, `pyric
 * sandbox` adds its own `--import` to what it inherits, and `next dev` joins
 * two space-separated `--import`s into one module path and exits. The sandbox's
 * resolver and catch-all listener still record, as for the check's Studio.
 */
function baseEnvironment(browsers: string): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    PLAYWRIGHT_BROWSERS_PATH: browsers,
    [PLAYWRIGHT_CLIENT_ENV]: PLAYWRIGHT_CLIENT,
    [ONLINE_INIT_ENV]: ONLINE_INIT_SCRIPT,
  };
  for (const name of ['LANG', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

/** `runSession` with its configuration given: the tests run a scripted agent this way, in a real sandbox. */
export async function runConfiguredSession(role: Role, options: SessionOptions, config: RunnerConfig): Promise<SessionResult> {
  const paths = sessionPaths(options.runDir, options.seat, runStamp());
  const problems = layoutProblems(options, config, paths);
  if (problems.length > 0) throw new Error(`the ${options.seat} session can't start:\n- ${problems.join('\n- ')}`);
  makeDirs(options.runDir, paths);
  const dirs = { briefDir: options.briefDir, runDir: options.runDir, appDir: options.appDir };
  const session: AgentSession = {
    command: config.install.command,
    cwd: options.appDir,
    runDir: options.runDir,
    briefDir: options.briefDir,
    home: paths.home,
    prompt: rolePrompt(role, options, dirs),
    instructions: readFileSync(config.skillFile, 'utf8'),
  };
  const cache = npmCacheDir();
  const app = appViews(options.runDir);
  const namespace = await startEgressNamespace({
    networkLog: paths.networkLog,
    runRoot: options.runDir,
    readOnly: [...readOnlyBinds(options, config), paths.sandboxDir, ...app.readOnly],
    overlaid: existsSync(cache) ? [cache] : [],
    innerViews: app.innerViews,
  });
  try {
    return await runAgentSession({
      agent: config.agent,
      session,
      runRoot: options.runDir,
      sandboxDir: paths.sandboxDir,
      logPath: paths.log,
      channelRecord: paths.channelRecord,
      deadlineMs: options.remainingMs,
      enter: namespace.enter,
      base: baseEnvironment(browsersOf(config)),
      signal: options.signal,
      credential: config.credential,
      upstream: config.upstream,
    });
  } finally {
    await namespace.stop();
  }
}

export function runSession(role: Role, options: SessionOptions): Promise<SessionResult> {
  return runConfiguredSession(role, options, runnerConfig(role, options));
}
