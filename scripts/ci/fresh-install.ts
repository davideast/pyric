/**
 * Installs pyric the way a new user does and fails on any crash. For each
 * template create-pyric offers, in a clean temporary directory with a fresh
 * HOME, it runs `npx --yes create-pyric@<tag> <dir> --template <name>`, then
 * `npm install` from the npm registry, runs plain `npm run dev` on the
 * template's default host and port, opens the page in Chromium and drives the
 * template's main flow: sign in, one write, one read, a reload.
 * `crashFindings` (fresh-install-checks.ts) decides what fails the run, and
 * `runNotes` adds npm's audit summary, the dev command and the chip to
 * findings.txt.
 *
 *   bun scripts/ci/fresh-install.ts run [--tag exp] [--templates web,chat] [--out <dir>]
 *                                       [--proxy http://127.0.0.1:<port> --egress-log <file>]
 *   bun scripts/ci/fresh-install.ts proxy --port <port> --log <file>
 *   bun scripts/ci/fresh-install.ts rejects --steps <steps.jsonl> --log <firewall-rejects.log> --findings <findings.txt>
 *
 * Every step the driver runs goes to `<out>/steps.jsonl` with its start and
 * end times, the commands it started, and those still running, so each
 * refused request (egress.jsonl) and each firewall reject (`rejects`) names
 * the template and step it fell in.
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
import { lookup } from 'node:dns/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { TEMPLATE_NAMES, type TemplateName } from '../../packages/create-pyric/src/templates.ts';
import { sendDirectMessage, signInAsAda } from '../../test/apps/chat-template.ts';
import { AppRun, launchScenarioBrowser, sleep, StepFailure, type AppProcess } from '../../test/apps/driver.ts';
import {
  ALLOWANCES,
  crashFindings,
  DEV_SETUPS,
  devCommandLine,
  firewallFindings,
  installEnvironment,
  parseFirewallRejects,
  runNotes,
  startEgressProxy,
  UNHANDLED_REJECTION_MARK,
  WORKER_ERROR_MARK,
  type DevCommandRun,
  type DevSetup,
  type EgressEntry,
  type StepRecord,
  type TemplateEvidence,
} from './fresh-install-checks.ts';

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as T);
}

// ─── Step log ──────────────────────────────────────────────────────────

/** A process as steps.jsonl names it: its command line, without the `$ `. */
function commandLabel(child: AppProcess): string {
  return child.header.replace(/^\$ /, '').trim();
}

/** The scenario driver's `AppRun`, with every step appended to a steps.jsonl. */
class RecordedAppRun extends AppRun {
  private stepCount = 0;

  constructor(name: string, dir: string, home: string, launchBrowser: () => Promise<Browser>, private readonly stepsFile: string) {
    super(name, dir, home, launchBrowser);
  }

  override async step<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    this.stepCount += 1;
    const index = this.stepCount;
    const firstNew = this.processes.length;
    const running = this.processes.filter((child) => child.running).map(commandLabel);
    const start = new Date().toISOString();
    try {
      return await super.step(name, run);
    } finally {
      const started = this.processes.slice(firstNew).map(commandLabel);
      const record: StepRecord = { template: this.name, index, step: name, started, running, start, end: new Date().toISOString() };
      appendFileSync(this.stepsFile, `${JSON.stringify(record)}\n`);
    }
  }
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
  /** Where the template's own `npm run dev` serves, and whether its pages mount the chip. */
  dev: DevSetup;
  drive(page: Page, run: TemplateRun): Promise<void>;
}

interface ScriptFlow {
  kind: 'script';
}

const SERVE_TIMEOUT_MS = 180_000;
const FLOW_TIMEOUT_MS = 60_000;

