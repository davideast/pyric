/**
 * Unit tests for the W1.3 workspace-draft `createDraftThenValidateStrategy`
 * and its parse/floor/feedback helpers.
 *
 * Fully offline and deterministic: a canned `ModelClient` replays scripted
 * draft text; validation runs through the REAL workspace-tests runner
 * (hermetic in-process pyric sandbox — same dependency the runner's own
 * tests use); `compileCheck` is a stub. No network, no provider, no spend.
 *
 * Coverage: fence parsing (all orders, labels, fallbacks, multi-file app
 * fences, missing artifacts), floor generation, validation pass/fail paths
 * incl. compile failure and floor-vs-model provenance, write-back, and the
 * compact repair feedback (no re-ship of passing artifacts).
 */
import { describe, test, expect } from 'bun:test';
import {
  BOUNDED_DRAFT_TOOLS,
  DEFAULT_DRAFT_TOOL_BUDGET,
  canonicalizeTests,
  composeDraftSystemPrompt,
  createDraftThenValidateStrategy,
  defaultFloor,
  extractWorkspaceState,
  formatRepairFeedback,
  parseDraftArtifacts,
  parseRules,
  selectDraftToolDeclarations,
  type DraftFailure,
  type DraftValidateConfig,
  type DraftValidation,
} from './draft-then-validate';
import { shouldEscalateOnExhaustion } from '~/lib/agent/strategy-router';
import { toOaiMessages } from '~/lib/llm/inference/openrouter-page';
import type { StrategyEvent, StrategyRunInput } from '@inbrowser/agent';

// ── fixtures ───────────────────────────────────────────────────────────

const OWNER_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /users/{uid} {',
  '      allow get: if request.auth != null && request.auth.uid == uid;',
  '      allow create: if request.auth != null && request.auth.uid == uid;',
  '    }',
  '  }',
  '}',
].join('\n');

const PUBLIC_CREATE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /users/{uid} {',
  '      allow read, create: if true;',
  '    }',
  '  }',
  '}',
].join('\n');

const APP_TSX = [
  "import { useState } from 'react';",
  'export default function App() {',
  '  const [n] = useState(0);',
  '  return <div>{n}</div>;',
  '}',
].join('\n');

const TESTS_FILE = {
  seed: [{ path: 'users/alice', data: { name: 'Alice' } }],
  cases: [
    { as: { uid: 'alice' }, do: { method: 'get', path: 'users/alice' }, expect: 'ALLOW', name: 'owner reads own profile' },
    { as: { uid: 'mallory' }, do: { method: 'get', path: 'users/alice' }, expect: 'DENY' },
    { as: null, do: { method: 'get', path: 'users/alice' }, expect: 'DENY' },
  ],
};

/** App spec matching OWNER_RULES exactly: users/{uid}, owner-only
 *  get+create, everything else deny-by-default. */
