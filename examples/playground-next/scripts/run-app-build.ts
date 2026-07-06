#!/usr/bin/env bun
/**
 * Headless app-building harness (fixture-ladder tiers T1–T4,
 * workstation-benchmarks.md §3a). T4 retrofit fixtures declare an
 * `initialWorkspace` (a seeded existing app) and are additionally scored
 * on the `retrofit` dimension: the pre-existing workspace tests re-run
 * against the final rules after the agent finishes.
 *
 * Drives the SAME agent the playground uses — real system prompt
 * (`buildSystemPrompt`), full tool registry (`buildToolRegistry`), real
 * `ToolContext` — from Node, against short app-building prompts that state
 * a data domain, an auth method, and a security need. Tier 1's in-memory
 * VFS makes the file tools author real files; Tier 2's in-node
 * `@pyric/sandbox` (via `getRunner()`) makes seed/discover/readState real.
 *
 * Grading is the held-out conformance oracle: each fixture carries hidden
 * ALLOW/DENY cases the agent never sees, evaluated against the produced
 * rules by the pure simulator.
 *
 * Modes:
 *   (default) STUB authoring model — a built-in owner-read scenario that
 *             emits write_file tool calls. No network/spend; proves the
 *             full loop + read-out + grading wiring.
 *   --local   real model on an OpenAI-compatible server — runs the whole
 *             app-build fixture matrix:
 *               bun scripts/run-app-build.ts --local \
 *                 --endpoint=http://HOST:8080/v1 --model=gpt-oss-120b
 *             optional: --fixture=tasks-per-user  --max-turns=12
 *             OpenRouter routing: --provider-sort=throughput|price|latency|default
 *               --max-prompt-price=N --max-completion-price=N ($/M tokens)
 */

// ── localStorage polyfill BEFORE the playground store/provider chain ────
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
  };
}

import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentStrategy, LlmClient, SandboxHandle, SessionEvent, ToolContext } from '@inbrowser/agent';
import { appendRecords, currentGitSha, type MetricsRecord } from '~/lib/experiment/metrics-store';
import {
  appendRequestRows,
  appendToolRows,
  createLedgerTracer,
  createToolLedgerRecorder,
  type RequestLedgerRow,
  type ToolLedgerRow,
} from '~/lib/experiment/efficiency-ledgers';

