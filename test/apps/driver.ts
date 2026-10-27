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
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { blackholedPort, type BlackholedPort } from '../../packages/cli/test/blackholed-port.ts';
import { npmInstall, pinPyricPackages, type Tarballs } from './install.ts';
import { describeProcState, describeUnreapedExit, watchUnreapedExit } from './unreaped-exit.ts';

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
  /** Set when the child's exit came from /proc (#1274): its process group may still hold children. */
  private exitedUnreaped = false;

  constructor(
    readonly name: string,
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly spawnChild: SpawnChild = spawn,
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
    child.on('close', (code, signal) => {
      if (!isCurrent()) return;
      if (signal) this.text += `\n[driver] exited on ${signal}\n`;
      this.finish(code);
    });
    // Bun can miss a child's exit and never reap it (#1274); /proc still has it.
    this.stopWatchingExit();
    if (child.pid !== undefined) {
      this.stopWatchingExit = watchUnreapedExit(child.pid, (exit) => {
        if (!isCurrent()) return;
        this.text += describeUnreapedExit(this.name, exit);
        this.exitedUnreaped = true;
        this.finish(exit.code);
      });
    }
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
  async stop(grace: StopGrace = DEFAULT_STOP_GRACE): Promise<void> {
    // A child whose exit was read from /proc left its group behind; stop that.
    if (this.exitedUnreaped && this.child.pid !== undefined) {
      try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* the group is gone */ }
      return;
    }
    if (!this.running || this.child.pid === undefined) return;
    const group = -this.child.pid;
    // A stopped process holds SIGTERM until it is continued.
    if (this.isPaused) {
      try { process.kill(group, 'SIGCONT'); } catch { /* already gone */ }
      this.isPaused = false;
    }
    try { process.kill(group, 'SIGTERM'); } catch { /* the group is gone; wait for close below */ }
    if (await this.closesWithin(grace.termMs)) return;
    try { process.kill(group, 'SIGKILL'); } catch { /* already gone */ }
    if (await this.closesWithin(grace.killMs)) return;
    this.text += `\n[driver] ${this.name} did not close within ${grace.killMs / 1000}s of SIGKILL; the driver records it as gone${describeProcState(this.child.pid)}\n`;
    this.finish(null);
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
   * stopped brings a host back on the URL its pages already use.
   */
  devServer(options?: { env?: Record<string, string>; name?: string; port?: number }): Promise<DevServer>;
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
   * packed tarballs, as the app's own do, and `npm install` runs in it.
   * Throws on a failed install.
   */
  installProject(path: string): Promise<ScriptResult>;
  /** The browser context for this app. Requests to hosts other than 127.0.0.1 and localhost are aborted unless a route answers them. */
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
  /** Every page's console lines, page errors, and error responses so far, in order. */
  readonly browserLog: readonly string[];
  /**
   * Declares that a page request to a `/__pyric/` route may answer with an
   * error status, such as a download URL with the wrong token. Any other error
   * a `/__pyric/` route answers to a page fails the app after its scenario.
   */
  expectHostError(pattern: RegExp): void;
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

/** One run of one app: the state behind the `App` a scenario receives. */
export class AppRun implements App {
  readonly processes: AppProcess[] = [];
  readonly browserLog: string[] = [];
  currentStep = 'setup';
  /** Error responses from `/__pyric/` routes to the app's pages, with the step each happened in. */
  private readonly hostErrors: { step: string; request: string }[] = [];
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
    /** The packed Pyric packages and npm cache the runner installed the app with. */
    private readonly packages?: { tarballs: Tarballs; npmCache: string },
    /** Where `freePort()`, `blackholedPort()`, and `devServer()` get their ports. */
    private readonly ports: PortIssuer = runPorts,
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

  async devServer(options: { env?: Record<string, string>; name?: string; port?: number } = {}): Promise<DevServer> {
    const port = options.port ?? await freePort(this.ports);
    this.serverCount += 1;
    const name = options.name ?? (this.serverCount === 1 ? 'dev server' : `dev server ${this.serverCount}`);
    const child = new AppProcess(
      name,
      'node',
      [join(this.dir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      this.dir,
      appEnvironment(this.home, options.env),
    );
    this.processes.push(child);
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
    this.scriptCount += 1;
    const label = [command, ...args].join(' ');
    const child = new AppProcess(
      `command ${this.scriptCount} (${label})`,
      command,
      args,
      join(this.dir, options.cwd ?? '.'),
      appEnvironment(this.home, options.env),
    );
    this.processes.push(child);
    const timeoutMs = options.timeoutMs ?? 60_000;
    const finished = await Promise.race([child.exited.then(() => true), sleep(timeoutMs).then(() => false)]);
    if (!finished) {
      await child.stop();
      throw new Error(`${label} did not exit within ${timeoutMs / 1000}s:\n${child.output}`);
    }
    return { code: await child.exited, output: child.output };
  }

  async installProject(path: string): Promise<ScriptResult> {
    if (!this.packages) throw new Error('installProject needs the packed packages; the runner passes them');
    pinPyricPackages(join(this.dir, path), this.packages.tarballs);
    const result = await npmInstall(this.packages.npmCache, (args) => this.command('npm', args, { cwd: path, timeoutMs: 240_000 }));
    if (result.code !== 0) throw new Error(`npm install in ${path} exited with code ${result.code}:\n${result.output}`);
    return result;
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
    // The first route registered runs last, so a scenario's own routes answer first.
    await context.route(() => true, async (route) => {
      const url = new URL(route.request().url());
      const isLocal = LOCAL_HOSTS.has(url.hostname) || url.protocol === 'data:' || url.protocol === 'blob:';
      if (isLocal) return route.continue();
      this.browserLog.push(`[blocked external request] ${route.request().method()} ${url.href}`);
      return route.abort('blockedbyclient');
    });
    this.context = context;
    return context;
  }

  async page(url: string): Promise<Page> {
    const context = await this.browser();
    const page = await context.newPage();
    const index = context.pages().length;
    page.on('console', (message) => this.browserLog.push(`[page ${index} console.${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => this.browserLog.push(`[page ${index} error] ${error.stack ?? error.message}`));
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
