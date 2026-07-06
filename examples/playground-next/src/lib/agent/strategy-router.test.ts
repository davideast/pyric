/**
 * C2 router tests — routing table, override precedence, and bounded
 * escalation with evidence carry-over.
 */
import { describe, test, expect } from 'bun:test';
import type { AgentStrategy, StrategyEvent, StrategyRunInput } from '@inbrowser/agent';
import {
  createRoutedStrategy,
  routePrompt,
  provenanceFromRouted,
  provenanceFromEscalated,
} from './strategy-router';

// ─── routePrompt — the routing table ─────────────────────────────────

const FIXTURE_PROMPTS = [
  "Build a blog where anyone can read posts at /posts/{postId}, any signed-in user can create a post, and only the author (resource.data.authorId equals the caller's uid) can update or delete it. Use Google sign-in. Write the Firestore rules and a minimal App.tsx.",
  'Build a config admin panel where any signed-in user can read /config/{configId}, but only a user whose auth token has a custom claim admin == true can create, update, or delete it. Use email/password sign-in. Write the Firestore rules and a minimal App.tsx.',
  "Build a docs app where the owner (resource.data.ownerId equals the caller's uid) can update /docs/{docId}, but the update must not change the ownerId field (request.resource.data.ownerId must equal resource.data.ownerId). Non-owners are denied. Use email/password sign-in. Write the Firestore rules and a minimal App.tsx.",
  "Build a notes app where a signed-in user creates notes at /notes/{noteId} that must include a string 'title' and an 'ownerId' equal to their uid; only the owner can read a note. Use email/password sign-in. Write the Firestore rules and a minimal App.tsx.",
  'Build a profile app where any visitor (even signed-out) can read a profile at /users/{uid}, but only the owner whose uid matches can create or update their own profile. Use anonymous sign-in. Write the Firestore rules and a minimal App.tsx.',
  "Build a tasks app where a signed-in user can read, create, update, and delete only their own tasks. Store each task at /tasks/{taskId} with an ownerId field equal to the creator's uid. Use email/password sign-in. Write the Firestore rules and a minimal App.tsx.",
];

describe('routePrompt', () => {
  test('all six app-build fixture prompts route to draft-validate', () => {
    for (const p of FIXTURE_PROMPTS) {
      const d = routePrompt(p);
      expect(d.strategy).toBe('draft-validate');
      expect(d.source).toBe('heuristic');
    }
  });

  test('interrogative openers route to react even when build verbs appear later', () => {
    for (const p of [
      'Why is my write being denied?',
      'What does this rule do?',
      'How do I make a query with orderBy?',
      'Explain why this rule denies alice',
      'Is my data secure?',
    ]) {
      expect(routePrompt(p).strategy).toBe('react');
    }
  });

  test('polite build requests are not mistaken for questions', () => {
    const d = routePrompt(
      'Can you build me a tasks app where users can only read their own tasks?',
    );
    expect(d.strategy).toBe('draft-validate');
  });

  test('inline debug phrasing without a work verb routes to react', () => {
    expect(routePrompt('something is off, investigate the denied request').strategy).toBe(
      'react',
    );
  });

  test('pure-UI build work routes to react (draft-validate is rules-shaped)', () => {
    expect(routePrompt('Make the buttons blue and add a dark-mode toggle').strategy).toBe(
      'react',
    );
  });

  test('no detectable intent defaults to react', () => {
    expect(routePrompt('hello there').strategy).toBe('react');
  });

  test('rules-modification work routes to draft-validate', () => {
    expect(
      routePrompt('Lock down the comments collection so only the post owner can delete').strategy,
    ).toBe('draft-validate');
  });
});

// ─── createRoutedStrategy — delegation, override, escalation ─────────

function stubStrategy(id: string, events: StrategyEvent[]): AgentStrategy & { calls: StrategyRunInput[] } {
  const calls: StrategyRunInput[] = [];
  return {
    id,
    calls,
    async *run(input) {
      calls.push(input);
      for (const ev of events) yield ev;
    },
  } as AgentStrategy & { calls: StrategyRunInput[] };
}

function makeInput(prompt: string): StrategyRunInput {
  return {
    prompt,
    history: [],
    systemPrompt: 'base',
    turnId: 't1',
  } as unknown as StrategyRunInput;
}

async function collect(s: AgentStrategy, input: StrategyRunInput): Promise<StrategyEvent[]> {
  const out: StrategyEvent[] = [];
  for await (const ev of s.run(input, new AbortController().signal)) out.push(ev);
  return out;
}

const DV_PROMPT = FIXTURE_PROMPTS[5]!; // tasks-per-user → draft-validate

