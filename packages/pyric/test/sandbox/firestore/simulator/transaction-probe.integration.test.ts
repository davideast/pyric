/**
 * Item 4.6 — Forward-deployed probe (automated harness).
 *
 * Calls a real model through OpenRouter with the
 * `firestore_simulator_transaction` tool exposed and forces tool use,
 * then statically analyses the proposed `{ $expr }` leaves against the
 * grammar without executing them. Repeats per model × prompt to surface
 * model nondeterminism.
 *
 * Gating:
 *   - `RUN_PROBE=1` must be set (otherwise the suite is skipped).
 *   - `OPENROUTER_API_KEY` must be set.
 *   - Optional: `PROBE_MODELS=anthropic/claude-sonnet-4-5,openai/gpt-5`
 *     (comma-separated). Defaults below.
 *   - Optional: `PROBE_RUNS=3`.
 *
 * Output:
 *   - Writes a markdown report to
 *     `packages/sdk/tmp/transaction-probe-report.md` so findings can
 *     be folded into the implementation plan's Decisions Log.
 *   - The single test asserts only that every (model × prompt × run)
 *     cell produced a result — the report content is the actual
 *     deliverable.
 *
 * NOT a part of CI: lives behind `RUN_PROBE` because it costs API
 * calls and is nondeterministic by design.
 */
import { describe, test, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize } from 'pyric/rules/internal';
import { parse } from 'pyric/rules/internal';
import {
  ExpressionLexError,
  ExpressionParseError,
} from 'pyric/rules/internal';

// ─── Gating ──────────────────────────────────────────────────────────────

const RUN = process.env.RUN_PROBE === '1';
const KEY = process.env.OPENROUTER_API_KEY;

const MODELS = (process.env.PROBE_MODELS ?? [
  'anthropic/claude-sonnet-4-5',
  'openai/gpt-5',
  'google/gemini-2.5-pro',
].join(',')).split(',').map((m) => m.trim()).filter(Boolean);

const N_RUNS = Number(process.env.PROBE_RUNS ?? 3);
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY ?? 4);

// ─── Tool schema (OpenAI-compatible) ─────────────────────────────────────
//
// Hand-authored to mirror the zod schema in `agent.ts`, with explicit
// `$expr` documentation on the `data` field. We don't auto-derive from
// zod because the auto-derived schema loses the `$expr` semantics in
// `z.record(z.unknown())`.

const TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'firestore_simulator_transaction',
    description: [
      'Run a declarative Firestore transaction. Reads are captured server-side and referenced',
      'from write data via { "$expr": "<expression>" } wrappers. The agent never sees the read',
      'values directly.',
      '',
      'Expression DSL:',
      '  - Arithmetic: + - * / %',
      '  - Comparison: == != < <= > >=',
      '  - Logical: && || !',
      '  - Ternary: cond ? whenTrue : whenFalse',
      '  - Field access: $alias.field, $alias.nested.field',
      '  - Index access: $alias.array[0]',
      '  - Sentinels: @serverTimestamp(), @increment(n), @arrayUnion(...vals),',
      '    @arrayRemove(...vals), @deleteField()',
      '  - References: $alias (declared in `reads`)',
      '',
      'Each leaf in `data` is either a plain JSON literal or { "$expr": "..." }.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['environmentId', 'auth', 'reads', 'writes'],
      properties: {
        environmentId: { type: 'string' },
        auth: {
          oneOf: [
            { type: 'object', required: ['uid'], properties: { uid: { type: 'string' } } },
            { type: 'null' },
          ],
        },
        reads: {
          type: 'object',
          description: 'Aliases → document paths. Reference as $alias in writes.',
          additionalProperties: { type: 'string' },
        },
        writes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['method', 'path'],
            properties: {
              method: { type: 'string', enum: ['create', 'update', 'set', 'delete'] },
              path: { type: 'string' },
              data: {
                type: 'object',
                description: 'Document data. Required for create/update/set; forbidden for delete. Each leaf is a JSON literal or { "$expr": "..." }.',
                additionalProperties: true,
              },
            },
          },
        },
        readOnly: { type: 'boolean' },
        includeReads: { type: 'boolean' },
      },
    },
  },
} as const;

// ─── Prompt fixtures ─────────────────────────────────────────────────────

interface Prompt {
  id: string;
  fixture: 'counter' | 'state-machine' | 'cross-doc' | 'gap-probe';
  system: string;
  user: string;
}