const APP_SPEC = {
  meta: { title: 'Profile app', assumptions: ['Users manage only their own profile.'] },
  identities: [
    { uid: 'alice', description: 'a user' },
    { uid: 'mallory', description: 'another user' },
  ],
  collections: [{ path: 'users/{uid}', fields: [{ name: 'name', type: 'string', required: true }] }],
  access: [
    { collection: 'users/{uid}', op: 'get', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
    { collection: 'users/{uid}', op: 'create', grant: [{ kind: 'authenticated' }, { kind: 'owner' }] },
  ],
};

function fence(label: string, body: string): string {
  return `\`\`\`${label}\n${body}\n\`\`\``;
}

/** The four-fence draft (spec + rules + app + tests). */
function fullDraft(rules = OWNER_RULES, app = APP_TSX, tests: object = TESTS_FILE, spec: object = APP_SPEC): string {
  return [
    'Here is the app.',
    fence('json app-spec', JSON.stringify(spec)),
    fence('firestore', rules),
    fence('tsx', app),
    fence('json', JSON.stringify(tests)),
  ].join('\n\n');
}

/** The pre-spec three-fence draft — degradation-pin fixture. */
function threeFenceDraft(rules = OWNER_RULES, app = APP_TSX, tests: object = TESTS_FILE): string {
  return [
    'Here is the app.',
    fence('firestore', rules),
    fence('tsx', app),
    fence('json', JSON.stringify(tests)),
  ].join('\n\n');
}

/** A draft that reliably FAILS validation on attempt 0 regardless of rules
 *  compilation — it omits the App.tsx fence (always a missing-artifact
 *  failure). Used by the SF leash/budget tests to trigger the repair hatch
 *  without depending on a bad rules fence (which the host now overrides by
 *  compiling from the spec). */
function failingDraft(): string {
  return [
    'Here is a partial draft.',
    fence('json app-spec', JSON.stringify(APP_SPEC)),
    fence('json', JSON.stringify(TESTS_FILE)),
  ].join('\n\n');
}

// ── stubs ──────────────────────────────────────────────────────────────

interface ReqSeen {
  toolCount: number;
  toolUseEnabled: boolean;
  messages: { role: string; text: string }[];
  /** The FULL messages as threaded by the strategy (incl. assistant
   *  `toolCalls` and tool-message `toolCallId`/`resultJson`) — the surface
   *  the OpenAI-strict transports lower. Used by the conformance test. */
  raw: Array<Record<string, unknown>>;
}

function makeLlm(scripts: string[]) {
  const seen: ReqSeen[] = [];
  let i = 0;
  const llm = {
    id: 'stub-llm',
    supportsTools: true,
    async *chat(req: { messages: { role: string; text: string }[]; tools: unknown[]; toolUseEnabled: boolean }) {
      seen.push({
        toolCount: req.tools.length,
        toolUseEnabled: req.toolUseEnabled,
        messages: req.messages.map((m) => ({ role: m.role, text: m.text })),
        raw: req.messages.map((m) => ({ ...(m as Record<string, unknown>) })),
      });
      const text = scripts[Math.min(i, scripts.length - 1)] ?? '';
      i += 1;
      yield { kind: 'text', text };
      yield { kind: 'usage', usage: { promptTokens: 5, outputTokens: 7 } };
    },
  };
  return { llm, seen };
}

function makeTools() {
  const calls: { name: string; args: { path?: string; content?: string } }[] = [];
  const tools = {
    async execute(call: { name: string; args: { path?: string; content?: string } }) {
      calls.push({ name: call.name, args: call.args });
      return { ok: true, summary: `wrote ${call.args.path ?? ''}` };
    },
  };
  return { tools, calls };
}

function makeInput(llm: unknown, tools: unknown, over: Partial<StrategyRunInput> = {}): StrategyRunInput {
  return {
    prompt: 'build a profile app where users read only their own profile',
    history: [],
    systemPrompt: 'HOST PROMPT (tool orchestration etc.)',
    toolList: [],
    toolContext: () => ({}),
    turnId: 'T1',
    workspace: {},
    runtime: {},
    llm,
    tools,
    ...over,
  } as unknown as StrategyRunInput;
}

async function drain(
  input: StrategyRunInput,
  config: DraftValidateConfig = { maxRepairs: 2 },
): Promise<StrategyEvent[]> {
  const strategy = createDraftThenValidateStrategy(config);
  const out: StrategyEvent[] = [];
  for await (const ev of strategy.run(input, new AbortController().signal)) out.push(ev);
  return out;
}

function customData(evs: StrategyEvent[], name: string): Record<string, unknown>[] {
  return evs
    .filter((e): e is Extract<StrategyEvent, { kind: 'custom' }> => e.kind === 'custom' && e.name === name)
    .map((e) => (e.data ?? {}) as Record<string, unknown>);
}

function failuresOf(vr: Record<string, unknown>): DraftFailure[] {
  return (vr.failures ?? []) as DraftFailure[];
}

const okCompile = async () => ({ ok: true });

// ── fence parsing ──────────────────────────────────────────────────────

describe('parseDraftArtifacts', () => {
  test('parses all three artifacts regardless of order', () => {
    const orders = [
      [fence('firestore', OWNER_RULES), fence('tsx', APP_TSX), fence('json', JSON.stringify(TESTS_FILE))],
      [fence('json', JSON.stringify(TESTS_FILE)), fence('firestore', OWNER_RULES), fence('tsx', APP_TSX)],
      [fence('tsx', APP_TSX), fence('json', JSON.stringify(TESTS_FILE)), fence('firestore', OWNER_RULES)],
    ];
    for (const parts of orders) {
      const p = parseDraftArtifacts(parts.join('\n\nprose between fences\n\n'));
      expect(p.rules).toContain('rules_version');
      expect(p.app).toContain('export default function App');
      expect(p.tests?.file?.cases).toHaveLength(3);
    }
  });

  test('accepts label variants (rules, jsx, info strings after the label)', () => {
    const p = parseDraftArtifacts(
      [
        '```rules\n' + OWNER_RULES + '\n```',
        '```jsx App.tsx\n' + APP_TSX + '\n```',
        '```json tests/draft.test.json\n' + JSON.stringify(TESTS_FILE) + '\n```',
      ].join('\n'),
    );
    expect(p.rules).toContain('rules_version');
    expect(p.app).toContain('export default');
    expect(p.tests?.file).not.toBeNull();
  });

  test('classifies unlabeled fences by content', () => {
    const p = parseDraftArtifacts(
      ['```\n' + OWNER_RULES + '\n```', '```\n' + APP_TSX + '\n```', '```\n' + JSON.stringify(TESTS_FILE) + '\n```'].join('\n'),
    );
    expect(p.rules).toContain('rules_version');
    expect(p.app).toContain('export default');
    expect(p.tests?.file?.cases).toHaveLength(3);
  });

  test('a ```ts fence containing rules is classified as rules, not app', () => {
    const p = parseDraftArtifacts(fence('ts', OWNER_RULES));
    expect(p.rules).toContain('rules_version');
    expect(p.app).toBeNull();
  });

  test('missing artifacts come back null — parsing never throws', () => {
    expect(parseDraftArtifacts('pure prose, no fences')).toEqual({ spec: null, rules: null, app: null, appFiles: {}, tests: null });
    const p = parseDraftArtifacts(fence('firestore', OWNER_RULES));
    expect(p.rules).not.toBeNull();
    expect(p.app).toBeNull();
    expect(p.tests).toBeNull();
    expect(p.spec).toBeNull();
  });

  test('parses path-labeled supporting app files without lowercasing their paths', () => {
    const component = [
      "export function ProfileCard() {",
      "  return <section>Profile</section>;",
      "}",
    ].join('\n');
    const p = parseDraftArtifacts(
      [
        fence('tsx /workspace/src/App.tsx', APP_TSX),
        fence('tsx /workspace/src/components/ProfileCard.tsx', component),
        fence('ts src/lib/formatName.ts', 'export const formatName = (s: string) => s.trim();'),
      ].join('\n'),
    );
    expect(p.app).toBe(APP_TSX);
    expect(p.appFiles['/workspace/src/components/ProfileCard.tsx']).toBe(component);
    expect(p.appFiles['/workspace/src/lib/formatName.ts']).toContain('formatName');
  });

  test('the spec fence parses: labeled app-spec, or shape-classified without the label', () => {
    // labeled
    const labeled = parseDraftArtifacts(
      [fence('json app-spec', JSON.stringify(APP_SPEC)), fence('json', JSON.stringify(TESTS_FILE))].join('\n'),
    );
    expect(labeled.spec?.spec?.meta.title).toBe('Profile app');
    expect(labeled.tests?.file?.cases).toHaveLength(3);
    // unlabeled json fences classified by shape (collections+access → spec)
    const byShape = parseDraftArtifacts(
      [fence('json', JSON.stringify(TESTS_FILE)), fence('json', JSON.stringify(APP_SPEC))].join('\n'),
    );
    expect(byShape.spec?.spec?.meta.title).toBe('Profile app');
    expect(byShape.tests?.file?.cases).toHaveLength(3);
  });

  test('an invalid spec is captured with its errors (referential check)', () => {
    const bad = { ...APP_SPEC, access: [{ collection: 'ghosts/{id}', op: 'get', grant: [] }] };
    const p = parseDraftArtifacts(fence('json app-spec', JSON.stringify(bad)));
    expect(p.spec?.spec).toBeNull();
    expect(p.spec?.errors?.join('\n')).toContain('unknown collection "ghosts/{id}"');
  });

  test('invalid tests JSON is captured with its error (not silently dropped)', () => {
    const p = parseDraftArtifacts(fence('json', '{ "cases": [ '));
    expect(p.tests?.file).toBeNull();
    expect(p.tests?.error).toBeTruthy();
  });

  test('a later valid json fence replaces an earlier unparseable candidate', () => {
    const p = parseDraftArtifacts(
      [fence('json', '{ broken'), fence('json', JSON.stringify(TESTS_FILE))].join('\n'),
    );
    expect(p.tests?.file?.cases).toHaveLength(3);
  });
});

describe('canonicalizeTests', () => {
  test('wraps a bare case array as { cases }', () => {
    const t = canonicalizeTests(JSON.stringify(TESTS_FILE.cases));
    expect(t.file?.cases).toHaveLength(3);
  });

  test("forces source:'authored' — a draft cannot spoof floor provenance", () => {
    const spoofed = {
      cases: [{ as: null, do: { method: 'get', path: 'users/alice' }, expect: 'ALLOW', source: 'floor' }],
    };
    const t = canonicalizeTests(JSON.stringify(spoofed));
    expect(t.file?.cases[0]?.source).toBe('authored');
  });
});

describe('parseRules (router escalation-evidence contract)', () => {
  test('prefers a rules-looking fence, null when absent', () => {
    expect(parseRules('```firestore\nrules_version = "2";\n```')).toContain('rules_version');
    expect(parseRules('```\nservice cloud.firestore { allow read; }\n```')).toContain('cloud.firestore');
    expect(parseRules('no code fence here')).toBeNull();
  });
});

// ── floor ──────────────────────────────────────────────────────────────

describe('defaultFloor', () => {
  test('adds unauth-create-DENY per distinct doc path, source floor', () => {
    const floor = defaultFloor({
      cases: [
        { as: { uid: 'a' }, do: { method: 'get', path: 'users/alice' }, expect: 'ALLOW' },
        { as: { uid: 'a' }, do: { method: 'update', path: 'users/alice' }, expect: 'ALLOW' },
        { as: { uid: 'a' }, do: { method: 'get', path: 'orders/o1' }, expect: 'ALLOW' },
      ],
    });
    expect(floor?.cases.map((c) => c.do.path).sort()).toEqual(['orders/o1', 'users/alice']);
    expect(floor?.cases.every((c) => c.source === 'floor' && c.as === null && c.expect === 'DENY')).toBe(true);
  });

  test('collection paths (list targets) get a synthetic doc segment — a create probe must be a valid doc write', () => {
    const floor = defaultFloor({
      cases: [{ as: { uid: 'a' }, do: { method: 'list', path: 'menuItems' }, expect: 'ALLOW' }],
    });
    expect(floor?.cases[0]?.do.path).toBe('menuItems/floor-probe');
  });

  test('null model tests → null floor', () => {
    expect(defaultFloor(null)).toBeNull();
  });
});

// ── draft prompt composition ───────────────────────────────────────────

describe('composeDraftSystemPrompt', () => {
  const HOST = [
    'You are a Firebase agent in a playground.',
    'TOOL ORCHESTRATION (long tool routing prose…)',
    '── CURRENT RULES ──',
    OWNER_RULES,
    '── END CURRENT ──',
    '',
    '── CURRENT APP ──',
    '(empty — user has not written an app yet)',
    '── END CURRENT ──',
  ].join('\n');

  test('does NOT inherit the host tool-orchestration prefix', () => {
    const p = composeDraftSystemPrompt(HOST);
    expect(p).not.toContain('TOOL ORCHESTRATION');
    // SF-S1 de-cage + SF leash: the draft is no longer tool-FREE, but the
    // framing is compose-first and tools are LAST-RESORT recovery, not a
    // workflow — never the full orchestration prefix.
    expect(p).toContain('COMPOSE THE FULL DRAFT FIRST');
    expect(p).toContain('LAST-RESORT escape hatch');
    // SF-S3: the host now COMPILES rules from the spec, so the draft asks
    // for artifact groups (spec/app files/tests), not a rules fence.
    expect(p).toContain('Compose the artifacts');
  });

  test('carries the artifact-group contract and key guidance invariants', () => {
    const p = composeDraftSystemPrompt('');
    expect(p).toContain('Emit the workspace artifacts');
    expect(p).toContain('```json app-spec');
    expect(p).toContain('```tsx /workspace/src/App.tsx');
    expect(p).toContain('/workspace/src/components/Name.tsx');
    expect(p).toContain('DENIED BY DEFAULT');
    // SF-S3: rules are HOST-COMPILED — the prompt says so and no longer
    // teaches the model to author a ```firestore fence.
    expect(p).toContain('RULES ARE HOST-COMPILED');
    expect(p).toContain('```tsx');
    expect(p).toContain('```json');
    // #575 anti-switcher rule
    expect(p).toContain('NEVER render a developer identity-switcher');
    // scope constraint
    expect(p).toContain('@pyric/*');
    // tests seeding contract
    expect(p).toContain('seed');
  });

  test('uses stable workspace references instead of extracted full file bodies', () => {
    const state = extractWorkspaceState(HOST);
    expect(state).toContain('WORKSPACE FILES:');
    expect(state).toContain('/workspace/src/App.tsx');
    expect(state).toContain('/workspace/firestore.rules');
    expect(state).not.toContain('CURRENT RULES');
    expect(state).not.toContain('rules_version');
    expect(composeDraftSystemPrompt(HOST)).not.toContain('rules_version');
  });

  test('is an order of magnitude smaller than a playground-scale host prompt', () => {
    // Guard against the failure mode this rewrite removes: the draft
    // wrapping the full tool-orchestration prefix. The composed guidance
    // must stay a small fraction of a ~40k-char host prompt. The spec,
    // stable workspace references, and multi-file app contract fit under
    // this ceiling without reintroducing the old host prompt.
    expect(composeDraftSystemPrompt('').length).toBeLessThan(9000);
  });
});

// ── strategy behavior (real runner, stub compile) ──────────────────────

describe('draft-then-validate strategy', () => {
  test('happy path: tool-free draft, host-compiled rules, build+test green, write-back', async () => {
    const { llm, seen } = makeLlm([fullDraft()]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 2, compileCheck: okCompile });

    // DRAFT was tool-free
    expect(seen).toHaveLength(1);
    expect(seen[0]!.toolCount).toBe(0);
    expect(seen[0]!.toolUseEnabled).toBe(false);
    // …and used the composed draft prompt, not the host prompt
    expect(seen[0]!.messages[0]!.text).not.toContain('HOST PROMPT');
    expect(seen[0]!.messages[0]!.text).toContain('Emit the workspace artifacts');

    // One attempt, green
    expect(customData(evs, 'draft_started')).toHaveLength(1);
    expect(customData(evs, 'repair_started')).toHaveLength(0);
    expect(customData(evs, 'validation_exhausted')).toHaveLength(0);
    const vr = customData(evs, 'validation_result')[0]!;
    expect(vr.passed).toBe(vr.total);
    expect((vr.total as number)).toBeGreaterThanOrEqual(4); // 3 model cases + ≥1 floor case
    expect(vr.artifacts).toEqual({ spec: 'ok', rules: 'ok', app: 'ok', tests: 'ok' });

    // SF-S3: rules were HOST-COMPILED from the spec (the enumerable case),
    // the model's rules fence was NOT used, and there were no custom holes.
    expect(vr.rulesSource).toBe('compiled');
    expect(vr.holes).toBe(0);
    expect(vr.holesUnfilled).toBe(0);

    // Spec observables ride the validation result (gate wiring)
    const specSummary = vr.spec as {
      title: string;
      customConditions: number;
      derivedCases: number;
      modelCases: number;
      matrix: Array<{ collection: string; op: string; grant: unknown }>;
    };
    expect(specSummary.title).toBe('Profile app');
    expect(specSummary.customConditions).toBe(0);
    expect(specSummary.derivedCases).toBeGreaterThanOrEqual(10); // matrix suite incl. deny-by-default
    expect(specSummary.modelCases).toBe(3);
    expect(specSummary.matrix).toHaveLength(5); // users × five ops, deny cells included

    // Write-back: ALL four artifacts via real write_file dispatches
    expect(calls.map((c) => c.name)).toEqual(['write_file', 'write_file', 'write_file', 'write_file']);
    expect(calls.map((c) => c.args.path)).toEqual([
      '/workspace/firestore.rules',
      '/workspace/src/App.tsx',
      '/workspace/tests/draft.test.json',
      '/workspace/app.spec.json',
    ]);
    // The written ruleset is the HOST-COMPILED output (correct-by-construction
    // for users/{uid} path-uid owner), not the model's verbatim fence.
    expect(calls[0]!.args.content).toContain("rules_version = '2';");
    expect(calls[0]!.args.content).toContain('match /users/{uid} {');
    expect(calls[0]!.args.content).toContain('request.auth.uid == uid');
    expect(calls[1]!.args.content).toBe(APP_TSX);
    const testsOut = JSON.parse(calls[2]!.args.content!) as { cases: { source?: string }[] };
    expect(testsOut.cases).toHaveLength(3);
    expect(testsOut.cases.every((c) => c.source === 'authored')).toBe(true);
    const specOut = JSON.parse(calls[3]!.args.content!) as { meta: { title: string } };
    expect(specOut.meta.title).toBe('Profile app');

    expect(evs.some((e) => e.kind === 'turn_complete')).toBe(true);
  });

  test('multi-file app drafts compile and write back supporting files', async () => {
    const entry = [
      "import { ProfileCard } from './components/ProfileCard';",
      'export default function App() {',
      '  return <ProfileCard />;',
      '}',
    ].join('\n');
    const component = [
      'export function ProfileCard() {',
      '  return <section>Profile</section>;',
      '}',
    ].join('\n');
    const draft = [
      fence('json app-spec', JSON.stringify(APP_SPEC)),
      fence('firestore', OWNER_RULES),
      fence('tsx /workspace/src/App.tsx', entry),
      fence('tsx /workspace/src/components/ProfileCard.tsx', component),
      fence('json', JSON.stringify(TESTS_FILE)),
    ].join('\n\n');
    const compileInputs: Array<Record<string, string>> = [];
    const compileCheck = async (files: Record<string, string>) => {
      compileInputs.push(files);
      return { ok: true };
    };
    const { llm } = makeLlm([draft]);
    const { tools, calls } = makeTools();
    await drain(makeInput(llm, tools), { maxRepairs: 2, compileCheck });

    expect(Object.keys(compileInputs[0]!).sort()).toEqual([
      '/workspace/src/App.tsx',
      '/workspace/src/components/ProfileCard.tsx',
    ]);
    expect(calls.map((c) => c.args.path)).toEqual([
      '/workspace/firestore.rules',
      '/workspace/src/App.tsx',
      '/workspace/src/components/ProfileCard.tsx',
      '/workspace/tests/draft.test.json',
      '/workspace/app.spec.json',
    ]);
    expect(calls[1]!.args.content).toBe(entry);
    expect(calls[2]!.args.content).toBe(component);
  });

  test('DEGRADATION PIN: spec fence missing after one repair → exact three-fence behavior', async () => {
    // The model never produces a spec; after ONE spec repair the
    // strategy must degrade to today's behavior: green validation,
    // three-file write-back, no spec failures surfacing.
    const { llm, seen } = makeLlm([threeFenceDraft(), threeFenceDraft()]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 2, compileCheck: okCompile });

    // Attempt 0: the ONLY failure is the missing spec fence
    const vr0 = customData(evs, 'validation_result')[0]!;
    const f0 = failuresOf(vr0);
    expect(f0).toHaveLength(1);
    expect(f0[0]!).toMatchObject({ artifact: 'spec', kind: 'missing_artifact' });
    expect((vr0.artifacts as Record<string, string>).spec).toBe('missing');
    // …and the repair asked for the spec fence
    expect(customData(evs, 'repair_started')).toHaveLength(1);
    expect(seen[1]!.messages.at(-1)!.text).toContain('app spec: FAILED');

    // Attempt 1: still no spec → FALLBACK, green, no spec failure
    const vr1 = customData(evs, 'validation_result')[1]!;
    expect((vr1.artifacts as Record<string, string>).spec).toBe('fallback');
    expect(vr1.passed).toBe(vr1.total);
    expect(failuresOf(vr1)).toHaveLength(0);
    expect(vr1.spec).toBeUndefined();
    expect(customData(evs, 'validation_exhausted')).toHaveLength(0);

    // Write-back: exactly today's three files — no app.spec.json
    expect(calls.map((c) => c.args.path)).toEqual([
      '/workspace/firestore.rules',
      '/workspace/src/App.tsx',
      '/workspace/tests/draft.test.json',
    ]);
    expect(evs.some((e) => e.kind === 'turn_complete')).toBe(true);
  });

  test('degradation with maxRepairs:0 falls back immediately — spec absence never costs the turn', async () => {
    const { llm } = makeLlm([threeFenceDraft()]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile });
    const vr = customData(evs, 'validation_result')[0]!;
    expect((vr.artifacts as Record<string, string>).spec).toBe('fallback');
    expect(vr.passed).toBe(vr.total);
    expect(customData(evs, 'validation_exhausted')).toHaveLength(0);
    expect(calls).toHaveLength(3);
  });

  test('an unparseable spec gets one repair, then fallback (invalid_spec quotes the errors)', async () => {
    const badSpec = { ...APP_SPEC, access: [{ collection: 'ghosts/{id}', op: 'get', grant: [] }] };
    const { llm, seen } = makeLlm([
      fullDraft(OWNER_RULES, APP_TSX, TESTS_FILE, badSpec),
      threeFenceDraft(), // repair still doesn't fix the spec
    ]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 2, compileCheck: okCompile });

    const vr0 = customData(evs, 'validation_result')[0]!;
    const f0 = failuresOf(vr0);
    expect(f0).toHaveLength(1);
    expect(f0[0]!).toMatchObject({ artifact: 'spec', kind: 'invalid_spec', source: 'authored' });
    expect(f0[0]!.detail).toContain('unknown collection');
    expect(seen[1]!.messages.at(-1)!.text).toContain('invalid spec');

    const vr1 = customData(evs, 'validation_result')[1]!;
    expect((vr1.artifacts as Record<string, string>).spec).toBe('fallback');
    expect(vr1.passed).toBe(vr1.total);
    // invalid spec is NOT written back
    expect(calls.map((c) => c.args.path)).not.toContain('/workspace/app.spec.json');
  });

  test('SF-S3: a valid spec OVERRIDES a wrong model rules fence — host compiles correct rules, attempt is green', async () => {
    // The model emits PUBLIC_CREATE_RULES (over-permissive) alongside a
    // correct owner-only spec. Pre-SF this failed the derived/floor cases;
    // now the host COMPILES the rules from the spec and the bad fence is
    // simply unused — the attempt is green and the compiled (correct) rules
    // are what get written back.
    const { llm } = makeLlm([fullDraft(PUBLIC_CREATE_RULES)]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 1, compileCheck: okCompile });

    const vr = customData(evs, 'validation_result')[0]!;
    expect(vr.rulesSource).toBe('compiled');
    expect(failuresOf(vr)).toHaveLength(0);
    expect(vr.passed).toBe(vr.total);
    expect(customData(evs, 'repair_started')).toHaveLength(0);
    // Written-back rules are the compiled owner-only rules, NOT the model's
    // public-create fence.
    const rulesWrite = calls.find((c) => c.args.path === '/workspace/firestore.rules')!;
    expect(rulesWrite.args.content).toContain('request.auth.uid == uid');
    expect(rulesWrite.args.content).not.toContain('allow read, create: if true');
  });

  test('FALLBACK: no spec + public-create rules fails the host floor → escalation-eligible', async () => {
    // No spec fence at all, maxRepairs 0 → immediate fallback to model
    // rules. The over-permissive fence then fails the host floor exactly as
    // before SF-S3 (the degradation path is byte-for-byte the old behavior).
    const { llm } = makeLlm([threeFenceDraft(PUBLIC_CREATE_RULES)]);
    const { tools } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile });

    const vr = customData(evs, 'validation_result')[0]!;
    expect(vr.rulesSource).toBe('authored'); // no spec → model rules
    const floorFails = failuresOf(vr).filter((f) => f.source === 'floor');
    expect(floorFails.length).toBeGreaterThan(0);
    expect(floorFails[0]!.method).toBe('create');
    expect(customData(evs, 'validation_exhausted')).toHaveLength(1);
    // Event-shape compatibility with the router's escalation policy:
    expect(shouldEscalateOnExhaustion(vr.failures)).toBe(true);
  });

  test('model-authored case failure carries source authored (not escalation evidence)', async () => {
    // Model claims mallory can read alice's profile — the rules deny it.
    const badTests = {
      seed: TESTS_FILE.seed,
      cases: [
        { as: { uid: 'alice' }, do: { method: 'get', path: 'users/alice' }, expect: 'ALLOW' },
        { as: { uid: 'mallory' }, do: { method: 'get', path: 'users/alice' }, expect: 'ALLOW' },
      ],
    };
    const { llm } = makeLlm([fullDraft(OWNER_RULES, APP_TSX, badTests)]);
    const { tools } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile });

    const vr = customData(evs, 'validation_result')[0]!;
    const fails = failuresOf(vr);
    expect(fails).toHaveLength(1);
    expect(fails[0]!.source).toBe('authored');
    expect(shouldEscalateOnExhaustion(vr.failures)).toBe(false);
  });

  test('compile failure: source floor, repaired app re-validates, unchanged artifacts carry forward', async () => {
    const FIXED_APP = APP_TSX.replace('{n}', '{n + 1}');
    const { llm, seen } = makeLlm([
      fullDraft(OWNER_RULES, 'const broken = <div', TESTS_FILE),
      // Repair re-emits ONLY the app artifact.
      fence('tsx', FIXED_APP),
    ]);
    const { tools, calls } = makeTools();
    const compileCheck = async (files: Record<string, string>) => {
      const src = files['/workspace/src/App.tsx'] ?? '';
      return src.includes('export default') ? { ok: true } : { ok: false, error: 'Unexpected end of file' };
    };
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 2, compileCheck });

    // Attempt 0 failed on compile only (rules+tests green)
    const vr0 = customData(evs, 'validation_result')[0]!;
    const f0 = failuresOf(vr0);
    expect(f0).toHaveLength(1);
    expect(f0[0]!).toMatchObject({ artifact: 'app', kind: 'compile_error', source: 'floor' });
    expect((vr0.artifacts as Record<string, string>).app).toBe('compile_failed');

    // Repair fired; feedback was compact: no re-ship of the passing rules
    expect(customData(evs, 'repair_started')).toHaveLength(1);
    const feedback = seen[1]!.messages.at(-1)!.text;
    expect(feedback).toContain('App.tsx: FAILED');
    expect(feedback).toContain('rules: PASSED — do NOT re-emit');
    expect(feedback).not.toContain('rules_version'); // passing artifact text not re-shipped

    // Attempt 1 green; write-back used the carried-forward (host-compiled)
    // rules + the repaired app.
    const vr1 = customData(evs, 'validation_result')[1]!;
    expect(vr1.passed).toBe(vr1.total);
    expect(vr1.rulesSource).toBe('compiled');
    expect(calls.map((c) => c.args.path)).toContain('/workspace/firestore.rules');
    const rulesContent = calls.find((c) => c.args.path === '/workspace/firestore.rules')!.args.content!;
    expect(rulesContent).toContain('match /users/{uid} {');
    expect(rulesContent).toContain('request.auth.uid == uid');
    expect(calls.find((c) => c.args.path === '/workspace/src/App.tsx')!.args.content).toBe(FIXED_APP);
  });

  test('absent compileCheck records compile as unchecked and does not fail the attempt', async () => {
    const { llm } = makeLlm([fullDraft()]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0 }); // no compileCheck

    const vr = customData(evs, 'validation_result')[0]!;
    expect((vr.artifacts as Record<string, string>).app).toBe('unchecked');
    expect(vr.passed).toBe(vr.total);
    expect(calls).toHaveLength(4); // write-back still happens (incl. spec)
  });

  test('missing artifacts are validation failures of those artifacts, not a crash', async () => {
    const { llm } = makeLlm(['I think the rules should allow reads but here is just prose.']);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile });

    const vr = customData(evs, 'validation_result')[0]!;
    const fails = failuresOf(vr);
    expect(fails.map((f) => f.artifact).sort()).toEqual(['app', 'rules', 'tests']);
    expect(fails.every((f) => f.kind === 'missing_artifact' && f.source === 'floor')).toBe(true);
    expect(customData(evs, 'validation_exhausted')).toHaveLength(1);
    expect(calls).toHaveLength(0); // nothing parseable → nothing written
    expect(evs.some((e) => e.kind === 'turn_complete')).toBe(true);
  });

  test('only the missing artifact fails when two of three are present', async () => {
    const { llm } = makeLlm([
      [fence('firestore', OWNER_RULES), fence('json', JSON.stringify(TESTS_FILE))].join('\n'),
    ]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile });

    const vr = customData(evs, 'validation_result')[0]!;
    const fails = failuresOf(vr);
    expect(fails).toHaveLength(1);
    expect(fails[0]!).toMatchObject({ artifact: 'app', kind: 'missing_artifact', source: 'floor' });
    // rules + tests still validated green and written back
    expect((vr.artifacts as Record<string, string>).rules).toBe('ok');
    expect(calls.map((c) => c.args.path)).toEqual([
      '/workspace/firestore.rules',
      '/workspace/tests/draft.test.json',
    ]);
  });

  test('FALLBACK: got:ERROR (update on unseeded doc) is attributed to the tests artifact with the teaching note', async () => {
    // FALLBACK path (no spec → model rules): rules ALLOW the owner update,
    // but the doc was never seeded, so the op fails as not-found, not
    // permission-denied — the TEST is wrong. (With a spec the host would
    // compile rules instead; this pins the model-rules attribution.)
    const updateRules = OWNER_RULES.replace('allow create:', 'allow create, update:');
    const errTests = {
      cases: [{ as: { uid: 'alice' }, do: { method: 'update', path: 'users/alice', data: { x: 1 } }, expect: 'ALLOW' }],
    };
    const { llm, seen } = makeLlm([threeFenceDraft(updateRules, APP_TSX, errTests), threeFenceDraft(updateRules, APP_TSX, errTests)]);
    const { tools } = makeTools();
    await drain(makeInput(llm, tools), { maxRepairs: 1, compileCheck: okCompile });

    const feedback = seen[1]!.messages.at(-1)!.text;
    expect(feedback).toContain('tests: FAILED');
    expect(feedback).toContain('got: ERROR');
    expect(feedback).toContain('fix the tests artifact, not the rules');
  });

  test('FALLBACK: garbage rules are attributed to the rules artifact as floor evidence', async () => {
    // FALLBACK path (no spec → model rules): pyric's setRules is lenient
    // (no throw on garbage — probed): reads behave deny-all (caught by the
    // model's ALLOW cases) and writes surface "Failed to parse rules source"
    // as an op-time ERROR — attributed to the RULES (deploy_error, source
    // floor), not the tests artifact.
    const { llm } = makeLlm([threeFenceDraft('rules_version = ; } syntax garbage {', APP_TSX, TESTS_FILE)]);
    const { tools } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile });

    const vr = customData(evs, 'validation_result')[0]!;
    const fails = failuresOf(vr);
    expect(fails.length).toBeGreaterThan(0);
    expect(fails.every((f) => f.artifact === 'rules')).toBe(true);
    const deploy = fails.find((f) => f.kind === 'deploy_error');
    expect(deploy?.source).toBe('floor');
    expect((vr.artifacts as Record<string, string>).rules).toBe('failed');
    expect(shouldEscalateOnExhaustion(vr.failures)).toBe(true);
  });

  test('SF-S3 repair loop: unfilled custom hole attempt 0, filled attempt 1, green', async () => {
    // A spec with a `custom` condition and NO rulesExpr → an unfilled-hole
    // failure on attempt 0; the repair fills the rulesExpr → the host
    // re-compiles with the hole spliced and the attempt goes green.
    const holeSpec = {
      meta: { title: 'Hole app', assumptions: [] },
      identities: [{ uid: 'alice' }],
      collections: [{ path: 'notes/{id}', fields: [{ name: 'text', type: 'string', required: true }] }],
      access: [
        { collection: 'notes/{id}', op: 'get', grant: [{ kind: 'authenticated' }] },
        {
          collection: 'notes/{id}',
          op: 'create',
          grant: [
            { kind: 'authenticated' },
            { kind: 'custom', rulesExpr: '', rationale: 'text under 500 chars' },
          ],
        },
      ],
    };
    const filledSpec = {
      ...holeSpec,
      access: [
        holeSpec.access[0],
        {
          collection: 'notes/{id}',
          op: 'create',
          grant: [
            { kind: 'authenticated' },
            { kind: 'custom', rulesExpr: 'request.resource.data.text.size() < 500', rationale: 'text under 500 chars' },
          ],
        },
      ],
    };
    const holeTests = { cases: [{ as: { uid: 'alice' }, do: { method: 'get', path: 'notes/n1' }, expect: 'ALLOW' }], seed: [{ path: 'notes/n1', data: { text: 'hi' } }] };
    const { llm, seen } = makeLlm([
      fullDraft(OWNER_RULES, APP_TSX, holeTests, holeSpec),
      fence('json app-spec', JSON.stringify(filledSpec)), // repair fills the hole
    ]);
    const { tools, calls } = makeTools();
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 2, compileCheck: okCompile });

    // attempt 0: an unfilled-hole failure surfaced.
    const vr0 = customData(evs, 'validation_result')[0]!;
    expect(vr0.rulesSource).toBe('compiled');
    expect(vr0.holes).toBe(1);
    expect(vr0.holesUnfilled).toBe(1);
    const hole0 = failuresOf(vr0).find((f) => f.kind === 'unfilled_hole');
    expect(hole0).toBeTruthy();
    expect(hole0!.detail).toContain('text under 500 chars');
    // repair feedback explains the hole + points at the app-spec fence.
    expect(customData(evs, 'repair_started')).toHaveLength(1);
    expect(seen[1]!.messages.at(-1)!.text).toContain('custom');

    // attempt 1: hole filled → green; the compiled rules carry the expr.
    const last = customData(evs, 'validation_result').at(-1)!;
    expect(last.holesUnfilled).toBe(0);
    expect(last.passed).toBe(last.total);
    const rulesWrite = calls.find((c) => c.args.path === '/workspace/firestore.rules')!;
    expect(rulesWrite.args.content).toContain('request.resource.data.text.size() < 500');
  });

  test('writeBack:false dispatches nothing', async () => {
    const { llm } = makeLlm([fullDraft()]);
    const { tools, calls } = makeTools();
    await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile, writeBack: false });
    expect(calls).toHaveLength(0);
  });

  test('write-back failure surfaces as ok:false tool_result, turn still completes', async () => {
    const { llm } = makeLlm([fullDraft()]);
    const tools = {
      async execute(call: { name: string; args: { path?: string } }) {
        if (call.args.path === '/workspace/src/App.tsx') throw new Error('disk on fire');
        return { ok: true, summary: 'wrote' };
      },
    };
    const evs = await drain(makeInput(llm, tools), { maxRepairs: 0, compileCheck: okCompile });
    const results = evs.filter(
      (e): e is Extract<StrategyEvent, { kind: 'tool_result' }> => e.kind === 'tool_result',
    );
    const wb = results.find((r) => r.id.endsWith('#writeback-app'));
    expect(wb?.result.ok).toBe(false);
    expect(wb?.result.summary).toContain('disk on fire');
    expect(evs.some((e) => e.kind === 'turn_complete')).toBe(true);
  });
});