describe('createRoutedStrategy', () => {
  test('routes build+data prompts to draft-validate and emits strategy_routed', async () => {
    const react = stubStrategy('react', [{ kind: 'text', chunk: 'r' }]);
    const dv = stubStrategy('dv', [{ kind: 'text', chunk: 'd' }]);
    const routed = createRoutedStrategy({ makeReact: () => react, makeDraftValidate: () => dv });
    const events = await collect(routed, makeInput(DV_PROMPT));
    const routedEv = events.find((e) => e.kind === 'custom' && e.name === 'strategy_routed');
    expect(routedEv && 'data' in routedEv ? (routedEv.data as { strategy: string }).strategy : null).toBe('draft-validate');
    expect(dv.calls.length).toBe(1);
    expect(react.calls.length).toBe(0);
  });

  test('explicit override ALWAYS wins over the heuristic', async () => {
    const react = stubStrategy('react', [{ kind: 'text', chunk: 'r' }]);
    const dv = stubStrategy('dv', [{ kind: 'text', chunk: 'd' }]);
    const routed = createRoutedStrategy({
      makeReact: () => react,
      makeDraftValidate: () => dv,
      override: 'react',
    });
    const events = await collect(routed, makeInput(DV_PROMPT)); // heuristic says dv
    const routedEv = events.find((e) => e.kind === 'custom' && e.name === 'strategy_routed');
    expect(routedEv && 'data' in routedEv ? (routedEv.data as { source: string }).source : null).toBe('override');
    expect(react.calls.length).toBe(1);
    expect(dv.calls.length).toBe(0);
  });

  test("override 'auto' defers to the heuristic", async () => {
    const react = stubStrategy('react', []);
    const dv = stubStrategy('dv', []);
    const routed = createRoutedStrategy({
      makeReact: () => react,
      makeDraftValidate: () => dv,
      override: 'auto',
    });
    await collect(routed, makeInput('Why is my write denied?'));
    expect(react.calls.length).toBe(1);
  });

  test('clean draft-validate run does NOT escalate', async () => {
    const react = stubStrategy('react', []);
    const dv = stubStrategy('dv', [
      { kind: 'custom', name: 'validation_result', data: { passed: 3, total: 3, failures: [] } },
    ]);
    const routed = createRoutedStrategy({ makeReact: () => react, makeDraftValidate: () => dv });
    const events = await collect(routed, makeInput(DV_PROMPT));
    expect(events.some((e) => e.kind === 'custom' && e.name === 'strategy_escalated')).toBe(false);
    expect(react.calls.length).toBe(0);
  });

  test('model-only case failures do NOT escalate (a model case is as suspect as the ruleset)', async () => {
    const failures = [{ method: 'get', path: 'tasks/t1', expect: 'ALLOW', got: 'DENY', source: 'model' }];
    const dv = stubStrategy('dv', [
      { kind: 'custom', name: 'validation_result', data: { passed: 0, total: 1, failures } },
      { kind: 'custom', name: 'validation_exhausted', data: { attempt: 2, remaining: 1 } },
    ]);
    const react = stubStrategy('react', []);
    const routed = createRoutedStrategy({ makeReact: () => react, makeDraftValidate: () => dv });
    const events = await collect(routed, makeInput(DV_PROMPT));
    expect(events.some((e) => e.kind === 'custom' && e.name === 'strategy_escalated')).toBe(false);
    expect(react.calls.length).toBe(0);
  });

  test('forced draft-validate override never escalates (override means "use this strategy")', async () => {
    const dv = stubStrategy('dv', [
      { kind: 'custom', name: 'validation_exhausted', data: { attempt: 2, remaining: 1 } },
    ]);
    const react = stubStrategy('react', []);
    const routed = createRoutedStrategy({
      makeReact: () => react,
      makeDraftValidate: () => dv,
      override: 'draft-validate',
    });
    const events = await collect(routed, makeInput('hello'));
    expect(events.some((e) => e.kind === 'custom' && e.name === 'strategy_escalated')).toBe(false);
    expect(react.calls.length).toBe(0);
  });

  test('exhausted draft-validate escalates ONCE to react with draft + failures as context', async () => {
    // A host-authored floor case failed — trustworthy evidence, escalate.
    const failures = [{ method: 'get', path: 'tasks/t1', expect: 'ALLOW', got: 'DENY', source: 'floor' }];
    const draft = [
      'Here are the rules:',
      '```firestore',
      "rules_version = '2';",
      'service cloud.firestore { match /databases/{db}/documents { match /tasks/{id} { allow read: if false; } } }',
      '```',
    ].join('\n');
    const dv = stubStrategy('dv', [
      { kind: 'text', chunk: draft },
      { kind: 'custom', name: 'validation_result', data: { passed: 0, total: 1, failures } },
      { kind: 'custom', name: 'validation_exhausted', data: { attempt: 2, remaining: 1 } },
    ]);
    const react = stubStrategy('react', [{ kind: 'text', chunk: 'fixed' }]);
    const routed = createRoutedStrategy({ makeReact: () => react, makeDraftValidate: () => dv });
    const events = await collect(routed, makeInput(DV_PROMPT));

    // escalation milestone fired exactly once, with the failure evidence
    const esc = events.filter((e) => e.kind === 'custom' && e.name === 'strategy_escalated');
    expect(esc.length).toBe(1);

    // react re-ran the SAME prompt with the evidence appended to history
    expect(react.calls.length).toBe(1);
    const call = react.calls[0]!;
    expect(call.prompt).toBe(DV_PROMPT);
    const last = call.history[call.history.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.text).toContain('rules_version');
    expect(last.text).toContain('tasks/t1');
    expect(last.text).toContain('out of repairs');

    // dv ran once — escalation is bounded to one per user prompt
    expect(dv.calls.length).toBe(1);
  });
});

