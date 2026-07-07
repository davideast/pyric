#!/usr/bin/env bun
/**
 * Eval harness for the pyric playground's agent.
 *
 * Drives `createAgentSession` directly (no React, no session-host
 * callbacks) against the playground's actual tool registry +
 * Gemini provider, so the measurements reflect the real surface
 * the user-facing playground exposes.
 *
 * Fixtures live in `scripts/evals/fixtures/*.json`. Baselines land
 * in `scripts/evals/baselines/` so PRs can `git diff` deltas.
 *
 * Why a hand-rolled harness rather than the agent CLI: the
 * playground's tool handlers mutate Zustand stores and the
 * playground-specific lint/denials context lives in the workspace
 * store + diagnostics block. Reusing the playground's wiring here
 * keeps eval measurements authentic to what users will see.
 *
 * Usage:
 *   bun --env-file=../../.env scripts/run-evals.ts
 *     # → runs every fixture in scripts/evals/fixtures/
 *     #   prints JSON report to stdout
 *
 *   bun --env-file=../../.env scripts/run-evals.ts --fixture=rules-basic-reads
 *     # → runs only the named fixture
 *
 *   bun --env-file=../../.env scripts/run-evals.ts --baseline
 *     # → writes the report to scripts/evals/baselines/<branch>.json
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Pre-import polyfill ─────────────────────────────────────────────
// `geminiByok.getKey()` reads from `window.localStorage`. In Node we
// don't have a window — install a Map-backed Storage before any
// import that touches the byok module.
function installLocalStoragePolyfill(): void {
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') return;
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  (globalThis as { localStorage?: unknown }).localStorage = storage;
}
installLocalStoragePolyfill();

// ─── Now safe to import the playground's wiring ──────────────────────
const { createAgentSession, createDispatch, createMetricsCollector, createReactLoopStrategy, callbackProviderAsLlmClient } =
  await import('@inbrowser/agent');
const { geminiByok } = await import('~/lib/llm/byok');
const { PROVIDERS } = await import('~/lib/llm/registry');
const { useWorkspaceStore } = await import('~/lib/store/workspace');
const { useChatStore } = await import('~/lib/store/chat');
const { useLlmStore } = await import('~/lib/store/llm');
const { useSettingsStore } = await import('~/lib/store/settings');
// Node has no same-origin server: the resumable server transport builds
// relative URLs (invalid for node fetch) and its transport-error
// classifier doesn't recognize node's wording, so it can't degrade
// gracefully here. Evals measure the provider, not the transport —
// force page-direct.
useSettingsStore.getState().setResumableServerMode(false);
const { buildToolRegistry } = await import('~/lib/tools');
const { buildSystemPrompt } = await import('~/lib/agent/system-prompt');
const { makeDiagnosticsContext } = await import('~/lib/agent/diagnostics');

import type { SessionEvent, ToolContext } from '@inbrowser/agent';

// ─── Types ───────────────────────────────────────────────────────────

interface FixtureWorkspace {
  rules?: string;
  code?: string;
  appSource?: string;
}

type SuccessPredicate =
  | { kind: 'rule-grep'; matches?: string[]; doesNotMatch?: string[] }
  | { kind: 'code-grep'; matches?: string[]; doesNotMatch?: string[] }
  | { kind: 'app-grep'; matches?: string[]; doesNotMatch?: string[] }
  | { kind: 'tool-called'; tool: string; atLeast?: number; atMost?: number }
  | { kind: 'final-text-grep'; matches?: string[]; doesNotMatch?: string[] };

interface Fixture {
  name: string;
  description?: string;
  prompt: string;
  workspace?: FixtureWorkspace;
  model?: { providerId: 'gemini' | 'openrouter'; modelId: string };
  /** All predicates must pass for the fixture to succeed. */
  success: SuccessPredicate[];
  /** Soft cap. Harness still finishes, just records `overTurnBudget: true`. */
  maxTurns?: number;
  /** Soft cap on tool-call count for the same reason. */
  maxToolCalls?: number;
}

