/**
 * Installs pyric the way a new user does and fails on any crash. For each
 * template create-pyric offers, in a clean temporary directory with a fresh
 * HOME, it runs `npx --yes create-pyric@<tag> <dir> --template <name>`, then
 * `npm install` from the npm registry, starts the template's own dev command,
 * opens the page in Chromium and drives the template's main flow: sign in,
 * one write, one read, a reload. `crashFindings` (fresh-install-checks.ts)
 * decides what fails the run.
 *
 *   bun scripts/ci/fresh-install.ts run [--tag exp] [--templates web,chat] [--out <dir>]
 *                                       [--proxy http://127.0.0.1:<port> --egress-log <file>]
 *   bun scripts/ci/fresh-install.ts proxy --port <port> --log <file>
 *
 * Every create and install goes through an egress guard: a local proxy that
 * tunnels only to registry.npmjs.org:443 and records every request. `run`
 * starts one in-process unless `--proxy` names one already running; the
 * nightly workflow starts it with `proxy`, outside a group whose direct
 * connections the firewall rejects, so a client that ignores the proxy
 * settings fails instead of leaving the machine. Pages and dev servers reach
 * only loopback (the app scenario driver's browser guard).
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { TEMPLATE_NAMES, type TemplateName } from '../../packages/create-pyric/src/templates.ts';
import { sendDirectMessage, signInAsAda } from '../../test/apps/chat-template.ts';
import { AppRun, launchScenarioBrowser, sleep, StepFailure, type AppProcess } from '../../test/apps/driver.ts';
import {
  crashFindings,
  REGISTRY_HOST,
  startEgressProxy,
  UNHANDLED_REJECTION_MARK,
  WORKER_ERROR_MARK,
  type EgressEntry,
  type TemplateEvidence,
} from './fresh-install-checks.ts';

// ─── Egress guard ──────────────────────────────────────────────────────

function proxyEnvironment(proxyUrl: string): Record<string, string> {
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
    npm_config_https_proxy: proxyUrl,
    npm_config_proxy: proxyUrl,
    npm_config_registry: `https://${REGISTRY_HOST}/`,
  };
}

function readEgressLog(path: string): EgressEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as EgressEntry);
}

// ─── Template flows ────────────────────────────────────────────────────

/** Selectors of the posts page the web, static and nextjs templates share in shape. */
interface PostsPage {
  signIn: string;
  title: string;
  submit: string;
  posts: string;
  /** Text the page's own code renders once it runs, which the served HTML does not already hold. */
  ready?: { step: string; selector: string; text: string };
  /** An element whose text must start with `prefix` once the page's server route answered. */
  serverStatus?: { selector: string; prefix: string };
}

interface PageFlow {
  kind: 'page';
  /** Arguments after `npm run dev --` that put the page on 127.0.0.1:`port`. */
  devArgs(port: number): string[];
  /** Environment for the dev command beyond the run's own. */
  devEnv?: Record<string, string>;
  /** `required` where the template's plane always mounts the runtime chip (the Vite plugin). */
  chip: 'required' | 'optional';
  drive(page: Page, run: TemplateRun): Promise<void>;
}

interface ScriptFlow {
  kind: 'script';
}

const SERVE_TIMEOUT_MS = 180_000;
const FLOW_TIMEOUT_MS = 60_000;
const VITE_ARGS = (port: number) => ['--host', '127.0.0.1', '--port', String(port), '--strictPort'];

