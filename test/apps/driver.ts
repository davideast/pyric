/**
 * The shared driver for app scenarios. A scenario receives an `App`: the
 * installed copy of one app directory, with helpers that start the app's real
 * Vite dev server, run its server scripts under `node --import
 * @pyric/cli/register`, and open its page in Chromium. Every process and page
 * the scenario starts is recorded, so a failure report can name the step and
 * show each log.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { blackholedPort, type BlackholedPort } from '../../packages/cli/test/blackholed-port.ts';
import {
  AppProcess,
  DEFAULT_PROCESS_TIMING,
  sleep,
  type LogWaitOptions,
  type ProcessTiming,
  type SpawnChild,
  type StopGrace,
} from './app-process.ts';
import { answers, guardContext, launchScenarioBrowser, LOCAL_ONLY_RESOLVER_RULES } from './driver-browser.ts';
import {
  scenario,
  type App,
  type DevServer,
  type DevServerOptions,
  type ExpectedCrash,
  type NestedInstalls,
  type Scenario,
  type ScriptResult,
} from './driver-types.ts';
import { NESTED_INSTALL_ATTEMPT_MS, pinPyricPackages, retryOnceOnTimeout, type TimedResult } from './install.ts';
import { NESTED_PROJECTS_FILE, nestedProject } from './nested-projects.ts';
import { freePort, isAddressInUseOutput, runPorts, type PortIssuer } from './ports.ts';
import { CrashWatch, type CrashVerdict, type WatchedProcess } from './crash-watch.ts';
import { firstLine, HostErrors, responseTimes, STOPPING_HOST_NOTE } from './host-errors.ts';
import { sessionHeaders, sessionToken } from './session-token.ts';
import { StepFailure } from './step-failure.ts';

export {
  AppProcess,
  DEFAULT_PROCESS_TIMING,
  guardContext,
  launchScenarioBrowser,
  LOCAL_ONLY_RESOLVER_RULES,
  scenario,
  sessionHeaders,
  sessionToken,
  sleep,
  StepFailure,
  type App,
  type DevServer,
  type DevServerOptions,
  type ExpectedCrash,
  type LogWaitOptions,
  type NestedInstalls,
  type ProcessTiming,
  type Scenario,
  type ScriptResult,
  type SpawnChild,
  type StopGrace,
};

const AUTO_PORT_BIND_ATTEMPTS = 3;

function numberedServerName(prefix: string, count: number, customName?: string): string {
  if (customName !== undefined) return customName;
  if (count === 1) return prefix;
  return `${prefix} ${count}`;
}

function isRetryableAutoPortCollision(
  fixedPort: number | undefined,
  attempt: number,
  child: AppProcess,
  port: number,
): boolean {
  if (fixedPort !== undefined) return false;
  if (attempt >= AUTO_PORT_BIND_ATTEMPTS) return false;
  if (child.running) return false;
  return isAddressInUseOutput(child.output, port);
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

/** One run of one app: the state behind the `App` a scenario receives. */
export class AppRun implements App {
  readonly processes: AppProcess[] = [];
  readonly browserLog: string[] = [];
  currentStep = 'setup';
  /** Error responses from `/__pyric/` routes to the app's pages, and which of them fail the app (host-errors.ts). */
  private readonly hostErrors = new HostErrors();
  private readonly expectedLeftovers: RegExp[] = [];
  private context: BrowserContext | undefined;
  private serverCount = 0;
  private scriptCount = 0;
  private readonly blackholes: BlackholedPort[] = [];
  /** Uncaught errors and crashes in the app's pages, workers, and processes (crash-watch.ts). */
  readonly crashWatch = new CrashWatch(() => this.currentStep);

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
    /** Starts the run's server processes; tests pass a stand-in. */
    private readonly spawnChild: SpawnChild = spawn,
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

