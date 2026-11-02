/**
 * Walks the started app in Chromium, inside the check's sandbox, under Node:
 *
 *   node test/builders/factory/walk-runner.ts <job.json>
 *
 * For each walk script (`export default async (page, baseURL) => void`) it
 * runs the walk in a fresh context, notes every page the walk visited, then
 * opens each of those pages at every width, runs the layout probe and takes a
 * full-page screenshot. It then does the same for the job's fixed routes
 * (the reference screens). It writes `<outDir>/walk-result.json`.
 *
 * Imports only Node and the Playwright client the job names, since it runs
 * inside the sandbox.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { probeLayout, type LayoutFinding } from './layout-probe.ts';
import { ONLINE_INIT_SCRIPT } from './online-init.ts';

export interface WalkJob {
  /** The Playwright client's ES module entry. */
  playwright: string;
  baseURL: string;
  walks: { name: string; file: string }[];
  /** Paths captured as they are, besides the pages walks visit. */
  routes: string[];
  /** A walk run before the routes are captured, in their context, such as signing in. */
  routesSetup?: string;
  widths: number[];
  outDir: string;
}

export interface WalkOutcome {
  name: string;
  passed: boolean;
  error?: string;
  visited: string[];
}

export interface PageCapture {
  path: string;
  width: number;
  /** Relative to the job's outDir. */
  screenshot: string;
  findings: LayoutFinding[];
  /** Why the page couldn't be captured, when it couldn't. */
  error?: string;
}

export interface WalkResult {
  walks: WalkOutcome[];
  pages: PageCapture[];
}

const WALK_TIMEOUT_MS = 5 * 60_000;
const PAGE_TIMEOUT_MS = 90_000;
const SETTLE_MS = 1_500;
const VIEWPORT_HEIGHT = 900;
const HOST_RESOLVER_RULES = 'MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';

/** A file name for a path: `/narration/abc` is `narration-abc`, `/` is `home`. */
export function pathSlug(path: string): string {
  const slug = path.replace(/[?#].*$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'home' : slug;
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000}s`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

async function capture(page: Page, job: WalkJob, path: string, width: number): Promise<PageCapture> {
  const screenshot = `${pathSlug(path)}-${width}.png`;
  try {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    await page.goto(new URL(path, job.baseURL).href, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    const findings = await page.evaluate(probeLayout);
    await page.screenshot({ path: join(job.outDir, screenshot), fullPage: true });
    return { path, width, screenshot, findings };
  } catch (error) {
    return { path, width, screenshot, findings: [], error: errorText(error) };
  }
}

async function captureAll(context: BrowserContext, job: WalkJob, paths: readonly string[]): Promise<PageCapture[]> {
  const page = await context.newPage();
  const captures: PageCapture[] = [];
  for (const path of paths) {
    for (const width of job.widths) captures.push(await capture(page, job, path, width));
  }
  await page.close();
  return captures;
}

/**
 * A context whose pages report `navigator.onLine` as true. Chromium in the
 * sandbox sees only a loopback interface and says it is offline, which a
 * real user's browser never does; Studio then disables sign-in.
 */
async function onlineContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  await context.addInitScript({ path: ONLINE_INIT_SCRIPT });
  return context;
}

type Walk = (page: Page, baseURL: string) => Promise<void>;

async function loadWalk(file: string): Promise<Walk> {
  const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (typeof loaded.default !== 'function') throw new Error(`${file} has no default export function`);
  return loaded.default as Walk;
}

async function runWalk(browser: Browser, job: WalkJob, walk: { name: string; file: string }, seen: Set<string>): Promise<{ outcome: WalkOutcome; pages: PageCapture[] }> {
  const context = await onlineContext(browser, { viewport: { width: job.widths[0] ?? 1440, height: VIEWPORT_HEIGHT } });
  const page = await context.newPage();
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(frame.url());
    const path = `${url.pathname}${url.search}`;
    if (url.origin === new URL(job.baseURL).origin && !visited.includes(path)) visited.push(path);
  });
  let outcome: WalkOutcome;
  try {
    const run = await loadWalk(walk.file);
    await withTimeout(run(page, job.baseURL), WALK_TIMEOUT_MS, `walk ${walk.name}`);
    outcome = { name: walk.name, passed: true, visited };
  } catch (error) {
    outcome = { name: walk.name, passed: false, error: errorText(error), visited };
  }
  await page.close();
  // The same context, so the pages see what the walk signed in as or made.
  const fresh = visited.filter((path) => !seen.has(path));
  for (const path of fresh) seen.add(path);
  const pages = await captureAll(context, job, fresh);
  await context.close();
  return { outcome, pages };
}

/** The fixed routes, after the setup walk when there is one. A failed setup still captures what the routes show. */
async function captureRoutes(browser: Browser, job: WalkJob): Promise<PageCapture[]> {
  const context = await onlineContext(browser);
  if (job.routesSetup !== undefined) {
    const page = await context.newPage();
    await withTimeout(loadWalk(job.routesSetup).then((run) => run(page, job.baseURL)), WALK_TIMEOUT_MS, 'the routes\' setup walk').catch((error: unknown) => {
      console.error(`the routes' setup walk failed: ${errorText(error)}`);
    });
    await page.close();
  }
  const pages = await captureAll(context, job, job.routes);
  await context.close();
  return pages;
}

export async function runJob(job: WalkJob): Promise<WalkResult> {
  mkdirSync(job.outDir, { recursive: true });
  const { chromium } = (await import(pathToFileURL(job.playwright).href)) as typeof import('@playwright/test');
  const browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=${HOST_RESOLVER_RULES}`] });
  const result: WalkResult = { walks: [], pages: [] };
  const seen = new Set<string>();
  try {
    for (const walk of job.walks) {
      const { outcome, pages } = await runWalk(browser, job, walk, seen);
      result.walks.push(outcome);
      result.pages.push(...pages);
    }
    if (job.routes.length > 0) result.pages.push(...await captureRoutes(browser, job));
  } finally {
    await browser.close();
  }
  writeFileSync(join(job.outDir, 'walk-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const isEntryPoint = process.argv[1] === new URL(import.meta.url).pathname;
if (isEntryPoint) {
  const jobFile = process.argv[2];
  if (jobFile === undefined) throw new Error('usage: node test/builders/factory/walk-runner.ts <job.json>');
  await runJob(JSON.parse(readFileSync(jobFile, 'utf8')) as WalkJob);
}
