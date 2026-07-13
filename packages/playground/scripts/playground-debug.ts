#!/usr/bin/env bun
/**
 * Drive the playground in a Playwright-controlled Chromium and dump
 * structured debug output. Useful for outer-loop debugging: one
 * invocation runs a single end-to-end turn (home → submit → agent
 * finishes) and writes everything an outer agent (or you) needs to
 * decide the next move.
 *
 * What it captures:
 *   - Every console message the page emits (level, text, location)
 *   - Page errors (uncaught exceptions, unhandled rejections)
 *   - Failed network requests (response code, URL, failure reason)
 *   - Final chat transcript (rendered DOM)
 *   - Final workspace artifacts (rules / code / appSource extracted
 *     from localStorage where the workspace store mirrors them, plus
 *     the latest assistant message)
 *
 * Setup (once per machine):
 *   cd packages/playground
 *   bun add -d playwright
 *   bunx playwright install chromium
 *
 * Required env (at least one provider key):
 *   GEMINI_API_KEY        BYOK key for Gemini
 *   OPENROUTER_API_KEY    BYOK key for OpenRouter
 *
 * Optional env:
 *   PROMPT          The prompt to submit
 *                   (default: a canonical playground example)
 *   PROVIDER        gemini | openrouter (default: gemini)
 *   MODEL           Model id matching the provider's registry
 *                   (default: gemini-3.5-flash for gemini,
 *                    google/gemini-2.5-flash-lite for openrouter)
 *   BASE_URL        Dev server URL (default: http://localhost:4329)
 *   HEADLESS        '1' to run headless (default: headed so you can
 *                   watch). Headed mode is the whole point of the
 *                   tool — flip to headless only for CI.
 *   TIMEOUT_MS      Total budget for the agent's first turn
 *                   (default: 120000 = 2 minutes)
 *   IDLE_MS         How long the compose box must look idle (send
 *                   button visible AND enabled) before we consider
 *                   the turn complete (default: 1500)
 *   OUT             Write the JSON report to this file. Default:
 *                   stdout.
 *   KEEP_OPEN       '1' leaves the browser open after the run so
 *                   you can poke at it. Otherwise we close cleanly.
 *   FROM_SESSION    Path to a saved-session JSON file (e.g., the
 *                   one the agent activity panel emits, or
 *                   auth-session.json at repo root). When set, the
 *                   driver SKIPS the agent loop: it extracts the
 *                   final writeRules + writeApp source from the
 *                   file, creates a fresh session pre-seeded with
 *                   those artifacts, and navigates straight to
 *                   /playground to render the preview against them.
 *                   Use this to deterministically reproduce a
 *                   preview-side crash without re-running the
 *                   model.
 *   PREVIEW_WAIT_MS How long to let the seeded preview settle
 *                   before scraping (default: 6000). Covers the
 *                   esbuild compile + initial render + any
 *                   `useEffect` that fires on mount (e.g., the
 *                   crashy `getFirestore()` calls we're hunting).
 *
 * Usage:
 *   GEMINI_API_KEY=… bun scripts/playground-debug.ts
 *   PROMPT="build a todo app" bun scripts/playground-debug.ts
 *   HEADLESS=1 OUT=run.json bun scripts/playground-debug.ts
 */

export {}; // top-level await needs the file to be a module

type Playwright = typeof import('playwright');
type Browser = import('playwright').Browser;
type BrowserContext = import('playwright').BrowserContext;
type Page = import('playwright').Page;
type ConsoleMessage = import('playwright').ConsoleMessage;
type PlaywrightRequest = import('playwright').Request;