const FLOWS: Record<TemplateName, PageFlow | ScriptFlow> = {
  // The served HTML already says "Signed out", so the required chip is what shows the page's code ran.
  web: {
    kind: 'page',
    devArgs: VITE_ARGS,
    chip: 'required',
    drive: (page, run) => drivePosts(page, run, { signIn: '#sign-in', title: '#post-title', submit: '#add-post button[type="submit"]', posts: '#posts' }),
  },
  static: {
    kind: 'page',
    devArgs: (port) => ['--no-open', '--host', '127.0.0.1', '--port', String(port)],
    chip: 'optional',
    drive: (page, run) => drivePosts(page, run, {
      signIn: '#sign-in',
      title: '#post-title',
      submit: '#add-post button[type="submit"]',
      posts: '#posts',
      ready: { step: 'the page lists the seeded posts', selector: '#posts', text: 'Welcome to pyric' },
    }),
  },
  nextjs: {
    kind: 'page',
    // `pyric sandbox -- next dev`: these land after `next dev`.
    devArgs: (port) => ['--port', String(port), '--hostname', '127.0.0.1'],
    // The firewall rejects anything but loopback, so telemetry is turned off the way a careful user does.
    devEnv: { NEXT_TELEMETRY_DISABLED: '1' },
    chip: 'optional',
    drive: (page, run) => drivePosts(page, run, {
      signIn: '#sign-in-button',
      title: '#post-title-input',
      submit: '#submit-post-button',
      posts: '#posts-list',
      // The page renders "Checking authentication state..." until its auth listener runs.
      ready: { step: 'the page reaches its signed-out state', selector: '#auth-status', text: 'Signed out' },
      serverStatus: { selector: '#api-status', prefix: 'Server-Side Admin API Runtime:' },
    }),
  },
  chat: { kind: 'page', devArgs: VITE_ARGS, chip: 'required', drive: driveChat },
  node: { kind: 'script' },
};

/** Runs in the page: the runtime chip's state, `absent` when the page has none. */
function readChip(): string {
  const root = document.querySelector('[data-pyric-runtime-chip-host]')?.shadowRoot;
  if (!root) return 'absent';
  const chip = root.querySelector('button.chip');
  if (chip?.classList.contains('error')) return `error: ${chip.getAttribute('title') ?? 'error tone'}`;
  const said = root.querySelector('.announcer')?.textContent ?? '';
  if (said !== '' && !said.startsWith('No runtime errors')) return said;
  return 'Ready';
}

async function chipState(page: Page, run: TemplateRun): Promise<string> {
  const timeout = run.chip === 'required' ? FLOW_TIMEOUT_MS : 10_000;
  await page.waitForSelector('[data-pyric-runtime-chip-host]', { state: 'attached', timeout }).catch(() => undefined);
  const state = await page.evaluate(readChip);
  if (state === 'absent' && run.chip === 'required') return 'absent, though this template always mounts it';
  return state;
}

async function signInThroughDialog(page: Page, trigger: string): Promise<void> {
  await page.click(trigger);
  const dialog = page.locator('dialog[data-pyric-auth][open]');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  await dialog.locator('input[type="email"]').fill('ada@example.com');
  await dialog.locator('input[placeholder="Display name (optional)"]').fill('Ada');
  await dialog.locator('button.submit').click();
}

/** Runs in the page: whether `#auth-status` matches `pattern`. */
function statusMatches(pattern: string): boolean {
  return new RegExp(pattern).test(document.querySelector('#auth-status')?.textContent ?? '');
}

/** Runs in the page: whether the element `selector` names shows `text`. */
function listShows({ selector, text }: { selector: string; text: string }): boolean {
  return document.querySelector(selector)?.textContent?.includes(text) === true;
}

/** Runs in the page: whether the element `selector` names starts with `prefix`. */
function startsWith({ selector, prefix }: { selector: string; prefix: string }): boolean {
  return document.querySelector(selector)?.textContent?.startsWith(prefix) === true;
}