// ── args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const useLocal = argv.includes('--local');
const endpoint = flag('endpoint') ?? 'http://localhost:8080/v1';
const model = flag('model') ?? 'gpt-oss-120b';
const maxTurns = Number(flag('max-turns') ?? '14') || 14;
const fixtureFilter = flag('fixture');
// Agent pattern to run: react | react+parallel | react+reflexion | draft-validate.
// Default: all four (the strategy × fixture matrix).
const strategyFilter = flag('strategy');
// Efficiency-variant label (the before/after key in the metrics store).
const variant = flag('variant') ?? 'baseline';
// Opt-in prompt caching (#511) — marks the static system prefix cacheable.
const cacheOn = argv.includes('--cache');
// Opt-in bounded tool-result history (#515) — summarizes old tool results
// before each model call. `--keep-last=N` sets how many recent results stay
// full (default 3).
const pruneOn = argv.includes('--prune');
const keepLast = Number(flag('keep-last') ?? '3') || 3;
// Bearer token for hosted OpenAI-compatible endpoints (OpenRouter). Local
// servers (Ollama) need none. Run with `bun --env-file=../../.env …`.
const apiKey = flag('api-key') ?? process.env.OPEN_ROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
// Reasoning effort (OpenRouter only — gated inside localOpenAiLlm).
// Default medium. ReAct arms make many small calls → low/medium; the
// one-shot draft-validate arm can afford high (one big up-front think).
// `off` explicitly disables thinking.
const VALID_EFFORTS = new Set(['off', 'low', 'medium', 'high']);
const effortFlag = flag('effort') ?? 'medium';
if (!VALID_EFFORTS.has(effortFlag)) throw new Error(`--effort must be one of off|low|medium|high, got ${effortFlag}`);
const effort = effortFlag as 'off' | 'low' | 'medium' | 'high';
// OpenRouter provider routing (gated inside localOpenAiLlm, same as
// --effort). --provider-sort default throughput; `default` sends no
// sort. --max-prompt-price / --max-completion-price are optional
// ceilings in USD per MILLION tokens (OpenRouter provider.max_price).
const VALID_SORTS = new Set(['throughput', 'price', 'latency', 'default']);
const providerSortFlag = flag('provider-sort') ?? 'throughput';
if (!VALID_SORTS.has(providerSortFlag)) {
  throw new Error(`--provider-sort must be one of throughput|price|latency|default, got ${providerSortFlag}`);
}
const providerSort = providerSortFlag as 'throughput' | 'price' | 'latency' | 'default';
const priceFlag = (name: string): number | undefined => {
  const raw = flag(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number ($/M tokens), got ${raw}`);
  return n;
};
const maxPromptPrice = priceFlag('max-prompt-price');
const maxCompletionPrice = priceFlag('max-completion-price');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, 'evals', 'fixtures', 'app-build');

// Harness scripts run under bun (same pattern as app-oracle.ts).
declare const Bun: typeof import('bun');

interface AppCase {
  method: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  data?: Record<string, unknown>;
  resource?: Record<string, unknown>;
  expect: 'ALLOW' | 'DENY';
}
interface AppFixture {
  id: string;
  /** Fixture-ladder tier (workstation-benchmarks.md §3a). Absent = 1. */
  tier?: number;
  domain: string;
  auth: string;
  security: string;
  prompt: string;
  cases: AppCase[];
  /** T4 retrofit fixtures: VFS files (path → content) written into the
   *  fresh workspace BEFORE the agent runs — a seeded existing app. When
   *  present, the harness also scores the `retrofit` dimension: the
   *  PRE-EXISTING `/workspace/tests/*.test.json` from here are re-run
   *  (original contents, even if the agent edited them) against the FINAL
   *  rules after the agent finishes — "did the agent break what already
   *  worked". Fixtures without this field behave exactly as before. */
  initialWorkspace?: Record<string, string>;
}

// ── built-in stub authoring model (no network) ─────────────────────────
const STUB_FIXTURE: AppFixture = {
  id: 'stub-owner-read',
  domain: 'users',
  auth: '—',
  security: 'owner read',
  prompt:
    'Build a small app where a signed-in user can read only their own profile at /users/{uid}. Write the rules and a minimal App.tsx.',
  cases: [
    { method: 'get', path: 'users/alice', auth: { uid: 'alice' }, expect: 'ALLOW' },
    { method: 'get', path: 'users/alice', auth: { uid: 'mallory' }, expect: 'DENY' },
    { method: 'get', path: 'users/alice', auth: null, expect: 'DENY' },
  ],
};

function stubAuthoringLlm(): LlmClient {
  let call = 0;
  const rules = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{database}/documents {',
    '    match /users/{uid} {',
    '      allow read: if request.auth != null && request.auth.uid == uid;',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const appSrc = [
    "import { useEffect, useState } from 'react';",
    "import { getDoc, doc } from 'firebase/firestore';",
    "import { getAuth, onAuthStateChanged } from 'firebase/auth';",
    "import { db } from './firebase';",
    'export default function App() {',
    '  const [profile, setProfile] = useState<unknown>(null);',
    '  useEffect(() => onAuthStateChanged(getAuth(), async (u) => {',
    '    if (u) setProfile((await getDoc(doc(db, "users", u.uid))).data());',
    '  }), []);',
    '  return <pre>{JSON.stringify(profile)}</pre>;',
    '}',
  ].join('\n');
  // W1.3: the workspace-tests artifact for the tool-free DRAFT path —
  // mirrors the stub's owner-read scenario (incl. a seed so the
  // owner-read case runs against an existing doc).
  const testsFile = {
    seed: [{ path: 'users/alice', data: { name: 'Alice' } }],
    cases: [
      { as: { uid: 'alice' }, do: { method: 'get', path: 'users/alice' }, expect: 'ALLOW', name: 'owner reads own profile' },
      { as: { uid: 'mallory' }, do: { method: 'get', path: 'users/alice' }, expect: 'DENY', name: 'non-owner denied' },
      { as: null, do: { method: 'get', path: 'users/alice' }, expect: 'DENY', name: 'unauthenticated denied' },
    ],
  };
  // APPSPEC-v1: the fourth fence — the access matrix matching the stub
  // rules exactly (get granted owner-only; everything else
  // deny-by-default, which `allow read` satisfies for bare lists since
  // the owner condition is unprovable for an unfiltered query).
  const appSpec = {
    meta: { title: 'Own-profile reader', assumptions: ['Users read only their own profile.'] },
    identities: [
      { uid: 'alice', description: 'a user' },
      { uid: 'mallory', description: 'another user' },
    ],
    collections: [{ path: 'users/{uid}', fields: [{ name: 'name', type: 'string', required: true }] }],
    access: [
      { collection: 'users/{uid}', op: 'get', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
    ],
  };
  const draftText = [
    'Here is the complete app.',
    '```json app-spec\n' + JSON.stringify(appSpec, null, 2) + '\n```',
    '```firestore\n' + rules + '\n```',
    '```tsx\n' + appSrc + '\n```',
    '```json\n' + JSON.stringify(testsFile, null, 2) + '\n```',
  ].join('\n\n');
  return {
    id: 'stub-authoring',
    supportsTools: true,
    async *chat(req: { toolUseEnabled?: boolean; tools?: Array<{ name: string }> }) {
      // DRAFT phase (W1.3 + SF-S1 de-cage): draft-validate calls with EITHER
      // no tools (`toolUseEnabled:false`) OR the bounded read-mostly escape
      // hatch — which NEVER includes `write_file` (the strategy owns
      // write-back). The react path always offers the full registry, so the
      // presence of `write_file` in the offered tools is the discriminator.
      // The stub composes the four fenced artifacts without reaching for a
      // tool — the common "draft didn't need the hatch" path — so the
      // offline matrix exercises parse → validate → write-back end to end.
      const offersWriteFile = (req.tools ?? []).some((t) => t.name === 'write_file');
      if (req.toolUseEnabled === false || !offersWriteFile) {
        yield { kind: 'text', chunk: draftText };
        yield { kind: 'turn_complete', usage: { promptTokens: 120, completionTokens: 90 }, details: {} };
        return;
      }
      call += 1;
      if (call === 1) {
        yield { kind: 'tool_call', id: 'c1', name: 'write_file', args: { path: '/workspace/firestore.rules', content: rules } };
        yield { kind: 'tool_call', id: 'c2', name: 'write_file', args: { path: '/workspace/src/App.tsx', content: appSrc } };
        yield { kind: 'turn_complete', usage: { promptTokens: 80, completionTokens: 40 }, details: {} };
      } else {
        yield { kind: 'text', chunk: 'Wrote the rules and the App component.' };
        yield { kind: 'turn_complete', usage: { promptTokens: 90, completionTokens: 12 }, details: {} };
      }
    },
  } as unknown as LlmClient;
}

async function loadFixtures(): Promise<AppFixture[]> {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
  const out: AppFixture[] = [];
  for (const f of files) out.push(JSON.parse(await readFile(resolve(FIXTURES_DIR, f), 'utf8')) as AppFixture);
  return out;
}

interface RunResult {
  arm: string;
  fixture: AppFixture;
  toolCalls: string[];
  files: string[];
  rules: string;
  appSource: string;
  /** W0 app-oracle vector (compile + render) — reported beside, never
   *  folded into, the rules `ok`. */
  appScore: import('~/lib/experiment/app-oracle').AppOracleScore;
  /** T4 retrofit dimension — only present for fixtures that declare an
   *  `initialWorkspace`. Prior tests run against the FINAL rules. */
  retrofit?: { priorTestsTotal: number; priorTestsPassed: number };
  liveDocs: number;
  passed: number;
  total: number;
  ok: boolean;
  oracleError?: string;
  errors: string[];
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  tokensReasoning: number;
  /** Real provider cost (OpenRouter usage.cost). 0 for local/free models. */
  costUsd: number;
  durationMs: number;
  turns: number;
  /** #514 adoption probe (console-only, not stored): how many
   *  simulate_firestore_write calls still re-passed the full `rules`
   *  arg, and the total bytes of ruleset re-shipped that way. After
   *  #514 the agent should omit `rules` → simWithRules→0, simRulesBytes→0. */
  simCalls: number;
  simWithRules: number;
  simRulesBytes: number;
  /** #515 probe (console-only): tool results summarized + bytes elided
   *  across the whole run by the history pruner. 0 when --prune is off. */
  prunedResults: number;
  prunedBytes: number;
  /** C2: which strategy the router picked ('routed' arm only). */
  routedStrategy?: string;
  /** C2: whether the bounded draft-validate→react escalation fired. */
  escalated: boolean;
}

async function main(): Promise<void> {
  const {
    createAgentSession,
    createDispatch,
    createMetricsCollector,
    createReactLoopStrategy,
  } = await import('@inbrowser/agent');
  const { buildToolRegistry } = await import('~/lib/tools');
  const { buildSystemPrompt } = await import('~/lib/agent/system-prompt');
  const { makeDiagnosticsContext } = await import('~/lib/agent/diagnostics');
  const { useWorkspaceStore } = await import('~/lib/store/workspace');
  const { useChatStore } = await import('~/lib/store/chat');
  const { resetVFS, getVFS } = await import('~/lib/vfs');
  const { listAllFiles } = await import('~/lib/files/file-tree');
  const { scoreApp } = await import('~/lib/experiment/app-oracle');
  const { WORKSPACE_ROOT } = await import('~/lib/store/files');
  const { conformanceSpec } = await import('~/lib/experiment/conformance-oracle');
  const { getRunner, disposeRunner } = await import('~/lib/sandbox/runner');
  const { createDraftThenValidateStrategy } = await import('~/lib/agent/strategies/draft-then-validate');
  const { createRoutedStrategy } = await import('~/lib/agent/strategy-router');
  const { notifyVfsWrite } = await import('~/lib/files/bootstrap');
  const { runWorkspaceTests } = await import('~/lib/workspace-tests/runner');

  // W1.3: the harness-side compile probe injected into draft-validate's
  // host validation (the browser host wires the esbuild service instead).
  // Same Bun.Transpiler approach as the W0 app oracle — bun-only, no deps.
  const compileCheck = async (files: Record<string, string>): Promise<{ ok: boolean; error?: string }> => {
    const transpiler = new Bun.Transpiler({ loader: 'tsx' });
    for (const [path, content] of Object.entries(files)) {
      if (!/\.(ts|tsx)$/.test(path)) continue;
      try {
        transpiler.transformSync(content);
      } catch (e) {
        return { ok: false, error: `${path}: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return { ok: true };
  };
  const makeDraftValidate = () => createDraftThenValidateStrategy({ maxRepairs: 2, compileCheck });

  // The pattern dimension. parallel/reflexion are react options; draft-validate
  // is the tool-free workspace draft → host build+test → bounded repair
  // strategy (W1.3); routed is the C2 production default (heuristic router +
  // floor-evidence escalation).
  const ALL_ARMS: { name: string; make: () => AgentStrategy }[] = [
    { name: 'react', make: () => createReactLoopStrategy({ maxTurns }) },
    { name: 'react+parallel', make: () => createReactLoopStrategy({ maxTurns, parallelDispatch: true }) },
    { name: 'react+reflexion', make: () => createReactLoopStrategy({ maxTurns, reflexion: { enabled: true, maxRetries: 1 } }) },
    { name: 'draft-validate', make: makeDraftValidate },
    {
      name: 'routed',
      make: () =>
        createRoutedStrategy({
          makeReact: () => createReactLoopStrategy({ maxTurns }),
          makeDraftValidate,
        }),
    },
  ];
  const armNames = strategyFilter ? strategyFilter.split(',').map((s) => s.trim()) : null;
  const arms = armNames ? ALL_ARMS.filter((a) => armNames.includes(a.name)) : ALL_ARMS;
  if (arms.length === 0) throw new Error(`no strategy matched --strategy=${strategyFilter}`);

  // Run identity is fixed BEFORE the first run so the efficiency ledgers
  // (EFF1) and the metrics records share one runId — joinable post-hoc.
  const modelLabel = useLocal ? model : 'stub';
  const ranAt = new Date().toISOString();
  const runId = `${modelLabel.replace(/[^a-z0-9]+/gi, '-')}-${ranAt.replace(/[:.]/g, '-')}`;
  // Ledger rows accumulate in memory across the whole matrix and flush in
  // ONE append per store at the end (same O_APPEND discipline as records).
  const requestLedgerRows: RequestLedgerRow[] = [];
  const toolLedgerRows: ToolLedgerRow[] = [];

  // Build a FRESH client per fixture: the stub carries a per-turn counter
  // that must reset between fixtures, and a clean client avoids any
  // cross-fixture state leaking through the provider.
  // Optional history pruner (#515). Wraps whatever client we build so old
  // tool results are summarized before each model call. `onPrune` lets the
  // per-fixture run tally how much was elided (measurement).
  const { withPrunedHistory } = await import('~/lib/agent/prune-history');
  type PruneSink = (s: { pruned: number; bytesSaved: number }) => void;
  let makeLlm: (onPrune?: PruneSink) => LlmClient;
  if (useLocal) {
    const { localOpenAiLlm } = await import('~/lib/experiment/local-openai-llm');
    makeLlm = (onPrune) => {
      const base = localOpenAiLlm({ baseUrl: endpoint, model, temperature: 0, reasoningEffort: effort, providerSort, ...(maxPromptPrice !== undefined ? { maxPromptPrice } : {}), ...(maxCompletionPrice !== undefined ? { maxCompletionPrice } : {}), ...(apiKey ? { apiKey } : {}), ...(cacheOn ? { cache: true } : {}) });
      return pruneOn ? withPrunedHistory(base, { keepLastResults: keepLast, onPrune }) : base;
    };
  } else {
    makeLlm = (onPrune) => {
      const base = stubAuthoringLlm();
      return pruneOn ? withPrunedHistory(base, { keepLastResults: keepLast, onPrune }) : base;
    };
  }

  async function runOne(fixture: AppFixture, arm: { name: string; make: () => AgentStrategy }): Promise<RunResult> {
    // Fresh workspace + sandbox per fixture.
    resetVFS();
    disposeRunner();
    useChatStore.getState().clear();
    const ws = useWorkspaceStore.getState();
    ws.setRules('');
    ws.setAppSource('');

    // T4 retrofit fixtures: seed the existing app into the fresh workspace
    // BEFORE the agent runs. `notifyVfsWrite` mirrors the special paths
    // (firestore.rules / src/App.tsx) into the workspace store, exactly as
    // an agent `write_file` would — the agent starts from a working app.
    if (fixture.initialWorkspace) {
      const vfs = getVFS();
      for (const [path, content] of Object.entries(fixture.initialWorkspace)) {
        const parent = path.slice(0, path.lastIndexOf('/'));
        if (parent && parent !== WORKSPACE_ROOT) await vfs.promises.mkdir(parent, { recursive: true });
        await vfs.promises.writeFile(path, content);
        notifyVfsWrite(path, content);
      }
    }

    const llm = makeLlm((s) => {
      prunedResults += s.pruned;
      prunedBytes += s.bytesSaved;
    });
    const registry = buildToolRegistry();
    const dispatch = createDispatch(registry);
    const metrics = createMetricsCollector();
    const ac = new AbortController();

    const toolCalls: string[] = [];
    let textBuf = '';
    let lastText = '';
    const errors: string[] = [];
    let simCalls = 0;
    let simWithRules = 0;
    let simRulesBytes = 0;
    let prunedResults = 0;
    let prunedBytes = 0;
    let routedStrategy: string | undefined;
    let escalated = false;
    const t0 = performance.now();

    // EFF1 ledgers: per-iteration request rows via the tracer seam,
    // per-call tool rows via the SessionEvent stream below.
    // `cadence` (SF-S0a) is resolved AFTER the run from the router
    // milestones (routedStrategy / escalated) and set on this same meta
    // object before `ledgerTracer.rows()` is read (the row builder reads
    // `meta.cadence` at row-build time).
    const ledgerMeta: { runId: string; fixture: string; strategy: string; model: string; cadence?: string } =
      { runId, fixture: fixture.id, strategy: arm.name, model: modelLabel };
    const ledgerTracer = createLedgerTracer(ledgerMeta);
    const toolRecorder = createToolLedgerRecorder(ledgerMeta);

    const session = createAgentSession({
      tracer: ledgerTracer,
      strategy: arm.make(),
      llm,
      tools: dispatch,
      toolList: registry.list(),
      toolContext: (): ToolContext => ({
        workspace: { presetId: '', rules: '', code: '', appSource: '', stitch: { projectId: null, latestScreenUrl: null, brief: null } },
        runtime: { terminal: [], runSummary: null, deploy: null, parseError: null, uiErrors: [], sandboxVersion: 0 },
        sandbox: ((): SandboxHandle => {
          const r = getRunner();
          return {
            async run(code) {
              return r.run(code);
            },
            async deployRules(source) {
              return r.deployRules(source);
            },
            async readState(opts) {
              return r.readState(opts);
            },
            reseed() {},
            dispose() {},
          };
        })(),
        ...makeDiagnosticsContext(true),
        signal: ac.signal,
      }),
      systemPromptBuilder: () => buildSystemPrompt({ diagnosticsEnabled: true }),
      metrics,
      history: [],
      id: `app-build-${fixture.id}-${Date.now().toString(36)}`,
    });

    for await (const ev of session.submit(fixture.prompt, ac.signal) as AsyncIterable<SessionEvent>) {
      switch (ev.kind) {
        case 'text':
          textBuf += ev.chunk;
          break;
        case 'tool_started': {
          toolCalls.push(ev.name);
          toolRecorder.onToolStarted(ev);
          // #514 adoption probe: did the model re-pass the full ruleset?
          if (ev.name === 'simulate_firestore_write') {
            simCalls += 1;
            const r = (ev.args as { rules?: unknown } | null)?.rules;
            if (typeof r === 'string' && r.trim().length > 0) {
              simWithRules += 1;
              simRulesBytes += r.length;
            }
          }
          break;
        }
        case 'tool_finished':
          toolRecorder.onToolFinished(ev);
          break;
        case 'turn_completed':
          lastText = textBuf;
          textBuf = '';
          break;
        case 'strategy_event': {
          // C2 router milestones — recorded so the metrics rows carry the
          // actual routing decision and any escalation.
          if (ev.name === 'strategy_routed') {
            routedStrategy = (ev.data as { strategy?: string } | undefined)?.strategy;
          } else if (ev.name === 'strategy_escalated') {
            escalated = true;
          }
          break;
        }
        case 'error':
          errors.push(ev.message);
          break;
      }
    }

    const durationMs = performance.now() - t0;
    // SF-S0a: resolve the cadence tag from the router milestones. The leaf
    // arms run a single cadence (cadence == arm.name); the `routed` arm's
    // cadence is the dispatched strategy, or 'react' once it escalated.
    ledgerMeta.cadence = escalated ? 'react' : routedStrategy ?? arm.name;
    requestLedgerRows.push(...ledgerTracer.rows());
    toolLedgerRows.push(...toolRecorder.rows());
    const totals = metrics.totals();
    const files = await listAllFiles(WORKSPACE_ROOT);
    const wsFinal = useWorkspaceStore.getState();
    if (wsFinal.rules) getRunner().deployRules(wsFinal.rules);
    const liveDocs = Object.keys(getRunner().readState()).length;

    const verdict = conformanceSpec(
      { finalWorkspace: { rules: wsFinal.rules }, finalRuntime: {}, assistantText: lastText, trace: [] } as never,
      { cases: fixture.cases },
    );
    const detail = verdict.detail as { passed?: number; total?: number } | undefined;

    // W0 app oracle: score the APP half of the artifact (compile + render).
    // Read every workspace file off the VFS so multi-file apps score too.
    const fileContents: Record<string, string> = {};
    for (const p of files) {
      try {
        const c = await getVFS().promises.readFile(p, 'utf8');
        if (typeof c === 'string') fileContents[p] = c;
      } catch {
        /* binary or unreadable — irrelevant to compile/render */
      }
    }
    if (wsFinal.appSource && !fileContents['/workspace/src/App.tsx']) {
      fileContents['/workspace/src/App.tsx'] = wsFinal.appSource;
    }
    const appScore = await scoreApp({ files: fileContents });

    // T4 retrofit dimension: re-run the fixture's PRE-EXISTING workspace
    // tests (the initialWorkspace contents, deliberately NOT the final VFS
    // state — an agent that edits or deletes a prior test must still be
    // judged against the original) against the FINAL rules. "Did the agent
    // break what already worked."
    let retrofit: RunResult['retrofit'];
    if (fixture.initialWorkspace) {
      const priorTests = Object.entries(fixture.initialWorkspace)
        .filter(([p]) => p.startsWith('/workspace/tests/') && p.endsWith('.test.json'))
        .map(([name, content]) => ({ name, content }));
      const report = await runWorkspaceTests(priorTests, wsFinal.rules);
      retrofit = { priorTestsTotal: report.total, priorTestsPassed: report.passed };
    }

    return {
      arm: arm.name,
      fixture,
      toolCalls,
      files,
      rules: wsFinal.rules,
      appSource: wsFinal.appSource,
      appScore,
      ...(retrofit ? { retrofit } : {}),
      liveDocs,
      passed: detail?.passed ?? 0,
      total: detail?.total ?? fixture.cases.length,
      ok: verdict.ok,
      oracleError: verdict.error,
      errors,
      tokensIn: totals.tokensIn,
      tokensOut: totals.tokensOut,
      tokensCached: totals.tokensCached,
      tokensReasoning: totals.tokensReasoning,
      costUsd: totals.costUsdTotal,
      durationMs,
      turns: totals.turnCount,
      simCalls,
      simWithRules,
      simRulesBytes,
      prunedResults,
      prunedBytes,
      ...(routedStrategy ? { routedStrategy } : {}),
      escalated,
    };
  }

  // Choose what to run: the full matrix (--local, or --matrix offline for a
  // loop check) or the single built-in stub scenario.
  const runMatrix = useLocal || argv.includes('--matrix');
  let fixtures: AppFixture[];
  if (runMatrix) {
    fixtures = await loadFixtures();
    if (fixtureFilter) fixtures = fixtures.filter((f) => f.id === fixtureFilter);
    if (fixtures.length === 0) throw new Error(`no app-build fixtures matched ${fixtureFilter ?? '(all)'}`);
    console.log(`# Headless app-build matrix (${useLocal ? `local · ${model}` : 'stub · loop check'} · ${fixtures.length} fixtures)\n`);
    if (!useLocal) {
      console.log(
        '_Offline loop check: the stub authors a fixed owner-read ruleset, so grades are NOT\nmeaningful here — this verifies the matrix runs all fixtures end to end. Real grades\nawait a model via --local._\n',
      );
    }
  } else {
    fixtures = [STUB_FIXTURE];
    console.log('# Headless app-build (stub authoring model · no network · wiring check)\n');
  }

  if (arms.length > 1) console.log(`strategies: ${arms.map((a) => a.name).join(', ')}\n`);

  const results: RunResult[] = [];
  for (const arm of arms) {
    if (arms.length > 1) console.log(`## strategy: ${arm.name}`);
    for (const fixture of fixtures) {
      const r = await runOne(fixture, arm);
      results.push(r);
      const status = r.ok ? 'PASS' : 'FAIL';
      const toolsShown = r.toolCalls.slice(0, 8).join(',') + (r.toolCalls.length > 8 ? `…(+${r.toolCalls.length - 8})` : '');
      const tok = r.tokensIn + r.tokensOut;
      const costStr = r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : '—';
      const simNote = r.simCalls > 0
        ? `\n   simulate: ${r.simCalls} calls · re-passed rules ${r.simWithRules}/${r.simCalls} (${r.simRulesBytes.toLocaleString()} bytes) [#514: lower is better]`
        : '';
      const pruneNote = r.prunedResults > 0
        ? `\n   pruned: ${r.prunedResults} old tool results · ${r.prunedBytes.toLocaleString()} bytes elided from re-sent history [#515]`
        : '';
      const appNote =
        `\n   app: compile ${r.appScore.compile.ok ? '✓' : `✗ (${r.appScore.compile.error ?? '?'})`}` +
        ` · render ${r.appScore.render.ok ? `✓ ${r.appScore.render.htmlBytes}b` : `✗ (${r.appScore.render.error ?? '?'})`}`;
      const retrofitNote = r.retrofit
        ? `\n   retrofit: prior tests ${r.retrofit.priorTestsPassed}/${r.retrofit.priorTestsTotal} still green [T4: did the agent break what already worked]`
        : '';
      console.log(
        `[${status}] ${r.fixture.id}\n` +
          `   oracle ${r.passed}/${r.total} · ${tok.toLocaleString()} tok · ${costStr} · ${(r.durationMs / 1000).toFixed(1)}s · files ${r.files.length} · tools: ${toolsShown || 'none'}` +
          appNote +
          retrofitNote +
          simNote +
          pruneNote +
          (r.oracleError ? `\n   oracle error: ${r.oracleError}` : '') +
          (r.errors.length ? `\n   agent errors: ${r.errors.join('; ')}` : ''),
      );
    }
  }

  // Detail view for a single run (stub or --fixture).
  if (results.length === 1) {
    const r = results[0]!;
    console.log('\n── firestore.rules ──');
    console.log(r.rules || '(empty)');
    console.log('\n── App.tsx (first 12 lines) ──');
    console.log((r.appSource || '(empty)').split('\n').slice(0, 12).join('\n'));
  }

  // ── Persist to the canonical metrics store (issue M1/#506). Views are
  // rendered separately by render-metrics (issue M3/#508) — the harness no
  // longer computes a grid inline; it just records raw rows. ──────────────
  const gitSha = currentGitSha();
  const records: MetricsRecord[] = results.map((r) => ({
    runId,
    ranAt,
    gitSha,
    model: { id: modelLabel, endpoint: useLocal ? endpoint : 'stub', paid: !!apiKey },
    strategy: {
      name: r.arm,
      params: {
        maxTurns,
        ...(r.routedStrategy ? { routedStrategy: r.routedStrategy } : {}),
        ...(r.escalated ? { escalated: true } : {}),
      },
    },
    fixture: {
      id: r.fixture.id,
      domain: r.fixture.domain,
      auth: r.fixture.auth,
      security: r.fixture.security,
      ...(r.fixture.tier ? { tier: r.fixture.tier } : {}),
    },
    trial: 0,
    variant,
    correctness: {
      ok: r.ok,
      casesPassed: r.passed,
      casesTotal: r.total,
      ...(r.oracleError ? { oracleError: r.oracleError } : {}),
    },
    appOracle: {
      compileOk: r.appScore.compile.ok,
      renderOk: r.appScore.render.ok,
      ...(r.appScore.compile.error ? { compileError: r.appScore.compile.error } : {}),
      ...(r.appScore.render.error ? { renderError: r.appScore.render.error } : {}),
      ...(r.appScore.render.htmlBytes ? { htmlBytes: r.appScore.render.htmlBytes } : {}),
    },
    ...(r.retrofit ? { retrofit: r.retrofit } : {}),
    tokens: {
      in: r.tokensIn,
      out: r.tokensOut,
      cached: r.tokensCached,
      reasoning: r.tokensReasoning,
      total: r.tokensIn + r.tokensOut,
    },
    costUsd: r.costUsd,
    costSource: r.costUsd > 0 ? 'usage.cost' : 'none',
    durationMs: Math.round(r.durationMs),
    turns: r.turns,
    toolCalls: r.toolCalls,
    rules: r.rules || undefined,
    files: r.files,
    liveDocs: r.liveDocs,
    errors: r.errors.length ? r.errors : undefined,
  }));
  appendRecords(records);
  // EFF1: flush the efficiency ledgers — one append per store per run.
  appendRequestRows(requestLedgerRows);
  appendToolRows(toolLedgerRows);

  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\n━━ recorded ${records.length} run(s) · ${passed} passed · variant=${variant} → metrics store ━━\n` +
      `   ledgers: ${requestLedgerRows.length} request row(s) · ${toolLedgerRows.length} tool row(s) → request-ledger.ndjson / tool-ledger.ndjson\n` +
      `_view with: bun scripts/render-metrics.ts (issue M3/#508) · analyze with: bun scripts/analyze-trace.ts (EFF1)_`,
  );
}

main().catch((e) => {
  console.error('run-app-build failed:', e);
  process.exit(1);
});
