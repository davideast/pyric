/**
 * One agent session, start to end: `runAgentSession`. Outside the sandbox
 * it starts the upstream forwarder (`upstream-forwarder.ts`), which alone
 * reads the credential, writes the phase file, and enters the phase
 * (`agent-phase.ts`) into the sandbox through `enter`, the sandbox's
 * `namespace.enter`. The agent's stdout goes to `logPath` as it comes, and
 * its stderr to `<logPath>.stderr`.
 *
 * Every file it writes is in the run's host directory, which no sandbox can
 * write (`host-files.ts`): the phase file and the forwarder's socket in the
 * session's sandbox directory, which only this session's sandbox binds, and
 * read-only; the logs and the channel record beside it. Each new file is
 * opened with `O_EXCL | O_NOFOLLOW`.
 *
 * A session ends one of four ways (`session-end.ts`): the agent exits
 * (`exit`), runs out of usage (`rate-limit`, with `resetAt` when the
 * upstream named one), is stopped by the caller's signal, a fault in the
 * forwarder or a signal no one in the harness sent (`killed`), or is stopped
 * at its deadline (`deadline`).
 */
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Listening } from '../model-channel.ts';
import type { Upstream } from '../model-forwarder.ts';
import { sessionEnvironment, type AgentAdapter, type AgentSession, type CredentialRead } from './agent.ts';
import { signalExitCode, type AgentPhase } from './agent-phase.ts';
import { appendFile, openNewFile, writeNewFile } from './host-files.ts';
import { sessionEnd } from './session-end.ts';
import type { SessionResult } from './session.ts';
import { startUpstreamForwarder, type UpstreamEvent } from './upstream-forwarder.ts';

export const AGENT_PHASE = fileURLToPath(new URL('./agent-phase.ts', import.meta.url));

/** How long a stopped session gets to exit after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 10_000;

/** The bridge's port on the sandbox's loopback. Each session has a network namespace of its own, so one port serves them all. */
export const AGENT_BRIDGE_PORT = 47_013;

export interface AgentSessionOptions {
  agent: AgentAdapter;
  session: AgentSession;
  /** The run directory: the sandbox's one read-write bind. */
  runRoot: string;
  /** The session's directory in the run's host directory, bound read-only into its sandbox: the phase file and the forwarder's socket. */
  sandboxDir: string;
  /** Where the agent's stdout is saved, in the run's host directory. */
  logPath: string;
  /** The channel record, in the run's host directory. */
  channelRecord: string;
  /** How long the session may run, in milliseconds. */
  deadlineMs: number;
  /** How a command runs in the sandbox: the sandbox's `enter`. */
  enter: (command: string, args: readonly string[], cwd: string) => { command: string; args: string[] };
  /** The environment besides HOME and the three directories: PATH, LANG, TMPDIR, the recorder's variables. No secret. */
  base: Record<string, string>;
  /** Stops the session; it then ends `killed`, or `deadline` when aborted with that reason. */
  signal?: AbortSignal;
  /** Reads the credential; the agent's own reader by default. Tests pass a made-up one. */
  credential?: () => CredentialRead;
  /** Test seam: where the forwarder sends requests. */
  upstream?: Upstream;
  /** Test seam: the phase file the entered command runs; `AGENT_PHASE` by default. */
  phaseScript?: string;
  /** Test seam: the bridge's port, for phases run on the host. */
  bridgePort?: number;
  /** Test seam: how long a stopped session gets before SIGKILL. */
  stopGraceMs?: number;
}

export const phaseFileOf = (sandboxDir: string) => join(sandboxDir, 'phase.json');
export const socketOf = (sandboxDir: string) => join(sandboxDir, 'f.sock');

function phaseOf(options: AgentSessionOptions): AgentPhase {
  const { agent, session } = options;
  const bridgePort = options.bridgePort ?? AGENT_BRIDGE_PORT;
  return {
    runRoot: options.runRoot,
    socketPath: socketOf(options.sandboxDir),
    bridgePort,
    homeDirs: [session.home, ...agent.homeDirs(session.home)],
    cwd: session.cwd,
    invocation: agent.invocation(session, `http://127.0.0.1:${bridgePort}`, sessionEnvironment(session, options.base)),
  };
}

