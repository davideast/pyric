#!/usr/bin/env bun
/**
 * Run every `<name>.json` fixture in `scripts/fixtures/` through the
 * playground in parallel via Playwright `BrowserContext` isolation,
 * grep each context's console for the probe's DONE marker, and
 * aggregate pass/fail.
 *
 * Pass contract per fixture:
 *   - Probe TSX logs `[<name>] DONE ok` on success
 *   - Probe TSX logs `[<name>] DONE fail: <reason>` on a caught throw
 *   - Anything else (or absence within the wait window) → fail/timeout
 *
 * Parallelism: each fixture runs in its own Playwright `BrowserContext`,
 * which has fresh IndexedDB / localStorage / sessionStorage. All
 * contexts share one Chromium browser + the dev server. Default
 * concurrency = fixture count (cap with CONCURRENCY env if needed).
 *
 * Setup (one-time):
 *   bun add -d playwright && bunx playwright install chromium
 *   bun scripts/fixtures/build.ts   # regenerate <name>.json wrappers
 *
 * Run:
 *   bun run debug:fixtures          # default — all fixtures in parallel
 *   FIXTURES=auth-anonymous,firestore-query bun run debug:fixtures
 *   CONCURRENCY=4 bun run debug:fixtures
 *
 * Env:
 *   BASE_URL          dev server URL (default http://localhost:4329)
 *   FIXTURES          comma-sep allowlist of fixture names (no extension)
 *   CONCURRENCY       max parallel contexts (default = number of fixtures)
 *   PREVIEW_WAIT_MS   per-fixture probe budget (default 20000)
 *   HEADLESS          '0' to watch in headed mode (default headless)
 *   OUT_DIR           where per-fixture reports go (default /tmp/fixtures)
 *   KEEP_OPEN         '1' to leave the browser open after the run
 */
export {}; // top-level await needs a module

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';

type Playwright = typeof import('playwright');
type Browser = import('playwright').Browser;
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;

let playwright: Playwright;
try {
  playwright = (await import('playwright')) as Playwright;
} catch {
  console.error(
    '[run-fixtures] playwright not installed. Run:\n' +
      '  cd packages/playground && bun add -d playwright && bunx playwright install chromium',
  );
  process.exit(1);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures');
const BASE_URL = process.env.BASE_URL || 'http://localhost:4329';
const HEADLESS = process.env.HEADLESS !== '0';
const PREVIEW_WAIT_MS = Number(process.env.PREVIEW_WAIT_MS || 20_000);
const OUT_DIR = process.env.OUT_DIR || '/tmp/fixtures';
const KEEP_OPEN = process.env.KEEP_OPEN === '1';
const ALLOW = process.env.FIXTURES?.split(',').map((s) => s.trim()).filter(Boolean);

mkdirSync(OUT_DIR, { recursive: true });

// ─── Fixture discovery ──────────────────────────────────────────────

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .filter((name) => !ALLOW || ALLOW.includes(name))
  .sort();

if (fixtures.length === 0) {
  console.error('[run-fixtures] no fixtures matched. Did you run scripts/fixtures/build.ts?');
  process.exit(1);
}

const concurrency = Math.min(
  Number(process.env.CONCURRENCY || fixtures.length),
  fixtures.length,
);

console.error(`[run-fixtures] discovered ${fixtures.length} fixtures, running ${concurrency} in parallel against ${BASE_URL}`);

// ─── Per-fixture runner ─────────────────────────────────────────────

interface FixtureSource {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

interface SeededArtifacts {
  rules: string;
  code: string;
  appSource: string;
}

function loadFixture(name: string): SeededArtifacts {
  const raw = readFileSync(join(FIXTURE_DIR, `${name}.json`), 'utf8');
  const parsed = JSON.parse(raw) as FixtureSource;
  const calls = parsed.toolCalls ?? [];
  const last = (n: string): string => {
    let s = '';
    for (const c of calls) {
      if (c.name === n && typeof c.args.source === 'string') s = c.args.source as string;
    }
    return s;
  };
  return { rules: last('writeRules'), code: last('writeCode'), appSource: last('writeApp') };
}

interface FixtureResult {
  name: string;
  status: 'pass' | 'fail' | 'timeout' | 'crash';
  durationMs: number;
  reason?: string;
  pageErrors: number;
  consoleErrors: number;
}

async function runOne(browser: Browser, name: string): Promise<FixtureResult> {
  const startedAt = Date.now();
  const seeded = loadFixture(name);
  const console_: Array<{ level: string; text: string }> = [];
  const pageErrors: string[] = [];
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    if (!seeded.appSource) {
      return { name, status: 'crash', durationMs: 0, reason: 'no writeApp in fixture', pageErrors: 0, consoleErrors: 0 };
    }

    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();

    page.on('console', (m) => console_.push({ level: m.type(), text: m.text() }));
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.getByLabel('New session prompt').waitFor({ state: 'visible', timeout: 15_000 });

    const sessionId = await page.evaluate(async (s: SeededArtifacts) => {
      const dbg = window.__pyric;
      if (!dbg) throw new Error('__pyric missing on window — dev build expected');
      const userId = dbg.sessions.getCurrentUserId();
      const id = (crypto as { randomUUID?: () => string }).randomUUID?.() ?? Math.random().toString(36).slice(2);
      await dbg.sessions.saveSession(userId, {
        id,
        title: 'fixture',
        preview: 'fixture',
        payload: {
          version: 1,
          workspace: { rules: s.rules, code: s.code, appSource: s.appSource },
          conversation: [],
        },
      });
      return id;
    }, seeded);

    await page.goto(
      `${BASE_URL}/playground?session=${encodeURIComponent(sessionId)}`,
      { waitUntil: 'domcontentloaded', timeout: 15_000 },
    );

    // Wait for the probe's DONE marker, polling the captured console
    // every 100ms. Resolves on first match; rejects with 'timeout'
    // after PREVIEW_WAIT_MS.
    const result = await waitForDone(console_, name, PREVIEW_WAIT_MS);

    return {
      name,
      status: result.ok ? 'pass' : 'fail',
      durationMs: Date.now() - startedAt,
      ...(result.reason ? { reason: result.reason } : {}),
      pageErrors: pageErrors.length,
      consoleErrors: console_.filter((c) => c.level === 'error').length,
    };
  } catch (e) {
    return {
      name,
      status: 'crash',
      durationMs: Date.now() - startedAt,
      reason: e instanceof Error ? e.message : String(e),
      pageErrors: pageErrors.length,
      consoleErrors: console_.filter((c) => c.level === 'error').length,
    };
  } finally {
    // Write per-fixture report regardless of outcome.
    const report = {
      name,
      console: console_,
      pageErrors,
      finishedAt: Date.now(),
    };
    try {
      writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(report, null, 2));
    } catch {
      /* swallow */
    }
    if (!KEEP_OPEN) {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
    }
  }
}