// ── repair feedback shape ──────────────────────────────────────────────

describe('formatRepairFeedback', () => {
  test('compact: per-artifact status + evidence rows, no passing-artifact text', () => {
    const v: DraftValidation = {
      attempt: 0,
      total: 5,
      passed: 3,
      artifacts: { spec: 'ok', rules: 'failed', app: 'ok', tests: 'ok' },
      rulesSource: 'authored',
      holes: 0,
      holesUnfilled: 0,
      failures: [
        { artifact: 'rules', kind: 'case', method: 'create', path: 'users/u9', as: null, expect: 'DENY', got: 'ALLOW', source: 'floor', name: 'floor: unauthenticated create on users/u9 must be denied' },
        { artifact: 'rules', kind: 'case', method: 'get', path: 'users/alice', as: { uid: 'alice' }, expect: 'ALLOW', got: 'DENY', source: 'authored' },
      ],
    };
    const fb = formatRepairFeedback(v);
    expect(fb).toContain('rules: FAILED');
    expect(fb).toContain('App.tsx: PASSED — do NOT re-emit');
    expect(fb).toContain('tests: PASSED — do NOT re-emit');
    expect(fb).toContain('[floor] create users/u9 unauthenticated: expected DENY, got ALLOW');
    expect(fb).toContain('[authored] get users/alice as alice: expected ALLOW, got DENY');
    expect(fb).toContain('Re-emit ONLY the artifacts that must change');
  });
});

