/**
 * Offline trace analysis (EFF1) — pure functions that turn the efficiency
 * ledgers and/or a trace-viewer JSON export into per-hypothesis priors.
 *
 * Inputs (any subset; each section states what it could and couldn't see):
 *   - request-ledger rows  (per-iteration; H1, H3, H4-share)
 *   - tool-ledger rows     (per tool call; H2, H5, H7-counts)
 *   - trace-viewer export  (CanonicalToolCallBundle records; H2, H4-deliberation,
 *                           H5, H7 incl. rewrite-vs-diff when contents present)
 *   - records.ndjson       (eval store; weak H1 prior, H6 router provenance,
 *                           H7 call-count prior)
 *
 * PRE-REGISTERED VERDICT THRESHOLDS (state them before looking at data):
 *   H1 supported: any turn with ≥3 iterations has Σ tokensIn / final tokensIn ≥ 5.
 *      refuted:   every turn with ≥4 iterations has ratio < 2.
 *   H2 supported: top-2 result payloads carry ≥30% of total result-token
 *      traffic, or the top decile of calls carries ≥50%. Needs ≥5 calls
 *      with results — concentration over a couple of calls is trivial.
 *   H3 supported: duplicatePromptTokens > 0 anywhere (it is a bug; any
 *      nonzero confirms the double-send).  refuted: provider-usage rows
 *      exist and every row has 0.
 *   H4 supported: reasoning ≥40% of output tokens, or median deliberation
 *      before the first tool call ≥ 30s.
 *   H5 supported: any identical simulate tuple (method+path+auth-shape)
 *      run ≥2 times.  refuted: ≥5 simulate calls, all tuples unique.
 *   H6 supported: ≥20% of routed, DV-eligible runs routed to react.
 *      (All app-build fixtures are DV-eligible by construction.)
 *   H7 supported: some path has ≥3 whole-file writes with mean changed-line
 *      ratio ≤ 0.35 (mostly-unchanged rewrites).
 *
 * Everything here is pure; the CLI (`scripts/analyze-trace.ts`) does I/O.
 */
import type { CanonicalToolCallBundle } from '~/lib/tools/canonical-bundle';
import { diffLines } from '~/lib/utils/diff';
import type { MetricsRecord } from './metrics-store';
import { estTokens, simulateTupleHash, type RequestLedgerRow, type ToolLedgerRow } from './efficiency-ledgers';

export type Verdict = 'supported' | 'refuted' | 'insufficient data';

export interface SectionResult {
  hypothesis: string;
  title: string;
  verdict: Verdict;
  /** The headline number(s), human-readable. */
  headline: string;
  /** Markdown body (tables / lists). */
  body: string;
  /** What was missing, when verdict is 'insufficient data'. */
  missing?: string;
}

// ── input parsing ───────────────────────────────────────────────────────

/** Accepts: a JSON array of bundles, `{records: [...]}` / `{calls: [...]}`,
 *  or NDJSON (one bundle per line). */
export function parseTraceExport(text: string): CanonicalToolCallBundle[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed.filter(isBundleLike);
    if (parsed && typeof parsed === 'object') {
      const o = parsed as { records?: unknown; calls?: unknown };
      const arr = Array.isArray(o.records) ? o.records : Array.isArray(o.calls) ? o.calls : null;
      if (arr) return arr.filter(isBundleLike);
      if (isBundleLike(parsed)) return [parsed];
      return [];
    }
    return [];
  } catch {
    // NDJSON fallback.
    const out: CanonicalToolCallBundle[] = [];
    for (const line of trimmed.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const obj = JSON.parse(s);
        if (isBundleLike(obj)) out.push(obj);
      } catch {
        /* skip */
      }
    }
    return out;
  }
}

function isBundleLike(x: unknown): x is CanonicalToolCallBundle {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return typeof r.name === 'string' && typeof r.turn_id === 'string' && 'args' in r;
}

// ── shared helpers ──────────────────────────────────────────────────────

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** A tool call viewed uniformly, whether it came from the tool ledger or a
 *  trace export. */