async function drivePosts(page: Page, run: TemplateRun, selectors: PostsPage): Promise<void> {
  const title = `fresh install ${Date.now()}`;
  const status = (pattern: string) => page.waitForFunction(statusMatches, pattern, { timeout: FLOW_TIMEOUT_MS });
  const listed = () => page.waitForFunction(listShows, { selector: selectors.posts, text: title }, { timeout: FLOW_TIMEOUT_MS });
  const { ready, serverStatus } = selectors;
  if (ready) await run.app.step(ready.step, () => page.waitForFunction(listShows, ready, { timeout: FLOW_TIMEOUT_MS }));
  run.chipStates.push(await chipState(page, run));
  if (serverStatus) {
    await run.app.step(`${serverStatus.selector} shows the server route answered`, () =>
      page.waitForFunction(startsWith, serverStatus, { timeout: FLOW_TIMEOUT_MS }));
  }
  await run.app.step('sign in through the sandbox Google dialog', async () => {
    await signInThroughDialog(page, selectors.signIn);
    await status('^Signed in as ');
  });
  await run.app.step('write one post', async () => {
    await page.fill(selectors.title, title);
    await page.click(selectors.submit);
  });
  await run.app.step('read the post back', listed);
  await run.app.step('after a reload the user and the post are still there', async () => {
    await page.reload();
    await status('^Signed in as ');
    await listed();
  });
  run.chipStates.push(await chipState(page, run));
}

async function driveChat(page: Page, run: TemplateRun): Promise<void> {
  const text = `fresh install ${Date.now()}`;
  const seesMessage = () => page.getByText(text, { exact: true }).first().waitFor({ timeout: FLOW_TIMEOUT_MS });
  await run.app.step('the page offers sign-in', () => page.getByRole('button', { name: 'Sign in to continue' }).waitFor({ timeout: FLOW_TIMEOUT_MS }));
  run.chipStates.push(await chipState(page, run));
  await run.app.step('sign in through the sandbox Google dialog', () => signInAsAda(page));
  await run.app.step('send one message', async () => {
    await sendDirectMessage(page, text);
    await page.getByRole('button', { name: 'Stop generating' }).waitFor({ state: 'hidden', timeout: 90_000 });
  });
  await run.app.step('read the message back', seesMessage);
  await run.app.step('after a reload the user and the message are still there', async () => {
    await page.reload();
    await page.getByRole('button', { name: 'Sign out' }).waitFor({ timeout: FLOW_TIMEOUT_MS });
    await seesMessage();
  });
  run.chipStates.push(await chipState(page, run));
}

// ─── One template ──────────────────────────────────────────────────────

interface TemplateRun {
  name: TemplateName;
  app: AppRun;
  project: string;
  chipStates: string[];
  chip: PageFlow['chip'];
  /** The browser context, once the flow opened one. */
  context?: BrowserContext;
}

/** Routes page crashes, unhandled rejections and worker errors into the browser log. */
async function watchContext(context: BrowserContext, log: string[]): Promise<void> {
  context.on('page', (page) => page.on('crash', () => log.push(`[page crashed] ${page.url()}`)));
  await context.addInitScript(({ rejection, worker }) => {
    addEventListener('unhandledrejection', (event) => {
      const { reason } = event as PromiseRejectionEvent;
      const stack = (reason as { stack?: unknown } | null | undefined)?.stack;
      console.error(`${rejection} ${typeof stack === 'string' ? stack : String(reason)}`);
    });
    for (const name of ['Worker', 'SharedWorker'] as const) {
      const Original = globalThis[name] as (new (...args: unknown[]) => EventTarget) | undefined;
      if (typeof Original !== 'function') continue;
      globalThis[name] = new Proxy(Original, {
        construct(target, args) {
          const created = Reflect.construct(target, args) as EventTarget;
          created.addEventListener('error', (event) => {
            console.error(`${worker} ${name} ${String(args[0])}: ${(event as ErrorEvent).message || 'script error'}`);
          });
          return created;
        },
      }) as never;
    }
  }, { rejection: UNHANDLED_REJECTION_MARK, worker: WORKER_ERROR_MARK });
  await context.tracing.start({ screenshots: true, snapshots: true });
}