let playwright: Playwright;
try {
  playwright = (await import('playwright')) as Playwright;
} catch {
  console.error(
    '[playground-debug] playwright is not installed. Run:\n' +
      '  cd packages/playground && bun add -d playwright && bunx playwright install chromium',
  );
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────

const DEFAULT_PROMPT =
  'Create an app where a user can order from a menu but modify the price. ' +
  'The items are stored in the database and can only be modified by the admin. ' +
  "If the price doesn't match the order is rejected.";

const PROMPT = process.env.PROMPT?.trim() || DEFAULT_PROMPT;
const PROVIDER = (process.env.PROVIDER || 'gemini') as 'gemini' | 'openrouter';
const MODEL =
  process.env.MODEL ||
  (PROVIDER === 'gemini'
    ? 'gemini-3.5-flash'
    : 'google/gemini-2.5-flash-lite');
const BASE_URL = process.env.BASE_URL || 'http://localhost:4329';
const HEADLESS = process.env.HEADLESS === '1';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120_000);
const IDLE_MS = Number(process.env.IDLE_MS || 1500);
const OUT = process.env.OUT;
const KEEP_OPEN = process.env.KEEP_OPEN === '1';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const FROM_SESSION = process.env.FROM_SESSION;
const PREVIEW_WAIT_MS = Number(process.env.PREVIEW_WAIT_MS || 6000);

// API key is only required for live-agent mode. The from-session
// replay path doesn't fire the model.
const apiKey = PROVIDER === 'gemini' ? GEMINI_KEY : OPENROUTER_KEY;
if (!apiKey && !FROM_SESSION) {
  console.error(
    `[playground-debug] Missing API key for provider '${PROVIDER}'. Set ` +
      (PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'OPENROUTER_API_KEY') +
      ' in the env, or set FROM_SESSION=<path> to replay a saved session without the model.',
  );
  process.exit(1);
}

// ─── Report shape ────────────────────────────────────────────────────

interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
  location?: string;
}
interface PageErrorEntry {
  ts: number;
  message: string;
  stack?: string;
}
interface NetworkFailureEntry {
  ts: number;
  url: string;
  method: string;
  status?: number;
  failure?: string;
}
interface ChatTranscriptItem {
  role: 'user' | 'assistant';
  text: string;
  tools?: string[];
  metrics?: string;
}
interface DebugReport {
  config: {
    prompt: string;
    provider: string;
    model: string;
    baseUrl: string;
    headless: boolean;
  };
  timing: {
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    timedOut: boolean;
  };
  console: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  networkFailures: NetworkFailureEntry[];
  chat: ChatTranscriptItem[];
  workspace: {
    sessionId: string | null;
    finalUrl: string;
    /** Whatever we could scrape from window state. */
    storeSnapshot?: unknown;
  };
}

// ─── Driver ──────────────────────────────────────────────────────────

const startedAt = Date.now();
const consoleEntries: ConsoleEntry[] = [];
const pageErrors: PageErrorEntry[] = [];
const networkFailures: NetworkFailureEntry[] = [];

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let timedOut = false;

interface SeededArtifacts {
  rules: string;
  code: string;
  appSource: string;
  firstUserPrompt: string;
}

/**
 * Read a saved-session JSON file and pluck the final writeRules /
 * writeApp / writeCode tool-call sources, plus the user prompt
 * (best-effort — different session shapes carry it differently).
 *
 * Tolerates two shapes:
 *
 *   1. A single assistant turn at root, with a `toolCalls` array
 *      (the shape `auth-session.json` at the worktree root uses —
 *      a copy-pasted activity-panel chat-message export).
 *   2. A full `useChatStore` messages array, with `toolCalls` on
 *      each assistant entry (the shape sessions in the sandbox use).
 *
 * Returns the LAST source emitted for each tool — the agent often
 * rewrites the app/rules several times in a turn, and the final
 * version is what the preview would render.
 */