  async devServer(options: DevServerOptions = {}): Promise<DevServer> {
    this.serverCount += 1;
    const name = numberedServerName('dev server', this.serverCount, options.name);
    const projectDir = join(this.dir, options.cwd ?? '.');
    return this.startHostOnPort(name, options.port, options.https === true, (port) => {
      const child = new AppProcess(
        name,
        'node',
        [join(projectDir, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
        projectDir,
        appEnvironment(this.home, options.env),
        this.spawnChild,
        this.timing,
      );
      child.runsUntilStopped = true;
      this.processes.push(child);
      return child;
    });
  }

  async sandboxServer(options: { env?: Record<string, string>; name?: string; port?: number } = {}): Promise<DevServer> {
    this.serverCount += 1;
    const name = numberedServerName('pyric sandbox', this.serverCount, options.name);
    return this.startHostOnPort(name, options.port, false, (port) =>
      this.pyricProcess(['sandbox', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)], { env: options.env }),
    );
  }

  private async startHostOnPort(
    name: string,
    fixedPort: number | undefined,
    https: boolean,
    start: (port: number) => AppProcess,
  ): Promise<DevServer> {
    for (let attempt = 1; ; attempt += 1) {
      const port = fixedPort ?? await freePort(this.ports);
      const child = start(port);
      try {
        return await this.servedHost(name, port, child, https);
      } catch (error) {
        if (!isRetryableAutoPortCollision(fixedPort, attempt, child, port)) throw error;
        const index = this.processes.indexOf(child);
        if (index !== -1) this.processes.splice(index, 1);
      }
    }
  }

  /** Waits until a host process serves `/` and `/__pyric/init.json` on `port`, over https when `https`. */
  private async servedHost(name: string, port: number, child: AppProcess, https = false): Promise<DevServer> {
    this.hostErrors.servedBy(port, child);
    const scheme = https ? 'https' : 'http';
    const url = `${scheme}://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      if (!child.running) throw new Error(`${name} exited (code ${await child.exited}) before it served ${url}`);
      if (await answers(`${url}/`) && await answers(`${url}/__pyric/init.json`)) break;
      if (Date.now() > deadline) throw new Error(`${name} did not serve ${url}/ and ${url}/__pyric/init.json within 90s`);
      await sleep(250);
    }
    child.snapshotSubgroups();
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
    child.runsUntilStopped = true;
    this.processes.push(child);
    return child;
  }

  pyricProcess(args: string[], options: { env?: Record<string, string> } = {}): AppProcess {
    const child = this.startPyric(args, options);
    child.runsUntilStopped = true;
    return child;
  }

  /** Starts the installed `pyric` command, for `pyric()` to run to exit and `pyricProcess()` to run until stopped. */
  private startPyric(args: string[], options: { env?: Record<string, string> }): AppProcess {
    this.scriptCount += 1;
    const child = new AppProcess(
      `pyric ${this.scriptCount} (${args.join(' ')})`,
      'node',
      [join('node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js'), ...args],
      this.dir,
      appEnvironment(this.home, options.env),
      this.spawnChild,
      this.timing,
    );
    this.processes.push(child);
    return child;
  }

  async pyric(args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<ScriptResult> {
    const child = this.startPyric(args, options);
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

  commandProcess(command: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): AppProcess {
    this.scriptCount += 1;
    const child = new AppProcess(
      `process ${this.scriptCount} (${[command, ...args].join(' ')})`,
      command,
      args,
      join(this.dir, options.cwd ?? '.'),
      appEnvironment(this.home, options.env),
      spawn,
      this.timing,
    );
    child.runsUntilStopped = true;
    this.processes.push(child);
    return child;
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
    await this.crashWatch.watchContext(context);
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
      const request = response.request();
      const verdict = this.hostErrors.record(this.currentStep, { status: response.status(), method: request.method(), href: response.url(), times: responseTimes(request.timing()) });
      let note = '';
      if (verdict.kind === 'from-stopping-host') note = STOPPING_HOST_NOTE;
      this.browserLog.push(`[page ${index} response ${response.status()}${note}] ${request.method()} ${response.url()}`);
      // The body says why the route failed, such as the dev server's own error page for a rewrite it could not proxy.
      if (verdict.kind === 'counted') response.text().then((text) => { verdict.error.body = firstLine(text); }, () => undefined);
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

  expectHostError(pattern: RegExp, options: { mayNotHappen?: string } = {}): void {
    this.hostErrors.expect(pattern, options);
  }

  expectLeftoverProcess(pattern: RegExp): void {
    this.expectedLeftovers.push(pattern);
  }

  /**
   * What fails the app after its scenario: each process an app process
   * started that outlived it and that no `expectLeftoverProcess` pattern
   * matches, then each pattern that matched no leftover. A pattern that
   * matched nothing fails the run as an `expectedCrashes` entry does
   * (crash-watch.ts), so the list cannot outlive what it describes.
   */
  unexpectedLeftoverProcesses(): string[] {
    const leftovers = this.processes.flatMap((child) => child.leftoverProcesses.map((leftover) => ({ leftover, child })));
    const unexpected = leftovers
      .filter(({ leftover }) => !this.expectedLeftovers.some((pattern) => pattern.test(leftover.comm)))
      .map(({ leftover, child }) => `pid ${leftover.pid} (${leftover.comm}), started by ${child.name}`);
    const stale = this.expectedLeftovers
      .filter((pattern) => !leftovers.some(({ leftover }) => pattern.test(leftover.comm)))
      .map((pattern) => `expectLeftoverProcess(${pattern}) matched no leftover process; remove it or fix its pattern`);
    return [...unexpected, ...stale];
  }

  /** Records an error response a page received; only `/__pyric/` routes count as host errors. */
  noteErrorResponse(status: number, method: string, href: string, body?: string): void {
    const verdict = this.hostErrors.record(this.currentStep, { status, method, href });
    if (verdict.kind === 'counted' && body !== undefined) verdict.error.body = firstLine(body);
  }

  /**
   * What fails the app after its scenario: each error response from a
   * `/__pyric/` route that counts and that no `expectHostError` pattern
   * matches, then each pattern that matched no error (host-errors.ts).
   */
  unexpectedHostErrors(): string[] {
    return this.hostErrors.unexpected();
  }

  watchCrashes(context: BrowserContext): Promise<void> {
    return this.crashWatch.watchContext(context);
  }

  /** The crashes in the app's pages, workers, and processes so far that no `expected` entry matches, and the entries nothing matched. */
  crashVerdict(expected: readonly ExpectedCrash[]): CrashVerdict {
    const processes: WatchedProcess[] = this.processes.map((child) => ({ name: child.name, output: child.output, earlyExitCode: child.earlyExitCode }));
    return this.crashWatch.verdict(expected, processes);
  }

  async close(): Promise<void> {
    await this.context?.close().catch((error) => { void error; });
    await Promise.all(this.processes.map((child) => child.stop()));
    for (const hole of this.blackholes) hole.close();
  }
}