// ─── SF-S0a provenance mapping (source resolution) ───────────────────

describe('provenanceFromRouted — source resolution', () => {
  test("override → 'user-selected' (settings reason dropped — no diagnostic signal)", () => {
    const p = provenanceFromRouted({
      strategy: 'react',
      source: 'override',
      reason: 'settings strategyMode',
    });
    expect(p).toEqual({ strategy: 'react', strategySource: 'user-selected' });
    expect(p?.reason).toBeUndefined();
  });

  test("heuristic → 'routed' carrying the classifier reason", () => {
    const p = provenanceFromRouted({
      strategy: 'draft-validate',
      source: 'heuristic',
      reason: 'build-intent "build" + data/security signal "only their own"',
    });
    expect(p).toEqual({
      strategy: 'draft-validate',
      strategySource: 'routed',
      reason: 'build-intent "build" + data/security signal "only their own"',
    });
  });

  test('heuristic with no reason still resolves (reason omitted)', () => {
    const p = provenanceFromRouted({ strategy: 'react', source: 'heuristic' });
    expect(p).toEqual({ strategy: 'react', strategySource: 'routed' });
  });

  test('malformed payloads return null (missing strategy / unknown source)', () => {
    expect(provenanceFromRouted({ source: 'override' })).toBeNull();
    expect(provenanceFromRouted({ strategy: 'react', source: 'mystery' })).toBeNull();
    expect(provenanceFromRouted({})).toBeNull();
  });
});

describe('provenanceFromEscalated — source resolution', () => {
  test("escalation → 'escalated', strategy is the react target, reason summarizes evidence", () => {
    const p = provenanceFromEscalated({
      from: 'draft-validate',
      to: 'react',
      failures: [
        { method: 'create', path: 'tasks/t1', expect: 'DENY', got: 'ALLOW', source: 'floor' },
      ],
    });
    expect(p.strategy).toBe('react');
    expect(p.strategySource).toBe('escalated');
    expect(p.reason).toContain('draft-validate→react');
    expect(p.reason).toContain('1 floor-case');
  });

  test('defaults from/to when absent (react target, draft-validate origin)', () => {
    const p = provenanceFromEscalated({ failures: [] });
    expect(p.strategy).toBe('react');
    expect(p.strategySource).toBe('escalated');
    expect(p.reason).toContain('draft-validate→react');
    expect(p.reason).toContain('0 floor-case');
  });
});

// ─── SF-S0a end-to-end: the three sources off the live event stream ──

describe('provenance off the routed-strategy event stream', () => {
  test("user override emits a routed event resolving to 'user-selected'", () => {
    const data = { strategy: 'react', source: 'override', reason: 'settings strategyMode' };
    expect(provenanceFromRouted(data)?.strategySource).toBe('user-selected');
  });

  test("auto-mode heuristic resolves to 'routed'", () => {
    // What the router yields for a DV-eligible prompt under auto.
    const d = routePrompt(DV_PROMPT);
    expect(provenanceFromRouted({ ...d })?.strategySource).toBe('routed');
  });

  test("escalation milestone resolves to 'escalated'", () => {
    const data = { from: 'draft-validate', to: 'react', failures: [{ source: 'floor' }] };
    expect(provenanceFromEscalated(data).strategySource).toBe('escalated');
  });
});