const FLOWS: Record<TemplateName, PageFlow | ScriptFlow> = {
  // The served HTML already says "Signed out", so the required chip is what shows the page's code ran.
  web: {
    kind: 'page',
    dev: DEV_SETUPS.web,
    drive: (page, run) => drivePosts(page, run, { signIn: '#sign-in', title: '#post-title', submit: '#add-post button[type="submit"]', posts: '#posts' }),
  },
  static: {
    kind: 'page',
    dev: DEV_SETUPS.static,
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
    dev: DEV_SETUPS.nextjs,
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
  chat: { kind: 'page', dev: DEV_SETUPS.chat, drive: driveChat },
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
  const timeout = run.chip === 'expected' ? FLOW_TIMEOUT_MS : 10_000;
  await page.waitForSelector('[data-pyric-runtime-chip-host]', { state: 'attached', timeout }).catch(() => undefined);
  return page.evaluate(readChip);
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
  /** Page templates only. */
  chip?: DevSetup['chip'];
  devCommand?: DevCommandRun;
  installOutput?: string;
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

/**
 * `localhost` as a dev server may bind it: 127.0.0.1, ::1, or both. Bun's
 * fetch tries only one, so the probe asks each; Chromium tries both itself.
 */
function loopbackForms(url: string): string[] {
  const parsed = new URL(url);
  if (parsed.hostname !== 'localhost') return [url];
  return ['127.0.0.1', '[::1]'].map((host) => url.replace('//localhost', `//${host}`));
}

async function answersOnSomeLoopback(url: string): Promise<boolean> {
  for (const form of loopbackForms(url)) {
    if (await answersOk(form)) return true;
  }
  return false;
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
    if (await answersOnSomeLoopback(`${url}/__pyric/init.json`) && await answersOnSomeLoopback(`${url}/`)) return;
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

/** The template's own `scripts.dev`, as its package.json says. */
function devScript(project: string): string {
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  return manifest.scripts?.dev ?? '(no dev script)';
}

async function runPageFlow(run: TemplateRun, flow: PageFlow): Promise<void> {
  const { url, env } = flow.dev;
  run.devCommand = { ran: devCommandLine(flow.dev), script: devScript(join(run.app.dir, run.project)), url };
  const dev = await run.app.step('npm run dev serves the page', async () => {
    const child = run.app.commandProcess('npm', ['run', 'dev'], { cwd: run.project, env });
    await waitUntilServed(child, url);
    return child;
  });
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
  const proxied = { env: installEnvironment(options.proxyUrl) };
  await expectExit(run.app, `npx create-pyric@${options.tag} --template ${run.name}`, 'npx', ['--yes', `create-pyric@${options.tag}`, run.project, '--template', run.name], { ...proxied, timeoutMs: 300_000 });
  run.installOutput = await expectExit(run.app, 'npm install', 'npm', ['install'], { ...proxied, cwd: run.project, timeoutMs: 600_000 });
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
  const app = new RecordedAppRun(name, options.workDir, home, () => Promise.resolve(browser), options.stepsFile);
  const flow = FLOWS[name];
  const run: TemplateRun = { name, app, project: `${name}-app`, chipStates: [], chip: flow.kind === 'page' ? flow.dev.chip : undefined };
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
  return {
    template: name,
    failedStep,
    browserLog: [...app.browserLog],
    serverOutput,
    chipStates: run.chipStates,
    chip: run.chip,
    devCommand: run.devCommand,
    installOutput: run.installOutput,
    hostErrors: app.unexpectedHostErrors(),
  };
}

// ─── Entry points ──────────────────────────────────────────────────────

interface RunOptions {
  tag: string;
  templates: TemplateName[];
  out: string;
  workDir: string;
  proxyUrl: string;
  stepsFile: string;
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
  const stepsFile = join(out, 'steps.jsonl');
  writeFileSync(stepsFile, '');
  const options: RunOptions = { tag: flag(args, 'tag') ?? 'exp', templates: templatesFrom(flag(args, 'templates')), out, workDir, proxyUrl, stepsFile };
  console.log(`[fresh-install] create-pyric@${options.tag}, templates ${options.templates.join(', ')}, in ${workDir}, egress through ${proxyUrl}`);

  const browser = await launchScenarioBrowser();
  const templates: TemplateEvidence[] = [];
  for (const name of options.templates) {
    console.log(`[fresh-install] ${name}`);
    templates.push(await evidenceFor(name, options, browser));
  }
  await browser.close();
  proxy?.close();

  const egress = egressLog === undefined ? inProcess : readJsonLines<EgressEntry>(egressLog);
  writeFileSync(join(out, 'egress.jsonl'), egress.map((entry) => JSON.stringify(entry)).join('\n'));
  const evidence = { templates, egress, steps: readJsonLines<StepRecord>(stepsFile) };
  const { failing, allowed } = crashFindings(evidence);
  const lines = [...failing, ...allowed, ...runNotes(evidence)];
  writeFileSync(join(out, 'findings.txt'), lines.join('\n'));
  for (const line of lines) console.error(`[fresh-install] ${line}`);
  console.log(`[fresh-install] ${failing.length} failing, ${allowed.length} allowed; logs in ${out}`);
  return failing.length === 0 ? 0 : 1;
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

/** Names the step of each firewall reject, prints it and adds it to findings.txt; exits 1 on any. */
async function attributeRejects(args: string[]): Promise<number> {
  const steps = flag(args, 'steps');
  const log = flag(args, 'log');
  const findingsFile = flag(args, 'findings');
  if (steps === undefined || log === undefined || findingsFile === undefined) {
    throw new Error('usage: fresh-install.ts rejects --steps <steps.jsonl> --log <firewall-rejects.log> --findings <findings.txt>');
  }
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const { failing, allowed } = firewallFindings(parseFirewallRejects(text), readJsonLines<StepRecord>(steps), await resolveAllowanceNames());
  const lines = [...failing, ...allowed];
  for (const line of lines) console.error(`[fresh-install] ${line}`);
  if (lines.length > 0) appendFileSync(findingsFile, `\n${lines.join('\n')}`);
  return failing.length === 0 ? 0 : 1;
}

/** Every address each allowance's `resolvesTo` name has now, both families; none when it does not resolve. */
async function resolveAllowanceNames(): Promise<Map<string, string[]>> {
  const names = [...new Set(ALLOWANCES.flatMap((allowance) => (allowance.resolvesTo === undefined ? [] : [allowance.resolvesTo])))];
  const resolved = new Map<string, string[]>();
  for (const name of names) {
    const addresses = await lookup(name, { all: true }).catch(() => []);
    resolved.set(name, addresses.map((entry) => entry.address));
    console.log(`[fresh-install] ${name} resolves to ${resolved.get(name)!.join(', ') || 'nothing'}`);
  }
  return resolved;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  const commands: Record<string, (args: string[]) => Promise<number>> = { run, proxy: serveProxy, rejects: attributeRejects };
  const entry = command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (entry === undefined) {
    console.error('usage: fresh-install.ts run [flags] | proxy --port <port> --log <file> | rejects --steps <file> --log <file> --findings <file>');
    process.exit(2);
  }
  process.exit(await entry(rest));
}