const PROMPTS: Prompt[] = [
  // Counter fixture
  {
    id: 'C1', fixture: 'counter',
    system: 'Environment id "env-1". Doc counters/c1 = { count: 5 }. Auth: { uid: "alice" }. Rule: count must rise monotonically and delta ≤ 100.',
    user: 'Increment the counter at counters/c1 by 1, atomically.',
  },
  {
    id: 'C2', fixture: 'counter',
    system: 'Environment id "env-1". Doc counters/c1 = { count: 5 }. Auth: { uid: "alice" }.',
    user: 'Add 7 to counters/c1.',
  },
  {
    id: 'C3', fixture: 'counter',
    system: 'Environment id "env-1". Doc counters/c1 = { count: 50 }. Auth: { uid: "alice" }.',
    user: 'Halve the counter at counters/c1, rounded down.',
  },
  {
    id: 'C4', fixture: 'counter',
    system: 'Environment id "env-1". Doc counters/c1 = { count: 150 }. Auth: { uid: "alice" }.',
    user: "Reset counters/c1 to zero only if it's currently above 100; otherwise leave it as-is.",
  },
  // State-machine fixture
  {
    id: 'S1', fixture: 'state-machine',
    system: 'Environment id "env-1". Doc jobs/j1 = { status: "pending" }. Allowed transitions: pending→active, active→done.',
    user: 'Advance jobs/j1 from pending to active.',
  },
  {
    id: 'S2', fixture: 'state-machine',
    system: 'Environment id "env-1". Doc jobs/j1 = { status: "pending" }. Allowed transitions: pending→active, active→done.',
    user: "If jobs/j1.status is 'pending', set it to 'active'; if 'active', set it to 'done'.",
  },
  {
    id: 'S3', fixture: 'state-machine',
    system: 'Environment id "env-1". Doc jobs/j1 = { status: "active" }. Allowed transitions: pending→active, active→done. There is no "cancelled" state.',
    user: 'Mark jobs/j1 as cancelled.',
  },
  // Cross-doc fixture
  {
    id: 'X1', fixture: 'cross-doc',
    system: 'Environment id "env-1". Docs: users/u1 = { balance: 100 }, users/u2 = { balance: 50 }. Auth: { uid: "u1" }.',
    user: 'Transfer 30 from users/u1 to users/u2 atomically. Record the transfer at transfers/t1 with { from, to, amount }.',
  },
  {
    id: 'X2', fixture: 'cross-doc',
    system: 'Environment id "env-1". Docs: users/u1 = { balance: 100 }, users/u2 = { balance: 50 }. Auth: { uid: "u1" }.',
    user: "Transfer u1's entire balance to u2.",
  },
  {
    id: 'X3', fixture: 'cross-doc',
    system: 'Environment id "env-1". Doc users/u1 = { balance: 100, history: ["created"] }. Auth: { uid: "u1" }.',
    user: 'Append the string "transferred" to users/u1.history.',
  },
  {
    id: 'X4', fixture: 'cross-doc',
    system: 'Environment id "env-1". Doc users/u1 = { balance: 100 }. Auth: { uid: "u1" }.',
    user: 'Stamp users/u1 with the current server time as lastSeenAt.',
  },
  {
    id: 'X5', fixture: 'cross-doc',
    system: 'Environment id "env-1". Docs: users/u1 = { balance: 40 }, users/u2 = { balance: 50 }. Auth: { uid: "u1" }.',
    user: "Reject the transfer if u1's balance is below 50; otherwise debit u1 by 30 and credit u2 by 30.",
  },
  // Expected-gap probes
  {
    id: 'F1', fixture: 'gap-probe',
    system: 'Environment id "env-1". Doc users/u1 = { name: "ALICE" }.',
    user: "Lowercase the user's name on users/u1.",
  },
  {
    id: 'F2', fixture: 'gap-probe',
    system: 'Environment id "env-1". Doc users/u1 = { score: 95 }.',
    user: "Cap users/u1.score at min(currentScore + 10, 100).",
  },
];

// ─── Classification ──────────────────────────────────────────────────────

type Classification =
  | { kind: 'ok' }
  | { kind: 'lex_error'; message: string }
  | { kind: 'parse_error'; message: string }
  | { kind: 'unknown_identifier'; alias: string };