// ── SF-S1 de-cage: bounded tool escape hatch ───────────────────────────

/** ToolHandlers for the bounded set (parameters minimal — the test only
 *  needs name/description lowered into declarations). */
function makeDraftToolList(names: readonly string[] = BOUNDED_DRAFT_TOOLS) {
  return names.map((name) => ({
    name,
    description: `${name} (test handler)`,
    parameters: { type: 'object' as const, properties: {} },
    execute: async () => ({ ok: true, summary: `${name} ran` }),
  }));
}

/** An LLM that, on each chat call, emits a SCRIPT step: either tool calls
 *  (an array of {name,args}) or final draft text (a string). Records every
 *  request's offered tool count + toolUseEnabled. */
function makeToolingLlm(steps: Array<string | Array<{ name: string; args?: unknown }>>) {
  const seen: ReqSeen[] = [];
  let i = 0;
  const llm = {
    id: 'stub-tool-llm',
    supportsTools: true,
    async *chat(req: { messages: { role: string; text: string }[]; tools: unknown[]; toolUseEnabled: boolean }) {
      seen.push({
        toolCount: req.tools.length,
        toolUseEnabled: req.toolUseEnabled,
        messages: req.messages.map((m) => ({ role: m.role, text: m.text })),
        raw: req.messages.map((m) => ({ ...(m as Record<string, unknown>) })),
      });
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      if (Array.isArray(step)) {
        for (let k = 0; k < step.length; k++) {
          yield { kind: 'tool_call', id: `tc-${i}-${k}`, name: step[k]!.name, args: step[k]!.args ?? {} };
        }
        yield { kind: 'usage', usage: { promptTokens: 5, outputTokens: 7 } };
        return;
      }
      yield { kind: 'text', text: step ?? '' };
      yield { kind: 'usage', usage: { promptTokens: 5, outputTokens: 7 } };
    },
  };
  return { llm, seen };
}