interface FixtureReport {
  name: string;
  ok: boolean;
  failures: string[];
  metrics: {
    turns: number;
    toolCalls: number;
    toolCallSequence: string[];
    tokensIn: number;
    tokensOut: number;
    durationMs: number;
    overTurnBudget: boolean;
    overToolCallBudget: boolean;
  };
  finalState: {
    rules: string;
    code: string;
    appSource: string;
    lastAssistantText: string;
  };
}

interface HarnessReport {
  ranAt: string;
  branch: string;
  model: { providerId: string; modelId: string };
  fixtures: FixtureReport[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    avgTurns: number;
    avgToolCalls: number;
    avgDurationMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
  };
}

// ─── Fixture loading ─────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, 'evals/fixtures');
const BASELINES_DIR = resolve(HERE, 'evals/baselines');

async function loadFixtures(filter: string | null): Promise<Fixture[]> {
  const entries = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json'));
  const out: Fixture[] = [];
  for (const f of entries) {
    const raw = await readFile(resolve(FIXTURES_DIR, f), 'utf8');
    const parsed = JSON.parse(raw) as Fixture;
    if (filter && parsed.name !== filter) continue;
    out.push(parsed);
  }
  return out;
}

// ─── Predicate evaluation ────────────────────────────────────────────

function evalPredicate(
  p: SuccessPredicate,
  ctx: { rules: string; code: string; appSource: string; lastAssistantText: string; toolCallSequence: string[] },
): string | null {
  if (p.kind === 'rule-grep') return matchOrFail('rules', ctx.rules, p.matches, p.doesNotMatch);
  if (p.kind === 'code-grep') return matchOrFail('code', ctx.code, p.matches, p.doesNotMatch);
  if (p.kind === 'app-grep') return matchOrFail('app', ctx.appSource, p.matches, p.doesNotMatch);
  if (p.kind === 'final-text-grep')
    return matchOrFail('final assistant text', ctx.lastAssistantText, p.matches, p.doesNotMatch);
  if (p.kind === 'tool-called') {
    const calls = ctx.toolCallSequence.filter((n) => n === p.tool).length;
    if (p.atLeast != null && calls < p.atLeast) return `expected ≥${p.atLeast} calls to '${p.tool}', got ${calls}`;
    if (p.atMost != null && calls > p.atMost) return `expected ≤${p.atMost} calls to '${p.tool}', got ${calls}`;
    return null;
  }
  return `unknown predicate kind`;
}

function matchOrFail(
  label: string,
  body: string,
  matches: string[] | undefined,
  doesNotMatch: string[] | undefined,
): string | null {
  for (const m of matches ?? []) {
    if (!body.includes(m)) return `${label} missing required substring ${JSON.stringify(m)}`;
  }
  for (const n of doesNotMatch ?? []) {
    if (body.includes(n)) return `${label} contains forbidden substring ${JSON.stringify(n)}`;
  }
  return null;
}

// ─── Fixture runner ──────────────────────────────────────────────────

