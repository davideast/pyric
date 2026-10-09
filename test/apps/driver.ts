/**
 * The shared driver for app scenarios. A scenario receives an `App`: the
 * installed copy of one app directory, with helpers that start the app's real
 * Vite dev server, run its server scripts under `node --import
 * @pyric/cli/register`, and open its page in Chromium. Every process and page
 * the scenario starts is recorded, so a failure report can name the step and
 * show each log.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';

export interface LogWaitOptions {
  /** Only output after this offset (from `mark()`) counts. Default: all output. */
  since?: number;
  timeoutMs?: number;
}

/** One child process of the app, with its interleaved stdout and stderr. */
export class AppProcess {
  readonly exited: Promise<number | null>;
  private readonly child: ChildProcess;
  /** The command line, shown at the top of the saved log. */
  readonly header: string;
  private text = '';
  private exitCode: number | null | undefined;

  constructor(readonly name: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const pyricEnv = Object.entries(env).filter(([key]) => key.startsWith('PYRIC_')).map(([key, value]) => `${key}=${value} `);
    this.header = `$ ${pyricEnv.join('')}${[command, ...args].join(' ')}\n`;
    this.child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.stdout?.on('data', (chunk) => { this.text += chunk; });
    this.child.stderr?.on('data', (chunk) => { this.text += chunk; });
    this.exited = new Promise((resolve) => {
      this.child.on('error', (error) => {
        this.text += `\n[driver] could not start ${command}: ${error.message}\n`;
        this.exitCode = null;
        resolve(null);
      });
      this.child.on('close', (code, signal) => {
        this.exitCode = code;
        if (signal) this.text += `\n[driver] exited on ${signal}\n`;
        resolve(code);
      });
    });
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

  async stop(): Promise<void> {
    if (!this.running || this.child.pid === undefined) return;
    const group = -this.child.pid;
    try { process.kill(group, 'SIGTERM'); } catch { return; }
    const stopped = await Promise.race([this.exited.then(() => true), sleep(5_000).then(() => false)]);
    if (!stopped) {
      try { process.kill(group, 'SIGKILL'); } catch { /* already gone */ }
      await this.exited;
    }
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
   * free port and waits until it serves the page and `/__pyric/init.json`.
   * The port is passed on the command line, which overrides the config file.
   */
  devServer(options?: { env?: Record<string, string>; name?: string }): Promise<DevServer>;
  /** Runs `node --import @pyric/cli/register <script> ...args` to exit. Throws on a non-zero exit. */
  serverScript(script: string, args?: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<ScriptResult>;
  /** The browser context for this app. Requests to hosts other than 127.0.0.1 and localhost are aborted unless a route answers them. */
  browser(): Promise<BrowserContext>;
  /** Opens `url` in a new page of the app's browser context. */
  page(url: string): Promise<Page>;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
  /** A free TCP port on 127.0.0.1. */
  freePort(): Promise<number>;
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

export function freePort(): Promise<number> {
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

  constructor(
    readonly name: string,
    readonly dir: string,
    private readonly home: string,
    private readonly launchBrowser: () => Promise<Browser>,
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
    return freePort();
  }

  async devServer(options: { env?: Record<string, string>; name?: string } = {}): Promise<DevServer> {
    const port = await freePort();
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
  }
}