/** Dispatch mock recording every dispatched call by name. `fail` makes
 *  `execute` throw — the degradation path. */
function makeCountingDispatch(opts: { fail?: boolean } = {}) {
  const dispatched: string[] = [];
  const tools = {
    async execute(call: { name: string; args: unknown }) {
      dispatched.push(call.name);
      if (opts.fail) throw new Error(`boom on ${call.name}`);
      return { ok: true, summary: `${call.name} ok` };
    },
  };
  return { tools, dispatched };
}

describe('selectDraftToolDeclarations', () => {
  test('intersects host toolList with the bounded set, in bounded-set order', () => {
    const host = [
      { name: 'write_file', description: 'w', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'read_file', description: 'r', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'search_file', description: 'search', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'seed_firestore_data_as_admin', description: 's', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'simulate_firestore_write', description: 'sim', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'sandbox_discover_paths', description: 'd', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'list_files', description: 'l', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
      { name: 'firestore_get_rules', description: 'x', parameters: {}, execute: async () => ({ ok: true, summary: '' }) },
    ];
    const decls = selectDraftToolDeclarations(host as never);
    expect(decls.map((d) => d.name)).toEqual([...BOUNDED_DRAFT_TOOLS]);
    expect(decls.some((d) => d.name === 'write_file')).toBe(false);
  });

  test('a host that registers none of the bounded tools yields []', () => {
    const host = [{ name: 'write_file', description: 'w', parameters: {}, execute: async () => ({ ok: true, summary: '' }) }];
    expect(selectDraftToolDeclarations(host as never)).toEqual([]);
  });
});

describe('SF leash — the hatch is a REPAIR-only recovery mechanism', () => {
  test('the INITIAL draft is ALWAYS tool-free — no hatch on attempt 0', async () => {
    // The leash: a weak model cannot use list_files/read_file as a
    // first-reach default. Even with the full bounded set registered and
    // budget available, attempt 0 offers ZERO tools.
    const { llm, seen } = makeToolingLlm([fullDraft()]);
    const { tools } = makeCountingDispatch();
    await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 2, compileCheck: okCompile },
    );
    expect(seen[0]!.toolUseEnabled).toBe(false);
    expect(seen[0]!.toolCount).toBe(0);
  });

  test('a REPAIR attempt offers the bounded tools with toolUseEnabled true', async () => {
    // First draft fails the host floor (public create) → a repair fires,
    // and ONLY then are the bounded tools on offer.
    const { llm, seen } = makeToolingLlm([failingDraft(), fullDraft()]);
    const { tools } = makeCountingDispatch();
    await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 1, compileCheck: okCompile, writeBack: false },
    );
    // attempt 0 (initial): tool-free; attempt 1 (repair): tools offered.
    expect(seen[0]!.toolUseEnabled).toBe(false);
    expect(seen[0]!.toolCount).toBe(0);
    expect(seen[1]!.toolUseEnabled).toBe(true);
    expect(seen[1]!.toolCount).toBe(BOUNDED_DRAFT_TOOLS.length);
  });

  test('no tools registered -> repair draft still runs tool-free (degradation floor)', async () => {
    const { llm, seen } = makeToolingLlm([failingDraft(), fullDraft()]);
    const { tools } = makeCountingDispatch();
    await drain(makeInput(llm, tools, { toolList: [] }), { maxRepairs: 1, compileCheck: okCompile, writeBack: false });
    expect(seen[1]!.toolUseEnabled).toBe(false);
    expect(seen[1]!.toolCount).toBe(0);
  });

  test('draftToolBudget: 0 disables the hatch even on a repair', async () => {
    const { llm, seen } = makeToolingLlm([failingDraft(), fullDraft()]);
    const { tools } = makeCountingDispatch();
    await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 1, compileCheck: okCompile, draftToolBudget: 0, writeBack: false },
    );
    expect(seen[1]!.toolUseEnabled).toBe(false);
    expect(seen[1]!.toolCount).toBe(0);
  });
});