function loadSessionSources(path: string): SeededArtifacts {
  const raw = require('node:fs').readFileSync(path, 'utf8') as string;
  const parsed = JSON.parse(raw) as unknown;

  // Normalize to a flat list of tool calls regardless of input shape.
  const allToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let firstUserPrompt = '';

  const collectFromMessage = (m: Record<string, unknown>) => {
    const toolCalls = (m.toolCalls as Array<{
      name: string;
      args: Record<string, unknown>;
    }> | undefined) ?? [];
    for (const tc of toolCalls) allToolCalls.push(tc);
  };

  if (parsed && typeof parsed === 'object') {
    if (Array.isArray((parsed as { messages?: unknown }).messages)) {
      // Shape 2: { messages: ChatMessage[] }
      const messages = (parsed as { messages: Array<Record<string, unknown>> }).messages;
      for (const m of messages) {
        if (m.role === 'user' && typeof m.text === 'string' && !firstUserPrompt) {
          firstUserPrompt = m.text;
        }
        collectFromMessage(m);
      }
    } else if (Array.isArray((parsed as { toolCalls?: unknown }).toolCalls)) {
      // Shape 1: single assistant message with `toolCalls`.
      collectFromMessage(parsed as Record<string, unknown>);
    }
  }

  const lastFor = (name: string): string => {
    let last = '';
    for (const tc of allToolCalls) {
      if (tc.name === name && typeof tc.args.source === 'string') {
        last = tc.args.source as string;
      }
    }
    return last;
  };

  return {
    rules: lastFor('writeRules'),
    code: lastFor('writeCode'),
    appSource: lastFor('writeApp'),
    firstUserPrompt: firstUserPrompt || 'Replay seeded session.',
  };
}