/** The phase's environment, from nothing: only PATH, HOME, LANG and TMPDIR of the harness's reach the sandbox. */
function phaseEnvironment(options: AgentSessionOptions): NodeJS.ProcessEnv {
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

/** A new log file, opened never through a link. */
const newLog = (path: string): WriteStream => createWriteStream(path, { fd: openNewFile(path) });

interface RunningPhase {
  exited: Promise<PhaseExit>;
  stop(why: 'deadline' | 'killed'): void;
}

/** Starts the phase in its own process group, so a stop reaches everything the phase started on the host side. */
function startPhase(options: AgentSessionOptions, events: WriteStream, stderr: WriteStream): RunningPhase {
  const phaseFile = phaseFileOf(options.sandboxDir);
  const { command, args } = options.enter(process.execPath, [options.phaseScript ?? AGENT_PHASE, phaseFile], options.session.cwd);
  // Inside, bwrap's --die-with-parent ends the sandbox, and every process in
  // its pid namespace, if the harness itself is killed.
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
    killTimer = setTimeout(() => signalGroup('SIGKILL'), options.stopGraceMs ?? STOP_GRACE_MS);
  };
  const exited = new Promise<PhaseExit>((resolve) => {
    child.once('error', () => resolve({ code: 127, signal: null, stoppedBy }));
    child.once('close', (code, signal) => {
      clearTimeout(killTimer);
      resolve({ code, signal, stoppedBy });
    });
  });
  return { exited, stop };
}

/** Runs the phase to its exit, stopping it at the deadline, on the caller's signal, or on a forwarder fault. */
async function runPhase(options: AgentSessionOptions, phase: RunningPhase): Promise<PhaseExit> {
  const deadline = setTimeout(() => phase.stop('deadline'), options.deadlineMs);
  const onAbort = () => phase.stop(stopReason(options.signal?.reason));
  if (options.signal?.aborted === true) onAbort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await phase.exited;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

const endStream = (stream: WriteStream) => new Promise<void>((resolve) => stream.end(resolve));

function readChannel(path: string): UpstreamEvent[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as UpstreamEvent);
}

/** Runs one agent session in the sandbox `enter` reaches, with its forwarder outside; resolves how it ended. */
export async function runAgentSession(options: AgentSessionOptions): Promise<SessionResult> {
  appendFile(options.channelRecord, '');
  // A run's sessions share a seat's record; only this session's lines say how it ended.
  const earlierLines = readChannel(options.channelRecord).length;
  writeNewFile(phaseFileOf(options.sandboxDir), `${JSON.stringify(phaseOf(options), null, 2)}\n`);
  const events = newLog(options.logPath);
  const stderr = newLog(`${options.logPath}.stderr`);
  let forwarder: Listening | undefined;
  let exit: PhaseExit;
  try {
    let phase: RunningPhase | undefined;
    forwarder = await startUpstreamForwarder({
      socketPath: socketOf(options.sandboxDir),
      record: options.channelRecord,
      policy: options.agent.policy,
      credential: options.credential ?? (() => options.agent.readCredential()),
      upstream: options.upstream,
      onFault: (reason) => {
        stderr.write(`[agent-session] ${reason}; stopping the session\n`);
        phase?.stop('killed');
      },
    });
    phase = startPhase(options, events, stderr);
    exit = await runPhase(options, phase);
  } finally {
    await forwarder?.close();
    await Promise.all([endStream(events), endStream(stderr)]);
  }
  const output = readFileSync(options.logPath, 'utf8');
  const channel = readChannel(options.channelRecord).slice(earlierLines);
  const end = sessionEnd({ ...exit, reportsRateLimit: options.agent.reportsRateLimit(output), channel });
  const exitCode = exit.code ?? signalExitCode(exit.signal ?? 'SIGKILL');
  return { exitCode, ...end, logPath: options.logPath };
}