async function answersOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntilServed(dev: AppProcess, url: string): Promise<void> {
  const deadline = Date.now() + SERVE_TIMEOUT_MS;
  for (;;) {
    if (!dev.running) throw new Error(`npm run dev exited (code ${await dev.exited}) before it served ${url}`);
    if (await answersOk(`${url}/__pyric/init.json`) && await answersOk(`${url}/`)) return;
    if (Date.now() > deadline) throw new Error(`npm run dev did not serve ${url}/ and ${url}/__pyric/init.json within ${SERVE_TIMEOUT_MS / 1000}s`);
    await sleep(500);
  }
}

async function expectExit(app: AppRun, step: string, command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; timeoutMs: number }): Promise<string> {
  return app.step(step, async () => {
    const result = await app.command(command, args, options);
    if (result.code !== 0) throw new Error(`exit ${result.code}: ${result.output.trimEnd().split('\n').slice(-20).join('\n')}`);
    return result.output;
  });
}

async function runPageFlow(run: TemplateRun, flow: PageFlow): Promise<void> {
  const port = await run.app.freePort();
  const url = `http://127.0.0.1:${port}`;
  const dev = run.app.commandProcess('npm', ['run', 'dev', '--', ...flow.devArgs(port)], { cwd: run.project, env: flow.devEnv });
  await run.app.step('npm run dev serves the page', () => waitUntilServed(dev, url));
  run.context = await run.app.browser();
  await watchContext(run.context, run.app.browserLog);
  const page = await run.app.step('open the page', () => run.app.page(`${url}/`));
  await flow.drive(page, run);
  await run.app.step('npm run dev is still running after the flow', async () => {
    if (!dev.running) throw new Error(`npm run dev exited with code ${await dev.exited}`);
  });
}

async function runScriptFlow(run: TemplateRun): Promise<void> {
  for (const attempt of ['first', 'second']) {
    const output = await expectExit(run.app, `the ${attempt} npm run dev seeds and reads the sandbox`, 'npm', ['run', 'dev'], { cwd: run.project, timeoutMs: SERVE_TIMEOUT_MS });
    if (!/\d+ posts:/.test(output)) throw new StepFailure(`the ${attempt} npm run dev prints its posts`, new Error(output));
  }
}

async function runTemplate(run: TemplateRun, options: RunOptions): Promise<void> {
  const proxied = { env: proxyEnvironment(options.proxyUrl) };
  await expectExit(run.app, `npx create-pyric@${options.tag} --template ${run.name}`, 'npx', ['--yes', `create-pyric@${options.tag}`, run.project, '--template', run.name], { ...proxied, timeoutMs: 300_000 });
  await expectExit(run.app, 'npm install', 'npm', ['install'], { ...proxied, cwd: run.project, timeoutMs: 600_000 });
  const flow = FLOWS[run.name];
  if (flow.kind === 'page') await runPageFlow(run, flow);
  else await runScriptFlow(run);
}

/** Saves each process's output, the browser log, the trace and npm's debug logs under `dir`. */
async function saveLogs(run: TemplateRun, home: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  run.app.processes.forEach((child, index) => writeFileSync(join(dir, `${index + 1}-process.log`), child.header + child.output));
  writeFileSync(join(dir, 'browser.log'), run.app.browserLog.join('\n'));
  await run.context?.tracing.stop({ path: join(dir, 'trace.zip') }).catch(() => undefined);
  const npmLogs = join(home, '.npm', '_logs');
  if (existsSync(npmLogs)) cpSync(npmLogs, join(dir, 'npm-logs'), { recursive: true });
}

async function evidenceFor(name: TemplateName, options: RunOptions, browser: Browser): Promise<TemplateEvidence> {
  // A HOME, and so an npm cache, of its own: no install reuses another's downloads.
  const home = join(options.workDir, `.home-${name}`);
  mkdirSync(home, { recursive: true });
  const app = new AppRun(name, options.workDir, home, () => Promise.resolve(browser));
  const flow = FLOWS[name];
  const run: TemplateRun = { name, app, project: `${name}-app`, chipStates: [], chip: flow.kind === 'page' ? flow.chip : 'optional' };
  let failedStep: TemplateEvidence['failedStep'];
  try {
    await runTemplate(run, options);
  } catch (error) {
    const step = error instanceof StepFailure ? error.step : app.currentStep;
    const reason = error instanceof StepFailure ? error.reason : error;
    failedStep = { step, reason: reason instanceof Error ? reason.message : String(reason) };
  }
  await saveLogs(run, home, join(options.out, name));
  await app.close();
  const serverOutput = app.processes.filter((child) => child.name.includes('npm run dev')).map((child) => child.output).join('\n');
  return { template: name, failedStep, browserLog: [...app.browserLog], serverOutput, chipStates: run.chipStates, hostErrors: app.unexpectedHostErrors() };
}

