/**
 * One child process of an app scenario, with its interleaved stdout and
 * stderr, spawn retry for Bun's EBADF (#997), and process-group teardown.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  DEFAULT_EXIT_TIMING,
  describeProcState,
  endGroup,
  watchChildExit,
  type ExitTiming,
  type LiveProcess,
} from './unreaped-exit.ts';
import {
  collectDescendantGroups,
  endProcessGroups,
  hasLiveGroupProcesses,
  killProcessGroupsNow,
  trackGroupOnRunnerExit,
  untrackGroupsOnRunnerExit,
} from './process-reaper.ts';
import { childOutputSockets, describeOutputSockets, isExitWithoutClose } from './output-sockets.ts';

export interface LogWaitOptions {
  /** Only output after this offset (from `mark()`) counts. Default: all output. */
  since?: number;
  timeoutMs?: number;
}

/** Starts a child process. `AppProcess` takes one so its tests can start a stand-in. */
export type SpawnChild = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** How long `stop()` waits after SIGTERM, and then after SIGKILL, for the child to close. */
export interface StopGrace {
  termMs: number;
  killMs: number;
}

const DEFAULT_STOP_GRACE: StopGrace = { termMs: 5_000, killMs: 5_000 };

/** The waits an `AppProcess` uses. Tests pass short ones; the runner uses the defaults. */
export interface ProcessTiming {
  exit: ExitTiming;
  /** The grace `stop()` uses when it is given none. */
  stop: StopGrace;
}