interface CallSample {
  tool: string;
  turnId: string;
  sequenceIndex: number;
  argsTokens: number;
  resultTokens: number;
  path?: string;
  tupleHash?: string;
  /** Full file content for write tools — only available from trace exports. */
  content?: string;
  timeIntoTurnMs?: number;
  thinkingTokensUpToHere?: number;
  durationMs?: number;
}

export function samplesFromToolRows(rows: ToolLedgerRow[]): CallSample[] {
  return rows.map((r) => ({
    tool: r.tool,
    turnId: r.turnId,
    sequenceIndex: r.sequenceIndex,
    argsTokens: r.argsTokensEst,
    resultTokens: r.resultTokensEst,
    ...(r.path ? { path: r.path } : {}),
    ...(r.tupleHash ? { tupleHash: r.tupleHash } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
  }));
}

export function samplesFromBundles(bundles: CanonicalToolCallBundle[]): CallSample[] {
  return bundles.map((b) => {
    const argsJson = safeStringify(b.args);
    const resultJson = b.result !== undefined ? safeStringify(b.result) : '';
    const path = (b.args as { path?: unknown } | null)?.path;
    const content = (b.args as { content?: unknown } | null)?.content;
    const tupleHash = simulateTupleHash(b.name, b.args);
    return {
      tool: b.name,
      turnId: b.turn_id,
      sequenceIndex: b.sequence_index,
      argsTokens: estTokens(argsJson),
      resultTokens: estTokens(resultJson),
      ...(typeof path === 'string' ? { path } : {}),
      ...(tupleHash ? { tupleHash } : {}),
      ...(typeof content === 'string' ? { content } : {}),
      ...(b.time_into_turn_ms !== undefined ? { timeIntoTurnMs: b.time_into_turn_ms } : {}),
      ...(b.thinking_up_to_here !== undefined
        ? { thinkingTokensUpToHere: estTokens(b.thinking_up_to_here) }
        : {}),
    };
  });
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

// ── H1 — context integral ───────────────────────────────────────────────

export function analyzeH1(rows: RequestLedgerRow[]): SectionResult {
  const base = {
    hypothesis: 'H1',
    title: 'Context integral — cumulative input vs final context',
  };
  if (rows.length === 0) {
    return {
      ...base,
      verdict: 'insufficient data',
      headline: 'no per-iteration request rows',
      body: '',
      missing:
        'request-ledger rows (run the harness with the ledger tracer, or wait for live-session request ledgers)',
    };
  }
  // Group by (runId, turnId).
  const byTurn = new Map<string, RequestLedgerRow[]>();
  for (const r of rows) {
    const k = `${r.runId}::${r.turnId}`;
    const arr = byTurn.get(k) ?? [];
    arr.push(r);
    byTurn.set(k, arr);
  }
  const lines: string[] = ['| run | turn | iters | Σ tokensIn | final tokensIn | ratio | Σ re-sent tool results |', '|---|---|---|---|---|---|---|'];
  let supported = false;
  let anyBigTurn = false;
  let allBigTurnsLow = true;
  for (const [k, arr] of byTurn) {
    arr.sort((a, b) => a.iteration - b.iteration);
    const sum = arr.reduce((s, r) => s + r.tokensIn, 0);
    const final = arr[arr.length - 1]!.tokensIn;
    const ratio = final > 0 ? sum / final : 0;
    const resent = arr.reduce((s, r) => s + r.composition.resentToolResults, 0);
    const [runId, turnId] = k.split('::');
    lines.push(
      `| ${runId} | ${turnId} | ${arr.length} | ${fmt(sum)} | ${fmt(final)} | ${ratio.toFixed(1)}× | ${fmt(resent)} |`,
    );
    if (arr.length >= 3 && ratio >= 5) supported = true;
    if (arr.length >= 4) {
      anyBigTurn = true;
      if (ratio >= 2) allBigTurnsLow = false;
    }
  }
  const verdict: Verdict = supported
    ? 'supported'
    : anyBigTurn && allBigTurnsLow
      ? 'refuted'
      : 'insufficient data';
  const totalIn = rows.reduce((s, r) => s + r.tokensIn, 0);
  return {
    ...base,
    verdict,
    headline: `${byTurn.size} turn(s), ${rows.length} iterations, Σ input ${fmt(totalIn)} tokens`,
    body: lines.join('\n'),
    ...(verdict === 'insufficient data'
      ? { missing: 'a mega-turn (≥3 iterations) — current data has only short turns' }
      : {}),
  };
}

// ── H2 — tool-result payload outliers ───────────────────────────────────

export function analyzeH2(samples: CallSample[]): SectionResult {
  const base = { hypothesis: 'H2', title: 'Tool-result payload outliers' };
  const withResults = samples.filter((s) => s.resultTokens > 0);
  if (withResults.length === 0) {
    return {
      ...base,
      verdict: 'insufficient data',
      headline: 'no tool results observed',
      body: '',
      missing: 'tool-ledger rows or a trace export with `result` fields',
    };
  }
  const total = withResults.reduce((s, c) => s + c.resultTokens, 0);
  const sorted = [...withResults].sort((a, b) => b.resultTokens - a.resultTokens);
  const top10 = sorted.slice(0, 10);
  const top2Share = (top10.slice(0, 2).reduce((s, c) => s + c.resultTokens, 0) / total) * 100;
  const decile = Math.max(1, Math.floor(sorted.length / 10));
  const decileShare = (sorted.slice(0, decile).reduce((s, c) => s + c.resultTokens, 0) / total) * 100;

  const topLines = ['| tool | path | result tok (est) | args tok (est) | turn |', '|---|---|---|---|---|'];
  for (const c of top10) {
    topLines.push(
      `| ${c.tool} | ${c.path ?? '—'} | ${fmt(c.resultTokens)} | ${fmt(c.argsTokens)} | ${c.turnId} |`,
    );
  }
  // Per-tool p50/p95.
  const byTool = new Map<string, number[]>();
  for (const c of withResults) {
    const arr = byTool.get(c.tool) ?? [];
    arr.push(c.resultTokens);
    byTool.set(c.tool, arr);
  }
  const distLines = ['', '| tool | calls | result p50 | result p95 | Σ result tok | share |', '|---|---|---|---|---|---|'];
  for (const [tool, arr] of [...byTool.entries()].sort((a, b) => sum(b[1]) - sum(a[1]))) {
    arr.sort((a, b) => a - b);
    distLines.push(
      `| ${tool} | ${arr.length} | ${fmt(percentile(arr, 50))} | ${fmt(percentile(arr, 95))} | ${fmt(sum(arr))} | ${((sum(arr) / total) * 100).toFixed(0)}% |`,
    );
  }
  // Concentration over a handful of calls is trivially high — demand a
  // minimum sample before issuing a verdict (pre-registered: ≥5).
  const verdict: Verdict =
    withResults.length < 5
      ? 'insufficient data'
      : top2Share >= 30 || decileShare >= 50
        ? 'supported'
        : 'refuted';
  return {
    ...base,
    verdict,
    headline: `top-2 results = ${top2Share.toFixed(0)}% of result traffic; top decile = ${decileShare.toFixed(0)}% (Σ ${fmt(total)} tok over ${withResults.length} calls)`,
    body: [...topLines, ...distLines].join('\n'),
    ...(verdict === 'insufficient data'
      ? { missing: `a real session's worth of tool calls (${withResults.length} < 5 observed)` }
      : {}),
  };
}

function sum(a: number[]): number {
  return a.reduce((s, x) => s + x, 0);
}

// ── H3 — duplicate-prompt waste ─────────────────────────────────────────

export function analyzeH3(rows: RequestLedgerRow[]): SectionResult {
  const base = { hypothesis: 'H3', title: 'Duplicate current-prompt per iteration' };
  if (rows.length === 0) {
    return {
      ...base,
      verdict: 'insufficient data',
      headline: 'no request rows',
      body: '',
      missing: 'request-ledger rows (the trace export does not carry message arrays)',
    };
  }
  const wasted = rows.reduce((s, r) => s + r.duplicatePromptTokens, 0);
  const affected = rows.filter((r) => r.duplicatePromptTokens > 0).length;
  const totalIn = rows.reduce((s, r) => s + r.tokensIn, 0);
  const share = totalIn > 0 ? (wasted / totalIn) * 100 : 0;
  const verdict: Verdict = wasted > 0 ? 'supported' : 'refuted';
  return {
    ...base,
    verdict,
    headline: `${fmt(wasted)} duplicated prompt tokens across ${affected}/${rows.length} iterations (${share.toFixed(1)}% of Σ input)`,
    body:
      'The fix lives in `@inbrowser/agent` (session appends the user msg to history AND passes `prompt`; `buildMessages` appends it again). This instrument only quantifies the waste.',
  };
}

// ── H4 — reasoning / deliberation waste ─────────────────────────────────

export function analyzeH4(rows: RequestLedgerRow[], samples: CallSample[]): SectionResult {
  const base = { hypothesis: 'H4', title: 'Reasoning share + deliberation before first tool' };
  const parts: string[] = [];
  let haveShare = false;
  let shareSupported = false;
  if (rows.length > 0) {
    const reasoning = rows.reduce((s, r) => s + r.reasoning, 0);
    const out = rows.reduce((s, r) => s + r.tokensOut, 0);
    if (out > 0) {
      haveShare = true;
      const share = (reasoning / out) * 100;
      shareSupported = share >= 40;
      parts.push(
        `Reasoning ≈ ${fmt(reasoning)} tok (chars/4 estimate of \`thinking\`; the trace usage shape has no reasoningTokens) = ${share.toFixed(0)}% of ${fmt(out)} output tokens.`,
      );
    }
  }
  // Deliberation before the FIRST tool call of each turn (trace export).
  const firstCalls = samples.filter(
    (s) => s.sequenceIndex === 1 && (s.timeIntoTurnMs !== undefined || s.thinkingTokensUpToHere !== undefined),
  );
  let haveDelib = false;
  let delibSupported = false;
  if (firstCalls.length > 0) {
    haveDelib = true;
    const times = firstCalls
      .map((s) => s.timeIntoTurnMs)
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => a - b);
    const medianMs = percentile(times, 50);
    delibSupported = medianMs >= 30_000;
    const lines = ['| turn | first tool | ms into turn | thinking tok up to call |', '|---|---|---|---|'];
    for (const s of firstCalls) {
      lines.push(
        `| ${s.turnId} | ${s.tool} | ${s.timeIntoTurnMs !== undefined ? fmt(s.timeIntoTurnMs) : '—'} | ${s.thinkingTokensUpToHere !== undefined ? fmt(s.thinkingTokensUpToHere) : '—'} |`,
      );
    }
    parts.push(`Median deliberation before first tool: ${fmt(medianMs)} ms over ${times.length} turn(s).`, lines.join('\n'));
  }
  if (!haveShare && !haveDelib) {
    return {
      ...base,
      verdict: 'insufficient data',
      headline: 'no reasoning or deliberation signal',
      body: '',
      missing:
        'request-ledger rows with thinking text, or a trace export with thinking_up_to_here / time_into_turn_ms',
    };
  }
  const verdict: Verdict = shareSupported || delibSupported ? 'supported' : 'refuted';
  return {
    ...base,
    verdict,
    headline: parts[0] ?? '',
    body: parts.slice(1).join('\n\n'),
  };
}

// ── H5 — simulate tuple redundancy ──────────────────────────────────────

export function analyzeH5(samples: CallSample[]): SectionResult {
  const base = { hypothesis: 'H5', title: 'Redundant simulate tuples (method+path+auth)' };
  const sims = samples.filter((s) => s.tupleHash);
  if (sims.length === 0) {
    return {
      ...base,
      verdict: 'insufficient data',
      headline: 'no simulate_firestore_write calls observed',
      body: '',
      missing: 'tool-ledger rows or a trace export containing simulate calls',
    };
  }
  const byTuple = new Map<string, CallSample[]>();
  for (const s of sims) {
    const arr = byTuple.get(s.tupleHash!) ?? [];
    arr.push(s);
    byTuple.set(s.tupleHash!, arr);
  }
  const dupes = [...byTuple.entries()].filter(([, arr]) => arr.length > 1);
  const wastedCalls = dupes.reduce((s, [, arr]) => s + arr.length - 1, 0);
  const lines = ['| tuple | runs | path |', '|---|---|---|'];
  for (const [hash, arr] of dupes) lines.push(`| ${hash} | ${arr.length} | ${arr[0]!.path ?? '—'} |`);
  const verdict: Verdict =
    wastedCalls > 0 ? 'supported' : sims.length >= 5 ? 'refuted' : 'insufficient data';
  return {
    ...base,
    verdict,
    headline: `${sims.length} simulate calls, ${byTuple.size} distinct tuples, ${wastedCalls} redundant re-run(s)`,
    body: dupes.length > 0 ? lines.join('\n') : '_no duplicated tuples_',
    ...(verdict === 'insufficient data'
      ? { missing: 'more simulate calls (<5 observed, none duplicated — cannot distinguish luck from discipline)' }
      : {}),
  };
}

// ── H6 — router provenance (eval store) ─────────────────────────────────

export function analyzeH6(records: MetricsRecord[]): SectionResult {
  const base = { hypothesis: 'H6', title: 'Router misses on DV-eligible prompts' };
  const routed = records.filter((r) => r.strategy.name === 'routed');
  if (routed.length === 0) {
    return {
      ...base,
      verdict: 'insufficient data',
      headline: 'no routed-arm runs in the store',
      body: '',
      missing: 'records with strategy.name === "routed" (router decision provenance lives in strategy.params.routedStrategy)',
    };
  }
  const withDecision = routed.filter((r) => typeof r.strategy.params?.routedStrategy === 'string');
  const misses = withDecision.filter((r) => r.strategy.params!.routedStrategy !== 'draft-validate');
  const missRate = withDecision.length > 0 ? (misses.length / withDecision.length) * 100 : 0;
  const lines = ['| fixture | routed to | escalated |', '|---|---|---|'];
  for (const r of withDecision) {
    lines.push(
      `| ${r.fixture.id} | ${String(r.strategy.params!.routedStrategy)} | ${r.strategy.params?.escalated ? 'yes' : 'no'} |`,
    );
  }
  const verdict: Verdict =
    withDecision.length === 0 ? 'insufficient data' : missRate >= 20 ? 'supported' : 'refuted';
  return {
    ...base,
    verdict,
    headline: `${withDecision.length} routed runs with provenance; ${misses.length} routed to react (${missRate.toFixed(0)}% miss rate; all app-build fixtures are DV-eligible)`,
    body: lines.join('\n'),
    ...(withDecision.length === 0
      ? { missing: 'routed runs predate provenance recording (strategy.params.routedStrategy)' }
      : {}),
  };
}

// ── H7 — whole-file write churn ─────────────────────────────────────────

export function analyzeH7(samples: CallSample[]): SectionResult {
  const base = { hypothesis: 'H7', title: 'Whole-file write churn (rewrite vs diff)' };
  const writes = samples.filter((s) => s.tool === 'write_file' && s.path);
  if (writes.length === 0) {
    return {
      ...base,
      verdict: 'insufficient data',
      headline: 'no write_file calls observed',
      body: '',
      missing: 'tool-ledger rows or a trace export with write_file calls',
    };
  }
  const byPath = new Map<string, CallSample[]>();
  for (const w of writes) {
    const arr = byPath.get(w.path!) ?? [];
    arr.push(w);
    byPath.set(w.path!, arr);
  }
  const lines = ['| path | writes | Σ args tok | mean changed-line ratio |', '|---|---|---|---|'];
  let supported = false;
  let anyRatio = false;
  for (const [path, arr] of [...byPath.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const argsTok = arr.reduce((s, w) => s + w.argsTokens, 0);
    // Rewrite-vs-diff: needs consecutive contents (trace exports carry
    // args.content; the tool ledger records only sizes).
    const contents = arr.map((w) => w.content).filter((c): c is string => typeof c === 'string');
    let ratioStr = '— (contents not in input)';
    if (contents.length >= 2) {
      anyRatio = true;
      const ratios: number[] = [];
      for (let i = 1; i < contents.length; i++) {
        const d = diffLines(contents[i - 1]!, contents[i]!);
        const total = contents[i]!.split('\n').length;
        ratios.push(total > 0 ? Math.min(1, (d.added + d.removed) / (2 * total)) : 0);
      }
      const mean = sum(ratios) / ratios.length;
      ratioStr = mean.toFixed(2);
      if (arr.length >= 3 && mean <= 0.35) supported = true;
    }
    lines.push(`| ${path} | ${arr.length} | ${fmt(argsTok)} | ${ratioStr} |`);
  }
  const multi = [...byPath.values()].filter((a) => a.length >= 2).length;
  const verdict: Verdict = supported
    ? 'supported'
    : anyRatio
      ? 'refuted'
      : multi > 0
        ? 'insufficient data'
        : 'refuted';
  return {
    ...base,
    verdict,
    headline: `${writes.length} write_file calls over ${byPath.size} path(s); ${multi} path(s) written more than once`,
    body: lines.join('\n'),
    ...(verdict === 'insufficient data'
      ? { missing: 'file contents (trace export with args.content) to compute rewrite-vs-diff ratios' }
      : {}),
  };
}

// ── eval-store weak priors (records.ndjson) ─────────────────────────────

/** What the EXISTING store can say before any ledger data exists: Σ input
 *  per run (H1's numerator — the denominator needs the ledger), simulate
 *  and write_file call counts (H5/H7 priors), router provenance (H6). */
export function recordsPriors(records: MetricsRecord[]): string {
  if (records.length === 0) return '_no records_';
  const lines = [
    '| run | strategy | fixture | turns | Σ tokensIn | tokensIn/turn | sim calls | write_file calls |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of records) {
    const sims = r.toolCalls.filter((t) => t === 'simulate_firestore_write').length;
    const writes = r.toolCalls.filter((t) => t === 'write_file').length;
    lines.push(
      `| ${r.runId} | ${r.strategy.name} | ${r.fixture.id} | ${r.turns} | ${fmt(r.tokens.in)} | ${r.turns > 0 ? fmt(r.tokens.in / r.turns) : '—'} | ${sims} | ${writes} |`,
    );
  }
  return lines.join('\n');
}

// ── report rendering ────────────────────────────────────────────────────

export interface AnalyzeInput {
  requestRows: RequestLedgerRow[];
  toolRows: ToolLedgerRow[];
  bundles: CanonicalToolCallBundle[];
  records: MetricsRecord[];
  /** Label for the report header (file names / run filter). */
  source: string;
}

export function analyze(input: AnalyzeInput): SectionResult[] {
  // Tool samples: prefer the richer source per hypothesis — bundles carry
  // contents/timing, ledger rows carry durations. H2/H5/H7 use whichever
  // is non-empty; when both exist, bundles win for H7 (contents) and the
  // union is deliberately NOT taken (double-counting risk).
  const ledgerSamples = samplesFromToolRows(input.toolRows);
  const bundleSamples = samplesFromBundles(input.bundles);
  const samples = bundleSamples.length > 0 ? bundleSamples : ledgerSamples;
  return [
    analyzeH1(input.requestRows),
    analyzeH2(samples),
    analyzeH3(input.requestRows),
    analyzeH4(input.requestRows, bundleSamples),
    analyzeH5(samples),
    analyzeH6(input.records),
    analyzeH7(samples),
  ];
}

export function renderReport(input: AnalyzeInput): string {
  const sections = analyze(input);
  const out: string[] = [
    '# Efficiency trace analysis',
    '',
    `_source: ${input.source}_`,
    `_inputs: ${input.requestRows.length} request rows · ${input.toolRows.length} tool rows · ${input.bundles.length} trace records · ${input.records.length} eval records_`,
    '',
    '| hypothesis | verdict | headline |',
    '|---|---|---|',
    ...sections.map((s) => `| ${s.hypothesis} | **${s.verdict}** | ${s.headline} |`),
    '',
  ];
  for (const s of sections) {
    out.push(`## ${s.hypothesis} — ${s.title}`, '', `Verdict: **${s.verdict}** — ${s.headline}`, '');
    if (s.body) out.push(s.body, '');
    if (s.missing) out.push(`Missing: ${s.missing}`, '');
  }
  if (input.records.length > 0) {
    out.push('## Eval-store weak priors (records.ndjson)', '', recordsPriors(input.records), '');
  }
  return out.join('\n');
}
