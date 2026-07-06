#!/usr/bin/env bun
/**
 * Controlled strategy experiment — arms × fixtures × trials.
 *
 * Pipeline (all from `@inbrowser/agent@0.2.0`'s eval module):
 *   runFixtures → evaluateSpec (held-out oracle) → collectMetrics →
 *   compareMetrics → renderMarkdown.
 *
 * Arms (the only thing that varies; controls held fixed):
 *   react · react+parallel · react+reflexion · draft-validate
 * Each non-baseline arm is compared against `react`. Fixtures +
 * held-out conformance oracle: see B2/B3. Decisions + rationale:
 * plans/draft-then-validate-experiment.md.
 *
 * Modes:
 *   (default) STUB LlmClient — canned response, NO API spend. Proves the
 *             arms/fixtures/oracle/compare wiring end-to-end.
 *   --real    GATED (G1). Real provider (minimax-m3), real tools, real
 *             spend. Requires explicit sign-off. NOTE: the real path's
 *             tool-context / system-prompt fidelity vs the live playground
 *             is the one thing to verify on the first --real run (the
 *             library runner builds its own ToolContext + default prompt).
 *
 * Usage:
 *   bun scripts/run-experiment.ts                 # stub smoke, N=1
 *   bun scripts/run-experiment.ts --trials=3      # stub, N=3
 *   bun --env-file=../../.env scripts/run-experiment.ts --real --trials=5   # GATED
 */
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectMetrics,
  compareMetrics,
  createDispatch,
  createReactLoopStrategy,
  createSpecRegistry,
  createToolRegistry,
  evaluateSpec,
  registerAllSpecs,
  renderMarkdown,
  runFixtures,
  type AgentStrategy,
  type EvalRunRecord,
  type LlmClient,
  type RunSnapshot,
  type SpecResult,
  type TaskFixture,
} from '@inbrowser/agent';
import { createDraftThenValidateStrategy } from '~/lib/agent/strategies/draft-then-validate';
import { registerConformanceSpec } from '~/lib/experiment/conformance-oracle';
import { localOpenAiLlm } from '~/lib/experiment/local-openai-llm';
import { buildSimulateFirestoreWriteHandler } from '~/lib/tools/diagnostics/simulate-firestore-write';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(HERE, 'evals', 'fixtures', 'experiment');
const EXPERIMENTS_DIR = resolve(HERE, 'evals', 'experiments');

// ── args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const trials = Number(flag('trials') ?? '1') || 1;
const real = argv.includes('--real');
const local = argv.includes('--local');
const endpoint = flag('endpoint') ?? 'http://localhost:8080/v1';
const localModel = flag('model') ?? 'gpt-oss-120b';
// Optional filters for cheap smokes: --arms=react,draft-validate --fixtures=owner-doc-read
const armFilter = flag('arms')?.split(',').map((s) => s.trim()).filter(Boolean);
const fixtureFilter = flag('fixtures')?.split(',').map((s) => s.trim()).filter(Boolean);

// ── arms ───────────────────────────────────────────────────────────────
const MAX_TURNS = 12;
interface Arm {
  name: string;
  strategy: () => AgentStrategy;
}
const ARMS: Arm[] = [
  { name: 'react', strategy: () => createReactLoopStrategy({ maxTurns: MAX_TURNS }) },
  { name: 'react+parallel', strategy: () => createReactLoopStrategy({ maxTurns: MAX_TURNS, parallelDispatch: true }) },
  {
    name: 'react+reflexion',
    strategy: () => createReactLoopStrategy({ maxTurns: MAX_TURNS, reflexion: { enabled: true, maxRetries: 1 } }),
  },
  { name: 'draft-validate', strategy: () => createDraftThenValidateStrategy({ maxRepairs: 2 }) },
];

// ── stub LLM (no spend) ────────────────────────────────────────────────
const STUB_ANSWER = [
  '```firestore',
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{db}/documents {',
  '    match /users/{uid} {',
  '      allow read: if request.auth != null && request.auth.uid == uid;',
  '    }',
  '  }',
  '}',
  '```',
].join('\n');

function stubLlm(answer: string): LlmClient {
  return {
    id: 'stub-llm',
    supportsTools: false,
    async *chat() {
      yield { kind: 'text', chunk: answer };
      yield { kind: 'turn_complete', usage: { promptTokens: 120, completionTokens: 60 }, details: {} };
    },
  } as unknown as LlmClient;
}

// ── real provider (GATED; built, not exercised in the stub smoke) ───────
// localStorage polyfill must precede the playground provider imports (they
// read window.localStorage at module init for BYOK), hence dynamic import.
function installLocalStoragePolyfill(): void {
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') return;
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  };
}

interface LlmSurface {
  llm: LlmClient;
  tools: ReturnType<typeof createDispatch>;
  toolRegistry: ReturnType<typeof createToolRegistry>;
  toolList: ReturnType<ReturnType<typeof createToolRegistry>['list']>;
}

async function buildRealLlm(): Promise<LlmSurface> {
  installLocalStoragePolyfill();
  // The OpenRouter provider reads its key from BYOK localStorage (empty in
  // node). Seed it from the environment so a node run can authenticate.
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error(
      '--real needs an OpenRouter key: set OPENROUTER_API_KEY in the environment ' +
        '(e.g. add it to examples/playground-next/.env and run with --env-file=.env).',
    );
  }
  const { callbackProviderAsLlmClient } = await import('@inbrowser/agent');
  const { PROVIDERS } = await import('~/lib/llm/registry');
  const { useLlmStore } = await import('~/lib/store/llm');
  const { buildToolRegistry } = await import('~/lib/tools');
  const { openrouterByok } = await import('~/lib/llm/byok');
  openrouterByok.setKey(key);
  // m3 only for v1 (locked decision). Provider reads model from the store.
  useLlmStore.getState().setProvider('openrouter', 'minimax/minimax-m3');
  const registry = buildToolRegistry();
  const def = PROVIDERS.openrouter;
  const llm = callbackProviderAsLlmClient(def.provider, def.id);
  return { llm, tools: createDispatch(registry), toolRegistry: registry, toolList: registry.list() };
}

