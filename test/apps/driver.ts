/**
 * The shared driver for app scenarios. A scenario receives an `App`: the
 * installed copy of one app directory, with helpers that start the app's real
 * Vite dev server, run its server scripts under `node --import
 * @pyric/cli/register`, and open its page in Chromium. Every process and page
 * the scenario starts is recorded, so a failure report can name the step and
 * show each log.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from '@playwright/test';
import { blackholedPort, type BlackholedPort } from '../../packages/cli/test/blackholed-port.ts';
import type { DependencyStore } from './dependency-store.ts';
import { NESTED_INSTALL_ATTEMPT_MS, pinPyricPackages, retryOnceOnTimeout, type Tarballs, type TimedResult } from './install.ts';
import { NESTED_PROJECTS_FILE, nestedProject } from './nested-projects.ts';
import {
  DEFAULT_EXIT_TIMING,
  describeProcState,
  endGroup,
  watchChildExit,
  type ExitTiming,
  type LiveProcess,
} from './unreaped-exit.ts';

/**
 * How `installProject` installs a nested project: from the run's dependency
 * store, with the run's tarballs. Tests pass a store over a stand-in npm, a
 * short limit, and their own report.
 */
export interface NestedInstalls {
  tarballs: Tarballs;
  store: Pick<DependencyStore, 'provide'>;
  /** How long one warm of the project's store entry gets; NESTED_INSTALL_ATTEMPT_MS by default. */
  attemptMs?: number;
  /** Where the `[runner]` lines go; the run's output by default. */
  report?: (line: string) => void;
}

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

