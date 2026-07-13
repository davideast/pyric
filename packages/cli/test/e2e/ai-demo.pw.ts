/**
 * AI graduation demo smoke test (examples/ai-chat): the SAME upstream-API
 * chat app under `pyric dev`, on both answer engines.
 *
 *   1. Scripted mode: a streamed chat reply and the get_weather function-call
 *      round trip render, with ZERO network requests to Google AI endpoints.
 *      Belt and braces: every page request is recorded and asserted clean,
 *      AND the browser launches with --host-resolver-rules blackholing
 *      firebasevertexai.googleapis.com / generativelanguage.googleapis.com to
 *      127.0.0.1 (covers SharedWorker fetches Playwright can't observe), so
 *      any real dependence on Google would fail the render assertions too.
 *   2. Local-model mode: the same app answered by a real model through
 *      serve's same-origin /__pyric/ai-proxy (Ollama upstream). Skipped with
 *      a clear message when Ollama isn't reachable on localhost:11434 or the
 *      model isn't pulled (CI-safe).
 *
 * Self-booting: spawns its own `pyric dev --port 0` on examples/ai-chat, so
 * it runs the same under this directory's shared playwright.config.ts or
 * standalone. `*.pw.ts` keeps it out of `bun test` (see README.md here).
 * Requires the built dist: `bun run build:cli`.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(HERE, '..', '..', 'dist', 'cli', 'index.js');
const DEMO_DIR = join(HERE, '..', '..', '..', '..', 'examples', 'ai-chat');

const GOOGLE_AI_HOSTS = ['firebasevertexai.googleapis.com', 'generativelanguage.googleapis.com'];
const OLLAMA = 'http://localhost:11434';
const LOCAL_MODEL = 'qwen3:4b';

// ── serve + browser orchestration (soak-harness pattern, real example dir) ──

let child: ChildProcess | null = null;
let serveUrl = '';
let browser: Browser;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  // Explicit launch (not the config's browser fixture) so the blackhole args
  // apply: DNS-level MAP of the Google AI endpoints to 127.0.0.1,
  // browser-wide. Even a request from inside the SharedWorker (invisible to
  // page.on('request')) would hit 127.0.0.1 and fail loudly instead of
  // reaching production.
  browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=${GOOGLE_AI_HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(',')}`],
  });
  const proc = spawn(
    process.execPath,
    // --no-cache: test the worker/entry bundles as built, never a warm cache.
    [CLI_PATH, 'dev', '--no-open', '--port', '0', '--json', '--no-cache'],
    { cwd: DEMO_DIR, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child = proc;
  let out = '';
  let err = '';
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');
  proc.stdout!.on('data', (c: string) => (out += c));
  proc.stderr!.on('data', (c: string) => (err += c));

  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`pyric dev exited early (code ${proc.exitCode}). stderr:\n${err.slice(-2000)}`);
    }
    const line = out.split('\n').find((l) => l.trim().startsWith('{'));
    if (line) {
      serveUrl = (JSON.parse(line) as { url: string }).url;
      break;
    }
    if (Date.now() >= deadline) throw new Error(`pyric dev --json line never arrived. stderr:\n${err.slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  await browser?.close();
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child!.once('exit', resolve));
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child!.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(killTimer);
  }
});

// ── shared page helpers ─────────────────────────────────────────────────────

async function openDemo(search: string): Promise<{ page: Page; requests: string[] }> {
  // A fresh browser context per mode: contexts don't share SharedWorkers, so
  // each mode gets its own worker broker (engine config is first-call-wins
  // per worker lifetime).
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  await page.goto(`${serveUrl}/${search}`);
  return { page, requests };
}

function lastModelMsg(page: Page) {
  return page.locator('.msg[data-role="model"][data-done="true"]').last();
}

// ── 1. scripted mode: renders, streams, round-trips, zero Google ───────────

test('scripted mode: chat + function calling render with zero Google AI requests', async () => {
  test.setTimeout(60_000);
  const { page, requests } = await openDemo('?engine=scripted');

  await expect(page.locator('#engine-label')).toHaveText(/scripted/);

  // Streamed chat turn: the scripted `hello` entry streams in chunks.
  await page.locator('#input').fill('hello pyric');
  await page.locator('#send').click();
  await expect(lastModelMsg(page)).toHaveText(/Hello from the scripted engine\./, { timeout: 30_000 });

  // Function-calling round trip: forced call, local tool stub, threaded
  // functionResponse, final scripted answer.
  await page.locator('#weather').click();
  await expect(page.locator('.msg[data-role="tool"]')).toHaveText(/get_weather\(.*Lisbon.*\)/, {
    timeout: 30_000,
  });
  await expect(lastModelMsg(page)).toHaveText(/Right now in Lisbon: sunny and 24/, { timeout: 30_000 });

  await page.screenshot({ path: test.info().outputPath('scripted-mode.png'), fullPage: true });

  // ZERO requests to the Google AI endpoints (page-observable requests; the
  // launch-arg blackhole covers worker-side fetches).
  const googleHits = requests.filter((url) => GOOGLE_AI_HOSTS.some((h) => url.includes(h)));
  expect(googleHits).toEqual([]);
  await page.context().close();
});

// ── 2. local-model mode: a real model through /__pyric/ai-proxy ────────────

async function ollamaModelAvailable(): Promise<'ok' | 'down' | 'no-model'> {
  try {
    const res = await fetch(`${OLLAMA}/v1/models`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return 'down';
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return body.data?.some((m) => m.id === LOCAL_MODEL) ? 'ok' : 'no-model';
  } catch {
    return 'down';
  }
}

test('local-model mode: a nonempty reply streams through /__pyric/ai-proxy from Ollama', async () => {
  test.setTimeout(180_000);
  const availability = await ollamaModelAvailable();
  test.skip(availability === 'down', `Ollama not reachable on ${OLLAMA}; skipping the local-model half`);
  test.skip(
    availability === 'no-model',
    `Ollama is up but model ${LOCAL_MODEL} is not pulled (ollama pull ${LOCAL_MODEL}); skipping the local-model half`,
  );

  const { page } = await openDemo(`?engine=local&model=${LOCAL_MODEL}`);
  await expect(page.locator('#engine-label')).toHaveText(/ai-proxy/);

  await page.locator('#input').fill('Reply with one short friendly sentence.');
  await page.locator('#send').click();

  const reply = lastModelMsg(page);
  // Local generation can be slow on first load (model cold start).
  await expect(reply).toBeVisible({ timeout: 150_000 });
  const text = (await reply.textContent()) ?? '';
  expect(text.trim().length).toBeGreaterThan(0);
  await expect(reply).not.toHaveClass(/error/);

  await page.screenshot({ path: test.info().outputPath('local-mode.png'), fullPage: true });
  await page.context().close();
});
