/**
 * One Codex session, start to end: `runCodexSession`. Outside the sandbox
 * it starts the Codex forwarder (`codex-forwarder.ts`), which alone reads
 * the login, writes the phase file, and enters the phase
 * (`codex-phase.ts`) into the sandbox through `enter`, the sandbox's
 * `namespace.enter`. The phase's stdout, Codex's JSON events, goes to
 * `logPath` as it comes, and its stderr to `<logPath>.stderr`.
 *
 * A session ends one of four ways: Codex exits (`exit`), runs out of usage
 * (`rate-limit`, with `resetAt` when the backend named one), is stopped by
 * the caller's signal or a signal no one in the harness sent (`killed`), or
 * is stopped at its deadline (`deadline`). Codex waits for the network
 * forever when its requests fail to connect, so the deadline is what ends a
 * session whose channel is down.
 *
 * The supervisor consumes exactly `CodexSessionResult`.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Listening } from '../model-channel.ts';
import type { Upstream } from '../model-forwarder.ts';
import type { CodexSession } from './codex-command.ts';
import { parseEvents, sessionEnd } from './codex-events.ts';
import { startCodexForwarder, type CodexChannelEvent } from './codex-forwarder.ts';
import { readCodexLogin, type LoginRead } from './codex-login.ts';
import { signalExitCode, type CodexPhase } from './codex-phase.ts';
import type { SessionResult } from './session.ts';

export const CODEX_PHASE = fileURLToPath(new URL('./codex-phase.ts', import.meta.url));

/** How long a stopped session gets to exit after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 10_000;

/** The supervisor's `SessionResult` (#1790). */
export type CodexSessionResult = SessionResult;

export interface CodexSessionOptions {
  session: CodexSession;
  /** The run directory: the sandbox's one read-write bind. */
  runRoot: string;
  /** Where the phase file goes, inside the run directory. */
  phaseFile: string;
  /** The forwarder's socket, inside the run directory, where the bridge connects. */
  socketPath: string;
  /** The channel record, outside the run directory. */
  channelRecord: string;
  /** Where Codex's JSON events are saved. */
  logPath: string;
  /** How long the session may run, in milliseconds. */
  deadlineMs: number;
  /** How a command runs in the sandbox: the sandbox's `enter`. */
  enter: (command: string, args: readonly string[], cwd: string) => { command: string; args: string[] };
  /** Codex's environment besides HOME and CODEX_HOME: PATH, LANG, TMPDIR, the recorder's variables. No secret. */
  base: Record<string, string>;
  /** Stops the session; it then ends `killed`. */
  signal?: AbortSignal;
  /** Reads the login; `readCodexLogin()` by default. Tests pass a made-up one. */
  login?: () => LoginRead;
  /** Test seam: where the forwarder sends requests. */
  upstream?: Upstream;
  /** Test seam: the phase file the entered command runs; `CODEX_PHASE` by default. */
  phaseScript?: string;
}

function writePhase(options: CodexSessionOptions): void {
  const phase: CodexPhase = { session: options.session, runRoot: options.runRoot, socketPath: options.socketPath, base: options.base };
  writeFileSync(options.phaseFile, `${JSON.stringify(phase, null, 2)}\n`);
}

/** The phase's environment, from nothing: only PATH, HOME, LANG and TMPDIR of the harness's reach the sandbox. */
function phaseEnvironment(options: CodexSessionOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: options.base.PATH ?? process.env.PATH, HOME: options.session.home };
  for (const name of ['LANG', 'TMPDIR']) {
    if (options.base[name] !== undefined) env[name] = options.base[name];
  }
  return env;
}

interface PhaseExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stoppedBy: 'deadline' | 'killed' | null;
}

/** How an abort ends the session: the supervisor aborts with `deadline` at the run's end, `stopped` otherwise. */
export function stopReason(reason: unknown): 'deadline' | 'killed' {
  return reason === 'deadline' ? 'deadline' : 'killed';
}

/** Runs the phase to its exit, stopping it at the deadline or on the caller's signal. */
function runPhase(options: CodexSessionOptions): Promise<PhaseExit> {
  const { command, args } = options.enter(process.execPath, [options.phaseScript ?? CODEX_PHASE, options.phaseFile], options.session.cwd);
  const events = createWriteStream(options.logPath);
  const stderr = createWriteStream(`${options.logPath}.stderr`);
  // Its own process group, so a stop reaches everything the phase started
  // on the host side. Inside, bwrap's --die-with-parent ends the sandbox,
  // and every process in its pid namespace, if the harness itself is killed.
  const child = spawn(command, args, { env: phaseEnvironment(options), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.pipe(events, { end: false });
  child.stderr.pipe(stderr, { end: false });
  let stoppedBy: PhaseExit['stoppedBy'] = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      // The group is gone: the phase already exited.
    }
  };
  const stop = (why: 'deadline' | 'killed') => {
    if (stoppedBy !== null) return;
    stoppedBy = why;
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), STOP_GRACE_MS);
  };
  const deadline = setTimeout(() => stop('deadline'), options.deadlineMs);
  const onAbort = () => stop(stopReason(options.signal?.reason));
  if (options.signal?.aborted === true) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  return new Promise((resolve) => {
    child.once('error', () => resolve({ code: 127, signal: null, stoppedBy }));
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      let flushed = 0;
      const done = () => {
        flushed += 1;
        if (flushed === 2) resolve({ code, signal, stoppedBy });
      };
      events.end(done);
      stderr.end(done);
    });
  });
}

function readChannel(path: string): CodexChannelEvent[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as CodexChannelEvent);
}

/** Runs one Codex session in the sandbox `enter` reaches, with its forwarder outside; resolves how it ended. */
export async function runCodexSession(options: CodexSessionOptions): Promise<CodexSessionResult> {
  writeFileSync(options.channelRecord, '', { flag: 'a' });
  // A run's sessions share its record; only this session's lines say how it ended.
  const earlierLines = readChannel(options.channelRecord).length;
  writePhase(options);
  let forwarder: Listening | undefined;
  let exit: PhaseExit;
  try {
    forwarder = await startCodexForwarder({
      socketPath: options.socketPath,
      record: options.channelRecord,
      model: options.session.model,
      login: options.login ?? (() => readCodexLogin()),
      upstream: options.upstream,
    });
    exit = await runPhase(options);
  } finally {
    await forwarder?.close();
  }
  const events = parseEvents(readFileSync(options.logPath, 'utf8'));
  const end = sessionEnd({ ...exit, events, channel: readChannel(options.channelRecord).slice(earlierLines) });
  const exitCode = exit.code ?? signalExitCode(exit.signal ?? 'SIGKILL');
  return { exitCode, ...end, logPath: options.logPath };
}