function classify(expr: string, declaredAliases: Set<string>): Classification {
  let tokens;
  try {
    tokens = tokenize(expr);
  } catch (e) {
    if (e instanceof ExpressionLexError) return { kind: 'lex_error', message: e.message };
    throw e;
  }
  let ast;
  try {
    ast = parse(tokens);
  } catch (e) {
    if (e instanceof ExpressionParseError) return { kind: 'parse_error', message: e.message };
    throw e;
  }
  // Check that every $alias referenced is declared
  const missing = collectReferences(ast).find((a) => !declaredAliases.has(a));
  if (missing) return { kind: 'unknown_identifier', alias: missing };
  return { kind: 'ok' };
}

function collectReferences(ast: any): string[] {
  const out: string[] = [];
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'reference' && typeof node.alias === 'string') out.push(node.alias);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object') walk(v);
    }
  };
  walk(ast);
  return out;
}

// ─── Walker: pull every $expr leaf out of the writes data trees ───────────

interface ExprLeaf {
  writeIndex: number;
  path: string;        // dotted path to the leaf
  expr: string;
}

function pullExprs(writes: any[]): ExprLeaf[] {
  const out: ExprLeaf[] = [];
  if (!Array.isArray(writes)) return out;
  for (let i = 0; i < writes.length; i++) {
    const data = writes[i]?.data;
    if (data === null || typeof data !== 'object') continue;
    walkLeaves(data, [], (path, val) => {
      if (val && typeof val === 'object' && typeof (val as any).$expr === 'string') {
        out.push({ writeIndex: i, path: path.join('.'), expr: (val as any).$expr });
      }
    });
  }
  return out;
}

function walkLeaves(node: any, path: string[], visit: (p: string[], v: any) => void): void {
  if (node === null || typeof node !== 'object') {
    visit(path, node);
    return;
  }
  // Treat { $expr } as a leaf
  if (typeof node.$expr === 'string') {
    visit(path, node);
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walkLeaves(node[i], [...path, String(i)], visit);
    return;
  }
  for (const [k, v] of Object.entries(node)) walkLeaves(v, [...path, k], visit);
}

// ─── OpenRouter call ─────────────────────────────────────────────────────

interface ProbeResult {
  model: string;
  promptId: string;
  run: number;
  status: 'ok' | 'no_tool_call' | 'bad_json' | 'http_error' | 'unexpected';
  rawArgs?: string;
  parsedArgs?: any;
  exprLeaves?: Array<ExprLeaf & { classification: Classification }>;
  errorMessage?: string;
  latencyMs?: number;
}