describe('SF-S1 de-cage — tool-call budget enforcement (on the repair hatch)', () => {
  test('a repair that calls a tool then composes dispatches it and produces a valid draft', async () => {
    // attempt 0: a failing draft (public create → floor violation). The
    // repair (attempt 1) reaches for the hatch, then composes a valid draft.
    const { llm } = makeToolingLlm([
      failingDraft(),
      [{ name: 'seed_firestore_data_as_admin', args: { collection: 'menuItems' } }],
      fullDraft(),
    ]);
    const { tools, dispatched } = makeCountingDispatch();
    const evs = await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 2, compileCheck: okCompile, writeBack: false },
    );
    expect(dispatched).toEqual(['seed_firestore_data_as_admin']);
    // The final validation_result (the repaired, valid draft) is green.
    const vrs = customData(evs, 'validation_result');
    expect(failuresOf(vrs[vrs.length - 1]!)).toHaveLength(0);
    expect(evs.some((e) => e.kind === 'tool_call' && e.name === 'seed_firestore_data_as_admin')).toBe(true);
    expect(evs.some((e) => e.kind === 'tool_result')).toBe(true);
  });

  test('budget caps dispatched calls at N even if the repair model keeps asking', async () => {
    const ask = [{ name: 'simulate_firestore_write', args: {} }];
    // attempt 0: failing draft; then every repair just keeps asking for tools.
    const { llm } = makeToolingLlm([failingDraft(), ...Array(10).fill(ask)]);
    const { tools, dispatched } = makeCountingDispatch();
    await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 2, compileCheck: okCompile, draftToolBudget: 3, writeBack: false },
    );
    expect(dispatched.length).toBe(3);
  });

  test('default budget is DEFAULT_DRAFT_TOOL_BUDGET (5)', async () => {
    const ask = [{ name: 'simulate_firestore_write', args: {} }];
    const { llm } = makeToolingLlm([failingDraft(), ...Array(20).fill(ask)]);
    const { tools, dispatched } = makeCountingDispatch();
    await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 8, compileCheck: okCompile, writeBack: false },
    );
    expect(dispatched.length).toBe(DEFAULT_DRAFT_TOOL_BUDGET);
    expect(DEFAULT_DRAFT_TOOL_BUDGET).toBe(5);
  });

  test('budget is shared across repair attempts (repairs cannot reset the cap)', async () => {
    const badDraft = failingDraft();
    const ask2 = [{ name: 'simulate_firestore_write', args: {} }, { name: 'read_file', args: {} }];
    const askMany = [{ name: 'read_file', args: {} }, { name: 'list_files', args: {} }, { name: 'read_file', args: {} }];
    // attempt 0: failing draft (tool-free). repair 1: 2 tool calls + bad
    // draft. repair 2: 3 more asks — budget(3) is shared, so total ≤ 3.
    const { llm } = makeToolingLlm([badDraft, [...ask2], badDraft, askMany, fullDraft()]);
    const { tools, dispatched } = makeCountingDispatch();
    await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 3, compileCheck: okCompile, draftToolBudget: 3, writeBack: false },
    );
    expect(dispatched.length).toBe(3);
  });
});