async function runFixture(fixture: Fixture, signal: AbortSignal): Promise<FixtureReport> {
  // Reset every store so fixtures don't leak into each other.
  useChatStore.getState().clear();
  const ws = useWorkspaceStore.getState();
  ws.setRules(fixture.workspace?.rules ?? '');
  // `code` was removed from the workspace store (rules + appSource only);
  // fixtures' `code` field is vestigial and ignored.
  ws.setAppSource(fixture.workspace?.appSource ?? '');

  // Provider + model from fixture or store defaults. Fixtures pin to
  // Gemini Flash Lite by default for a cheap baseline.
  const providerId = fixture.model?.providerId ?? 'gemini';
  const modelId = fixture.model?.modelId ?? 'gemini-3.5-flash';
  useLlmStore.getState().setProvider(providerId, modelId);

  const registry = buildToolRegistry();
  const rawDispatch = createDispatch(registry);
  // Per-tool-call payload accounting (epic #787 P1 token baseline):
  // chars in/out per call. chars/4 ~ tokens; the report aggregates per
  // tool name so copy-mode costs (stdlib_get responses, rules
  // re-reads, resolve_modules output) are attributable.
  const toolAccounting: { name: string; argChars: number; resultChars: number }[] = [];
  const dispatch: typeof rawDispatch = {
    execute: async (call, tctx) => {
      const r = await rawDispatch.execute(call, tctx);
      let argChars = 0;
      let resultChars = 0;
      try { argChars = JSON.stringify(call.args ?? {}).length; } catch { /* opaque */ }
      try { resultChars = JSON.stringify(r).length; } catch { /* opaque */ }
      toolAccounting.push({ name: call.name, argChars, resultChars });
      return r;
    },
  };
  const metrics = createMetricsCollector();

  const def = PROVIDERS[providerId];
  const llm = callbackProviderAsLlmClient(def.provider, def.id);

  const toolCallSequence: string[] = [];
  let turns = 0;
  let lastAssistantText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  const t0 = performance.now();

  const session = createAgentSession({
    strategy: createReactLoopStrategy({ maxTurns: fixture.maxTurns ?? 16 }),
    llm,
    tools: dispatch,
    toolList: registry.list(),
    toolContext: (): ToolContext => ({
      workspace: {
        presetId: '',
        rules: '',
        code: '',
        appSource: '',
        stitch: { projectId: null, latestScreenUrl: null, brief: null },
      },
      runtime: { terminal: [], runSummary: null, deploy: null, parseError: null, uiErrors: [], sandboxVersion: 0 },
      sandbox: noopSandbox(),
      ...makeDiagnosticsContext(true),
      signal,
    }),
    systemPromptBuilder: () => buildSystemPrompt({ diagnosticsEnabled: true }),
    metrics,
    history: [],
    id: `eval-${fixture.name}-${Date.now().toString(36)}`,
  });

  let textBuf = '';
  const errors: string[] = [];
  for await (const ev of session.submit(fixture.prompt, signal) as AsyncIterable<SessionEvent>) {
    if (signal.aborted) break;
    switch (ev.kind) {
      case 'turn_started':
        turns += 1;
        // Each turn restarts the assistant text buffer; lastAssistantText
        // ends up being the final turn's accumulated text.
        textBuf = '';
        break;
      case 'text':
        textBuf += ev.chunk;
        break;
      case 'tool_started':
        toolCallSequence.push(ev.name);
        break;
      case 'turn_completed':
        lastAssistantText = textBuf;
        break;
      case 'error':
        errors.push(ev.message);
        break;
    }
  }

  const durationMs = performance.now() - t0;
  const m = metrics.totals();
  tokensIn = m.tokensIn ?? 0;
  tokensOut = m.tokensOut ?? 0;

  const wsFinal = useWorkspaceStore.getState();
  const finalState = {
    rules: wsFinal.rules,
    code: '', // legacy report field — the store no longer carries `code`
    appSource: wsFinal.appSource,
    lastAssistantText,
  };

  const failures: string[] = [];
  for (const e of errors) failures.push(`agent error: ${e}`);
  for (const p of fixture.success) {
    const failure = evalPredicate(p, { ...finalState, toolCallSequence });
    if (failure) failures.push(failure);
  }

  return {
    name: fixture.name,
    ok: failures.length === 0,
    failures,
    metrics: {
      turns,
      toolCalls: toolCallSequence.length,
      toolAccounting: Object.entries(
        toolAccounting.reduce<Record<string, { calls: number; argChars: number; resultChars: number }>>(
          (acc, t) => {
            const e = (acc[t.name] ??= { calls: 0, argChars: 0, resultChars: 0 });
            e.calls += 1;
            e.argChars += t.argChars;
            e.resultChars += t.resultChars;
            return acc;
          },
          {},
        ),
      ).map(([name, v]) => ({ name, ...v })),
      toolCallSequence,
      tokensIn,
      tokensOut,
      durationMs,
      overTurnBudget: fixture.maxTurns != null && turns > fixture.maxTurns,
      overToolCallBudget: fixture.maxToolCalls != null && toolCallSequence.length > fixture.maxToolCalls,
    },
    finalState,
  };
}