// ─── Entry points ──────────────────────────────────────────────────────

interface RunOptions {
  tag: string;
  templates: TemplateName[];
  out: string;
  workDir: string;
  proxyUrl: string;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function templatesFrom(list: string | undefined): TemplateName[] {
  if (list === undefined) return [...TEMPLATE_NAMES];
  const names = list.split(',').filter(Boolean);
  const unknown = names.filter((name) => !(TEMPLATE_NAMES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`unknown template ${unknown.join(', ')} (create-pyric offers ${TEMPLATE_NAMES.join(', ')})`);
  // Each template runs once: a repeat would scaffold into the directory the first one made.
  return [...new Set(names)] as TemplateName[];
}

async function run(args: string[]): Promise<number> {
  const out = resolve(flag(args, 'out') ?? 'test-results/fresh-install');
  mkdirSync(out, { recursive: true });
  const workDir = mkdtempSync(join(tmpdir(), 'pyric-fresh-install-'));
  const inProcess: EgressEntry[] = [];
  const externalProxy = flag(args, 'proxy');
  const egressLog = flag(args, 'egress-log');
  const proxy = externalProxy === undefined ? await startEgressProxy(0, (entry) => inProcess.push(entry)) : undefined;
  const address = proxy?.address();
  const proxyUrl = externalProxy ?? `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const options: RunOptions = { tag: flag(args, 'tag') ?? 'exp', templates: templatesFrom(flag(args, 'templates')), out, workDir, proxyUrl };
  console.log(`[fresh-install] create-pyric@${options.tag}, templates ${options.templates.join(', ')}, in ${workDir}, egress through ${proxyUrl}`);

  const browser = await launchScenarioBrowser();
  const templates: TemplateEvidence[] = [];
  for (const name of options.templates) {
    console.log(`[fresh-install] ${name}`);
    templates.push(await evidenceFor(name, options, browser));
  }
  await browser.close();
  proxy?.close();

  const egress = egressLog === undefined ? inProcess : readEgressLog(egressLog);
  writeFileSync(join(out, 'egress.jsonl'), egress.map((entry) => JSON.stringify(entry)).join('\n'));
  const findings = crashFindings({ templates, egress });
  writeFileSync(join(out, 'findings.txt'), findings.join('\n'));
  for (const finding of findings) console.error(`[fresh-install] ${finding}`);
  console.log(`[fresh-install] ${findings.length === 0 ? 'no findings' : `${findings.length} findings`}; logs in ${out}`);
  return findings.length === 0 ? 0 : 1;
}

async function serveProxy(args: string[]): Promise<number> {
  const port = Number(flag(args, 'port'));
  const log = flag(args, 'log');
  if (!Number.isInteger(port) || port <= 0 || log === undefined) throw new Error('usage: fresh-install.ts proxy --port <port> --log <file>');
  writeFileSync(log, '');
  await startEgressProxy(port, (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`));
  console.log(`[fresh-install] egress guard on http://127.0.0.1:${port}, logging to ${log}`);
  return new Promise(() => {});
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const commands: Record<string, (args: string[]) => Promise<number>> = { run, proxy: serveProxy };
  const entry = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (entry === undefined) {
    console.error('usage: fresh-install.ts run [flags] | proxy --port <port> --log <file>');
    process.exit(2);
  }
  process.exit(await entry(rest));
}