function stubSurface(): LlmSurface {
  const toolRegistry = createToolRegistry();
  return {
    llm: stubLlm(STUB_ANSWER),
    tools: createDispatch(toolRegistry),
    toolRegistry,
    toolList: toolRegistry.list(),
  };
}

// Local OpenAI-compatible server (llama-server etc.). Registers ONLY the
// parse-only simulate tool (self-contained — no sandbox/ctx): enough for
// the draft-validate arm's host-driven validation, and the react arms can
// use it too. The model writes the ruleset in prose; the oracle grades via
// finalWorkspace.rules or the assistantText fence. The full playground tool
// surface (buildToolRegistry) is a later step once reachability is proven.
function buildLocalSurface(): LlmSurface {
  const toolRegistry = createToolRegistry();
  toolRegistry.register(buildSimulateFirestoreWriteHandler());
  return {
    llm: localOpenAiLlm({ baseUrl: endpoint, model: localModel, temperature: 0 }),
    tools: createDispatch(toolRegistry),
    toolRegistry,
    toolList: toolRegistry.list(),
  };
}

// ── fixtures + oracle ──────────────────────────────────────────────────
async function loadFixtures(): Promise<TaskFixture[]> {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.json')).sort();
  const out: TaskFixture[] = [];
  for (const f of files) {
    out.push(JSON.parse(await readFile(resolve(FIXTURES_DIR, f), 'utf8')) as TaskFixture);
  }
  return out;
}

function snapshotOf(rec: EvalRunRecord): RunSnapshot {
  return {
    finalWorkspace: rec.finalWorkspace,
    finalRuntime: rec.finalRuntime,
    assistantText: rec.assistantText,
    trace: rec.trace,
  };
}

// ── run ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (real) {
    console.error(
      '⚠ --real spends API budget (minimax-m3 × 4 arms × fixtures × trials). This is the GATED\n' +
        '  step G1 and must be launched with explicit sign-off. Verify tool-context fidelity on the\n' +
        '  first run. Proceeding because --real was passed.\n',
    );
  }

  const allFixtures = await loadFixtures();
  const fixtures = fixtureFilter
    ? allFixtures.filter((f) => fixtureFilter.some((id) => f.id === id || f.id.endsWith(`/${id}`)))
    : allFixtures;
  const activeArms = armFilter ? ARMS.filter((a) => armFilter.includes(a.name)) : ARMS;
  if (fixtures.length === 0) throw new Error('no fixtures matched --fixtures filter');
  if (activeArms.length === 0) throw new Error('no arms matched --arms filter');

  const specReg = createSpecRegistry();
  registerAllSpecs(specReg); // starter + custom specs
  registerConformanceSpec(specReg); // held-out oracle: experiment/conformance

  const surface = real ? await buildRealLlm() : local ? buildLocalSurface() : stubSurface();
  const modeLabel = real ? 'REAL · minimax-m3' : local ? `local · ${localModel}` : 'stub';

  console.log(
    `# Strategy experiment (${modeLabel} · ${fixtures.length} fixtures · ${activeArms.length} arms · ${trials} trial(s))\n`,
  );

  const tablesByArm = new Map<string, ReturnType<typeof collectMetrics>>();
  for (const arm of activeArms) {
    const records = await runFixtures(
      fixtures,
      { llm: surface.llm, tools: surface.tools, toolList: surface.toolList, strategy: arm.strategy },
      { trials },
    );
    const evaluations: (SpecResult | undefined)[] = [];
    for (const rec of records) {
      evaluations.push(await evaluateSpec(specReg, rec.fixture.successSpec, snapshotOf(rec)));
    }
    tablesByArm.set(arm.name, collectMetrics({ records, evaluations, toolRegistry: surface.toolRegistry }));
    const passes = evaluations.filter((e) => e?.ok).length;
    console.log(`- arm \`${arm.name}\`: ${records.length} record(s), ${passes}/${records.length} held-out-pass`);
  }

  // Compare every non-baseline arm against react (when both are present).
  const baseline = tablesByArm.get('react');
  const sections: string[] = [];
  if (baseline) {
    for (const arm of activeArms) {
      if (arm.name === 'react') continue;
      const report = compareMetrics({
        baseline,
        variant: tablesByArm.get(arm.name)!,
        baselineName: 'react',
        variantName: arm.name,
      });
      sections.push(`## react vs ${arm.name}\n\n${renderMarkdown(report)}`);
    }
  }
  const md = sections.length
    ? sections.join('\n\n')
    : '_Single arm or no `react` baseline in this run — comparison skipped; see held-out-pass counts above._';
  console.log('\n' + md);

  // Persist: committable metrics.json (diffable) + the markdown report.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const modeTag = real ? 'real' : local ? 'local' : 'stub';
  const outDir = resolve(EXPERIMENTS_DIR, `${modeTag}-${stamp}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(resolve(outDir, 'report.md'), md + '\n');
  await writeFile(
    resolve(outDir, 'metrics.json'),
    JSON.stringify(Object.fromEntries(tablesByArm), null, 2) + '\n',
  );
  console.log(`\n_Report written to ${outDir.replace(HERE, 'scripts')}_`);
}

main().catch((e) => {
  console.error('run-experiment failed:', e);
  process.exit(1);
});