// runOnce uses the real sandbox runner which depends on browser-ish
// glue. For evals we don't actually need to execute sandbox code —
// just measure whether the agent CALLS the tool. Substitute a noop
// SandboxHandle so the registry can register runOnce without crashing
// on first invocation.
function noopSandbox() {
  return {
    async run() {
      return {
        ok: true,
        logs: [],
        durationMs: 0,
        denials: [],
        docsTouched: 0,
        errors: [],
      };
    },
    async deployRules() {
      return { ok: true, messages: [] };
    },
    async readState() {
      return { docs: [], denials: [] };
    },
    reseed() {},
    dispose() {},
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Set the Gemini key from the env var into the byok slot the
  // playground's provider reads from.
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    console.error('GEMINI_API_KEY not set in environment. Pass --env-file=../../.env or export it.');
    process.exit(1);
  }
  geminiByok.setKey(geminiKey);

  const argv = process.argv.slice(2);
  const fixtureFilter = argv.find((a) => a.startsWith('--fixture='))?.slice('--fixture='.length) ?? null;
  const baselineMode = argv.includes('--baseline');

  const fixtures = await loadFixtures(fixtureFilter);
  if (fixtures.length === 0) {
    console.error(`No fixtures found${fixtureFilter ? ` matching '${fixtureFilter}'` : ''}.`);
    process.exit(1);
  }

  console.error(`Running ${fixtures.length} fixture${fixtures.length === 1 ? '' : 's'}…`);
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());

  const reports: FixtureReport[] = [];
  for (const [i, fixture] of fixtures.entries()) {
    console.error(`  → ${fixture.name}`);
    // Gemini free tier rate-limits aggressively — a 2s pause between
    // fixtures keeps the suite from tripping a 429 mid-run.
    if (i > 0) await new Promise((r) => setTimeout(r, 2000));
    try {
      reports.push(await runFixture(fixture, ac.signal));
    } catch (e) {
      reports.push({
        name: fixture.name,
        ok: false,
        failures: [`harness error: ${e instanceof Error ? e.message : String(e)}`],
        metrics: {
          turns: 0,
          toolCalls: 0,
          toolCallSequence: [],
          tokensIn: 0,
          tokensOut: 0,
          durationMs: 0,
          overTurnBudget: false,
          overToolCallBudget: false,
        },
        finalState: { rules: '', code: '', appSource: '', lastAssistantText: '' },
      });
    }
  }

  const passed = reports.filter((r) => r.ok).length;
  const report: HarnessReport = {
    ranAt: new Date().toISOString(),
    branch: (process.env.GIT_BRANCH ?? 'feat/playground'),
    model: { providerId: 'gemini', modelId: 'gemini-3.5-flash' },
    fixtures: reports,
    summary: {
      total: reports.length,
      passed,
      failed: reports.length - passed,
      avgTurns: avg(reports.map((r) => r.metrics.turns)),
      avgToolCalls: avg(reports.map((r) => r.metrics.toolCalls)),
      avgDurationMs: avg(reports.map((r) => r.metrics.durationMs)),
      totalTokensIn: sum(reports.map((r) => r.metrics.tokensIn)),
      totalTokensOut: sum(reports.map((r) => r.metrics.tokensOut)),
    },
  };

  const json = JSON.stringify(report, null, 2);
  if (baselineMode) {
    await mkdir(BASELINES_DIR, { recursive: true });
    const outPath = resolve(BASELINES_DIR, `${report.branch.replace(/\//g, '_')}.json`);
    await writeFile(outPath, json + '\n', 'utf8');
    console.error(`Baseline written to ${outPath}`);
  } else {
    console.log(json);
  }

  console.error('');
  console.error(`  ${passed}/${reports.length} passed · avg ${report.summary.avgTurns.toFixed(1)} turns · avg ${report.summary.avgToolCalls.toFixed(1)} tool calls · avg ${(report.summary.avgDurationMs / 1000).toFixed(1)}s`);
  process.exit(passed === reports.length ? 0 : 1);
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

await main();