/** One child process of the app, with its interleaved stdout and stderr. */
export class AppProcess {
  readonly exited: Promise<number | null>;
  private child: ChildProcess;
  private settle!: (code: number | null) => void;
  /** The command line, shown at the top of the saved log. */
  readonly header: string;
  private text = '';
  private exitCode: number | null | undefined;
  private isPaused = false;
  private spawnAttempts = 0;
  private childWrote = false;
  private stopWatchingExit: () => void = () => {};
  /**
   * Set when the child's exit was counted without its `close` (#1274): a
   * process it started may still be in its group, holding its pipes.
   */
  private exitedEarly = false;
  /** Processes this child started that outlived it, holding its pipes (#1274). */
  readonly leftoverProcesses: LiveProcess[] = [];

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
      this.text += exit.note;
      if (exit.source !== 'close') this.exitedEarly = true;
      this.leftoverProcesses.push(...exit.leftovers);
      this.finish(exit.code);
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
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* never started or already gone */ }
  }

  private finish(code: number | null): void {
    if (!this.running) return;
    this.stopWatchingExit();
    this.exitCode = code;
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

  /** The current end of the output, for `waitForLog({ since })`. */
  mark(): number {
    return this.text.length;
  }

  async waitForLog(pattern: RegExp, options: LogWaitOptions = {}): Promise<RegExpMatchArray> {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    for (;;) {
      const match = this.text.slice(options.since ?? 0).match(pattern);
      if (match) return match;
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
    if (!this.running) {
      await this.stopLeftoverGroup(grace);
      return;
    }
    const group = -this.child.pid;
    // A stopped process holds SIGTERM until it is continued.
    if (this.isPaused) {
      try { process.kill(group, 'SIGCONT'); } catch { /* already gone */ }
      this.isPaused = false;
    }
    try { process.kill(group, 'SIGTERM'); } catch { /* the group is gone; wait for close below */ }
    if (await this.closesWithin(grace.termMs)) {
      // The leader went; a member that ignores SIGTERM may hold its pipes.
      if (this.exitedEarly) try { process.kill(group, 'SIGKILL'); } catch { /* the group is gone */ }
      return;
    }
    try { process.kill(group, 'SIGKILL'); } catch { /* already gone */ }
    if (await this.closesWithin(grace.killMs)) return;
    this.text += `\n[driver] ${this.name} did not close within ${grace.killMs / 1000}s of SIGKILL; the driver records it as gone${describeProcState(this.child.pid)}\n`;
    this.finish(null);
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

export interface DevServer {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  port: number;
  process: AppProcess;
}

export interface ScriptResult {
  code: number | null;
  output: string;
}

export interface App {
  readonly name: string;
  /** The installed project directory. */
  readonly dir: string;
  /** Runs one named step. A failure inside it is reported with this name. */
  step<T>(name: string, run: () => Promise<T> | T): Promise<T>;
  /**
   * Starts the app's Vite dev server (`vite` from the app's node_modules) on a
   * free port, or on `port` when given, and waits until it serves the page and
   * `/__pyric/init.json`. The port is passed on the command line, which
   * overrides the config file. Passing the port of a server the scenario
   * stopped brings a host back on the URL its pages already use. `cwd`
   * (relative to the app directory) runs the dev server of a project the
   * scenario created there, such as one `create-pyric` scaffolded.
   */
  devServer(options?: { env?: Record<string, string>; name?: string; port?: number; cwd?: string }): Promise<DevServer>;
  /**
   * Starts the installed `pyric sandbox` (no Vite: the import-map plane) on a
   * free port, or on `port` when given, from the app directory, and waits
   * until it serves the page and `/__pyric/init.json`. It serves the
   * directory `firebase.json`'s `hosting.public` names and runs no command.
   */
  sandboxServer(options?: { env?: Record<string, string>; name?: string; port?: number }): Promise<DevServer>;
  /** Runs `node --import @pyric/cli/register <script> ...args` to exit. Throws on a non-zero exit. */
  serverScript(script: string, args?: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<ScriptResult>;
  /**
   * Starts `node --import @pyric/cli/register <script> ...args` and returns at
   * once, without waiting for it to exit. The process runs until the scenario
   * stops it or the run ends; the run's teardown resumes it if it is paused.
   */
  serverProcess(script: string, args?: string[], options?: { env?: Record<string, string> }): AppProcess;
  /**
   * Runs the installed `pyric` command (`@pyric/cli`'s bin, under node) with
   * `args` to exit, from the app directory. Unlike `serverScript`, a non-zero
   * exit is returned rather than thrown, so a scenario can assert a refusal.
   */
  pyric(args: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<ScriptResult>;
  /**
   * Starts the installed `pyric` command with `args` and returns at once, as
   * `serverProcess` does, for a command that runs until stopped, such as
   * `pyric sandbox -- next dev`.
   */
  pyricProcess(args: string[], options?: { env?: Record<string, string> }): AppProcess;
  /**
   * Runs `command` with `args` to exit from `cwd` (relative to the app
   * directory; the app directory when omitted), with the app's environment.
   * A non-zero exit is returned rather than thrown. For the commands a user
   * types, such as `node node_modules/create-pyric/dist/bin.js` or `npm run dev`.
   */
  command(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<ScriptResult>;
  /**
   * Installs a project the scenario created inside the app directory, such
   * as one `create-pyric` scaffolded: its Pyric dependencies point at the
   * packed tarballs, as the app's own do, and its tree comes from the
   * dependency store. `path` must be declared in test/apps/nested-projects.ts.
   * Throws on a failed install.
   */
  installProject(path: string): Promise<ScriptResult>;
  /**
   * The browser context for this app. Requests and page WebSockets to hosts
   * other than 127.0.0.1 and localhost are blocked and logged unless a route
   * (`route` or `routeWebSocket`) answers them.
   */
  browser(): Promise<BrowserContext>;
  /** Opens `url` in a new page of the app's browser context. */
  page(url: string): Promise<Page>;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  /** A free TCP port on 127.0.0.1. */
  freePort(): Promise<number>;
  /**
   * A port on 127.0.0.1 whose connects never complete and never refuse, as a
   * closed port behaves under WSL mirrored networking. Held until the run ends.
   */
  blackholedPort(): Promise<number>;
  /** Every page's console lines, page errors, error responses, and blocked external connections so far, in order. */
  readonly browserLog: readonly string[];
  /**
   * Declares that a page request to a `/__pyric/` route may answer with an
   * error status, such as a download URL with the wrong token. Any other error
   * a `/__pyric/` route answers to a page fails the app after its scenario.
   */
  expectHostError(pattern: RegExp): void;
  /**
   * Declares that a process an app process starts may outlive it, holding its
   * output pipes, such as a daemon the scenario starts on purpose. `pattern`
   * matches the leftover's command name. Any other leftover fails the app
   * after its scenario (#1274).
   */
  expectLeftoverProcess(pattern: RegExp): void;
}

export type Scenario = (app: App) => Promise<void>;

/** Declares an app's scenario. The default export of `scenario.ts`. */
export function scenario(run: Scenario): Scenario {
  return run;
}

export class StepFailure extends Error {
  constructor(readonly step: string, readonly reason: unknown) {
    super(`step "${step}" failed: ${reason instanceof Error ? reason.message : String(reason)}`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Binds port 0 on loopback, reads the port the kernel chose, and closes it. */
export function probePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Hands out ports nothing listens on, never the same port twice. */
export interface PortIssuer {
  next(): Promise<number>;
}

const PORT_ATTEMPTS = 32;

/**
 * A probe closes its socket before the caller binds the port, so the kernel
 * can choose that port again for the next probe. The issuer remembers every
 * port it handed out and probes again on a repeat.
 */
export function portIssuer(probe: () => Promise<number> = probePort): PortIssuer {
  const issued = new Set<number>();
  return {
    async next() {
      const repeats: number[] = [];
      for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
        const port = await probe();
        const isFresh = port > 0 && !issued.has(port);
        if (isFresh) {
          issued.add(port);
          return port;
        }
        repeats.push(port);
      }
      throw new Error(`no unissued port after ${PORT_ATTEMPTS} probes; the probe only returned ${[...new Set(repeats)].join(', ')}`);
    },
  };
}

/** The one issuer every app in a run shares, so concurrent apps never get the same port. */
const runPorts = portIssuer();

/** A port nothing listens on that no earlier call in this run returned. */
export function freePort(issuer: PortIssuer = runPorts): Promise<number> {
  return issuer.next();
}

/** The environment of every app process: no inherited credentials or keys, and a fresh HOME. */
function appEnvironment(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'CI']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    CLOUDSDK_CONFIG: join(home, '.config', 'gcloud'),
    NO_COLOR: '1',
    ...extra,
  };
}

async function answers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * Chromium's resolver rules for scenario pages: every name and address but
 * the local ones fails to resolve. The routes in `browser()` block and log;
 * these rules stop what no route sees, such as a WebSocket a worker opens,
 * before it leaves the machine (#1606).
 */
export const LOCAL_ONLY_RESOLVER_RULES = [
  'MAP * ~NOTFOUND',
  ...[...LOCAL_HOSTS].map((host) => `EXCLUDE ${host.replace(/^\[(.*)\]$/, '$1')}`),
].join(', ');

/**
 * Launches the Chromium that every scenario's pages run in, headless, with
 * the local-only resolver rules added to any `args` in `options`. A scenario
 * that needs its own browser, such as one with the back-forward cache
 * enabled, launches it here and guards its contexts with `guardContext`.
 */
export function launchScenarioBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const args = [...(options.args ?? []), `--host-resolver-rules=${LOCAL_ONLY_RESOLVER_RULES}`];
  return chromium.launch({ headless: true, ...options, args });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A WebSocket URL to any host but the local ones. It is a RegExp, not a
 * function, so Playwright connects a local socket in the page itself instead
 * of relaying each of its frames through the driver.
 */
const EXTERNAL_WEBSOCKET = new RegExp(`^wss?://(?!(?:${[...LOCAL_HOSTS].map(escapeRegExp).join('|')})(?::\\d+)?/)`);

/**
 * Blocks and logs to `log` every request and page WebSocket from `context`
 * to a host other than the local ones. Register it before a scenario's own
 * routes: the first route registered runs last, so those answer first.
 */
export async function guardContext(context: BrowserContext, log: string[]): Promise<void> {
  await context.route(() => true, async (route) => {
    const url = new URL(route.request().url());
    const isLocal = LOCAL_HOSTS.has(url.hostname) || url.protocol === 'data:' || url.protocol === 'blob:';
    if (isLocal) return route.continue();
    log.push(`[blocked external request] ${route.request().method()} ${url.href}`);
    return route.abort('blockedbyclient');
  });
  // `route` never sees a WebSocket. The page sees the connection close without opening.
  await context.routeWebSocket(EXTERNAL_WEBSOCKET, async (socket) => {
    log.push(`[blocked external WebSocket] ${socket.url()}`);
    await socket.close({ code: 1008, reason: 'blocked by the app scenario driver' });
  });
}

/** One run of one app: the state behind the `App` a scenario receives. */
export class AppRun implements App {
  readonly processes: AppProcess[] = [];
  readonly browserLog: string[] = [];
  currentStep = 'setup';
  /** Error responses from `/__pyric/` routes to the app's pages, with the step each happened in. */
  private readonly hostErrors: { step: string; request: string }[] = [];
  private readonly expectedLeftovers: RegExp[] = [];
  private readonly expectedHostErrors: RegExp[] = [];
  private context: BrowserContext | undefined;
  private serverCount = 0;
  private scriptCount = 0;
  private readonly blackholes: BlackholedPort[] = [];

  constructor(
    readonly name: string,
    readonly dir: string,
    private readonly home: string,
    private readonly launchBrowser: () => Promise<Browser>,
    /** The packed Pyric packages the runner installed the app with, and the store nested projects come from. */
    private readonly packages?: NestedInstalls,
    /** Where `freePort()`, `blackholedPort()`, and `devServer()` get their ports. */
    private readonly ports: PortIssuer = runPorts,
    /** The waits every process the run starts uses. */
    private readonly timing: ProcessTiming = DEFAULT_PROCESS_TIMING,
  ) {}

  async step<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    this.currentStep = name;
    try {
      return await run();
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      throw new StepFailure(name, error);
    }
  }

  freePort(): Promise<number> {
    return freePort(this.ports);
  }

  /** Listens on an issued port, so no later `freePort()` in the run returns it. */
  async blackholedPort(): Promise<number> {
    const hole = await blackholedPort(await freePort(this.ports));
    this.blackholes.push(hole);
    return hole.port;
  }

  async devServer(options: { env?: Record<string, string>; name?: string; port?: number; cwd?: string } = {}): Promise<DevServer> {
    const port = options.port ?? await freePort(this.ports);
    this.serverCount += 1;
    const name = options.name ?? (this.serverCount === 1 ? 'dev server' : `dev server ${this.serverCount}`);
    const projectDir = join(this.dir, options.cwd ?? '.');
    const child = new AppProcess(
      name,
      'node',
      [join(projectDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      projectDir,
      appEnvironment(this.home, options.env),
      spawn,
      this.timing,
    );
    this.processes.push(child);
    return this.servedHost(name, port, child);
  }

  async sandboxServer(options: { env?: Record<string, string>; name?: string; port?: number } = {}): Promise<DevServer> {
    const port = options.port ?? await freePort(this.ports);
    this.serverCount += 1;
    const name = options.name ?? (this.serverCount === 1 ? 'pyric sandbox' : `pyric sandbox ${this.serverCount}`);
    const child = this.pyricProcess(['sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)], { env: options.env });
    return this.servedHost(name, port, child);
  }

  /** Waits until a host process serves `/` and `/__pyric/init.json` on `port`. */
  private async servedHost(name: string, port: number, child: AppProcess): Promise<DevServer> {
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (!child.running) throw new Error(`${name} exited (code ${await child.exited}) before it served ${url}`);
      if (await answers(`${url}/`) && await answers(`${url}/__pyric/init.json`)) break;
      if (Date.now() > deadline) throw new Error(`${name} did not serve ${url}/ and ${url}/__pyric/init.json within 90s`);
      await sleep(250);
    }
    return { url, port, process: child };
  }

  serverProcess(script: string, args: string[] = [], options: { env?: Record<string, string> } = {}): AppProcess {
    this.scriptCount += 1;
    const child = new AppProcess(
      `server process ${this.scriptCount} (${script})`,
      'node',
      ['--import', '@pyric/cli/register', script, ...args],
      this.dir,
      appEnvironment(this.home, options.env),
      spawn,
      this.timing,
    );
    this.processes.push(child);
    return child;
  }

  pyricProcess(args: string[], options: { env?: Record<string, string> } = {}): AppProcess {
    this.scriptCount += 1;
    const child = new AppProcess(
      `pyric ${this.scriptCount} (${args.join(' ')})`,
      'node',
      [join('node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js'), ...args],
      this.dir,
      appEnvironment(this.home, options.env),
      spawn,
      this.timing,
    );
    this.processes.push(child);
    return child;
  }

  async pyric(args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ScriptResult> {
    const child = this.pyricProcess(args, options);
    const timeoutMs = options.timeoutMs ?? 60_000;
    const finished = await Promise.race([child.exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!finished) {
      await child.stop();
      throw new Error(`pyric ${args.join(' ')} did not exit within ${timeoutMs / 1000}s:\n${child.output}`);
    }
    return { code: await child.exited, output: child.output };
  }

  async command(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<ScriptResult> {
    const result = await this.timedCommand(command, args, options);
    if (result.timedOut) throw new Error(`${[command, ...args].join(' ')} did not exit within ${result.timeoutMs / 1000}s:\n${result.output}`);
    return { code: result.code, output: result.output };
  }

  /** Runs a command to exit, or stops it at `timeoutMs` and says so instead of throwing. */
  private async timedCommand(
    command: string,
    args: string[],
    options: { cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<TimedResult & { timeoutMs: number }> {
    this.scriptCount += 1;
    const label = [command, ...args].join(' ');
    const child = new AppProcess(
      `command ${this.scriptCount} (${label})`,
      command,
      args,
      join(this.dir, options.cwd ?? '.'),
      appEnvironment(this.home, options.env),
      spawn,
      this.timing,
    );
    this.processes.push(child);
    const timeoutMs = options.timeoutMs ?? 60_000;
    const finished = await Promise.race([child.exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!finished) {
      await child.stop();
      return { code: null, output: child.output, timedOut: true, timeoutMs };
    }
    return { code: await child.exited, output: child.output, timedOut: false, timeoutMs };
  }

  /**
   * The project in `path`, from the dependency store, keyed by its
   * package.json. A warm of its entry that hangs is stopped and tried once
   * more (#1476); the warm builds in a directory of its own, so nothing is
   * left to reset, and its output, with the processes npm was running and
   * the end of npm's debug log, is printed at once.
   */
  async installProject(path: string): Promise<ScriptResult> {
    if (nestedProject(this.name, path) === undefined) {
      throw new Error(`${this.name} installs the nested project ${path}, which ${NESTED_PROJECTS_FILE} does not declare. Nested installs come from the dependency store, keyed before the run: add { app: '${this.name}', path: '${path}', manifest } to that list.`);
    }
    if (!this.packages) throw new Error('installProject needs the packed packages; the runner passes them');
    const { tarballs, store, attemptMs = NESTED_INSTALL_ATTEMPT_MS } = this.packages;
    const report = this.packages.report ?? ((line: string) => console.log(line));
    const projectDir = join(this.dir, path);
    pinPyricPackages(projectDir, tarballs);
    const what = `${this.name}: install of ${path} from the dependency store`;
    let source = '';
    const attempt = async (): Promise<TimedResult> => {
      const result = await store.provide(projectDir, `${this.name}, nested project ${path}`, { warmAttemptMs: attemptMs });
      source = result.source;
      const timedOut = result.timedOut === true;
      // Printed now: the app's logs are saved only when it fails, and its home
      // is removed after it, so a retry that passes would lose this (#1494).
      if (timedOut) report(`[runner] ${what} stopped after ${attemptMs / 1000} s\n${result.output.trimEnd()}`);
      return { code: result.code, output: result.output, timedOut };
    };
    const result = await retryOnceOnTimeout(attempt, { what, reset: async () => {}, report });
    report(`[runner] nested project ${path} for ${this.name}: ${source}`);
    if (result.timedOut) throw new Error(`the install of ${path} timed out on both attempts:\n${result.output}`);
    if (result.code !== 0) throw new Error(`the install of ${path} failed with exit ${result.code}:\n${result.output}`);
    return { code: result.code, output: result.output };
  }

  async serverScript(
    script: string,
    args: string[] = [],
    options: { env?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<ScriptResult> {
    this.scriptCount += 1;
    const child = new AppProcess(
      `server script ${this.scriptCount} (${script})`,
      'node',
      ['--import', '@pyric/cli/register', script, ...args],
      this.dir,
      appEnvironment(this.home, options.env),
      spawn,
      this.timing,
    );
    this.processes.push(child);
    const timeoutMs = options.timeoutMs ?? 60_000;
    const finished = await Promise.race([child.exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!finished) {
      await child.stop();
      throw new Error(`${script} did not exit within ${timeoutMs / 1000}s:\n${child.output}`);
    }
    const code = await child.exited;
    if (code !== 0) throw new Error(`${script} exited with code ${code}:\n${child.output}`);
    return { code, output: child.output };
  }

  async browser(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const browser = await this.launchBrowser();
    const context = await browser.newContext();
    await guardContext(context, this.browserLog);
    this.context = context;
    return context;
  }

  async page(url: string): Promise<Page> {
    const context = await this.browser();
    const page = await context.newPage();
    const index = context.pages().length;
    page.on('console', (message) => this.browserLog.push(`[page ${index} console.${message.type()}] ${message.text()}`));
    // A module that fails to resolve throws with an empty stack, so the message stands in for it.
    page.on('pageerror', (error) => this.browserLog.push(`[page ${index} error] ${error.stack || `${error.name}: ${error.message}`}`));
    page.on('response', (response) => {
      if (response.status() < 400) return;
      this.browserLog.push(`[page ${index} response ${response.status()}] ${response.request().method()} ${response.url()}`);
      const url = new URL(response.url());
      if (url.pathname.startsWith('/__pyric/')) {
        this.hostErrors.push({ step: this.currentStep, request: `${response.status()} ${response.request().method()} ${url.pathname}${url.search}` });
      }
    });
    await page.goto(url);
    return page;
  }

  readFile(path: string): string {
    return readFileSync(join(this.dir, path), 'utf8');
  }

  writeFile(path: string, text: string): void {
    writeFileSync(join(this.dir, path), text);
  }

  expectHostError(pattern: RegExp): void {
    this.expectedHostErrors.push(pattern);
  }

  expectLeftoverProcess(pattern: RegExp): void {
    this.expectedLeftovers.push(pattern);
  }

  /** Processes app processes started that outlived them, and that no `expectLeftoverProcess` pattern matches. */
  unexpectedLeftoverProcesses(): string[] {
    return this.processes.flatMap((child) => child.leftoverProcesses
      .filter((leftover) => !this.expectedLeftovers.some((pattern) => pattern.test(leftover.comm)))
      .map((leftover) => `pid ${leftover.pid} (${leftover.comm}), started by ${child.name}`));
  }

  /** Error responses from `/__pyric/` routes that no `expectHostError` pattern matches. */
  unexpectedHostErrors(): string[] {
    return this.hostErrors
      .filter(({ request }) => !this.expectedHostErrors.some((pattern) => pattern.test(request)))
      .map(({ step, request }) => `${request} (during "${step}")`);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await Promise.all(this.processes.map((child) => child.stop()));
    for (const hole of this.blackholes) hole.close();
  }
}