function waitForDone(
  console_: Array<{ level: string; text: string }>,
  name: string,
  budgetMs: number,
): Promise<{ ok: boolean; reason?: string }> {
  const prefix = `[${name}] DONE `;
  const deadline = Date.now() + budgetMs;
  return new Promise((resolve) => {
    const tick = () => {
      for (const c of console_) {
        if (!c.text.startsWith(prefix)) continue;
        const tail = c.text.slice(prefix.length).trim();
        if (tail === 'ok') return resolve({ ok: true });
        if (tail.startsWith('fail')) return resolve({ ok: false, reason: tail });
        return resolve({ ok: false, reason: `unexpected DONE payload: ${tail}` });
      }
      if (Date.now() > deadline) {
        return resolve({ ok: false, reason: `timeout — no DONE marker after ${budgetMs}ms` });
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ─── Fan-out + summarize ────────────────────────────────────────────

const { chromium } = playwright;
const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--disable-blink-features=AutomationControlled'],
});

const queue = [...fixtures];
const inFlight: Promise<FixtureResult>[] = [];
const results: FixtureResult[] = [];

async function pump(): Promise<void> {
  while (queue.length > 0 && inFlight.length < concurrency) {
    const name = queue.shift() as string;
    const p = runOne(browser, name).then((r) => {
      const slot = inFlight.indexOf(p);
      if (slot >= 0) inFlight.splice(slot, 1);
      results.push(r);
      const tag = r.status === 'pass' ? 'PASS' : 'FAIL';
      const detail = r.reason ? `  (${r.reason})` : '';
      console.error(`[run-fixtures] ${tag.padEnd(4)} ${r.name.padEnd(34)} ${r.durationMs}ms${detail}`);
      void pump();
      return r;
    });
    inFlight.push(p);
  }
}

void pump();
while (inFlight.length > 0) await inFlight[0];

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.length - pass;
const totalMs = Math.max(...results.map((r) => r.durationMs), 0);

console.error('');
console.error(`[run-fixtures] ${pass}/${results.length} passed (${fail} failed). Wall-clock: ${totalMs}ms (longest fixture).`);
console.error(`[run-fixtures] per-fixture reports in ${OUT_DIR}/<name>.json`);

if (!KEEP_OPEN) {
  await browser.close().catch(() => {});
}
if (fail > 0) process.exitCode = 1;