export const DEFAULT_PROCESS_TIMING: ProcessTiming = { exit: DEFAULT_EXIT_TIMING, stop: DEFAULT_STOP_GRACE };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killGroupIgnoringGone(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(group, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

/** One child process of the app, with its interleaved stdout and stderr. */
export class AppProcess {
  readonly exited: Promise<number | null>;
  private child: ChildProcess;
  private settle: (code: number | null) => void = () => {};
  /** The command line, shown at the top of the saved log. */
  readonly header: string;
  private text = '';
  private exitCode: number | null | undefined;
  private isPaused = false;
  private spawnAttempts = 0;
  private childWrote = false;
  private stopWatchingExit: () => void = () => {};
  private readonly subgroups = new Set<number>();
  /**
   * Set when the child's exit was counted without its `close` (#1274): a
   * process it started may still be in its group, holding its pipes.
   */
  private exitedEarly = false;
  /** Processes this child started that outlived it, holding its pipes (#1274). */
  readonly leftoverProcesses: LiveProcess[] = [];
  /**
   * Set for a process the scenario starts to run until it stops it, such as a
   * dev server, and not for a command it runs to exit. Such a process that
   * exits on its own with a non-zero code fails the app (crash-watch.ts).
   */
  runsUntilStopped = false;
  /** When `stop()` first found the process running, so its exit was the driver's doing. */
  stopRequestedAt: number | undefined;
  /** When the driver saw the process gone. */
  exitedAt: number | undefined;

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly spawnChild: SpawnChild = spawn,
    private readonly timing: ProcessTiming = DEFAULT_PROCESS_TIMING,
  ) {
    const pyricEnv = Object.entries(env).filter(([key]) => key.startsWith('PYRIC_')).map(([key, value]) => `${key}=${value} `);
    this.header = `$ ${pyricEnv.join('')}${[command, ...args].join(' ')}\n`;
    this.exited = new Promise((resolve) => { this.settle = resolve; });
    this.child = this.start();
  }

  private start(): ChildProcess {
    this.spawnAttempts += 1;
    const child = this.spawnChild(this.command, this.args, { cwd: this.cwd, env: this.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (this.spawnChild === spawn && child.pid !== undefined) {
      trackGroupOnRunnerExit(child.pid);
    }
    const outputSockets = childOutputSockets(child.pid);
    const isCurrent = () => child === this.child;
    const record = (chunk: unknown) => {
      if (!isCurrent()) return;
      this.childWrote = true;
      this.text += String(chunk);
    };
    child.stdout?.on('data', record);
    child.stderr?.on('data', record);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (!isCurrent()) return;
      if (this.retriesSpawn(error)) {
        this.text += `\n[driver] could not start ${this.command}: ${error.message}; the child wrote no output, so the driver starts it once more\n`;
        this.abandon(child);
        this.child = this.start();
        return;
      }
      this.text += `\n[driver] could not start ${this.command}: ${error.message}\n`;
      this.finish(null);
    });
    child.on('close', (_code, signal) => {
      if (isCurrent() && signal) this.text += `\n[driver] exited on ${signal}\n`;
    });
    // `close` waits for the output pipes too, and Bun can miss an exit (#1274):
    // watchChildExit also counts an exit whose pipes stay held, and a zombie.
    this.stopWatchingExit();
    this.stopWatchingExit = watchChildExit(child, this.name, (exit) => {
      if (!isCurrent()) return;
      this.captureSubgroups();
      this.text += exit.note;
      // Without `close`, output can go missing: say whether the kernel still holds it (#1797).
      if (isExitWithoutClose(exit.source)) this.text += describeOutputSockets(this.name, outputSockets);
      if (exit.source !== 'close') this.exitedEarly = true;
      this.leftoverProcesses.push(...exit.leftovers);
      this.finish(exit.code);
      if (exit.source === 'close' && child.pid !== undefined) {
        const allGroups = new Set<number>([child.pid, ...this.subgroups]);
        if (!hasLiveGroupProcesses(allGroups)) {
          this.untrackFromReaper();
        }
      }
    }, this.timing.exit);
    return child;
  }

  /**
   * Under concurrency, Bun's spawn sometimes fails with `EBADF ... epoll_ctl`
   * before the child runs (#997). That failure, before any output, gets one
   * more spawn. Any other error, or a second failure, fails as before.
   */
  private retriesSpawn(error: NodeJS.ErrnoException): boolean {
    const isBadDescriptor = error.code === 'EBADF';
    const isFirstAttempt = this.spawnAttempts === 1;
    return isBadDescriptor && isFirstAttempt && !this.childWrote;
  }

  /** Ends a child whose spawn failed, in case it got a process before the error. */
  private abandon(child: ChildProcess): void {
    if (child.pid === undefined) return;
    killGroupIgnoringGone(-child.pid, 'SIGKILL');
    if (this.spawnChild === spawn) {
      untrackGroupsOnRunnerExit([child.pid]);
    }
  }

  /** Records any detached child process groups currently reachable under this process. */
  snapshotSubgroups(): void {
    this.captureSubgroups();
  }

  private captureSubgroups(): void {
    const pid = this.child.pid;
    if (this.spawnChild !== spawn || pid === undefined) return;
    const beforeSize = this.subgroups.size;
    collectDescendantGroups(pid, this.subgroups);
    if (this.subgroups.size > beforeSize) {
      for (const subgroup of this.subgroups) {
        trackGroupOnRunnerExit(subgroup);
      }
    }
  }

  private untrackFromReaper(): void {
    const pid = this.child.pid;
    if (this.spawnChild !== spawn || pid === undefined) return;
    untrackGroupsOnRunnerExit([pid, ...this.subgroups]);
  }

  private finish(code: number | null): void {
    if (!this.running) return;
    this.stopWatchingExit();
    this.exitCode = code;
    this.exitedAt = Date.now();
    this.settle(code);
  }

  get output(): string {
    return this.text;
  }

  /** The child's pid, which also numbers its process group (it is spawned detached). */
  get pid(): number | undefined {
    return this.child.pid;
  }

  get running(): boolean {
    return this.exitCode === undefined;
  }

  /** The non-zero code a process started to run until stopped exited with before anything stopped it. */
  get earlyExitCode(): number | undefined {
    const exitedOnItsOwn = this.runsUntilStopped && this.stopRequestedAt === undefined;
    const failed = typeof this.exitCode === 'number' && this.exitCode !== 0;
    if (exitedOnItsOwn && failed) return this.exitCode as number;
    return undefined;
  }

  /** The current end of the output, for `waitForLog({ since })`. */
  mark(): number {
    return this.text.length;
  }

  async waitForLog(pattern: RegExp, options: LogWaitOptions = {}): Promise<RegExpMatchArray> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    for (;;) {
      const match = this.text.slice(options.since ?? 0).match(pattern);
      if (match) {
        this.snapshotSubgroups();
        return match;
      }
      if (!this.running) throw new Error(`${this.name} exited before logging ${pattern}`);
      if (Date.now() > deadline) throw new Error(`${this.name} did not log ${pattern} in time`);
      await sleep(100);
    }
  }

  /** Whether `pause()` stopped the process and `resume()` has not continued it. */
  get paused(): boolean {
    return this.isPaused;
  }

  /**
   * Stops the process group with SIGSTOP. The kernel keeps its sockets open,
   * so a peer sees no close and no frames: a half-open connection, as from a
   * process held at a debugger breakpoint or an app the OS suspended.
   * `stop()` and the run's teardown resume a paused process before ending it.
   */
  pause(): void {
    this.signalGroup('SIGSTOP');
    this.isPaused = true;
  }

  /** Continues a paused process group with SIGCONT. */
  resume(): void {
    if (!this.isPaused) return;
    this.signalGroup('SIGCONT');
    this.isPaused = false;
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    const canSignal = this.running && pid !== undefined;
    if (!canSignal) throw new Error(`${this.name} is not running`);
    process.kill(-pid, signal);
  }

  /**
   * Ends the process group: SIGTERM, then SIGKILL after `grace.termMs`. A
   * child that has still not closed `grace.killMs` later, such as one whose
   * pipes a process outside the group holds open, is recorded as gone, so
   * `exited` settles and nothing waits on it past that.
   */
  async stop(grace: StopGrace = this.timing.stop): Promise<void> {
    if (this.child.pid === undefined) return;
    this.captureSubgroups();
    if (this.running) this.stopRequestedAt ??= Date.now();
    if (!this.running) {
      await this.stopLeftoverGroup(grace);
      await endProcessGroups(this.subgroups, grace.termMs);
      this.untrackFromReaper();
      return;
    }
    const group = -this.child.pid;
    // A stopped process holds SIGTERM until it is continued.
    if (this.isPaused) {
      killGroupIgnoringGone(group, 'SIGCONT');
      this.isPaused = false;
    }
    killGroupIgnoringGone(group, 'SIGTERM');
    if (await this.closesWithin(grace.termMs)) {
      this.captureSubgroups();
      // The leader went; a member that ignores SIGTERM may hold its pipes.
      if (this.exitedEarly) killGroupIgnoringGone(group, 'SIGKILL');
      await endProcessGroups(this.subgroups, grace.termMs);
      this.untrackFromReaper();
      return;
    }
    this.captureSubgroups();
    killGroupIgnoringGone(group, 'SIGKILL');
    if (await this.closesWithin(grace.killMs)) {
      await endProcessGroups(this.subgroups, Math.min(grace.termMs, grace.killMs));
      this.untrackFromReaper();
      return;
    }
    this.text += `\n[driver] ${this.name} did not close within ${grace.killMs / 1000}s of SIGKILL; the driver records it as gone${describeProcState(this.child.pid)}\n`;
    this.finish(null);
    killProcessGroupsNow(this.subgroups);
    this.untrackFromReaper();
  }

  /**
   * End what is left of the group of a child whose exit counted without its
   * `close`: SIGTERM, then SIGKILL. The signals reach only members of that
   * process group.
   */
  private async stopLeftoverGroup(grace: StopGrace): Promise<void> {
    const pid = this.child.pid;
    if (!this.exitedEarly || pid === undefined) return;
    await endGroup(pid, grace.termMs);
  }

  private closesWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
    return Promise.race([this.exited.then(() => true), timeout]).finally(() => clearTimeout(timer));
  }
}