async function main(): Promise<DebugReport> {
  const { chromium } = playwright;
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();

  // ─── Wire up listeners BEFORE any navigation ───────────────────────
  page.on('console', (msg: ConsoleMessage) => {
    const loc = msg.location();
    consoleEntries.push({
      ts: Date.now(),
      level: msg.type(),
      text: msg.text(),
      ...(loc.url ? { location: `${loc.url}:${loc.lineNumber}` } : {}),
    });
  });
  page.on('pageerror', (err) => {
    pageErrors.push({
      ts: Date.now(),
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
    });
  });
  page.on('requestfailed', (req: PlaywrightRequest) => {
    const f = req.failure();
    networkFailures.push({
      ts: Date.now(),
      url: req.url(),
      method: req.method(),
      ...(f ? { failure: f.errorText } : {}),
    });
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status < 400) return;
    networkFailures.push({
      ts: Date.now(),
      url: res.url(),
      method: res.request().method(),
      status,
    });
  });

  // ─── Seed localStorage so BYOK + provider are pre-configured ───────
  // We must do this BEFORE the first navigation otherwise the page's
  // initial render reads empty state. Playwright's `addInitScript`
  // runs in every new document context. Skip the key write when
  // running in replay mode — no key needed, and we don't want to
  // demand one to reproduce a preview crash.
  if (apiKey) {
    await context.addInitScript(
      ({ provider, model, key }: { provider: string; model: string; key: string }) => {
        const KEY_PREFIX = 'pyric.playground.byok.';
        const SELECTION_KEY = 'pyric.playground.llm.selection';
        window.localStorage.setItem(`${KEY_PREFIX}${provider}`, key);
        window.localStorage.setItem(
          SELECTION_KEY,
          JSON.stringify({ providerId: provider, modelId: model }),
        );
      },
      { provider: PROVIDER, model: MODEL, key: apiKey },
    );
  }

  // ─── Bail early if dev server isn't up ─────────────────────────────
  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } catch (e) {
    throw new Error(
      `Could not reach ${BASE_URL}. Is the dev server running? ` +
        `(cd packages/playground && bun --env-file=../../.env --env-file=.env astro dev --port 4329)\n` +
        `Underlying: ${(e as Error).message}`,
    );
  }

  if (FROM_SESSION) {
    // ─── Replay mode: seed a session from a saved-session file and
    //     render the preview without firing the agent. The artifacts
    //     are mounted directly into the workspace store and saved
    //     into the sessions sandbox so the existing session-routing
    //     code path hydrates them on `/playground` mount.
    const seeded = loadSessionSources(FROM_SESSION);
    if (!seeded.appSource) {
      throw new Error(
        `FROM_SESSION file ${FROM_SESSION} had no writeApp tool call — nothing to replay.`,
      );
    }

    // Wait for the home-page React island to mount before reaching
    // for the debug surface — it self-installs on `HomePage.tsx`
    // first import, which is async relative to `domcontentloaded`.
    await page.getByLabel('New session prompt').waitFor({
      state: 'visible',
      timeout: 15_000,
    });

    const sessionId = await page.evaluate(async (s: SeededArtifacts) => {
      const dbg = window.__pyric;
      if (!dbg) {
        throw new Error(
          '__pyric debug surface missing — make sure the dev server has lib/debug/expose imported and import.meta.env.DEV is true.',
        );
      }
      const userId = dbg.sessions.getCurrentUserId();
      const id = (crypto as { randomUUID?: () => string }).randomUUID?.() ??
        Math.random().toString(36).slice(2);
      await dbg.sessions.saveSession(userId, {
        id,
        title: 'replay: ' + s.firstUserPrompt.slice(0, 40),
        preview: s.firstUserPrompt.slice(0, 120),
        payload: {
          version: 1,
          workspace: {
            rules: s.rules,
            code: s.code,
            appSource: s.appSource,
          },
          conversation: [],
        },
      });
      return id;
    }, seeded);

    await page.goto(`${BASE_URL}/playground?session=${encodeURIComponent(sessionId)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });

    // Let the preview compile + mount the user component. The crash
    // we're hunting fires inside a `useEffect` on first render, so
    // a fixed wait is the simplest way to surface it.
    await page.waitForTimeout(PREVIEW_WAIT_MS);
  } else {
    // ─── Live mode: drive the home page and let the agent run ──────
    const textarea = page.getByLabel('New session prompt');
    await textarea.waitFor({ state: 'visible', timeout: 10_000 });
    await textarea.fill(PROMPT);

    await page.getByRole('button', { name: /start session/i }).click();

    // ─── Wait for the workspace to mount and the agent to fire ────
    await page.waitForURL(/\/playground\?session=/, { timeout: 15_000 });

    // ─── Wait for the agent's first turn to finish ────────────────
    // Signal: the compose-bar's Stop button (which only renders while
    // `sending === true`) is absent for a sustained `IDLE_MS` window.
    // The Send button can't be a positive idle signal because it's
    // rendered disabled when the compose box is empty (the post-turn
    // state); only Stop reliably distinguishes streaming from done.
    //
    // Also requires Stop to have appeared at least once first —
    // otherwise we'd return immediately on pages that never started a
    // turn (e.g., the auto-fire didn't trigger).
    const remaining = TIMEOUT_MS - (Date.now() - startedAt);
    try {
      await waitForAgentIdle(page, remaining > 0 ? remaining : 10_000, IDLE_MS);
    } catch {
      timedOut = true;
    }
  }

  // ─── Scrape final state ────────────────────────────────────────────
  const finalUrl = page.url();
  const sessionId =
    new URL(finalUrl).searchParams.get('session');
  const chat = await scrapeChat(page);
  const storeSnapshot = await scrapeWorkspace(page);

  return {
    config: {
      prompt: PROMPT,
      provider: PROVIDER,
      model: MODEL,
      baseUrl: BASE_URL,
      headless: HEADLESS,
    },
    timing: {
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      timedOut,
    },
    console: consoleEntries,
    pageErrors,
    networkFailures,
    chat,
    workspace: {
      sessionId,
      finalUrl,
      ...(storeSnapshot ? { storeSnapshot } : {}),
    },
  };
}

async function waitForAgentIdle(
  page: Page,
  budgetMs: number,
  idleMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const stopBtn = page.getByRole('button', { name: /^stop$/i });
  let sawStop = false;
  let idleSince: number | null = null;

  while (Date.now() < deadline) {
    const stopVisible = await stopBtn.isVisible().catch(() => false);
    if (stopVisible) {
      sawStop = true;
      idleSince = null;
    } else if (sawStop) {
      // Stop disappeared after having been seen — agent is winding down.
      if (idleSince === null) idleSince = Date.now();
      if (Date.now() - idleSince >= idleMs) return;
    }
    // Before Stop has ever appeared, just keep polling — the auto-fire
    // effect needs a moment to land. Don't count this as idle.
    await page.waitForTimeout(250);
  }

  if (!sawStop) {
    throw new Error('timeout: Stop button never appeared (agent never started)');
  }
  throw new Error('timeout: agent kept streaming past budget');
}

async function scrapeChat(page: Page): Promise<ChatTranscriptItem[]> {
  // The Activity panel renders messages with role-tagged badges.
  // Pulling structured data through React internals is fragile;
  // we read the rendered text instead. Output is intentionally
  // coarse — enough to see the conversation shape, not a faithful
  // re-render.
  return await page.evaluate(() => {
    const out: { role: 'user' | 'assistant'; text: string; tools?: string[]; metrics?: string }[] = [];
    const activity =
      (document.querySelector('[role="tabpanel"]') as HTMLElement | null)
      ?? (document.querySelector('main') as HTMLElement | null)
      ?? (document.body as HTMLElement);
    if (!activity) return out;
    const text = activity.innerText || '';
    // Very loose parse — split on YOU / ASSISTANT markers the UI
    // already prints. The actual transcript scraping is best-effort;
    // a downstream tool can also read the workspace's chat store
    // directly from window if we ever expose it.
    const lines = text.split('\n');
    let role: 'user' | 'assistant' | null = null;
    let buf: string[] = [];
    const flush = () => {
      if (role && buf.length > 0) {
        out.push({ role, text: buf.join('\n').trim() });
      }
      buf = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^you$/i.test(trimmed)) {
        flush();
        role = 'user';
        continue;
      }
      if (/^assistant/i.test(trimmed)) {
        flush();
        role = 'assistant';
        continue;
      }
      if (role) buf.push(line);
    }
    flush();
    return out;
  });
}

async function scrapeWorkspace(page: Page): Promise<unknown> {
  // The workspace store doesn't currently mirror its full state to
  // localStorage. Read the durable model selection; the chat scraper
  // above covers the conversation side.
  return await page.evaluate(() => {
    const keys = ['pyric.playground.llm.selection'];
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      try {
        const v = window.localStorage.getItem(k);
        if (v) out[k] = JSON.parse(v);
      } catch {
        /* skip */
      }
    }
    return out;
  });
}

// ─── Entrypoint ──────────────────────────────────────────────────────

try {
  const report = await main();
  const json = JSON.stringify(report, null, 2);
  if (OUT) {
    await Bun.write(OUT, json);
    console.error(`[playground-debug] wrote ${OUT}`);
  } else {
    process.stdout.write(json + '\n');
  }
  // Quick summary to stderr so a human watching the run sees signal
  // without parsing the JSON.
  const errs = report.console.filter((c) => c.level === 'error').length;
  const warns = report.console.filter((c) => c.level === 'warning').length;
  console.error(
    `[playground-debug] done in ${Math.round(report.timing.durationMs)}ms. ` +
      `console: ${errs} error / ${warns} warning. ` +
      `pageErrors: ${report.pageErrors.length}. ` +
      `networkFailures: ${report.networkFailures.length}. ` +
      `chat: ${report.chat.length} entries. ` +
      `timedOut: ${report.timing.timedOut}.`,
  );
} catch (e) {
  console.error('[playground-debug] failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  if (KEEP_OPEN) {
    console.error('[playground-debug] KEEP_OPEN set — browser left open. Ctrl-C to exit.');
    await new Promise(() => {});
  } else {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