async function callOpenRouter(model: string, prompt: Prompt): Promise<ProbeResult> {
  const t0 = Date.now();
  const body = {
    model,
    messages: [
      { role: 'system', content: prompt.system + ' You must call the firestore_simulator_transaction tool exactly once.' },
      { role: 'user', content: prompt.user },
    ],
    tools: [TOOL_SCHEMA],
    tool_choice: { type: 'function', function: { name: 'firestore_simulator_transaction' } },
    temperature: 0.7,
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KEY}`,
      'HTTP-Referer': 'https://github.com/davideast/pyric',
      'X-Title': 'pyric transaction probe',
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    return {
      model, promptId: prompt.id, run: 0, status: 'http_error',
      errorMessage: `HTTP ${res.status}: ${text.slice(0, 300)}`, latencyMs,
    };
  }
  const json = await res.json() as any;
  const toolCalls = json?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return {
      model, promptId: prompt.id, run: 0, status: 'no_tool_call',
      errorMessage: 'no tool_calls in response', latencyMs,
    };
  }
  const rawArgs = toolCalls[0]?.function?.arguments ?? '';
  let parsed: any;
  try {
    parsed = JSON.parse(rawArgs);
  } catch (e) {
    return {
      model, promptId: prompt.id, run: 0, status: 'bad_json',
      rawArgs, errorMessage: String(e), latencyMs,
    };
  }
  const declared = new Set<string>(Object.keys(parsed?.reads ?? {}));
  const leaves = pullExprs(parsed?.writes ?? []);
  const classified = leaves.map((l) => ({ ...l, classification: classify(l.expr, declared) }));
  return {
    model, promptId: prompt.id, run: 0, status: 'ok',
    rawArgs, parsedArgs: parsed, exprLeaves: classified, latencyMs,
  };
}

// ─── Concurrency-limited runner ──────────────────────────────────────────

async function runAll(): Promise<ProbeResult[]> {
  const tasks: Array<{ model: string; prompt: Prompt; run: number }> = [];
  for (const model of MODELS) {
    for (const prompt of PROMPTS) {
      for (let run = 1; run <= N_RUNS; run++) {
        tasks.push({ model, prompt, run });
      }
    }
  }
  const results: ProbeResult[] = new Array(tasks.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      const { model, prompt, run } = tasks[idx]!;
      try {
        const r = await callOpenRouter(model, prompt);
        results[idx] = { ...r, run };
      } catch (e) {
        results[idx] = {
          model, promptId: prompt.id, run,
          status: 'unexpected', errorMessage: String(e),
        };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

// ─── Report ───────────────────────────────────────────────────────────────

function buildReport(results: ProbeResult[]): string {
  const lines: string[] = [];
  lines.push('# Transaction Probe Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Models: ${MODELS.join(', ')}`);
  lines.push(`Prompts: ${PROMPTS.length} | Runs/cell: ${N_RUNS} | Total calls: ${results.length}`);
  lines.push('');

  // Aggregate by classification
  const opCounts = new Map<string, number>();
  const gapHits = new Map<string, Set<string>>(); // operator-ish key → prompt IDs
  let totalLeaves = 0;
  for (const r of results) {
    if (r.status !== 'ok' || !r.exprLeaves) continue;
    for (const leaf of r.exprLeaves) {
      totalLeaves++;
      const k = leaf.classification.kind;
      opCounts.set(k, (opCounts.get(k) ?? 0) + 1);
      if (k !== 'ok') {
        const sig = k === 'unknown_identifier'
          ? `unknown $${leaf.classification.alias}`
          : leaf.classification.message.slice(0, 80);
        if (!gapHits.has(sig)) gapHits.set(sig, new Set());
        gapHits.get(sig)!.add(r.promptId);
      }
    }
  }
  lines.push('## Classification summary');
  lines.push('');
  lines.push(`Total \`$expr\` leaves seen: ${totalLeaves}`);
  for (const [k, n] of [...opCounts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${k}\`: ${n}`);
  }
  lines.push('');

  lines.push('## Grammar-gap candidates (≥2 distinct prompts)');
  lines.push('');
  const candidates = [...gapHits.entries()]
    .filter(([, ps]) => ps.size >= 2)
    .sort((a, b) => b[1].size - a[1].size);
  if (candidates.length === 0) {
    lines.push('_None._');
  } else {
    for (const [sig, ps] of candidates) {
      lines.push(`- \`${sig}\` — surfaced from prompts: ${[...ps].sort().join(', ')}`);
    }
  }
  lines.push('');

  // Per-cell breakdown
  lines.push('## Per-cell results');
  lines.push('');
  lines.push('| Model | Prompt | Run | Status | Leaves | Notes |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const leaves = r.exprLeaves?.length ?? 0;
    const notes = r.status === 'ok'
      ? r.exprLeaves!.map((l) => `${l.path}=${l.classification.kind}`).join('; ') || '(none)'
      : (r.errorMessage ?? '').slice(0, 100);
    lines.push(`| ${r.model} | ${r.promptId} | ${r.run} | ${r.status} | ${leaves} | ${escape(notes)} |`);
  }
  lines.push('');

  // Raw expressions for review
  lines.push('## Raw expressions per prompt');
  lines.push('');
  const byPrompt = new Map<string, ProbeResult[]>();
  for (const r of results) {
    if (!byPrompt.has(r.promptId)) byPrompt.set(r.promptId, []);
    byPrompt.get(r.promptId)!.push(r);
  }
  for (const p of PROMPTS) {
    lines.push(`### ${p.id} (${p.fixture})`);
    lines.push(`> ${p.user}`);
    lines.push('');
    for (const r of byPrompt.get(p.id) ?? []) {
      if (r.status !== 'ok' || !r.exprLeaves) continue;
      for (const l of r.exprLeaves) {
        lines.push(`- \`${l.expr}\` _(${r.model}, run ${r.run}, ${l.classification.kind})_`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ─── Test ────────────────────────────────────────────────────────────────

describe.skipIf(!RUN || !KEY)('transaction grammar probe (Item 4.6)', () => {
  test('runs prompts × models × N and writes report', { timeout: 600_000 }, async () => {
    const results = await runAll();

    expect(results).toHaveLength(MODELS.length * PROMPTS.length * N_RUNS);
    expect(results.every((r) => r !== undefined)).toBe(true);

    const report = buildReport(results);
    const outDir = join(process.cwd(), 'tmp');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'transaction-probe-report.md');
    writeFileSync(outPath, report, 'utf-8');
    console.log(`[probe] report written to ${outPath}`);

    // Sanity: at least one cell produced an `ok` parse
    const okCount = results.filter((r) => r.status === 'ok').length;
    expect(okCount).toBeGreaterThan(0);
  });
});