describe('SF-S1 de-cage — degradation contract', () => {
  test('a tool dispatch error on the repair hatch never aborts the draft; a valid draft still lands', async () => {
    // attempt 0: failing draft; repair reaches for the hatch (dispatch
    // throws → ok:false tool_result), then composes a valid draft.
    const { llm } = makeToolingLlm([
      failingDraft(),
      [{ name: 'seed_firestore_data_as_admin', args: {} }],
      fullDraft(),
    ]);
    const { tools } = makeCountingDispatch({ fail: true });
    const evs = await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 2, compileCheck: okCompile, writeBack: false },
    );
    expect(evs.some((e) => e.kind === 'error')).toBe(false);
    const vrs = customData(evs, 'validation_result');
    expect(failuresOf(vrs[vrs.length - 1]!)).toHaveLength(0);
    const tr = evs.find((e) => e.kind === 'tool_result');
    expect(tr && tr.kind === 'tool_result' && tr.result.ok).toBe(false);
  });

  test('write_file is never in the draft tool set (strategy owns write-back)', () => {
    expect(BOUNDED_DRAFT_TOOLS).not.toContain('write_file');
  });
});

// ── SF fix: OpenAI-strict tool-message threading ───────────────────────
//
// The k2.7-code provider-400 root cause: a hatch dispatch was threaded as
// PROSE — `{role:'assistant', text:'(calling X)'}` + `{role:'tool',
// text:'...'}` with no callId — so the transports emitted a `role:'tool'`
// message with `tool_call_id:''` and an assistant message with NO
// `tool_calls`. OpenAI-strict providers reject both. The fix threads the
// package's `ModelMessage` shape verbatim; these tests pin it AND its
// lowering through the LIVE transport's `toOaiMessages`.
describe('SF fix — hatch dispatch threads an OpenAI-strict message sequence', () => {
  test('the assistant turn carries tool_calls; the tool message carries the SAME id; no empty tool_call_id', async () => {
    // attempt 0 fails (floor); the repair (attempt 1) dispatches one hatch
    // tool, so the NEXT chat request (attempt 2) sees the threaded pair.
    const { llm, seen } = makeToolingLlm([
      failingDraft(),
      [{ name: 'seed_firestore_data_as_admin', args: { collection: 'menuItems' } }],
      fullDraft(),
    ]);
    const { tools } = makeCountingDispatch();
    await drain(
      makeInput(llm, tools, { toolList: makeDraftToolList() as never }),
      { maxRepairs: 2, compileCheck: okCompile, writeBack: false },
    );
    // The request AFTER the dispatch (attempt 2) carries the threaded pair.
    const post = seen[seen.length - 1]!.raw;
    const asstWithCalls = post.find(
      (m) => m.role === 'assistant' && Array.isArray(m.toolCalls) && (m.toolCalls as unknown[]).length > 0,
    );
    expect(asstWithCalls).toBeDefined();
    const tc = (asstWithCalls!.toolCalls as Array<{ id: string; name: string }>)[0]!;
    expect(tc.name).toBe('seed_firestore_data_as_admin');
    expect(typeof tc.id).toBe('string');
    expect(tc.id.length).toBeGreaterThan(0);
    const toolMsg = post.find((m) => m.role === 'tool' && m.toolCallId === tc.id);
    expect(toolMsg).toBeDefined();
    // No prose-threaded "(calling …)" assistant or empty-id tool message.
    expect(post.some((m) => m.role === 'tool' && (m.toolCallId === '' || m.toolCallId == null))).toBe(false);
    expect(post.some((m) => typeof m.text === 'string' && (m.text as string).startsWith('(calling '))).toBe(false);

    // …and the LIVE transport lowers the pair to a strict OAI sequence:
    // every `role:'tool'` carries a non-empty tool_call_id that matches a
    // preceding assistant `tool_calls[].id`.
    const oai = toOaiMessages(post as never);
    const assistantIds = new Set<string>();
    for (const m of oai) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const c of m.tool_calls) assistantIds.add(c.id);
      }
      if (m.role === 'tool') {
        expect(m.tool_call_id).toBeTruthy();
        expect(assistantIds.has(m.tool_call_id!)).toBe(true);
      }
    }
  });
});
